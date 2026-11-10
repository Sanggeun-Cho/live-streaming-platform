// 송출 컨트롤러: 캡처 → WHIP 송출 → 끊김 감지·자동 재연결 → 종료를 한 곳에서 관리한다.
// React와 분리해 상태 전이를 한눈에 볼 수 있게 했다. 화면(StudioPage)은 subscribe로 상태만 그린다.
//
//   idle ─selectSource()→ requesting ─→ preview ─start()→ connecting ─→ live
//                                                                      │ 연결 끊김
//                     (다른 곳에서 송출) takenOver ◀── reconnecting ◀───┘
//                                                         └─ 새 토큰으로 재송출 → live
//   영상 소스가 끝남(화면 공유 중지 등) → sourceEnded: 송출을 멈춘다(마이크 포함).
//     유예 시간 안에 다시 선택하면 재송출, 아니면 서버가 방송을 종료한다.
//     카메라는 사용자가 끈 것이 아니므로(다른 앱·OS가 가져감) 먼저 같은 카메라를 다시 열어 이어 간다. 실패하면 sourceEnded.
//   소스를 고르는 중(requesting)에도 송출은 계속된다. 그사이 연결이 끊기면 똑같이 재연결한다.
//   종료(이 화면·다른 탭·유예 만료) → ended
//
// 비동기 작업(연결, 재연결, 캡처)은 시작할 때의 세대 번호(gen)를 기억했다가, await 뒤에 세대가 바뀌었으면
// 결과를 버린다. 종료·탭 경쟁·소스 중단·release 같은 동작이 세대를 올려 진행 중인 작업을 무효로 만든다.

import { ApiError } from '../api'
import { endBroadcast, getBroadcast, issuePublishToken } from '../broadcasts'
import { publishErrorMessage } from './errors'
import { type Capture, captureCamera, captureScreen, type FacingMode } from './media'
import { publish, setMaxBitrate, type WebRtcSession } from './whip'

export type SourceKind = 'screen' | 'camera'

export type Phase =
  | 'idle'
  | 'requesting'
  | 'preview'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'sourceEnded'
  | 'takenOver'
  | 'ended'

export type PublisherState = {
  phase: Phase
  source: SourceKind | null
  /** 미리보기에 붙일 캡처 스트림 (소스를 바꾸면 새 객체) */
  stream: MediaStream | null
  facing: FacingMode
  hasDisplayAudio: boolean
  hasMic: boolean
  displayVolume: number
  micVolume: number
  micMuted: boolean
  reconnectAttempt: number
  error: string | null
  /** 오류의 API 코드 (예: UNAUTHORIZED면 화면이 로그인으로 보낸다) */
  errorCode: string | null
}

// 화면 공유는 글자 선명도, 카메라는 움직임이 중요하다. 업로드가 느린 환경을 고려해 상한을 둔다
const MAX_BITRATE: Record<SourceKind, number> = { screen: 2_500_000, camera: 1_500_000 }
export const MAX_RECONNECT = 5
// 연결이 'disconnected'로 이 시간 이상 머물면 끊긴 것으로 본다 (잠깐의 끊김은 브라우저가 스스로 복구한다)
const DISCONNECT_GRACE_MS = 4000
// 끊긴 뒤 서버 상태를 확인하기 전에 기다리는 시간. MediaMTX offline 훅이 반영될 시간을 준다
const STATUS_CHECK_DELAY_MS = 3000
// 카메라 트랙이 예기치 않게 끝났을 때 다시 열어 보는 횟수. 간격은 1·2·3·3·3초(합계 약 12초).
// 카메라 서비스가 재시작되는 동안에는 한동안 장치가 없다고(NotFoundError) 나오므로 몇 초는 기다려 본다
export const CAMERA_RECOVER_ATTEMPTS = 6
const cameraRecoverDelay = (attempt: number) => Math.min(1000 * (attempt - 1), 3000)
// 영상 소스가 끝난 뒤 다시 선택하지 않으면 이 시간 뒤 방송을 종료한다 (서버 유예 시간과 같게).
// 송출 직후 바로 끊기면 MediaMTX에 송출이 잡히지 않아 서버가 끊김을 모를 수 있어서 화면이 직접 끝낸다
export const SOURCE_ENDED_TIMEOUT_MS = 45_000

