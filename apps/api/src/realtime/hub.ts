// 방송별 실시간 이벤트 허브 (SSE). 상태 변경(#6), 댓글(#10), 후원(#11)이 같은 통로를 쓴다.
// 단일 인스턴스라 메모리 안의 구독 목록으로 충분하다. 연결 종료 책임도 여기 한 곳에 둔다.

export type Subscriber = {
  send: (event: string, data: unknown) => void
  /** 서버 쪽에서 연결을 닫는다 (방송 삭제, 서버 종료) */
  close: () => void
  /** false면 시청자 수에서 뺀다 (방송자 본인) */
  viewer: boolean
}

export type EventHub = {
  /** 구독을 등록하고 해제 함수를 돌려준다 */
  subscribe(broadcastId: number, subscriber: Subscriber): () => void
  publish(broadcastId: number, event: string, data: unknown): void
  /** 지금 이 방송을 보고 있는 시청자 수 */
  count(broadcastId: number): number
  /** 이 방송의 연결을 모두 닫는다 (방송 삭제) */
  closeBroadcast(broadcastId: number): void
  /** 모든 연결을 닫는다 (서버 종료) */
  closeAll(): void
}

export function createEventHub({ viewerDebounceMs = 1000 } = {}): EventHub {
  const subscribers = new Map<number, Set<Subscriber>>()
  // 입장·퇴장이 몰려도 시청자 수 이벤트는 방송당 debounce 간격에 한 번만 보낸다
  const viewerTimers = new Map<number, NodeJS.Timeout>()

  const count = (broadcastId: number) => {
    let n = 0
    for (const s of subscribers.get(broadcastId) ?? []) if (s.viewer) n++
    return n
  }

  function publish(broadcastId: number, event: string, data: unknown) {
    for (const s of subscribers.get(broadcastId) ?? []) {
      try {
        s.send(event, data)
      } catch {
        // 끊긴 연결은 close 이벤트에서 정리된다
      }
    }
  }

  function scheduleViewerCount(broadcastId: number) {
    if (viewerTimers.has(broadcastId)) return
    const timer = setTimeout(() => {
      viewerTimers.delete(broadcastId)
      publish(broadcastId, 'viewers', { count: count(broadcastId) })
    }, viewerDebounceMs)
    timer.unref()
    viewerTimers.set(broadcastId, timer)
  }

  function closeBroadcast(broadcastId: number) {
    for (const s of [...(subscribers.get(broadcastId) ?? [])]) s.close()
  }

  return {
    subscribe(broadcastId, subscriber) {
      let set = subscribers.get(broadcastId)
      if (!set) {
        set = new Set()
        subscribers.set(broadcastId, set)
      }
      set.add(subscriber)
      scheduleViewerCount(broadcastId)
      return () => {
        const current = subscribers.get(broadcastId)
        if (!current?.delete(subscriber)) return
        if (current.size === 0) subscribers.delete(broadcastId)
        scheduleViewerCount(broadcastId)
      }
    },
    publish,
    count,
    closeBroadcast,
    closeAll() {
      for (const timer of viewerTimers.values()) clearTimeout(timer)
      viewerTimers.clear()
      for (const id of [...subscribers.keys()]) closeBroadcast(id)
    },
  }
}
