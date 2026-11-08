import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useAuth } from './context'

/** 로그인이 필요한 화면을 감싼다. 비로그인이면 로그인 화면으로 보내고, 로그인 후 원래 위치로 돌아온다. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, refresh } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <p className="muted">확인 중…</p>
  // 로그인 여부를 모르는 상태에서 로그인 화면으로 보내지 않는다 (세션이 살아 있을 수 있다)
  if (status === 'error') {
    return (
      <div role="alert">
        <p className="error">서버에 연결할 수 없어 로그인 상태를 확인하지 못했습니다.</p>
        <button type="button" onClick={refresh}>
          다시 시도
        </button>
      </div>
    )
  }
  if (status === 'anonymous') {
    const next = location.pathname + location.search
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  return children
}
