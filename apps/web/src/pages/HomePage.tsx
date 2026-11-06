import { useEffect, useState } from 'react'
import { useAuth } from '../auth/context'
import { api, errorMessage } from '../lib/api'

type Health = { status: string; db: string; time: string }

// 방송 목록(#5) 전까지는 로그인 상태와 API 상태만 보여준다
export function HomePage() {
  const { user } = useAuth()
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<Health>('/health')
      .then(setHealth)
      .catch((e: unknown) => setError(errorMessage(e)))
  }, [])

  return (
    <>
      <h1>Live Streaming Platform</h1>
      <p>{user ? `${user.nickname}님, 환영합니다.` : '로그인 없이도 방송을 시청할 수 있습니다.'}</p>
      <section>
        <h2>API 상태</h2>
        {error && <p className="error">연결 실패: {error}</p>}
        {!error && !health && <p className="muted">확인 중…</p>}
        {health && (
          <ul>
            <li>status: {health.status}</li>
            <li>db: {health.db}</li>
            <li>server time: {health.time}</li>
          </ul>
        )}
      </section>
    </>
  )
}
