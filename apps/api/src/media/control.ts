// MediaMTX Control API 클라이언트 (v3). Docker 내부 네트워크에서만 접근한다.
// https://mediamtx.org/docs/references/control-api
//
// 훅(runOnOnline/runOnOffline)은 순서가 뒤바뀌거나 유실될 수 있어서(#2 스파이크),
// 상태 머신은 중요한 전이 전에 이 API로 "지금 실제로 송출 중인지"를 다시 확인한다.

export type PathSource = { type: string; id: string }

export type MediaControl = {
  /** path에 송출(source)이 붙어 있으면 그 정보를, 없으면 null. path가 없어도 null */
  getSource(path: string): Promise<PathSource | null>
  /** 송출 중인 path 목록 (주기 대조용) */
  listReadyPaths(): Promise<Set<string>>
  /** 송출 세션을 강제로 끊는다. 이미 없으면 조용히 넘어간다 */
  kick(source: PathSource): Promise<void>
}

type PathItem = { name: string; ready: boolean; source: PathSource | null }

// source.type → kick 엔드포인트. 이 프로젝트는 WHIP(WebRTC) 송출만 받는다
const KICK_ENDPOINT: Record<string, string> = {
  webRTCSession: 'webrtcsessions',
  rtspSession: 'rtspsessions',
  rtspsSession: 'rtspssessions',
  rtmpConn: 'rtmpconns',
  rtmpsConn: 'rtmpsconns',
  srtConn: 'srtconns',
}

export function createMediaControl(baseUrl: string, { timeoutMs = 3000 } = {}): MediaControl {
  async function call(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  }

  return {
    async getSource(path) {
      const res = await call(`/v3/paths/get/${path}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`MediaMTX paths/get ${res.status}`)
      const item = (await res.json()) as PathItem
      return item.ready && item.source ? item.source : null
    },

    async listReadyPaths() {
      const ready = new Set<string>()
      // 방송 수가 적어 페이지 하나(최대 1000개)로 충분하다
      const res = await call('/v3/paths/list?itemsPerPage=1000')
      if (!res.ok) throw new Error(`MediaMTX paths/list ${res.status}`)
      const { items } = (await res.json()) as { items: PathItem[] }
      for (const item of items) if (item.ready) ready.add(item.name)
      return ready
    },

    async kick(source) {
      const endpoint = KICK_ENDPOINT[source.type]
      if (!endpoint) throw new Error(`kick을 지원하지 않는 송출 유형: ${source.type}`)
      const res = await call(`/v3/${endpoint}/kick/${source.id}`, { method: 'POST' })
      if (!res.ok && res.status !== 404) throw new Error(`MediaMTX kick ${res.status}`)
    },
  }
}
