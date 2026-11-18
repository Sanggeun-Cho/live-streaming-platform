import { useEffect } from 'react'

const SITE = 'galle LIVE'
// index.html의 <title>과 같게 둔다
const DEFAULT_TITLE = `${SITE} — 실시간 라이브 방송`

/**
 * 브라우저 탭 제목을 "제목 | galle LIVE"로 바꾼다. title이 비어 있으면(불러오는 중 등) 기본 제목을 쓴다.
 * 화면을 떠나면 기본 제목으로 돌려서, 이 훅을 쓰지 않는 화면에 이전 화면의 제목이 남지 않게 한다.
 */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} | ${SITE}` : DEFAULT_TITLE
    return () => {
      document.title = DEFAULT_TITLE
    }
  }, [title])
}
