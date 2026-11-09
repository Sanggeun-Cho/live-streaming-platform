import { api } from './api'

export type BroadcastStatus = 'READY' | 'LIVE' | 'ENDED'

export type Broadcast = {
  id: number
  title: string
  description: string
  status: BroadcastStatus
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
  channel: { id: number; name: string }
  streamer: { id: number; nickname: string }
}

export type BroadcastPage = { items: Broadcast[]; nextCursor: number | null }

export type ListParams = { status?: BroadcastStatus; channelId?: number; cursor?: number; limit?: number }

export const STATUS_LABEL: Record<BroadcastStatus, string> = {
  READY: '방송 준비',
  LIVE: 'LIVE',
  ENDED: '방송 종료',
}

export function listBroadcasts(params: ListParams = {}, signal?: AbortSignal) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v))
  const query = qs.size > 0 ? `?${qs}` : ''
  return api<BroadcastPage>(`/broadcasts${query}`, { signal })
}

export const getBroadcast = (id: number, signal?: AbortSignal) =>
  api<{ broadcast: Broadcast }>(`/broadcasts/${id}`, { signal }).then((r) => r.broadcast)

export const createBroadcast = (body: { title: string; description: string }) =>
  api<{ broadcast: Broadcast }>('/broadcasts', { method: 'POST', body }).then((r) => r.broadcast)

export const updateBroadcast = (id: number, body: { title?: string; description?: string }) =>
  api<{ broadcast: Broadcast }>(`/broadcasts/${id}`, { method: 'PATCH', body }).then((r) => r.broadcast)

export const deleteBroadcast = (id: number) => api<void>(`/broadcasts/${id}`, { method: 'DELETE' })
