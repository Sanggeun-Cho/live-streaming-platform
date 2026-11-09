import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../lib/api'
import { listRecordings, type Recording } from '../lib/recordings'

// 방송이 끝난 직후에는 세그먼트 변환(오디오 AAC)·등록이 끝나지 않았을 수 있다.
// 이 시간 동안은 "준비 중"으로 안내하고 주기적으로 다시 조회한다 (SSE recording 이벤트를 놓쳤을 때 대비)
const PREPARE_WINDOW_MS = 10 * 60_000
const POLL_MS = 10_000

type State = { key: number; recordings: Recording[] | null; error: string | null }

const byStart = (a: Recording, b: Recording) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id

/**
 * 종료된 방송의 녹화 세그먼트 목록. enabled가 false면(방송 중 등) 읽지 않는다.
 * 종료 후 PREPARE_WINDOW_MS 동안은 주기적으로 다시 읽고, 그동안 녹화가 하나도 없으면 preparing=true.
 */
export function useRecordings(broadcastId: number, enabled: boolean, endedAt: string | null) {
  const [state, setState] = useState<State | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    listRecordings(broadcastId, controller.signal)
      .then((recordings) => setState({ key: broadcastId, recordings: recordings.sort(byStart), error: null }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setState((prev) => ({ key: broadcastId, recordings: prev?.key === broadcastId ? prev.recordings : null, error: errorMessage(e) }))
      })
    return () => controller.abort()
  }, [broadcastId, enabled, reloadKey])

  const current = state?.key === broadcastId ? state : null
  const recordings = enabled ? (current?.recordings ?? null) : null
  const endedMs = endedAt ? Date.parse(endedAt) : NaN
  // 종료 직후에는 녹화 개수와 상관없이 다시 읽는다: 앞 구간만 등록되고 마지막 구간이 변환 중일 수 있다
  const recent = enabled && recordings !== null && now - endedMs < PREPARE_WINDOW_MS
  const preparing = recent && recordings.length === 0

  useEffect(() => {
    if (!recent) return
    const timer = setInterval(() => {
      setNow(Date.now())
      setReloadKey((k) => k + 1)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [recent])

  /** SSE로 받은 새 세그먼트를 끼워 넣는다 (같은 id는 무시) */
  const add = useCallback(
    (recording: Recording) =>
      setState((prev) => {
        if (prev?.key !== broadcastId || !prev.recordings) return prev
        if (prev.recordings.some((r) => r.id === recording.id)) return prev
        return { ...prev, recordings: [...prev.recordings, recording].sort(byStart) }
      }),
    [broadcastId],
  )

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  return { recordings, error: current?.error ?? null, preparing, add, reload }
}
