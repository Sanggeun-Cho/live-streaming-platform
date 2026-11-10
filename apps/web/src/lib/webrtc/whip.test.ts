// H.264 코덱 선택(h264Rank/preferH264)과 WHIP 송출 협상(publish) 단위 테스트
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodecUnsupportedError, h264Rank, preferH264, publish, WebRtcHttpError } from './whip'

const codec = (mimeType: string, sdpFmtpLine?: string) => ({ mimeType, clockRate: 90000, sdpFmtpLine }) as RTCRtpCodec

const CB = codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f')
const BASELINE = codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f')
const HIGH = codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f')
const MODE0 = codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f')
const VP8 = codec('video/VP8')
const RTX = codec('video/rtx', 'apt=96')
const RED = codec('video/red')

describe('h264Rank', () => {
  it('Constrained Baseline < Baseline < 기타 프로필 < packetization-mode=1이 아닌 것 순서로 고른다', () => {
    expect(h264Rank(CB)).toBe(0)
    expect(h264Rank(BASELINE)).toBe(1)
    expect(h264Rank(HIGH)).toBe(2)
    expect(h264Rank(MODE0)).toBe(3)
    expect(h264Rank(codec('video/H264'))).toBe(3)
  })
})

describe('preferH264', () => {
  const stubCaps = (sender: RTCRtpCodec[] | null, receiver: RTCRtpCodec[] | null) => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => (sender ? { codecs: sender, headerExtensions: [] } : null) })
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => (receiver ? { codecs: receiver, headerExtensions: [] } : null) })
  }
  afterEach(() => vi.unstubAllGlobals())

  it('H.264만 순위대로 남기고 VP8 등은 빼며, 재전송·오류정정 코덱은 뒤에 둔다', () => {
    stubCaps([VP8, MODE0, HIGH, RTX, CB, RED, BASELINE], null)
    const setCodecPreferences = vi.fn()
    preferH264({ setCodecPreferences } as unknown as RTCRtpTransceiver)
    expect(setCodecPreferences).toHaveBeenCalledWith([CB, BASELINE, HIGH, MODE0, RTX, RED])
  })

  it('송신 capability를 거부하면 수신 capability로 다시 시도한다', () => {
    stubCaps([HIGH], [CB])
    const setCodecPreferences = vi.fn((codecs: RTCRtpCodec[]) => {
      if (codecs[0] === HIGH) throw new DOMException('invalid', 'InvalidModificationError')
    })
    preferH264({ setCodecPreferences } as unknown as RTCRtpTransceiver)
    expect(setCodecPreferences).toHaveBeenLastCalledWith([CB])
  })

  it('H.264가 없으면 CodecUnsupportedError', () => {
    stubCaps([VP8, RTX], [VP8])
    expect(() => preferH264({ setCodecPreferences: vi.fn() } as unknown as RTCRtpTransceiver)).toThrow(CodecUnsupportedError)
  })
})

describe('publish (WHIP)', () => {
  class FakePc {
    static last: FakePc
    iceGatheringState = 'complete'
    localDescription: { sdp: string } | null = null
    remoteDescription: { sdp: string } | null = null
    closed = false
    transceivers: { kind: string; setCodecPreferences: ReturnType<typeof vi.fn> }[] = []
    constructor() {
      FakePc.last = this
    }
    addTransceiver(track: { kind: string }) {
      const t = { kind: track.kind, setCodecPreferences: vi.fn() }
      this.transceivers.push(t)
      return t
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 offer' }
    }
    async setLocalDescription(d: { sdp: string }) {
      this.localDescription = d
    }
    async setRemoteDescription(d: { sdp: string }) {
      this.remoteDescription = d
    }
    getSenders() {
      return []
    }
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.closed = true
    }
  }
  const stream = {
    getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
    getVideoTracks: () => [{ kind: 'video' }],
  } as unknown as MediaStream
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('RTCPeerConnection', FakePc)
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [CB], headerExtensions: [] }) })
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => null })
    vi.stubGlobal('window', { location: { href: 'https://example.test/broadcasts/1/studio' } })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('토큰을 Bearer로 실어 SDP offer를 POST하고, 종료 시 Location 리소스에 DELETE한다', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('v=0\r\na=rtpmap:96 H264/90000\r\n', { status: 201, headers: { Location: '/live/1/whip/abc' } }),
    )
    const session = await publish('/live/1/whip', stream, { token: 'tok' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/live/1/whip')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/sdp', Authorization: 'Bearer tok' })
    expect(init.body).toBe('v=0 offer')
    // 영상 트랜시버에만 H.264 선호를 건다
    expect(FakePc.last.transceivers.map((t) => t.setCodecPreferences.mock.calls.length)).toEqual([1, 0])

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    await session.close()
    expect(FakePc.last.closed).toBe(true)
    expect(fetchMock.mock.calls[1]![0]).toBe('https://example.test/live/1/whip/abc')
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'DELETE', keepalive: true })
  })

  it('서버 답에 H.264가 없으면 연결을 닫고 CodecUnsupportedError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('v=0\r\na=rtpmap:96 VP8/90000\r\n', { status: 201 }))
    await expect(publish('/live/1/whip', stream)).rejects.toThrow(CodecUnsupportedError)
    expect(FakePc.last.closed).toBe(true)
  })

  it('201이 아니면 상태 코드를 담은 WebRtcHttpError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    const err = await publish('/live/1/whip', stream).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WebRtcHttpError)
    expect((err as WebRtcHttpError).status).toBe(401)
    expect(FakePc.last.closed).toBe(true)
  })
})
