// 송출 컨트롤러: 캡처 → WHIP 송출 → 끊김 감지·자동 재연결 → 종료를 한 곳에서 관리한다.
// React와 분리해 상태 전이를 한눈에 볼 수 있게 했다. 화면(StudioPage)은 subscribe로 상태만 그린다.
//
//   idle ─selectSource()→ requesting ─→ preview ─start()→ connecting ─→ live
//                                                                      │ 연결 끊김
//                     (다른 곳에서 송출) takenOver ◀── reconnecting ◀───┘
//                                                         └─ 새 토큰으로 재송출 → live
//   영상 소스가 끝남(화면 공유 중지 등) → sourceEnded: 송출을 멈춘다(마이크 포함).
//     유예 시간 안에 다시 선택하면 재송출, 아니면 서버가 방송을 종료한다.
//     카메라는 사용자가 끈 것이 아니므로(다른 앱·OS가 가져감) 먼저 같은 카메라를 다시 열어 이어 간다(healCamera).
//     다시 열지 못하거나, 권한이 회수됐거나, 1분에 복구가 너무 잦으면 sourceEnded.
//     sourceEnded 자동 종료는 마감 시각으로 관리해 다시 고르다 취소해도 시한이 이어진다.
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
// 1분 안에 이보다 많이 복구(카메라 다시 열기·재송출)해야 하면 장치가 불안정한 것이다 → 송출을 멈춘다
export const RECOVERY_BUDGET = 5
const CAMERA_LOST_MESSAGE = '카메라를 다시 열지 못해 송출을 멈췄습니다. 다른 앱이 카메라를 쓰고 있는지 확인한 뒤 다시 선택하세요'
const SOURCE_UNSTABLE_MESSAGE = '영상이 계속 끊겨 송출을 멈췄습니다. 장치와 네트워크를 확인한 뒤 다시 선택하세요'
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
  // sourceEnded 자동 종료 시각 (다시 고르다 취소해도 시한은 이어진다)
  private sourceEndedDeadline: number | null = null
  private wakeLock: WakeLockSentinel | null = null
  private gen = 0
  // 소스 선택 창이 열려 있다 (연결이 끊겨 phase가 reconnecting으로 바뀌어도 중복 요청을 막는다)
  private picking = false
  // 복구 루프가 돌고 있는 카메라 캡처 (ended·전환 실패·연결 직후 확인이 겹쳐도 루프는 하나)
  private healing: Capture | null = null
  // 영상 없이 맺어진 것으로 보여 새로 맺어야 하는 연결
  private republishFor: WebRtcSession | null = null
  // 끊기기 전 영상 송출 여부를 이미 확인한 연결
  private framesChecked: WebRtcSession | null = null
  // 최근 1분 복구 시각 (RECOVERY_BUDGET)
  private recoveries: number[] = []
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
      if (this.state.phase !== 'requesting') return this.set(errorState(e))
      this.set({ phase: before, ...errorState(e) })
      // 소스 중단 뒤 고르다 취소했다: 자동 종료 시한은 그대로다 (이미 지났으면 바로 종료)
      if (before === 'sourceEnded') this.armSourceEndedTimer()
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
    this.recoveries = []
    next.onEnded(() => this.onSourceEnded(next))
    this.set({
      source,
      stream: previewStream(next),
      hasDisplayAudio: next.hasDisplayAudio,
      hasMic: next.hasMic,
      displayVolume: 1,
      micVolume: 1,
      micMuted: false,
    })

    if (this.session) {
      // 송출 중이면 연결을 유지한 채 트랙만 바꾼다. 시청자는 끊김 없이 새 화면을 본다
      const session = this.session
      try {
        await this.replaceTracks(session, next.stream)
        await setMaxBitrate(session.pc, MAX_BITRATE[source]).catch(() => undefined)
      } catch {
        // 트랙 교체가 안 되면 새 캡처로 연결을 다시 맺는다 (checkVideo가 처리)
        if (session === this.session) this.republishFor = session
      }
      previous?.stop()
      if (this.state.phase === 'requesting') this.set({ phase: 'live' })
      this.checkVideo()
      return
    }
    previous?.stop()
    if (from === 'reconnecting' || from === 'connecting') {
      // 진행 중인 (재)연결이 새 캡처로 이어서 연결한다 (connect가 바뀐 캡처를 확인한다)
      this.set({ phase: from })
    } else if (now === 'takenOver') {
      // 고르는 사이 다른 탭이 송출을 가져갔다: 새 소스만 준비해 두고 송출을 빼앗지 않는다
      this.set({ phase: 'takenOver' })
    } else if (from === 'sourceEnded' || from === 'takenOver') {
      clearTimeout(this.sourceEndedTimer)
      this.sourceEndedDeadline = null
      // 멈췄던 방송을 이어서 송출한다
      this.set({ phase: 'preview' })
      await this.start()
    } else {
      this.set({ phase: 'preview' })
      this.checkVideo()
    }
  }

  /** 모바일: 전면 ↔ 후면 카메라. 송출 중이면 연결을 유지한 채 영상 트랙만 바꾼다 */
  async switchCamera() {
    const capture = this.capture
    if (this.state.source !== 'camera' || !capture?.switchFacing) return
    const facing: FacingMode = this.state.facing === 'user' ? 'environment' : 'user'
    try {
      const track = await capture.switchFacing(facing)
      this.set({ facing, stream: previewStream(capture) })
      await this.videoSender()?.replaceTrack(track)
    } catch (e) {
      this.set({ ...errorState(e), stream: previewStream(capture) })
    }
    // 전환에 실패해 영상 트랙이 없어졌거나, 송출 연결에 새 트랙을 붙이지 못했으면 복구한다
    this.checkVideo()
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

  private async replaceTracks(session: WebRtcSession, stream: MediaStream) {
    for (const sender of session.pc.getSenders()) {
      const track = stream.getTracks().find((t) => t.kind === sender.track?.kind)
      if (track) await sender.replaceTrack(track)
    }
  }

  /** 화면 공유를 브라우저에서 중지했거나 카메라를 다른 앱·OS가 가져갔다 */
  private onSourceEnded(ended: Capture) {
    if (ended !== this.capture) return
    // 화면 공유 중지는 사용자 의도다 → 송출을 멈춘다. 카메라는 사용자가 끈 것이 아니다 → 다시 열어 본다
    if (this.state.source === 'camera' && ended.restartVideo) void this.healCamera(ended)
    else this.stopSource(ended)
  }

  /** 카메라 영상이 살아 있고 송출 연결이 그 영상을 보내는지 확인하고, 아니면 복구를 시작한다 */
  private checkVideo() {
    const capture = this.capture
    if (!capture) return
    if (this.state.source !== 'camera' || !capture.restartVideo) {
      // 화면 공유: 트랙 교체에 실패한 연결만 새로 맺는다 (공유 중지는 ended 이벤트 → stopSource)
      if (this.session && this.republishFor === this.session) {
        if (this.spendRecovery()) void this.reconnect({ immediate: true })
        else this.stopSource(capture, SOURCE_UNSTABLE_MESSAGE)
      }
      return
    }
    const sender = this.videoSender()
    const track = liveVideo(capture)
    if (!track || (sender && sender.track !== track) || (this.session && this.republishFor === this.session)) {
      void this.healCamera(capture)
    }
  }

  /**
   * 카메라 복구 루프. 매 바퀴 상태를 다시 보고, 할 일이 없을 때만 끝난다 (그사이 다시 끊겨도 놓치지 않는다).
   *  1) 영상 트랙이 끝났으면 같은 카메라를 다시 연다 (약 12초 동안 6번, 권한 거부면 바로 포기)
   *  2) 이 연결로 영상이 한 프레임도 나가기 전에 끊겼다면 MediaMTX가 영상 없이(오디오만) 스트림을 확정했을 수 있으므로
   *     새 WHIP 연결로 다시 송출한다. 아니면 연결을 유지한 채 replaceTrack으로 바꾼다
   *  3) 1분에 RECOVERY_BUDGET번 넘게 복구해야 하면 카메라가 불안정한 것이다 → 송출을 멈춘다(sourceEnded)
   * 세대가 아니라 캡처로 유효성을 판단한다: 재연결(세대 변경) 중에도 카메라는 계속 다시 열어야 한다.
   * 종료·release·소스 변경은 this.capture를 바꾸므로 그때 멈춘다.
   */
  private async healCamera(capture: Capture) {
    if (this.healing === capture) return // 이미 도는 루프가 다음 바퀴에 다시 확인한다
    this.healing = capture
    try {
      await this.healLoop(capture)
    } finally {
      if (this.healing === capture) this.healing = null
    }
    // 루프가 끝나는 사이(마지막 await 뒤) 생긴 문제를 놓치지 않는다
    if (this.capture === capture) this.checkVideo()
  }

  private async healLoop(capture: Capture) {
    const restart = capture.restartVideo
    if (!restart) return
    const valid = () => this.capture === capture
    let failures = 0
    while (valid()) {
      const session = this.session
      const track = liveVideo(capture)
      if (!track) {
        // 끊기기 전에 이 연결로 영상이 나갔는지 한 번 확인한다 (안 나갔으면 다시 송출해야 한다)
        if (session && this.framesChecked !== session) {
          this.framesChecked = session
          if (!(await videoFramesSent(session.pc)) && session === this.session) this.republishFor = session
          continue
        }
        if (failures >= CAMERA_RECOVER_ATTEMPTS) return this.stopSource(capture, CAMERA_LOST_MESSAGE)
        if (failures > 0) await sleep(cameraRecoverDelay(failures + 1))
        if (!valid()) return
        let next: MediaStreamTrack
        try {
          next = await restart()
        } catch (e) {
          // 권한을 거둬 갔으면 다시 열어도 소용없다
          if (e instanceof DOMException && e.name === 'NotAllowedError') {
            return valid() ? this.stopSource(capture, publishErrorMessage(e)) : undefined
          }
          failures++
          continue
        }
        if (!valid()) return next.stop()
        failures = 0
        if (!this.spendRecovery()) return this.stopSource(capture, SOURCE_UNSTABLE_MESSAGE)
        this.set({ stream: previewStream(capture) })
        continue
      }
      if (!session) return // 연결되면 start·재연결이 checkVideo로 다시 확인한다
      if (this.republishFor === session) {
        if (!this.spendRecovery()) return this.stopSource(capture, SOURCE_UNSTABLE_MESSAGE)
        await this.reconnect({ immediate: true })
        continue
      }
      const sender = this.videoSender()
      if (sender && sender.track !== track) {
        // 이 연결로 영상이 아직 한 프레임도 안 나갔다(끝난 트랙으로 연결됨) → 영상 없는 스트림이다. 새로 맺는다
        if (!(await videoFramesSent(session.pc))) {
          if (session === this.session) this.republishFor = session
          continue
        }
        if (session !== this.session || !valid()) continue
        try {
          await sender.replaceTrack(track)
        } catch {
          // 트랙을 붙이지 못했다 → 새 연결로 다시 송출한다
          if (session === this.session) this.republishFor = session
        }
        continue
      }
      return
    }
  }

  /** 1분 안의 복구 횟수가 예산 안이면 기록하고 true */
  private spendRecovery() {
    const now = Date.now()
    this.recoveries = this.recoveries.filter((t) => now - t < 60_000)
    if (this.recoveries.length >= RECOVERY_BUDGET) return false
    this.recoveries.push(now)
    return true
  }

  /** 영상 소스를 잃었다: 영상이 멈춘 채 마이크만 나가지 않도록 송출과 장치를 모두 멈춘다 */
  private stopSource(ended: Capture, error: string | null = null) {
    const wasOnAir = this.isOnAir()
    this.nextGen()
    // 서버는 끊김으로 보고 유예 시간을 시작한다 → 그 안에 다시 선택하면 같은 방송이 이어진다
    this.closeSession()
    ended.stop()
    this.capture = null
    void this.releaseWakeLock()
    this.set({ phase: wasOnAir ? 'sourceEnded' : 'idle', stream: null, ...(error ? { error, errorCode: null } : {}) })
    if (wasOnAir) {
      this.sourceEndedDeadline = Date.now() + SOURCE_ENDED_TIMEOUT_MS
      this.armSourceEndedTimer()
    }
  }

  /** sourceEnded 자동 종료 타이머. 시한이 지났으면 바로 종료한다 */
  private armSourceEndedTimer() {
    clearTimeout(this.sourceEndedTimer)
    const deadline = this.sourceEndedDeadline
    if (deadline === null) return
    const gen = this.gen
    this.sourceEndedTimer = setTimeout(
      () => {
        if (this.stale(gen)) return
        // 다시 고르는 중이면 결과를 기다린다: 취소하면 selectSource가 이 함수를 다시 불러 바로 종료한다
        if (this.state.phase === 'sourceEnded') void this.end()
      },
      Math.max(0, deadline - Date.now()),
    )
  }

  // ---- 송출 ----

  async start() {
    if (!this.capture || this.isOnAir()) return
    const gen = this.nextGen()
    this.set({ phase: 'connecting', error: null, errorCode: null, reconnectAttempt: 0 })
    try {
      if (await this.connect(gen)) this.wentLive()
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
    const capture = this.capture
    if (this.stale(gen) || !capture) return false
    const session = await publish(whipPath, capture.stream, {
      token,
      maxVideoBitrate: MAX_BITRATE[this.state.source ?? 'camera'],
    })
    if (this.stale(gen) || !this.capture) {
      void session.close()
      return false
    }
    this.session = session
    session.pc.addEventListener('connectionstatechange', () => this.onConnectionState(session))
    // 연결하는 사이 소스를 바꿨다(공유 창에서 새로 고름): 끈 이전 캡처를 보내지 않도록 지금 캡처로 바꾼다
    if (this.capture !== capture) {
      try {
        await this.replaceTracks(session, this.capture.stream)
      } catch {
        this.republishFor = session
      }
    }
    return true
  }

  /** (재)연결이 끝나 LIVE가 됐다 */
  private wentLive() {
    this.set({ phase: 'live', reconnectAttempt: 0, error: null, errorCode: null })
    this.channel?.postMessage({ broadcastId: this.broadcastId, tabId: this.tabId })
    void this.acquireWakeLock()
    // 연결하는 사이 카메라가 끊겼을 수 있다
    this.checkVideo()
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
    // 소스를 고르는 중(requesting)에도 연결이 있으면 송출 중이므로 똑같이 복구한다
    if (!this.session) return
    await this.reconnect({ immediate: false })
  }

  /**
   * 지금 연결을 닫고 새 토큰으로 다시 송출한다.
   * immediate: 카메라 복구처럼 이쪽 사정으로 다시 맺는 경우. 바로 시도하고, 서버가 아직 LIVE로 보는 것을
   * 다른 기기의 송출로 오해하지 않는다. 실패하면 일반 재연결과 같이 재시도한다.
   */
  private async reconnect({ immediate }: { immediate: boolean }) {
    const gen = this.nextGen()
    this.closeSession()
    for (let attempt = 1; attempt <= MAX_RECONNECT; attempt++) {
      this.set({ phase: 'reconnecting', reconnectAttempt: attempt })
      if (!(immediate && attempt === 1)) await sleep(attempt === 1 ? STATUS_CHECK_DELAY_MS : 2000 * attempt)
      if (this.stale(gen)) return
      try {
        const b = await getBroadcast(this.broadcastId)
        if (this.stale(gen)) return
        if (b.status === 'ENDED') return this.handleServerEnded()
        // 서버는 송출이 붙어 있다고 본다 = 다른 탭·기기가 송출을 대체했다
        if (!immediate && b.status === 'LIVE' && !b.disconnectedAt && attempt === 1) return this.toTakenOver()
        if (!(await this.connect(gen))) return
        this.wentLive()
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

/** 미리보기에 붙일 새 스트림 (트랙 구성이 바뀌면 새 객체여야 화면이 다시 그린다) */
const previewStream = (capture: Capture) => new MediaStream(capture.stream.getTracks())

/** 살아 있는 영상 트랙 (없으면 null) */
const liveVideo = (capture: Capture) => capture.stream.getVideoTracks().find((t) => t.readyState === 'live') ?? null

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
