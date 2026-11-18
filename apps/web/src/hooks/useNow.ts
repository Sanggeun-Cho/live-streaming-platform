import { useEffect, useState } from 'react'

/** 지금 시각. "3분 전" 같은 상대 시간이 화면에 그대로 멈춰 있지 않게 주기적으로 갱신한다 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
