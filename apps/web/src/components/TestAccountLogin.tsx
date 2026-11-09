import { useEffect, useState } from 'react'
import { useAuth } from '../auth/context'
import { api, errorMessage } from '../lib/api'

type TestAccount = { role: string; email: string; password: string }

/**
 * 심사·시연용 "테스트 계정으로 바로 로그인". 서버가 SEED_TEST_ACCOUNTS로 켜 둔 경우에만 보인다.
 * 로그인에 성공하면 AuthForm이 원래 가려던 화면(next)으로 보낸다.
 */
export function TestAccountLogin() {
  const { login } = useAuth()
  const [accounts, setAccounts] = useState<TestAccount[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api<{ accounts: TestAccount[] }>('/auth/test-accounts', { signal: controller.signal })
      .then((r) => setAccounts(r.accounts))
      .catch(() => undefined) // 없어도 일반 로그인은 된다
    return () => controller.abort()
  }, [])

  if (accounts.length === 0) return null

  async function loginAs(account: TestAccount) {
    setError(null)
    setPending(account.email)
    try {
      await login({ email: account.email, password: account.password })
    } catch (e) {
      setError(errorMessage(e))
      setPending(null)
    }
  }

  return (
    <div className="test-login">
      <p className="dim">테스트 계정으로 바로 로그인</p>
      <div className="test-login-buttons">
        {accounts.map((a) => (
          <button key={a.email} type="button" onClick={() => void loginAs(a)} disabled={pending !== null}>
            {pending === a.email ? '로그인 중…' : a.role}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
