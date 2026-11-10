import { useSyncExternalStore } from 'react'

/** CSS 미디어 쿼리 결과를 구독한다 (예: 넓은 화면에서만 보이는 컴포넌트가 좁은 화면에서 요청하지 않게) */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}
