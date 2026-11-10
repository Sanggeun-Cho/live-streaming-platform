// Publisher 상태 전이 단위 테스트.
// 브라우저 API(캡처, RTCPeerConnection, BroadcastChannel, Wake Lock)와 서버(fetch)를 가짜로 바꾸고
// 가짜 타이머로 재연결 대기·끊김 유예·소스 중단 자동 종료(45초)를 앞당겨 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture } from './media'
import type { WebRtcSession } from './whip'
import type * as Whip from './whip'

vi.mock('./media', () => ({ captureCamera: vi.fn(), captureScreen: vi.fn() }))
vi.mock('./whip', async (importOriginal) => ({
  ...(await importOriginal<typeof Whip>()),
  publish: vi.fn(),
  setMaxBitrate: vi.fn(async () => undefined),
}))

const { captureCamera, captureScreen } = await import('./media')
const { publish } = await import('./whip')
const { CAMERA_RECOVER_ATTEMPTS, MAX_RECONNECT, Publisher, RECOVERY_BUDGET, SOURCE_ENDED_TIMEOUT_MS } = await import('./publisher')

// ---- 가짜 미디어 ----

let trackSeq = 0
class FakeTrack {
  readonly id = `t${++trackSeq}`
  readyState: 'live' | 'ended' = 'live'
  readonly kind: 'audio' | 'video'
  constructor(kind: 'audio' | 'video') {
    this.kind = kind
  }
  stop() {
    this.readyState = 'ended'
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks() {
    return [...this.tracks]
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t)
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t)
  }
}

type FakeCapture = Capture & {
  /** OS·브라우저가 영상 트랙을 끝냈다 (ended 이벤트) */
  endVideo: () => void
  videoTrack: () => FakeTrack
  stop: ReturnType<typeof vi.fn>
  restartVideo?: ReturnType<typeof vi.fn>
}

function fakeCapture(kind: 'camera' | 'screen'): FakeCapture {
  const stream = new FakeMediaStream([new FakeTrack('video'), new FakeTrack('audio')])
  let onEnded: (() => void) | null = null
  const capture = {
    stream: stream as unknown as MediaStream,
    hasDisplayAudio: kind === 'screen',
    hasMic: true,
    setDisplayVolume: vi.fn(),
    setMicVolume: vi.fn(),
    onEnded: (cb: () => void) => {
      onEnded = cb
    },
    stop: vi.fn(() => stream.getTracks().forEach((t) => t.stop())),
    endVideo: () => {
      capture.videoTrack().stop()
      onEnded?.()
    },
    videoTrack: () => stream.getVideoTracks()[0]!,
  } as FakeCapture
  if (kind === 'camera') {
    capture.restartVideo = vi.fn(async () => {
      const next = new FakeTrack('video')
      const old = capture.videoTrack()
      stream.removeTrack(old)
      stream.addTrack(next)
      return next as unknown as MediaStreamTrack
    })
  }
  return capture
}

// ---- 가짜 연결 ----

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'connected'
  framesEncoded = 30
  readonly senders: { track: FakeTrack | null; replaceTrack: ReturnType<typeof vi.fn> }[]
  private listeners: (() => void)[] = []
  constructor(stream: FakeMediaStream) {
    this.senders = stream.getTracks().map((track) => {
      const sender = {
        track: track as FakeTrack | null,
        replaceTrack: vi.fn(async (t: FakeTrack | null) => {
          sender.track = t
        }),
      }
      return sender
    })
    // 끝난 영상 트랙으로 연결하면 영상 프레임이 한 번도 나가지 않는다
    const video = this.senders.find((x) => x.track?.kind === 'video')?.track
    this.framesEncoded = video?.readyState === 'live' ? 30 : 0
  }
  getSenders() {
    return this.senders
  }
  addEventListener(_type: 'connectionstatechange', cb: () => void) {
    this.listeners.push(cb)
  }
  async getStats() {
    return new Map([['v', { type: 'outbound-rtp', kind: 'video', framesEncoded: this.framesEncoded, bytesSent: this.framesEncoded * 1000 }]])
  }
  /** 연결 상태를 바꾸고 connectionstatechange를 보낸다 */
  setState(s: RTCPeerConnectionState) {
    this.connectionState = s
    this.listeners.forEach((cb) => cb())
  }
}

