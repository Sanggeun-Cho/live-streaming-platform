// 송출 컨트롤러: 캡처 → WHIP 송출 → 끊김 감지·자동 재연결 → 종료를 한 곳에서 관리한다.
// React와 분리해 상태 전이를 한눈에 볼 수 있게 했다. 화면(StudioPage)은 subscribe로 상태만 그린다.
//
//   idle ─capture()→ requesting ─→ preview ─start()→ connecting ─→ live
//                                    ▲                               │ 연결 끊김
//                                    │                               ▼
//                      (다른 곳에서 송출) takenOver ◀── reconnecting ─→ live (새 토큰으로 재송출)
//   화면 공유를 브라우저에서 중단 → sourceEnded (다시 공유 or 종료)
//   종료(이 화면·다른 탭·유예 만료) → ended

import { ApiError } from '../api'
import { endBroadcast, getBroadcast, issuePublishToken } from '../broadcasts'
import { publishErrorMessage } from './errors'
import { type Capture, captureCamera, captureScreen, type FacingMode } from './media'
import { publish, type WebRtcSession } from './whip'

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
  facing: FacingMode
  hasDisplayAudio: boolean
  hasMic: boolean
  micMuted: boolean
  reconnectAttempt: number
  error: string | null
}

// 화면 공유는 글자 선명도, 카메라는 움직임이 중요하다. 업로드가 느린 환경을 고려해 상한을 둔다
const MAX_BITRATE: Record<SourceKind, number> = { screen: 2_500_000, camera: 1_500_000 }
const MAX_RECONNECT = 5
// 연결이 'disconnected'로 이 시간 이상 머물면 끊긴 것으로 본다 (잠깐의 끊김은 브라우저가 스스로 복구한다)
const DISCONNECT_GRACE_MS = 4000
// 끊긴 뒤 서버 상태를 확인하기 전에 기다리는 시간. MediaMTX offline 훅이 반영될 시간을 준다
const STATUS_CHECK_DELAY_MS = 3000

export class Publisher {
  private state: PublisherState = {
    phase: 'idle',
    source: null,
    facing: 'user',
    hasDisplayAudio: false,
    hasMic: false,
    micMuted: false,
    reconnectAttempt: 0,
    error: null,
  }
  private listeners = new Set<(s: PublisherState) => void>()
  private capture: Capture | null = null
  private session: WebRtcSession | null = null
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined
  private wakeLock: WakeLockSentinel | null = null
  // 같은 브라우저의 다른 탭과 "누가 송출 중인지" 공유한다 (탭 두 개가 서로 송출을 빼앗는 것 방지)
  private channel: BroadcastChannel | null = typeof BroadcastChannel === 'function' ? new BroadcastChannel('publisher') : null
  private readonly tabId = Math.random().toString(36).slice(2)
  private disposed = false

  private readonly broadcastId: number

  constructor(broadcastId: number) {
    this.broadcastId = broadcastId
    this.channel?.addEventListener('message', (e: MessageEvent<{ broadcastId: number; tabId: string }>) => {
      if (e.data.broadcastId !== this.broadcastId || e.data.tabId === this.tabId) return
      if (this.isPublishing()) this.toTakenOver()
    })
  }

  get snapshot(): PublisherState {
    return this.state
  }

  get stream(): MediaStream | null {
    return this.capture?.stream ?? null
  }

  get peerConnection(): RTCPeerConnection | null {
    return this.session?.pc ?? null
  }

