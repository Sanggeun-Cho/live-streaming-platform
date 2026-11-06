// 연결 품질 요약. 송출·시청 화면의 디버그 표시와 스파이크 측정에 쓴다.

export type RtcSummary = {
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  fps?: number
  /** 직전 호출 이후 영상 비트레이트(kbps) */
  videoKbps?: number
  framesDecoded?: number
  /** 시청 측 지터 버퍼 평균 지연(ms) */
  jitterBufferMs?: number
  rttMs?: number
  /** 실제 사용 중인 후보 경로. 예) "udp host→host" */
  route?: string
}

type Prev = { bytes: number; at: number }
const prevByPc = new WeakMap<RTCPeerConnection, Prev>()

export async function summarize(pc: RTCPeerConnection): Promise<RtcSummary> {
  const report = await pc.getStats()
  const byId = new Map<string, Record<string, unknown>>()
  report.forEach((s: Record<string, unknown>) => byId.set(s.id as string, s))

  const out: RtcSummary = {}
  let videoBytes: number | undefined
  let at: number | undefined

  for (const s of byId.values()) {
    const kind = s.kind as string | undefined
    const codec = s.codecId ? (byId.get(s.codecId as string)?.mimeType as string | undefined) : undefined
    if ((s.type === 'outbound-rtp' || s.type === 'inbound-rtp') && kind === 'video') {
      out.videoCodec = codec
      out.width = s.frameWidth as number | undefined
      out.height = s.frameHeight as number | undefined
      out.fps = s.framesPerSecond as number | undefined
      videoBytes = (s.bytesSent ?? s.bytesReceived) as number | undefined
      at = s.timestamp as number
      if (s.type === 'inbound-rtp') {
        out.framesDecoded = s.framesDecoded as number | undefined
        const emitted = s.jitterBufferEmittedCount as number | undefined
        if (emitted) out.jitterBufferMs = Math.round(((s.jitterBufferDelay as number) / emitted) * 1000)
      }
    }
    if ((s.type === 'outbound-rtp' || s.type === 'inbound-rtp') && kind === 'audio') {
      out.audioCodec = codec
    }
    if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
      if (typeof s.currentRoundTripTime === 'number') out.rttMs = Math.round(s.currentRoundTripTime * 1000)
      const local = byId.get(s.localCandidateId as string)
      const remote = byId.get(s.remoteCandidateId as string)
      if (local && remote) out.route = `${local.protocol} ${local.candidateType}→${remote.candidateType}`
    }
  }

  if (videoBytes !== undefined && at !== undefined) {
    const prev = prevByPc.get(pc)
    if (prev && at > prev.at) out.videoKbps = Math.round(((videoBytes - prev.bytes) * 8) / (at - prev.at))
    prevByPc.set(pc, { bytes: videoBytes, at })
  }
  return out
}