type FakeSession = { pc: FakePeerConnection; close: ReturnType<typeof vi.fn> }
let sessions: FakeSession[] = []
const lastSession = () => sessions.at(-1)!

// 다른 탭과 송출 상태를 나누는 BroadcastChannel (같은 이름의 다른 인스턴스에 바로 전달)
class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>()
  onmessage: ((e: MessageEvent) => void) | null = null
  readonly name: string
  constructor(name: string) {
    this.name = name
    FakeBroadcastChannel.open.add(this)
  }
  postMessage(data: unknown) {
    for (const c of FakeBroadcastChannel.open) {
      if (c !== this && c.name === this.name) c.onmessage?.({ data } as MessageEvent)
    }
  }
  close() {
    FakeBroadcastChannel.open.delete(this)
  }
}

// ---- 가짜 서버 (fetch) ----

type ServerBroadcast = { status: 'READY' | 'LIVE' | 'ENDED'; disconnectedAt: string | null }
let server: ServerBroadcast
let tokenCalls = 0
let endCalls = 0
let failStatus = false

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function fakeFetch(input: string, init?: RequestInit) {
  const method = init?.method ?? 'GET'
  if (method === 'POST' && /\/publish-token$/.test(input)) {
    tokenCalls++
    if (server.status === 'ENDED') return json(409, { code: 'BROADCAST_ENDED', message: '종료된 방송' })
    return json(200, { token: `tok${tokenCalls}`, expiresAt: '', whipPath: '/live/1/whip' })
  }
  if (method === 'POST' && /\/end$/.test(input)) {
    endCalls++
    server.status = 'ENDED'
    return json(200, { status: { ...server, startedAt: null, endedAt: null } })
  }
  if (method === 'GET' && /\/broadcasts\/1$/.test(input)) {
    if (failStatus) throw new TypeError('network down')
    return json(200, { broadcast: { id: 1, ...server } })
  }
  return json(404, { code: 'NOT_FOUND', message: input })
}

const wakeLockRequest = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  trackSeq = 0
  sessions = []
  server = { status: 'READY', disconnectedAt: null }
  tokenCalls = 0
  endCalls = 0
  failStatus = false
  FakeBroadcastChannel.open.clear()
  vi.stubGlobal('MediaStream', FakeMediaStream)
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
  wakeLockRequest.mockReset()
  wakeLockRequest.mockImplementation(async () => ({ release: vi.fn(async () => undefined), addEventListener: vi.fn() }))
  vi.stubGlobal('navigator', { wakeLock: { request: wakeLockRequest } })
  vi.mocked(captureCamera).mockReset()
  vi.mocked(captureScreen).mockReset()
  vi.mocked(captureCamera).mockImplementation(async () => fakeCapture('camera'))
  vi.mocked(captureScreen).mockImplementation(async () => fakeCapture('screen'))
  vi.mocked(publish).mockReset()
  vi.mocked(publish).mockImplementation(async (_url, stream) => makeSession(stream))
})

function makeSession(stream: MediaStream) {
  const pc = new FakePeerConnection(stream as unknown as FakeMediaStream)
  const session: FakeSession = { pc, close: vi.fn(async () => undefined) }
  sessions.push(session)
  return session as unknown as WebRtcSession
}

/** 다음 publish를 붙잡아 둔다: 호출 시점의 스트림으로 연결을 만들되, release/fail을 부를 때까지 끝나지 않는다 */
function holdNextPublish() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  let calledWith: MediaStream | null = null
  vi.mocked(publish).mockImplementationOnce((_url, stream) => {
    calledWith = stream
    // 실제 publish처럼 호출 시점의 트랙으로 송신기를 만든다 (그 뒤 스트림이 바뀌어도 송신 트랙은 그대로)
    const tracks = new FakeMediaStream((stream as unknown as FakeMediaStream).getTracks()) as unknown as MediaStream
    return new Promise((res, rej) => {
      resolve = () => res(makeSession(tracks))
      reject = rej
    })
  })
  return {
    called: () => calledWith !== null,
    release: () => resolve(),
    fail: (e: unknown) => reject(e),
  }
}

