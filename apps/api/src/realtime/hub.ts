// 방송별 실시간 이벤트 허브 (SSE). 상태 변경(#6), 댓글(#10), 후원(#11)이 같은 통로를 쓴다.
// 단일 인스턴스라 메모리 안의 구독 목록으로 충분하다.

export type Send = (event: string, data: unknown) => void

export type EventHub = {
  /** 구독을 등록하고 해제 함수를 돌려준다. viewer=false(방송자 본인)는 시청자 수에서 뺀다 */
  subscribe(broadcastId: number, send: Send, opts?: { viewer?: boolean }): () => void
  publish(broadcastId: number, event: string, data: unknown): void
  /** 지금 이 방송을 보고 있는 연결 수 (시청자 수로 표시) */
  count(broadcastId: number): number
  /** 서버 종료 시 모든 연결을 닫는다 */
  closeAll(): void
}

export function createEventHub({ viewerDebounceMs = 1000 } = {}): EventHub {
  // 구독 → 시청자로 셀지 여부
  const subscribers = new Map<number, Map<Send, boolean>>()
  const viewerCount = (broadcastId: number) => {
    let n = 0
    for (const isViewer of subscribers.get(broadcastId)?.values() ?? []) if (isViewer) n++
    return n
  }
  const closers = new Set<() => void>()
  // 입장·퇴장이 몰려도 시청자 수 이벤트는 방송당 debounce 간격에 한 번만 보낸다
  const viewerTimers = new Map<number, NodeJS.Timeout>()

  function publish(broadcastId: number, event: string, data: unknown) {
    const set = subscribers.get(broadcastId)
    if (!set) return
    for (const send of set.keys()) {
      try {
        send(event, data)
      } catch {
        // 끊긴 연결은 close 이벤트에서 정리된다
      }
    }
  }

  function scheduleViewerCount(broadcastId: number) {
    if (viewerTimers.has(broadcastId)) return
    const timer = setTimeout(() => {
      viewerTimers.delete(broadcastId)
      publish(broadcastId, 'viewers', { count: viewerCount(broadcastId) })
    }, viewerDebounceMs)
    timer.unref()
    viewerTimers.set(broadcastId, timer)
  }

  return {
    subscribe(broadcastId, send, { viewer = true } = {}) {
      let set = subscribers.get(broadcastId)
      if (!set) {
        set = new Map()
        subscribers.set(broadcastId, set)
      }
      set.set(send, viewer)
      scheduleViewerCount(broadcastId)
      const unsubscribe = () => {
        closers.delete(unsubscribe)
        const current = subscribers.get(broadcastId)
        if (!current?.delete(send)) return
        if (current.size === 0) subscribers.delete(broadcastId)
        scheduleViewerCount(broadcastId)
      }
      closers.add(unsubscribe)
      return unsubscribe
    },

    publish,

    count: viewerCount,

    closeAll() {
      for (const timer of viewerTimers.values()) clearTimeout(timer)
      viewerTimers.clear()
      for (const close of [...closers]) close()
    },
  }
}
