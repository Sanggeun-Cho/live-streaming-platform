import { createContext, useContext } from 'react'

export type User = {
  id: number
  email: string
  nickname: string
  channelId: number
}

export type AuthState = {
  /**
   * loading: /me 확인 중. 이 동안은 로그인 여부를 판단하지 않는다
   * error: 서버에 연결하지 못해 로그인 여부를 모른다 (세션이 유효할 수 있으므로 비로그인으로 취급하지 않는다)
   */
  status: 'loading' | 'authenticated' | 'anonymous' | 'error'
  user: User | null
  login: (input: { email: string; password: string }) => Promise<User>
  signup: (input: { email: string; password: string; nickname: string }) => Promise<User>
  logout: () => Promise<void>
  /** 세션 상태를 서버에 다시 확인한다 (status가 error일 때 '다시 시도') */
  refresh: () => void
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth는 AuthProvider 안에서만 사용할 수 있습니다')
  return ctx
}