/** 연결의 영상 송신 트랙 */
const sentVideo = (s: FakeSession) => s.pc.senders.find((x) => x.track?.kind === 'video')?.track ?? null

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 대기 중인 비동기 작업(마이크로태스크)을 모두 흘려보낸다. 타이머는 움직이지 않는다 */
async function settle() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

/** 방송 화면에 붙은 Publisher (attach까지) */
function newPublisher() {
  const p = new Publisher(1)
  const detach = p.attach()
  return { p, detach }
}

async function goLive(p: InstanceType<typeof Publisher>, source: 'camera' | 'screen' = 'camera') {
  await p.selectSource(source)
  expect(p.snapshot.phase).toBe('preview')
  await p.start()
  expect(p.snapshot.phase).toBe('live')
  server.status = 'LIVE'
}

const captureOf = async (source: 'camera' | 'screen', index = 0) =>
  (await vi.mocked(source === 'camera' ? captureCamera : captureScreen).mock.results[index]!.value) as FakeCapture

describe('송출 시작·종료', () => {
  it('소스 선택 → 미리보기 → 방송 시작 → LIVE: 새 토큰으로 WHIP 송출하고 Wake Lock을 잡는다', async () => {
    const { p } = newPublisher()
    const phases: string[] = []
    p.subscribe((s) => phases.at(-1) !== s.phase && phases.push(s.phase))
    await goLive(p)
    expect(phases).toEqual(['requesting', 'preview', 'connecting', 'live'])
    expect(vi.mocked(publish)).toHaveBeenCalledWith('/live/1/whip', expect.anything(), { token: 'tok1', maxVideoBitrate: 1_500_000 })
    expect(wakeLockRequest).toHaveBeenCalledWith('screen')
  })

  it('종료하면 서버에 종료를 요청하고 연결·장치를 모두 끈다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    await p.end()
    expect(endCalls).toBe(1)
    expect(p.snapshot.phase).toBe('ended')
    expect(lastSession().close).toHaveBeenCalled()
    expect((await captureOf('camera')).stop).toHaveBeenCalled()
  })

  it('토큰을 받는 사이 종료되면 늦게 만들어진 연결은 버린다 (세대 무효화)', async () => {
    const { p } = newPublisher()
    await p.selectSource('camera')
    const starting = p.start()
    p.handleServerEnded()
    await starting
    await settle()
    expect(p.snapshot.phase).toBe('ended')
    // 토큰 발급이 끝나기 전에 세대가 바뀌었으므로 송출 연결을 만들지 않는다
    expect(tokenCalls).toBe(1)
    expect(sessions).toHaveLength(0)
  })

  it('화면을 떠나면(release) 송출을 멈추고 처음 상태로 돌아간다', async () => {
    const { p, detach } = newPublisher()
    await goLive(p)
    detach()
    expect(p.snapshot.phase).toBe('idle')
    expect(lastSession().close).toHaveBeenCalled()
  })
})