  subscribe(listener: (s: PublisherState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<PublisherState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }

  private isPublishing() {
    return this.state.phase === 'live' || this.state.phase === 'connecting' || this.state.phase === 'reconnecting'
  }

  // ---- 캡처 ----

  /** 반드시 클릭 핸들러에서 바로 호출한다 (화면 공유·오디오 처리는 사용자 동작이 필요하다) */
  async selectSource(source: SourceKind, facing: FacingMode = this.state.facing) {
    const before = this.state.phase
    this.set({ phase: 'requesting', error: null })
    let next: Capture
    try {
      next = source === 'screen' ? await captureScreen({ mic: true }) : await captureCamera(facing)
    } catch (e) {
      this.set({ phase: before === 'requesting' ? 'idle' : before, error: publishErrorMessage(e) })
      return
    }
    const previous = this.capture
    this.capture = next
    next.onEnded(() => this.onSourceEnded(next))
    this.set({ source, facing, hasDisplayAudio: next.hasDisplayAudio, hasMic: next.hasMic, micMuted: false })
    if (this.session) {
      // 송출 중(또는 화면 공유가 끊긴 상태)이면 연결을 유지한 채 트랙만 바꾼다. 시청자는 끊김 없이 새 화면을 본다
      await this.replaceTracks(next.stream)
      previous?.stop()
      this.set({ phase: 'live' })
    } else {
      previous?.stop()
      this.set({ phase: 'preview' })
    }
  }

  /** 모바일: 전면 ↔ 후면 카메라 */
  async switchCamera() {
    if (this.state.source !== 'camera') return
    await this.selectSource('camera', this.state.facing === 'user' ? 'environment' : 'user')
  }

  setMicMuted(muted: boolean) {
    this.capture?.setMicVolume(muted ? 0 : 1)
    this.set({ micMuted: muted })
  }

  setDisplayVolume(v: number) {
    this.capture?.setDisplayVolume(v)
  }

  setMicVolume(v: number) {
    this.capture?.setMicVolume(v)
    this.set({ micMuted: v === 0 })
  }

  private async replaceTracks(stream: MediaStream) {
    for (const sender of this.session?.pc.getSenders() ?? []) {
      const track = stream.getTracks().find((t) => t.kind === sender.track?.kind)
      if (track) await sender.replaceTrack(track)
    }
  }

  private onSourceEnded(ended: Capture) {
    if (ended !== this.capture || this.disposed) return
    // 화면 공유를 브라우저의 "공유 중지"로 끝냈다. 송출 연결은 유지한 채(시청자에게는 마지막 화면) 선택을 묻는다.
    // 아무것도 하지 않으면 서버가 유예 시간 뒤 방송을 종료한다
    this.set({ phase: 'sourceEnded' })
  }

  // ---- 송출 ----

  async start() {
    if (!this.capture || this.isPublishing()) return
    this.set({ phase: 'connecting', error: null, reconnectAttempt: 0 })
    try {
      await this.connect()
      this.set({ phase: 'live' })
      this.announce()
      void this.acquireWakeLock()
    } catch (e) {
      this.set({ phase: e instanceof ApiError && e.code === 'BROADCAST_ENDED' ? 'ended' : 'preview', error: publishErrorMessage(e) })
    }
  }

  /** 매번 새 토큰을 받아 WHIP로 연결한다. 같은 path의 이전 송출은 서버가 대체한다(overridePublisher) */
  private async connect() {
    const capture = this.capture!
    const { token, whipPath } = await issuePublishToken(this.broadcastId)
    const session = await publish(whipPath, capture.stream, { token, maxVideoBitrate: MAX_BITRATE[this.state.source!] })
    if (this.disposed) {
      void session.close()
      return
    }
    this.session = session
    session.pc.addEventListener('connectionstatechange', () => this.onConnectionState(session))
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
    if (!this.isPublishing() || this.disposed) return
    this.closeSession()
    for (let attempt = 1; attempt <= MAX_RECONNECT; attempt++) {
      this.set({ phase: 'reconnecting', reconnectAttempt: attempt })
      await sleep(attempt === 1 ? STATUS_CHECK_DELAY_MS : 2000 * attempt)
      if (this.disposed || this.state.phase !== 'reconnecting') return
      try {
        const b = await getBroadcast(this.broadcastId)
        if (b.status === 'ENDED') return this.toEnded()
        // 서버는 송출이 붙어 있다고 본다 = 다른 탭·기기가 송출을 대체했다
        if (b.status === 'LIVE' && !b.disconnectedAt && attempt === 1) return this.toTakenOver()
        await this.connect()
        this.set({ phase: 'live', reconnectAttempt: 0, error: null })
        this.announce()
        return
      } catch (e) {
        if (e instanceof ApiError && e.code === 'BROADCAST_ENDED') return this.toEnded()
        this.set({ error: publishErrorMessage(e) })
      }
    }
    this.set({ phase: 'preview', error: '네트워크 연결이 불안정해 송출을 다시 시작하지 못했습니다. 연결을 확인한 뒤 "방송 시작"을 눌러 주세요' })
  }

  /** 다른 탭·기기에서 송출 중일 때 이 화면에서 다시 가져온다 */
  async takeBack() {
    if (this.state.phase !== 'takenOver') return
    this.set({ phase: 'preview' })
    await this.start()
  }

  private toTakenOver() {
    this.closeSession()
    this.set({ phase: 'takenOver', reconnectAttempt: 0 })
  }

  /** 방송이 (어디서든) 종료됐다. 카메라·마이크·화면 공유를 끈다 */
  toEnded() {
    if (this.state.phase === 'ended') return
    this.closeSession()
    this.capture?.stop()
    this.capture = null
    void this.releaseWakeLock()
    this.set({ phase: 'ended', reconnectAttempt: 0 })
  }

  async end() {
    try {
      await endBroadcast(this.broadcastId)
      this.toEnded()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BROADCAST_ENDED') return this.toEnded()
      this.set({ error: publishErrorMessage(e) })
      throw e
    }
  }

  private announce() {
    this.channel?.postMessage({ broadcastId: this.broadcastId, tabId: this.tabId })
  }

  private closeSession() {
    clearTimeout(this.disconnectTimer)
    void this.session?.close()
    this.session = null
  }

  // 모바일에서 화면이 꺼지면 카메라 송출이 멈추므로 방송 중에는 화면 꺼짐을 막는다
  private async acquireWakeLock() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
    } catch {
      // 지원하지 않거나 거부되면 무시한다
    }
  }

  private async releaseWakeLock() {
    await this.wakeLock?.release().catch(() => undefined)
    this.wakeLock = null
  }

  /** 화면을 떠날 때. 탭을 닫는 경우(pagehide)에도 호출해 WHIP 세션을 바로 지운다 */
  dispose() {
    this.disposed = true
    this.closeSession()
    this.capture?.stop()
    this.capture = null
    void this.releaseWakeLock()
    this.channel?.close()
    this.listeners.clear()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
