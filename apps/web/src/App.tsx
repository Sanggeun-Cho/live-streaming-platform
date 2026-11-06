import { useEffect, useState } from 'react'

type Health = { status: string; db: string; time: string }

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Health>
      })
      .then(setHealth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <main className="container">
      <h1>Live Streaming Platform</h1>
      <p>골격 동작 확인용 화면입니다.</p>
      <section>
        <h2>API 상태</h2>
        {error && <p className="error">연결 실패: {error}</p>}
        {!error && !health && <p>확인 중…</p>}
        {health && (
          <ul>
            <li>status: {health.status}</li>
            <li>db: {health.db}</li>
            <li>server time: {health.time}</li>
          </ul>
        )}
      </section>
    </main>
  )
}
