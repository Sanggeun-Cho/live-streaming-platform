/**
 * 지금 열려 있는 방송 화면이 SSE로 받은 시청자 수·상태를 다른 컴포넌트(사이드바)에 알린다.
 * 사이드바가 같은 방송을 따로 구독하면 시청자 수가 두 번 세어지므로, 이미 열린 연결의 값을 나눠 쓴다.
 */
export type LiveSignal = {
  broadcastId: number
  viewers?: number
  /** false면 방송이 끝났거나 삭제됨 */
  live?: boolean
}

const listeners = new Set<(signal: LiveSignal) => void>()

export function emitLiveSignal(signal: LiveSignal) {
  for (const listener of listeners) listener(signal)
}

export function onLiveSignal(listener: (signal: LiveSignal) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
