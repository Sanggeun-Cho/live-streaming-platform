import { createContext, useContext } from 'react'

export type User = {
  id: number
  email: string
  nickname: string
  channelId: number
}

export type AuthState = {
  /** loading: 첫 /me 확인 중. 이 동안은 로그인 여부를 판단하지 않는다 */
  status: 'loading' | 'authenticated' | 'anonymous'
  user: User | null
  login: (input: { email: string; password: string }) => Promise<User>
  signup: (input: { email: string; password: string; nickname: string }) => Promise<User>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth는 AuthProvider 안에서만 사용할 수 있습니다')
  return ctx
}
