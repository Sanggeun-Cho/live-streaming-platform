import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/api'
import {
  type Donation,
  type DonationConfig,
  type DonationEvent,
  type DonationTotal,
  getDonationConfig,
  listDonations,
} from '../lib/donations'

type State = {
  broadcastId: number
  items: Donation[]
  total: DonationTotal
  nextCursor: number | null
  status: 'loading' | 'idle' | 'error'
  error: string | null
}

const initial = (broadcastId: number): State => ({
  broadcastId,
  items: [],
  total: { amount: 0, count: 0 },
  nextCursor: null,
  status: 'loading',
  error: null,
})

/**
 * 방송별 후원 내역과 합계. 처음에 한 페이지를 읽고, 실시간 이벤트(SSE donation)는 push로 앞에 붙인다.
 * SSE가 다시 연결되면 reload로 그 사이 놓친 후원을 맞춘다.
 */
export function useDonations(broadcastId: number | null) {
  const [state, setState] = useState<State | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const fetchPage = useCallback((id: number, cursor?: number) => {
    if (!cursor) controllerRef.current?.abort()
    const controller = new AbortController()
    if (!cursor) controllerRef.current = controller
    listDonations(id, cursor, controller.signal)
      .then((page) =>
        setState((prev) => {
          const base = prev?.broadcastId === id ? prev : initial(id)
          return {
            ...base,
            items: cursor ? [...base.items, ...page.items] : page.items,
            total: page.total,
            nextCursor: page.nextCursor,
            status: 'idle',
            error: null,
          }
        }),
      )
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setState((prev) => ({ ...(prev?.broadcastId === id ? prev : initial(id)), status: 'error', error: errorMessage(e) }))
      })
  }, [])

  useEffect(() => {
    if (broadcastId === null) return
    fetchPage(broadcastId)
    return () => controllerRef.current?.abort()
  }, [broadcastId, fetchPage])

  const push = useCallback(
    ({ donation, total }: DonationEvent) =>
      setState((prev) => {
        if (!prev || prev.broadcastId !== donation.broadcastId) return prev
        // 재연결 직후 다시 읽은 목록과 겹칠 수 있다
        if (prev.items.some((d) => d.id === donation.id)) return { ...prev, total }
        return { ...prev, items: [donation, ...prev.items], total }
      }),
    [],
  )

  const reload = useCallback(() => {
    if (broadcastId !== null) fetchPage(broadcastId)
  }, [broadcastId, fetchPage])

  const current = state && state.broadcastId === broadcastId ? state : null
  return {
    items: current?.items ?? [],
    total: current?.total ?? { amount: 0, count: 0 },
    status: current?.status ?? 'loading',
    error: current?.error ?? null,
    hasMore: current?.nextCursor != null,
    loadMore: () => {
      if (broadcastId !== null && current?.nextCursor) fetchPage(broadcastId, current.nextCursor)
    },
    reload,
    push,
  }
}

let configCache: Promise<DonationConfig> | null = null

/** 후원 설정(결제 키 유무, 금액 규칙). 앱 전체에서 한 번만 읽는다. 실패하면 다음 마운트에서 다시 읽는다 */
export function useDonationConfig() {
  const [result, setResult] = useState<{ config: DonationConfig | null; error: string | null }>({
    config: null,
    error: null,
  })
  useEffect(() => {
    let alive = true
    configCache ??= getDonationConfig().catch((e: unknown) => {
      configCache = null
      throw e
    })
    configCache
      .then((config) => alive && setResult({ config, error: null }))
      .catch((e: unknown) => alive && setResult({ config: null, error: errorMessage(e) }))
    return () => {
      alive = false
    }
  }, [])
  return result
}