describe('연결 끊김과 재연결', () => {
  it('연결이 failed가 되면 서버 상태를 확인한 뒤 새 토큰으로 다시 송출한다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const first = lastSession()
    server.disconnectedAt = new Date().toISOString()
    first.pc.setState('failed')
    await settle()
    expect(p.snapshot.phase).toBe('reconnecting')
    expect(p.snapshot.reconnectAttempt).toBe(1)
    expect(first.close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.snapshot.phase).toBe('live')
    expect(p.snapshot.reconnectAttempt).toBe(0)
    expect(sessions).toHaveLength(2)
    expect(tokenCalls).toBe(2)
  })

  it('잠깐의 disconnected는 유예 시간(4초) 안에 회복되면 재연결하지 않는다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    lastSession().pc.setState('disconnected')
    await vi.advanceTimersByTimeAsync(3000)
    lastSession().pc.setState('connected')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(p.snapshot.phase).toBe('live')
    expect(sessions).toHaveLength(1)
  })

  it('disconnected가 4초 넘게 이어지면 끊김으로 처리한다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    lastSession().pc.setState('disconnected')
    await vi.advanceTimersByTimeAsync(4000)
    expect(p.snapshot.phase).toBe('reconnecting')
  })

  it('끊긴 뒤 서버가 송출이 붙어 있다고 하면(다른 기기가 대체) takenOver로 멈춘다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    lastSession().pc.setState('failed')
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.snapshot.phase).toBe('takenOver')
    expect(sessions).toHaveLength(1)
  })

  it('끊긴 사이 방송이 종료됐으면 ended로 바꾸고 장치를 끈다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    server.status = 'ENDED'
    lastSession().pc.setState('failed')
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.snapshot.phase).toBe('ended')
    expect((await captureOf('camera')).stop).toHaveBeenCalled()
  })

  it(`${MAX_RECONNECT}번 모두 실패하면 미리보기로 돌아가 안내한다`, async () => {
    const { p } = newPublisher()
    await goLive(p)
    failStatus = true
    lastSession().pc.setState('failed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(p.snapshot.phase).toBe('preview')
    expect(p.snapshot.error).toMatch(/네트워크 연결이 불안정/)
    expect(sessions).toHaveLength(1)
  })
})

describe('다른 탭과 송출 경쟁 (BroadcastChannel)', () => {
  it('다른 탭이 송출을 시작하면 이 탭은 takenOver가 되고, 다시 가져오면 상대가 takenOver가 된다', async () => {
    const a = newPublisher().p
    const b = newPublisher().p
    await goLive(a)
    const aSession = lastSession()
    await goLive(b)
    expect(a.snapshot.phase).toBe('takenOver')
    expect(aSession.close).toHaveBeenCalled()
    expect(b.snapshot.phase).toBe('live')

    await a.takeBack()
    expect(a.snapshot.phase).toBe('live')
    expect(b.snapshot.phase).toBe('takenOver')
  })

  it('다른 방송의 송출 알림은 무시한다', async () => {
    const a = newPublisher().p
    const other = new Publisher(2)
    other.attach()
    await goLive(a)
    await other.selectSource('camera')
    await other.start()
    expect(a.snapshot.phase).toBe('live')
  })
})