const INITIAL: PublisherState = {
  phase: 'idle',
  source: null,
  stream: null,
  facing: 'user',
  hasDisplayAudio: false,
  hasMic: false,
  displayVolume: 1,
  micVolume: 1,
  micMuted: false,
  reconnectAttempt: 0,
  error: null,
  errorCode: null,
}

const errorState = (e: unknown) => ({
  error: publishErrorMessage(e),
  errorCode: e instanceof ApiError ? e.code : null,
})

export class Publisher {
  private state: PublisherState = INITIAL
  private listeners = new Set<(s: PublisherState) => void>()
  private capture: Capture | null = null
  private session: WebRtcSession | null = null
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined
  private sourceEndedTimer: ReturnType<typeof setTimeout> | undefined
  private wakeLock: WakeLockSentinel | null = null
  private gen = 0
  // 소스 선택 창이 열려 있다 (연결이 끊겨 phase가 reconnecting으로 바뀌어도 중복 요청을 막는다)
  private picking = false
  // 다시 열고 있는 카메라 캡처 (ended와 전환 실패가 겹쳐도 복구는 한 번만 돈다)
  private recovering: Capture | null = null
  // 같은 브라우저의 다른 탭과 "누가 송출 중인지" 공유한다 (두 탭이 서로 송출을 빼앗지 않게)
  private channel: BroadcastChannel | null = null
  private readonly tabId = Math.random().toString(36).slice(2)
  private readonly broadcastId: number

  constructor(broadcastId: number) {
    this.broadcastId = broadcastId
  }

  get snapshot(): PublisherState {
    return this.state
  }

  get peerConnection(): RTCPeerConnection | null {
    return this.session?.pc ?? null
  }

