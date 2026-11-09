import { useEffect, useRef, useState } from 'react'

export type BroadcastEventHandlers = Partial<Record<string, (data: unknown) => void>>

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
    const names = ['status', 'viewers', 'updated', 'deleted', 'comment', 'donation']
    const listeners = names.map((name) => {
      const listener = (e: MessageEvent<string>) => handlersRef.current[name]?.(JSON.parse(e.data))
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