describe('영상 소스 중단', () => {
  it('화면 공유를 중지하면 송출과 마이크를 멈추고, 45초 안에 다시 고르지 않으면 방송을 종료한다', async () => {
    const { p } = newPublisher()
    await goLive(p, 'screen')
    const capture = await captureOf('screen')
    capture.endVideo()
    expect(p.snapshot.phase).toBe('sourceEnded')
    expect(lastSession().close).toHaveBeenCalled()
    expect(capture.stop).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SOURCE_ENDED_TIMEOUT_MS - 1)
    expect(endCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(endCalls).toBe(1)
    expect(p.snapshot.phase).toBe('ended')
  })

  it('유예 시간 안에 다시 고르면 같은 방송을 이어서 송출하고 자동 종료하지 않는다', async () => {
    const { p } = newPublisher()
    await goLive(p, 'screen')
    ;(await captureOf('screen')).endVideo()
    await vi.advanceTimersByTimeAsync(10_000)
    await p.selectSource('screen')
    expect(p.snapshot.phase).toBe('live')
    expect(sessions).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(SOURCE_ENDED_TIMEOUT_MS)
    expect(endCalls).toBe(0)
    expect(p.snapshot.phase).toBe('live')
  })

  it('미리보기 중 화면 공유가 끝나면 처음 상태(idle)로 돌아가고 방송은 건드리지 않는다', async () => {
    const { p } = newPublisher()
    await p.selectSource('screen')
    ;(await captureOf('screen')).endVideo()
    expect(p.snapshot.phase).toBe('idle')
    await vi.advanceTimersByTimeAsync(SOURCE_ENDED_TIMEOUT_MS)
    expect(endCalls).toBe(0)
  })

  it('카메라 트랙이 예기치 않게 끝나면 카메라를 다시 열어 같은 연결로 이어 간다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    const session = lastSession()
    capture.endVideo()
    await settle()
    expect(capture.restartVideo).toHaveBeenCalledTimes(1)
    expect(p.snapshot.phase).toBe('live')
    expect(sessions).toHaveLength(1)
    const videoSender = session.pc.senders.find((s) => s.track?.kind === 'video')!
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(capture.videoTrack())
    expect(p.snapshot.stream?.getVideoTracks()[0]).toBe(capture.videoTrack())
    expect(capture.stop).not.toHaveBeenCalled()
  })

  it('송출 직후 영상이 한 프레임도 나가기 전에 카메라가 끊기면 새 연결로 다시 송출한다 (오디오만 잡힌 스트림 방지)', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    const first = lastSession()
    first.pc.framesEncoded = 0
    capture.endVideo()
    await settle()
    expect(first.close).toHaveBeenCalled()
    expect(sessions).toHaveLength(2)
    expect(p.snapshot.phase).toBe('live')
    // 새 연결은 다시 연 카메라 트랙으로 보낸다
    expect(lastSession().pc.senders.some((s) => s.track === capture.videoTrack())).toBe(true)
  })

  it(`카메라를 ${CAMERA_RECOVER_ATTEMPTS}번 다시 열지 못하면 sourceEnded로 멈춘다`, async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    capture.restartVideo!.mockRejectedValue(new DOMException('Requested device not found', 'NotFoundError'))
    capture.endVideo()
    await vi.advanceTimersByTimeAsync(10_000)
    // 아직 기다리는 중: 송출은 유지한다
    expect(p.snapshot.phase).toBe('live')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(capture.restartVideo).toHaveBeenCalledTimes(CAMERA_RECOVER_ATTEMPTS)
    expect(p.snapshot.phase).toBe('sourceEnded')
    expect(capture.stop).toHaveBeenCalled()
  })

  it('카메라 서비스가 몇 초 동안 장치를 못 찾다가 돌아오면 이어서 송출한다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    const reopen = capture.restartVideo!.getMockImplementation()!
    capture.restartVideo!
      .mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'))
      .mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'))
      .mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'))
      .mockImplementation(reopen)
    capture.endVideo()
    await vi.advanceTimersByTimeAsync(7_000)
    expect(capture.restartVideo).toHaveBeenCalledTimes(4)
    expect(p.snapshot.phase).toBe('live')
    expect(capture.videoTrack().readyState).toBe('live')
  })

  it('카메라를 다시 여는 중에 연결이 끊겨도 복구를 이어 가고, 재연결은 다시 연 카메라로 송출한다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    const reopen = capture.restartVideo!.getMockImplementation()!
    capture.restartVideo!.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError')).mockImplementation(reopen)
    capture.endVideo()
    await settle()
    server.disconnectedAt = new Date().toISOString()
    lastSession().pc.setState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture.restartVideo).toHaveBeenCalledTimes(2)
    expect(p.snapshot.phase).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.snapshot.phase).toBe('live')
    const video = lastSession().pc.senders.find((s) => s.track?.kind === 'video')!.track!
    expect(video).toBe(capture.videoTrack())
    expect(video.readyState).toBe('live')
  })

  it('카메라 전환에 실패해 영상 트랙이 없어지면 원래 방향 카메라를 다시 열어 본다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    const stream = capture.stream as unknown as FakeMediaStream
    capture.switchFacing = vi.fn(async () => {
      // 이전 트랙을 끈 뒤 새 카메라도 원래 카메라도 열지 못했다
      const old = capture.videoTrack()
      stream.removeTrack(old)
      old.stop()
      throw new DOMException('Requested device not found', 'NotFoundError')
    })
    await p.switchCamera()
    expect(p.snapshot.error).toMatch(/카메라나 마이크를 찾을 수 없습니다/)
    await settle()
    expect(capture.restartVideo).toHaveBeenCalledTimes(1)
    expect(capture.videoTrack().readyState).toBe('live')
    expect(p.snapshot.phase).toBe('live')
  })

  it('카메라를 다시 여는 사이 방송을 끝내면 새 트랙을 바로 끈다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    let resolve!: (t: MediaStreamTrack) => void
    capture.restartVideo!.mockImplementation(() => new Promise((r) => (resolve = r)))
    capture.endVideo()
    await p.end()
    const late = new FakeTrack('video')
    resolve(late as unknown as MediaStreamTrack)
    await settle()
    expect(late.readyState).toBe('ended')
    expect(p.snapshot.phase).toBe('ended')
  })
})

