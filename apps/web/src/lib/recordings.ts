import { api } from './api'
import type { Broadcast } from './broadcasts'

/** 녹화 세그먼트 (api/src/recordings/service.ts의 RecordingView와 짝) */
export type Recording = {
  id: number
  /** 같은 출처 재생 주소 (/recordings/live/{id}/....mp4) */
  url: string
  startedAt: string
  durationMs: number
  sizeBytes: number | null
}

export type Replay = Broadcast & { recordingCount: number; totalDurationMs: number }

export type ReplayPage = { items: Replay[]; nextCursor: number | null }

export const listReplays = (params: { cursor?: number; limit?: number } = {}, signal?: AbortSignal) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v))
  return api<ReplayPage>(`/replays${qs.size > 0 ? `?${qs}` : ''}`, { signal })
}

export const listRecordings = (broadcastId: number, signal?: AbortSignal) =>
  api<{ recordings: Recording[] }>(`/broadcasts/${broadcastId}/recordings`, { signal }).then((r) => r.recordings)

/** 1:02:03 / 4:05 */
export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
