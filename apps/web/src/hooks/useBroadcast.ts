import { useCallback, useEffect, useState } from 'react'
import { ApiError, errorMessage } from '../lib/api'
import { type Broadcast, getBroadcast } from '../lib/broadcasts'

type LoadError = { status: number; message: string }
type Result = { id: number; broadcast: Broadcast | null; error: LoadError | null }

const isValidId = (id: number) => Number.isInteger(id) && id > 0
const NOT_FOUND: LoadError = { status: 404, message: '방송을 찾을 수 없습니다' }

/**
 * 방송 상세를 읽는다. 404 등은 status로 구분할 수 있게 돌려준다.
 * 결과를 요청한 id와 함께 저장해서, id가 바뀌면 이전 방송이나 이전 오류를 보여주지 않는다.
 */
export function useBroadcast(id: number) {
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    if (!isValidId(id)) return
    const controller = new AbortController()
    getBroadcast(id, controller.signal)
      .then((broadcast) => setResult({ id, broadcast, error: null }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setResult({ id, broadcast: null, error: { status: e instanceof ApiError ? e.status : 0, message: errorMessage(e) } })
      })
    return () => controller.abort()
  }, [id])

  /** 실시간 이벤트(SSE)로 받은 변경을 반영한다 */
  const patch = useCallback(
    (changes: Partial<Broadcast>) =>
      setResult((prev) =>
        prev?.id === id && prev.broadcast ? { ...prev, broadcast: { ...prev.broadcast, ...changes } } : prev,
      ),
    [id],
  )

  if (!isValidId(id)) return { broadcast: null, error: NOT_FOUND, patch }
  const current = result?.id === id ? result : null
  return { broadcast: current?.broadcast ?? null, error: current?.error ?? null, patch }
}