describe('소스 선택 중(requesting) 연결 끊김', () => {
  it('공유 창이 열린 사이 연결이 끊겨도 재연결하고, 고른 새 소스로 이어서 송출한다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const first = lastSession()
    let pick!: (c: Capture) => void
    vi.mocked(captureScreen).mockImplementationOnce(() => new Promise((r) => (pick = r)))
    const selecting = p.selectSource('screen')
    expect(p.snapshot.phase).toBe('requesting')

    server.disconnectedAt = new Date().toISOString()
    first.pc.setState('failed')
    await settle()
    expect(p.snapshot.phase).toBe('reconnecting')
    // 고르는 중에는 다시 누를 수 없다 (phase가 바뀌어도 공유 창은 하나)
    await p.selectSource('camera')
    expect(vi.mocked(captureCamera)).toHaveBeenCalledTimes(1)

    const screen = fakeCapture('screen')
    pick(screen)
    await selecting
    expect(p.snapshot.phase).toBe('reconnecting')
    expect(p.snapshot.source).toBe('screen')
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.snapshot.phase).toBe('live')
    expect(lastSession().pc.senders.some((s) => s.track === screen.videoTrack())).toBe(true)
  })

  it('끊긴 뒤 공유 창을 취소해도 재연결 상태를 되돌리지 않는다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    let cancel!: (e: unknown) => void
    vi.mocked(captureScreen).mockImplementationOnce(() => new Promise((_, rej) => (cancel = rej)))
    const selecting = p.selectSource('screen')
    server.disconnectedAt = new Date().toISOString()
    lastSession().pc.setState('failed')
    await settle()
    cancel(new DOMException('cancel', 'NotAllowedError'))
    await selecting
    expect(p.snapshot.phase).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.snapshot.phase).toBe('live')
  })

  it('끊김 없이 고르면 연결을 유지한 채 트랙만 바꾼다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    await p.selectSource('screen')
    expect(p.snapshot.phase).toBe('live')
    expect(sessions).toHaveLength(1)
    const screen = await captureOf('screen')
    expect(lastSession().pc.senders.some((s) => s.track === screen.videoTrack())).toBe(true)
    expect((await captureOf('camera')).stop).toHaveBeenCalled()
  })

  it('고르는 사이 다른 탭이 송출하면 takenOver가 되고, 고른 소스로 송출을 빼앗지 않는다', async () => {
    const a = newPublisher().p
    const b = newPublisher().p
    await goLive(a)
    let pick!: (c: Capture) => void
    vi.mocked(captureScreen).mockImplementationOnce(() => new Promise((r) => (pick = r)))
    const selecting = a.selectSource('screen')
    await b.selectSource('camera')
    await b.start()
    expect(a.snapshot.phase).toBe('takenOver')
    pick(fakeCapture('screen'))
    await selecting
    expect(a.snapshot.phase).toBe('takenOver')
    expect(b.snapshot.phase).toBe('live')
  })
})

