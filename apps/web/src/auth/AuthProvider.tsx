import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { AuthContext, type AuthState, type User } from './context'

type UserResponse = { user: User }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthState['status']>('loading')

  // 새로고침해도 서버 세션 기준으로 로그인 상태를 복원한다
  useEffect(() => {
    const controller = new AbortController()
    api<UserResponse>('/auth/me', { signal: controller.signal })
      .then(({ user }) => {
        setUser(user)
        setStatus('authenticated')
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        // 401 외의 실패(서버 다운 등)도 비로그인으로 보여주고, 다음 요청에서 다시 확인된다
        if (!(e instanceof ApiError && e.status === 401)) console.warn('세션 확인 실패', e)
        setUser(null)
        setStatus('anonymous')
      })
    return () => controller.abort()
  }, [])

  const applyUser = useCallback((next: User) => {
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
    try {
      await api<void>('/auth/logout', { method: 'POST' })
    } finally {
      // 서버 호출이 실패해도 화면에서는 로그아웃 상태로 전환한다
      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({ status, user, login, signup, logout }),
    [status, user, login, signup, logout],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
