import { useEffect, useRef, useState } from 'react'
import type { Broadcast, StatusPayload } from '../lib/broadcasts'
import type { DonationEvent } from '../lib/donations'
import type { Recording } from '../lib/recordings'

/** 서버가 보내는 SSE 이벤트 이름과 데이터 (api/src/routes/broadcasts.ts의 events 라우트와 짝) */
export type BroadcastEventMap = {
  status: StatusPayload
  viewers: { count: number }
  updated: Pick<Broadcast, 'title' | 'description'>
  deleted: Record<string, never>
  /** 후원 적립 (#11). 새 합계를 함께 보낸다 */
  donation: DonationEvent
  /** 녹화 세그먼트가 새로 등록됨 (#12) */
  recording: Recording
}

export type BroadcastEventHandlers = { [K in keyof BroadcastEventMap]?: (data: BroadcastEventMap[K]) => void }

const EVENT_NAMES: Array<keyof BroadcastEventMap> = ['status', 'viewers', 'updated', 'deleted', 'donation', 'recording']

/**
 * 방송 실시간 이벤트(SSE)를 구독한다. 끊기면 EventSource가 자동으로 다시 연결하고,
 * 서버는 연결 직후 현재 상태(status)를 다시 보내므로 놓친 변경이 맞춰진다.
 * handlers는 매 렌더마다 새로 만들어도 된다 (연결은 id가 바뀔 때만 다시 맺는다).
 */
export function useBroadcastEvents(id: number | null, handlers: BroadcastEventHandlers) {
  const handlersRef = useRef(handlers)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    if (id === null) return
    const source = new EventSource(`/api/broadcasts/${id}/events`)
    const listeners = EVENT_NAMES.map((name) => {
      const listener = (e: MessageEvent<string>) => {
        const handler = handlersRef.current[name] as ((data: unknown) => void) | undefined
        handler?.(JSON.parse(e.data))
      }
      source.addEventListener(name, listener)
      return [name, listener] as const
    })
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    return () => {
      for (const [name, listener] of listeners) source.removeEventListener(name, listener)
      source.close()
      setConnected(false)
    }
  }, [id])

  return { connected }
}