describe('카메라 복구 루프 (리뷰 반영)', () => {
  const videoSenderOf = (s: FakeSession) => s.pc.senders.find((x) => x.track?.kind === 'video')!

  it('트랙 교체(replaceTrack) 중에 다시 끊겨도 놓치지 않고 한 번 더 복구한다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    const session = lastSession()
    const sender = videoSenderOf(session)
    let finishReplace!: () => void
    sender.replaceTrack.mockImplementationOnce(
      (t: FakeTrack | null) =>
        new Promise<void>((r) => {
          finishReplace = () => {
            sender.track = t
            r()
          }
        }),
    )
    capture.endVideo()
    await settle()
    expect(capture.restartVideo).toHaveBeenCalledTimes(1)
    capture.endVideo() // 교체하는 사이 다시 끊김
    finishReplace()
    await settle()
    expect(capture.restartVideo).toHaveBeenCalledTimes(2)
    expect(sentVideo(session)).toBe(capture.videoTrack())
    expect(capture.videoTrack().readyState).toBe('live')
    expect(sessions).toHaveLength(1)
    expect(p.snapshot.phase).toBe('live')
  })

  it('다시 송출하는 사이 또 끊겨도 영상이 살아 있는 연결로 끝난다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    lastSession().pc.framesEncoded = 0
    const held = holdNextPublish()
    capture.endVideo()
    await settle()
    expect(held.called()).toBe(true)
    capture.endVideo() // 새 연결을 맺는 사이 다시 끊김
    held.release()
    await settle()
    const video = sentVideo(lastSession())!
    expect(video).toBe(capture.videoTrack())
    expect(video.readyState).toBe('live')
    expect(p.snapshot.phase).toBe('live')
    expect(sessions.slice(0, -1).every((s) => s.close.mock.calls.length > 0)).toBe(true)
  })

  it('방송 시작(연결 중)에 카메라가 끊기면 연결된 뒤 확인해 다시 연 카메라로 다시 송출한다', async () => {
    const { p } = newPublisher()
    await p.selectSource('camera')
    const capture = await captureOf('camera')
    const held = holdNextPublish()
    const starting = p.start()
    await settle()
    expect(held.called()).toBe(true)
    capture.endVideo()
    await settle()
    held.release()
    await starting
    await settle()
    expect(sessions).toHaveLength(2)
    expect(sentVideo(lastSession())).toBe(capture.videoTrack())
    expect(capture.videoTrack().readyState).toBe('live')
    expect(p.snapshot.phase).toBe('live')
  })

  it('공유 창이 열린 사이 재송출하고 창에서 새 소스를 고르면, 끈 카메라가 아니라 새 소스로 LIVE가 된다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const camera = await captureOf('camera')
    lastSession().pc.framesEncoded = 0
    let pick!: (c: Capture) => void
    vi.mocked(captureScreen).mockImplementationOnce(() => new Promise((r) => (pick = r)))
    const selecting = p.selectSource('screen')
    const held = holdNextPublish()
    camera.endVideo()
    await settle()
    expect(held.called()).toBe(true)
    expect(p.snapshot.phase).toBe('reconnecting')

    const screen = fakeCapture('screen')
    pick(screen)
    await selecting
    expect(camera.stop).toHaveBeenCalled()
    held.release()
    await settle()
    expect(p.snapshot.phase).toBe('live')
    expect(p.snapshot.source).toBe('screen')
    expect(sentVideo(lastSession())).toBe(screen.videoTrack())
    expect(lastSession().pc.senders.every((s) => s.track?.readyState === 'live')).toBe(true)
  })

  it('재송출이 실패하면 LIVE로 표시하지 않고 재연결 절차로 넘어간다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    lastSession().pc.framesEncoded = 0
    vi.mocked(publish).mockRejectedValueOnce(new Error('media server down'))
    const phases: string[] = []
    p.subscribe((s) => phases.at(-1) !== s.phase && phases.push(s.phase))
    capture.endVideo()
    await settle()
    expect(p.snapshot.phase).toBe('reconnecting')
    // 재송출을 시작한 뒤로는 실제로 연결될 때까지 LIVE가 아니다
    expect(phases.slice(phases.indexOf('reconnecting'))).not.toContain('live')
    await vi.advanceTimersByTimeAsync(4000)
    expect(p.snapshot.phase).toBe('live')
    expect(sentVideo(lastSession())).toBe(capture.videoTrack())
  })

  it(`1분에 ${RECOVERY_BUDGET}번 넘게 복구해야 하면 카메라가 불안정한 것으로 보고 송출을 멈춘다`, async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    for (let i = 0; i < RECOVERY_BUDGET; i++) {
      capture.endVideo()
      await settle()
      expect(p.snapshot.phase).toBe('live')
    }
    capture.endVideo()
    await settle()
    expect(capture.restartVideo).toHaveBeenCalledTimes(RECOVERY_BUDGET + 1)
    expect(p.snapshot.phase).toBe('sourceEnded')
    expect(p.snapshot.error).toMatch(/계속 끊겨/)
    expect(capture.stop).toHaveBeenCalled()
  })

  it('카메라 권한을 거둬 가면(NotAllowedError) 다시 열지 않고 바로 sourceEnded', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    capture.restartVideo!.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    capture.endVideo()
    await settle()
    expect(capture.restartVideo).toHaveBeenCalledTimes(1)
    expect(p.snapshot.phase).toBe('sourceEnded')
    expect(p.snapshot.error).toMatch(/권한이 거부/)
  })

  it('다시 연 트랙을 연결에 붙이지 못하면(replaceTrack 실패) 새 연결로 다시 송출한다', async () => {
    const { p } = newPublisher()
    await goLive(p)
    const capture = await captureOf('camera')
    videoSenderOf(lastSession()).replaceTrack.mockRejectedValueOnce(new Error('InvalidStateError'))
    capture.endVideo()
    await settle()
    expect(sessions).toHaveLength(2)
    expect(sentVideo(lastSession())).toBe(capture.videoTrack())
    expect(p.snapshot.phase).toBe('live')
  })

  it('화면 공유 중지는 카메라 복구 로직을 타지 않는다 (restartVideo 없음 → 바로 sourceEnded)', async () => {
    const { p } = newPublisher()
    await goLive(p, 'screen')
    const screen = await captureOf('screen')
    expect(screen.restartVideo).toBeUndefined()
    screen.endVideo()
    await settle()
    expect(p.snapshot.phase).toBe('sourceEnded')
    expect(vi.mocked(captureCamera)).not.toHaveBeenCalled()
    expect(sessions).toHaveLength(1)
  })
})