  /** 화면에 붙을 때 호출한다. 해제 함수는 송출·장치를 모두 정리한다 (StrictMode의 재마운트에도 안전) */
  attach(): () => void {
    if (typeof BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel('publisher')
      this.channel.onmessage = (e: MessageEvent<{ broadcastId: number; tabId: string }>) => {
        if (e.data.broadcastId !== this.broadcastId || e.data.tabId === this.tabId) return
        if (this.isOnAir()) this.toTakenOver()
      }
    }
    // 화면이 다시 보이면 Wake Lock을 다시 얻는다 (탭이 숨겨지면 브라우저가 자동으로 놓는다)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && this.state.phase === 'live') void this.acquireWakeLock()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      this.channel?.close()
      this.channel = null
      this.release()
    }
  }

  subscribe(listener: (s: PublisherState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<PublisherState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }

  /** 송출 중인가: 소스를 고르는 동안(requesting)에도 연결이 살아 있으면 송출 중이다 */
  private isOnAir() {
    const p = this.state.phase
    return p === 'live' || p === 'connecting' || p === 'reconnecting' || (p === 'requesting' && this.session !== null)
  }

  private nextGen() {
    clearTimeout(this.sourceEndedTimer)
    return ++this.gen
  }

  private stale(gen: number) {
    return gen !== this.gen
  }

  // ---- 캡처 ----

  /** 반드시 클릭 핸들러에서 바로 호출한다 (화면 공유·오디오 처리는 사용자 동작이 필요하다) */
  async selectSource(source: SourceKind) {
    const before = this.state.phase
    if (this.picking || before === 'requesting' || before === 'connecting' || before === 'ended') return
    this.picking = true
    this.set({ phase: 'requesting', error: null, errorCode: null })
    let next: Capture
    try {
      next = source === 'screen' ? await captureScreen({ mic: true }) : await captureCamera(this.state.facing)
    } catch (e) {
      // 고르는 사이 상태가 바뀌었으면(연결 끊김 → 재연결 등) 그 상태를 유지한다
      this.set(this.state.phase === 'requesting' ? { phase: before, ...errorState(e) } : errorState(e))
      return
    } finally {
      this.picking = false
    }
    const now = this.state.phase
    if (now === 'ended') return next.stop()
    // 고르는 사이 상태가 바뀌었으면(연결 끊김·탭 경쟁·소스 중단) 바뀐 상태를 기준으로 이어 간다
    const from = now === 'requesting' ? before : now
    const previous = this.capture
    this.capture = next
    next.onEnded(() => this.onSourceEnded(next))
    this.set({
      source,
      stream: next.stream,
      hasDisplayAudio: next.hasDisplayAudio,
      hasMic: next.hasMic,
      displayVolume: 1,
      micVolume: 1,
      micMuted: false,
    })

    if (this.session) {
      // 송출 중이면 연결을 유지한 채 트랙만 바꾼다. 시청자는 끊김 없이 새 화면을 본다
      await this.replaceTracks(next.stream)
      await setMaxBitrate(this.session.pc, MAX_BITRATE[source]).catch(() => undefined)
      previous?.stop()
      this.set({ phase: from === 'reconnecting' ? 'reconnecting' : 'live' })
      return
    }
    previous?.stop()
    if (from === 'reconnecting') {
      // 재연결 루프가 새 캡처로 이어서 연결한다
      this.set({ phase: 'reconnecting' })
    } else if (now === 'takenOver') {
      // 고르는 사이 다른 탭이 송출을 가져갔다: 새 소스만 준비해 두고 송출을 빼앗지 않는다
      this.set({ phase: 'takenOver' })
    } else if (from === 'sourceEnded' || from === 'takenOver') {
      clearTimeout(this.sourceEndedTimer)
      // 멈췄던 방송을 이어서 송출한다
      this.set({ phase: 'preview' })
      await this.start()
    } else {
      this.set({ phase: 'preview' })
    }
  }

  /** 모바일: 전면 ↔ 후면 카메라. 송출 중이면 연결을 유지한 채 영상 트랙만 바꾼다 */
  async switchCamera() {
    const capture = this.capture
    if (this.state.source !== 'camera' || !capture?.switchFacing) return
    const facing: FacingMode = this.state.facing === 'user' ? 'environment' : 'user'
    try {
      const track = await capture.switchFacing(facing)
      await this.videoSender()?.replaceTrack(track)
      this.set({ facing, stream: new MediaStream(capture.stream.getTracks()) })
    } catch (e) {
      this.set({ ...errorState(e), stream: new MediaStream(capture.stream.getTracks()) })
      // 새 카메라도 원래 카메라도 열지 못해 영상 트랙이 없다 → 끊긴 카메라처럼 다시 열어 본다
      if (capture === this.capture && !capture.stream.getVideoTracks().some((t) => t.readyState === 'live')) {
        void this.recoverCamera(capture)
      }
    }
  }

  setMicMuted(muted: boolean) {
    this.capture?.setMicVolume(muted ? 0 : this.state.micVolume)
    this.set({ micMuted: muted })
  }

  setDisplayVolume(v: number) {
    this.capture?.setDisplayVolume(v)
    this.set({ displayVolume: v })
  }

  setMicVolume(v: number) {
    this.capture?.setMicVolume(this.state.micMuted ? 0 : v)
    this.set({ micVolume: v })
  }

  private videoSender() {
    return this.session?.pc.getSenders().find((s) => s.track?.kind === 'video' || s.track === null)
  }

  private async replaceTracks(stream: MediaStream) {
    for (const sender of this.session?.pc.getSenders() ?? []) {
      const track = stream.getTracks().find((t) => t.kind === sender.track?.kind)
      if (track) await sender.replaceTrack(track)
    }
  }

  /** 화면 공유를 브라우저에서 중지했거나 카메라를 다른 앱·OS가 가져갔다 */
  private onSourceEnded(ended: Capture) {
    if (ended !== this.capture) return
    // 카메라는 사용자가 직접 끈 것이 아니다 → 같은 카메라를 다시 열어 본다
    if (ended.restartVideo) {
      void this.recoverCamera(ended)
      return
    }
    this.stopSource(ended)
  }

  /**
   * 카메라를 다시 열어 영상 트랙을 바꾼다. 연결은 유지한다.
   * 단, 이 연결로 영상이 한 프레임도 나가지 않았다면 MediaMTX가 영상 트랙 없이(오디오만) 스트림을 확정했을 수
   * 있으므로 새 연결로 다시 송출한다. 몇 번 시도해도 열리지 않으면 sourceEnded로 넘어간다.
   */
  private async recoverCamera(capture: Capture) {
    if (this.recovering === capture) return
    this.recovering = capture
    try {
      await this.recoverCameraLoop(capture)
    } finally {
      if (this.recovering === capture) this.recovering = null
    }
  }

  private async recoverCameraLoop(capture: Capture) {
    // 세대가 아니라 캡처로 판단한다: 복구 중 재연결(세대 변경)이 일어나도 카메라는 계속 다시 열어야
    // 재연결이 끝난 트랙을 보내지 않는다. 종료·release·소스 변경은 this.capture를 바꾸므로 여기서 멈춘다
    const valid = () => this.capture === capture
    for (let attempt = 1; attempt <= CAMERA_RECOVER_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(cameraRecoverDelay(attempt))
      if (!valid()) return
      let track: MediaStreamTrack
      try {
        track = await capture.restartVideo!()
      } catch {
        continue
      }
      if (!valid()) return track.stop()
      this.set({ stream: new MediaStream(capture.stream.getTracks()) })
      const session = this.session
      if (!session) return
      if (await videoFramesSent(session.pc)) {
        if (valid() && session === this.session) await this.videoSender()?.replaceTrack(track).catch(() => undefined)
      } else if (valid() && session === this.session) {
        await this.republish()
      }
      return
    }
    if (valid()) this.stopSource(capture)
  }

  /** 지금 캡처로 새 연결을 맺어 다시 송출한다 (overridePublisher로 이전 송출을 대체) */
  private async republish() {
    const gen = this.nextGen()
    this.closeSession()
    this.set({ phase: 'connecting', reconnectAttempt: 0 })
    try {
      if (!(await this.connect(gen))) return
      this.set({ phase: 'live', error: null, errorCode: null })
      this.onLive()
    } catch (e) {
      if (this.stale(gen)) return
      if (e instanceof ApiError && e.code === 'BROADCAST_ENDED') return this.handleServerEnded()
      // 일반 재연결 절차(서버 상태 확인 → 재시도)로 넘긴다
      this.set({ phase: 'live', ...errorState(e) })
      void this.handleDrop()
    }
  }

  /** 영상 소스를 잃었다: 영상이 멈춘 채 마이크만 나가지 않도록 송출과 장치를 모두 멈춘다 */
  private stopSource(ended: Capture) {
    const wasOnAir = this.isOnAir()
    this.nextGen()
    // 영상이 멈춘 채 마이크만 계속 나가지 않도록 송출과 장치를 모두 멈춘다.
    // 서버는 끊김으로 보고 유예 시간을 시작한다 → 그 안에 다시 선택하면 같은 방송이 이어진다
    this.closeSession()
    ended.stop()
    this.capture = null
    void this.releaseWakeLock()
    this.set({ phase: wasOnAir ? 'sourceEnded' : 'idle', stream: null })
    if (wasOnAir) {
      const gen = this.gen
      this.sourceEndedTimer = setTimeout(() => {
        if (!this.stale(gen) && this.state.phase === 'sourceEnded') void this.end()
      }, SOURCE_ENDED_TIMEOUT_MS)
    }
  }

  // ---- 송출 ----

  async start() {
    if (!this.capture || this.isOnAir()) return
    const gen = this.nextGen()
    this.set({ phase: 'connecting', error: null, errorCode: null, reconnectAttempt: 0 })
    try {
      if (!(await this.connect(gen))) return
      this.set({ phase: 'live' })
      this.onLive()
    } catch (e) {
      if (this.stale(gen)) return
      if (e instanceof ApiError && e.code === 'BROADCAST_ENDED') return this.handleServerEnded()
      this.set({ phase: 'preview', ...errorState(e) })
    }
  }

  /**
   * 매번 새 토큰을 받아 WHIP로 연결한다. 같은 path의 이전 송출은 서버가 대체한다(overridePublisher).
   * 그사이 세대가 바뀌었으면(종료·탭 경쟁 등) 만든 세션을 닫고 false를 돌려준다.
   */
  private async connect(gen: number): Promise<boolean> {
    const { token, whipPath } = await issuePublishToken(this.broadcastId)
    if (this.stale(gen) || !this.capture) return false
    const session = await publish(whipPath, this.capture.stream, {
      token,
      maxVideoBitrate: MAX_BITRATE[this.state.source ?? 'camera'],
    })
    if (this.stale(gen)) {
      void session.close()
      return false
    }
    this.session = session
    session.pc.addEventListener('connectionstatechange', () => this.onConnectionState(session))
    return true
  }

  private onLive() {
    this.channel?.postMessage({ broadcastId: this.broadcastId, tabId: this.tabId })
    void this.acquireWakeLock()
  }

  private onConnectionState(session: WebRtcSession) {
    if (session !== this.session) return
    const s = session.pc.connectionState
    clearTimeout(this.disconnectTimer)
    if (s === 'failed') void this.handleDrop()
    else if (s === 'disconnected') this.disconnectTimer = setTimeout(() => void this.handleDrop(), DISCONNECT_GRACE_MS)
  }

  /** 연결이 끊겼다: 다른 곳에서 송출을 가져갔는지, 방송이 끝났는지, 내 네트워크 문제인지 가린다 */
  private async handleDrop() {
    // 소스를 고르는 중(requesting)에도 송출은 살아 있으므로 똑같이 복구한다
    const p = this.state.phase
    if (p !== 'live' && !(p === 'requesting' && this.session)) return
    const gen = this.nextGen()
    this.closeSession()
    for (let attempt = 1; attempt <= MAX_RECONNECT; attempt++) {
      this.set({ phase: 'reconnecting', reconnectAttempt: attempt })
      await sleep(attempt === 1 ? STATUS_CHECK_DELAY_MS : 2000 * attempt)
      if (this.stale(gen)) return
      try {
        const b = await getBroadcast(this.broadcastId)
        if (this.stale(gen)) return
        if (b.status === 'ENDED') return this.handleServerEnded()
        // 서버는 송출이 붙어 있다고 본다 = 다른 탭·기기가 송출을 대체했다
        if (b.status === 'LIVE' && !b.disconnectedAt && attempt === 1) return this.toTakenOver()
        if (!(await this.connect(gen))) return
        this.set({ phase: 'live', reconnectAttempt: 0, error: null, errorCode: null })
        this.onLive()
        return
      } catch (e) {
        if (this.stale(gen)) return
        if (e instanceof ApiError && e.code === 'BROADCAST_ENDED') return this.handleServerEnded()
        this.set(errorState(e))
        if (e instanceof ApiError && e.status === 401) return this.set({ phase: 'preview' })
      }
    }
    this.set({
      phase: 'preview',
      error: '네트워크 연결이 불안정해 송출을 다시 시작하지 못했습니다. 연결을 확인한 뒤 "방송 시작"을 눌러 주세요',
      errorCode: null,
    })
  }

  /** 다른 탭·기기에서 송출 중일 때 이 화면에서 다시 가져온다 */
  async takeBack() {
    if (this.state.phase !== 'takenOver') return
    this.set({ phase: 'preview' })
    await this.start()
  }

  private toTakenOver() {
    this.nextGen()
    this.closeSession()
    void this.releaseWakeLock()
    this.set({ phase: 'takenOver', reconnectAttempt: 0 })
  }

  /** 방송이 (어디서든) 종료됐다. 진행 중인 연결을 무효로 하고 카메라·마이크·화면 공유를 끈다 */
  handleServerEnded() {
    if (this.state.phase === 'ended') return
    this.stopEverything()
    this.set({ phase: 'ended', stream: null, reconnectAttempt: 0 })
  }

  async end() {
    try {
      await endBroadcast(this.broadcastId)
      this.handleServerEnded()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BROADCAST_ENDED') return this.handleServerEnded()
      this.set(errorState(e))
    }
  }

  private stopEverything() {
    this.nextGen()
    this.closeSession()
    this.capture?.stop()
    this.capture = null
    void this.releaseWakeLock()
  }

  private closeSession() {
    clearTimeout(this.disconnectTimer)
    void this.session?.close()
    this.session = null
  }

  /** 화면을 떠날 때(언마운트, 탭 닫기). 송출은 멈추고 방송은 유예 시간 뒤 서버가 종료한다 */
  release() {
    this.stopEverything()
    if (this.state.phase !== 'ended') this.set({ ...INITIAL })
  }

  // 모바일에서 화면이 꺼지면 카메라 송출이 멈추므로 방송 중에는 화면 꺼짐을 막는다
  private async acquireWakeLock() {
    if (this.wakeLock) return
    try {
      this.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
      this.wakeLock?.addEventListener('release', () => (this.wakeLock = null))
    } catch {
      // 지원하지 않거나 거부되면 무시한다
    }
  }

  private async releaseWakeLock() {
    await this.wakeLock?.release().catch(() => undefined)
    this.wakeLock = null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type OutboundStats = { type?: string; kind?: string; framesEncoded?: number; bytesSent?: number }

/** 이 연결로 영상 프레임이 한 번이라도 나갔는가 (확인할 수 없으면 나갔다고 본다) */
async function videoFramesSent(pc: RTCPeerConnection): Promise<boolean> {
  try {
    let sent: boolean | null = null
    const report = await pc.getStats()
    report.forEach((s: OutboundStats) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') sent = (s.framesEncoded ?? 0) > 0 || (s.bytesSent ?? 0) > 0
    })
    return sent ?? true
  } catch {
    return true
  }
}
