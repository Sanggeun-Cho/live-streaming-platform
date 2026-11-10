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

/**
 * 다시보기에서 지금 보는 구간의 위치. 녹화 id로 찾는다: SSE로 앞쪽 구간이 늦게 끼어들어도 보던 구간이 바뀌지 않는다.
 * 목록에서 사라졌으면(삭제 등) 첫 구간으로 돌아간다.
 */
export function segmentPosition(recordings: readonly Recording[], selectedId: number): number {
  return Math.max(
    0,
    recordings.findIndex((r) => r.id === selectedId),
  )
}

/** 지금 구간이 끝났을 때 이어서 재생할 다음 구간 (마지막이면 null) */
export function nextSegment(recordings: readonly Recording[], selectedId: number): Recording | null {
  return recordings[segmentPosition(recordings, selectedId) + 1] ?? null
}