describe('소스 중단 뒤 자동 종료 시한', () => {
  it('다시 고르는 창이 열린 채 시한이 지나고 취소하면 바로 방송을 종료한다', async () => {
    const { p } = newPublisher()
    await goLive(p, 'screen')
    ;(await captureOf('screen')).endVideo()
    await vi.advanceTimersByTimeAsync(40_000)
    let cancel!: (e: unknown) => void
    vi.mocked(captureScreen).mockImplementationOnce(() => new Promise((_, rej) => (cancel = rej)))
    const selecting = p.selectSource('screen')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(endCalls).toBe(0) // 고르는 중에는 기다린다
    cancel(new DOMException('cancel', 'NotAllowedError'))
    await selecting
    await settle()
    expect(endCalls).toBe(1)
    expect(p.snapshot.phase).toBe('ended')
  })

  it('시한 전에 취소하면 남은 시간만큼 기다렸다가 종료한다', async () => {
    const { p } = newPublisher()
    await goLive(p, 'screen')
    ;(await captureOf('screen')).endVideo()
    let cancel!: (e: unknown) => void
    vi.mocked(captureScreen).mockImplementationOnce(() => new Promise((_, rej) => (cancel = rej)))
    const selecting = p.selectSource('screen')
    await vi.advanceTimersByTimeAsync(20_000)
    cancel(new DOMException('cancel', 'NotAllowedError'))
    await selecting
    expect(p.snapshot.phase).toBe('sourceEnded')
    await vi.advanceTimersByTimeAsync(SOURCE_ENDED_TIMEOUT_MS - 20_000 - 1)
    expect(endCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(endCalls).toBe(1)
    expect(p.snapshot.phase).toBe('ended')
  })
})
