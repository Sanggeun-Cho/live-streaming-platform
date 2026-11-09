import { useEffect, useState } from 'react'
import { ApiError, errorMessage } from '../lib/api'
import { type Broadcast, getBroadcast } from '../lib/broadcasts'

/** 방송 상세를 읽는다. 404 등은 status로 구분할 수 있게 돌려준다 */
export function useBroadcast(id: number) {
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getBroadcast(id, controller.signal)
      .then(setBroadcast)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setError({ status: e instanceof ApiError ? e.status : 0, message: errorMessage(e) })
      })
    return () => controller.abort()
  }, [id])

  return { broadcast, error }
}
