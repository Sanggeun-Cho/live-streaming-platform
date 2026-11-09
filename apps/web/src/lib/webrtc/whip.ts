// WHIP(송출) / WHEP(시청) 클라이언트.
// 규격: RFC 9725 (WHIP), draft-ietf-wish-whep. MediaMTX 구현 기준으로 필요한 부분만 구현한다.
// - 신호: SDP offer를 POST(application/sdp) → 201 + answer, Location 헤더가 세션 리소스
// - 종료: 세션 리소스에 DELETE
// - ICE trickle(PATCH)은 쓰지 않는다. 서버가 공인 주소를 광고하고, 브라우저 후보는
//   서버가 들어오는 연결로 알아내므로(peer-reflexive) 짧게 모은 뒤 한 번에 보낸다.

export class WebRtcHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WebRtcHttpError'
    this.status = status
  }
}

export class CodecUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecUnsupportedError'
  }
}

export type WebRtcSession = {
  pc: RTCPeerConnection
  close: () => Promise<void>
}

export type PublishOptions = {
  /** MediaMTX 인가로 전달할 토큰 (Authorization: Bearer). #6에서 publish 토큰을 넣는다 */
  token?: string
  /** 영상 최대 비트레이트(bps). 미지정 시 브라우저 기본값 */
  maxVideoBitrate?: number
}

const ICE_GATHER_TIMEOUT_MS = 1000

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS)
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

async function negotiate(url: string, pc: RTCPeerConnection, token?: string): Promise<string | null> {
  await pc.setLocalDescription(await pc.createOffer())
  await waitIceGathering(pc)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: pc.localDescription!.sdp,
  })
  if (res.status !== 201) {
    throw new WebRtcHttpError(res.status, (await res.text()) || `HTTP ${res.status}`)
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })

  const location = res.headers.get('Location')
  return location ? new URL(location, new URL(url, window.location.href)).toString() : null
}

function sessionOf(pc: RTCPeerConnection, resourceUrl: string | null, token?: string): WebRtcSession {
  let closed = false
  return {
    pc,
    close: async () => {
      if (closed) return
      closed = true
      pc.close()
      if (!resourceUrl) return
      // 탭을 닫는 중에도 전송되도록 keepalive. 실패해도 서버가 연결 끊김으로 정리한다.
      await fetch(resourceUrl, {
        method: 'DELETE',
        keepalive: true,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => undefined)
    },
  }
}

// 녹화(fMP4)와 모든 시청 기기(iOS Safari 포함)의 호환을 위해 영상은 H.264만 협상한다.
// 재전송·오류정정용 보조 코덱(rtx, red, ulpfec)은 남긴다.
const AUX_VIDEO_CODECS = new Set(['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03'])

function h264Rank(codec: RTCRtpCodec): number {
  const fmtp = codec.sdpFmtpLine ?? ''
  // packetization-mode=1이 아니면 MediaMTX/재생 호환성이 떨어진다
  if (!fmtp.includes('packetization-mode=1')) return 3
  // Constrained Baseline(42e0xx/42e01f)이 디코더 호환성이 가장 넓다
  if (/profile-level-id=42e0/i.test(fmtp)) return 0
  if (/profile-level-id=42/i.test(fmtp)) return 1
  return 2
}

export function preferH264(transceiver: RTCRtpTransceiver): void {
  const candidates = [RTCRtpSender.getCapabilities?.('video'), RTCRtpReceiver.getCapabilities?.('video')]
  for (const caps of candidates) {
    if (!caps) continue
    const h264 = caps.codecs
      .filter((c) => c.mimeType.toLowerCase() === 'video/h264')
      .sort((a, b) => h264Rank(a) - h264Rank(b))
    if (h264.length === 0) continue
    const aux = caps.codecs.filter((c) => AUX_VIDEO_CODECS.has(c.mimeType.toLowerCase()))
    try {
      transceiver.setCodecPreferences([...h264, ...aux])
      return
    } catch {
      // 일부 브라우저는 송신/수신 capability 중 한쪽만 받는다. 다음 후보로 재시도
    }
  }
  throw new CodecUnsupportedError('이 브라우저는 H.264 송출을 지원하지 않습니다')
}

export async function publish(url: string, stream: MediaStream, options: PublishOptions = {}): Promise<WebRtcSession> {
  const pc = new RTCPeerConnection()
  try {
    for (const track of stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] })
      if (track.kind === 'video') preferH264(transceiver)
    }
    const resourceUrl = await negotiate(url, pc, options.token)

    const sdp = pc.remoteDescription?.sdp ?? ''
    if (stream.getVideoTracks().length > 0 && !/a=rtpmap:\d+ H264\//i.test(sdp)) {
      throw new CodecUnsupportedError('서버와 H.264 협상에 실패했습니다')
    }
    if (options.maxVideoBitrate) {
      await setMaxBitrate(pc, options.maxVideoBitrate)
    }
    return sessionOf(pc, resourceUrl, options.token)
  } catch (e) {
    pc.close()
    throw e
  }
}

export async function setMaxBitrate(pc: RTCPeerConnection, bps: number): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    params.encodings[0]!.maxBitrate = bps
    await sender.setParameters(params)
  }
}

export type ViewSession = WebRtcSession & { stream: MediaStream }

export async function view(url: string): Promise<ViewSession> {
  const pc = new RTCPeerConnection()
  const stream = new MediaStream()
  pc.addEventListener('track', (e) => stream.addTrack(e.track))
  try {
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    const resourceUrl = await negotiate(url, pc)
    return { ...sessionOf(pc, resourceUrl), stream }
  } catch (e) {
    pc.close()
    throw e
  }
}
