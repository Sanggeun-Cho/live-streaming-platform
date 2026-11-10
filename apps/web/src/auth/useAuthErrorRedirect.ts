import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '../lib/api'
import { useAuth } from './context'

/**
 * 요청이 401(세션 만료 등)로 실패하면 로그인 화면으로 보내고, 로그인 후 지금 화면으로 돌아오게 한다.
 * 처리했으면 true를 돌려준다. 그 밖의 오류는 호출한 쪽에서 표시한다.
 */
export function useAuthErrorRedirect() {
  const navigate = useNavigate()
  const location = useLocation()
  const { refresh } = useAuth()
  return useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError) || e.status !== 401) return false
      // 헤더 등 화면의 로그인 상태도 서버 기준으로 다시 맞춘다
      refresh()
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`)
      return true
    },
    [navigate, location, refresh],
  )
}
