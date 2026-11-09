import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { AuthContext, type AuthState, type User } from './context'

type UserResponse = { user: User }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthState['status']>('loading')
  // 첫 /me 응답보다 로그인·가입·로그아웃이 먼저 끝나면, 늦게 온 /me 결과로 상태를 덮어쓰지 않게 막는다
  const meController = useRef<AbortController | null>(null)

  // 서버 세션 기준으로 로그인 상태를 확인한다 (새로고침 복원, '다시 시도')
  const checkSession = useCallback(() => {
    meController.current?.abort()
    const controller = new AbortController()
    meController.current = controller
    api<UserResponse>('/auth/me', { signal: controller.signal })
      .then(({ user }) => {
        if (controller.signal.aborted) return
        setUser(user)
        setStatus('authenticated')
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setUser(null)
        if (e instanceof ApiError && e.status === 401) {
          setStatus('anonymous')
          return
        }
        // 서버 다운·네트워크 오류: 세션은 유효할 수 있으므로 비로그인으로 단정하지 않는다.
        // 다시 로그인하면 불필요한 세션만 늘어나므로, 화면에서 '다시 시도'를 안내한다
        console.warn('세션 확인 실패', e)
        setStatus('error')
      })
    return controller
  }, [])

  useEffect(() => {
    const controller = checkSession()
    return () => controller.abort()
  }, [checkSession])

  // 오류 상태에서 네트워크가 돌아오면 자동으로 다시 확인한다
  useEffect(() => {
    if (status !== 'error') return
    const onOnline = () => {
      setStatus('loading')
      checkSession()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [status, checkSession])

  const applyUser = useCallback((next: User) => {
    meController.current?.abort()
    setUser(next)
    setStatus('authenticated')
    return next
  }, [])

  const login = useCallback<AuthState['login']>(
    async (input) => applyUser((await api<UserResponse>('/auth/login', { method: 'POST', body: input })).user),
    [applyUser],
  )

  const signup = useCallback<AuthState['signup']>(
    async (input) => applyUser((await api<UserResponse>('/auth/signup', { method: 'POST', body: input })).user),
    [applyUser],
  )

  const logout = useCallback(async () => {
    meController.current?.abort()
    try {
      await api<void>('/auth/logout', { method: 'POST' })
    } finally {
      // 서버 호출이 실패해도 화면에서는 로그아웃 상태로 전환한다
      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  const refresh = useCallback(() => {
    setStatus('loading')
    checkSession()
  }, [checkSession])

  const value = useMemo<AuthState>(
    () => ({ status, user, login, signup, logout, refresh }),
    [status, user, login, signup, logout, refresh],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
