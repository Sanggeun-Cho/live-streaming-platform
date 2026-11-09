import { type FormEvent, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/context'
import { TestAccountLogin } from '../components/TestAccountLogin'
import { errorMessage } from '../lib/api'

// 로그인 후 돌아갈 수 없는 경로. 로그인 상태로 이 화면들에 오면 다시 next로 보내므로 자기 자신을 가리키면 멈추거나 반복된다
const AUTH_PATHS = new Set(['/login', '/signup'])

// 외부 주소로의 오픈 리다이렉트를 막기 위해 같은 출처의 경로만 허용한다.
// '//evil.com', '/\evil.com' 같은 변형은 브라우저가 외부 주소로 해석하므로 URL로 풀어서 출처를 비교한다.
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/')) return '/'
  try {
    const url = new URL(next, window.location.origin)
    if (url.origin !== window.location.origin) return '/'
    if (AUTH_PATHS.has(url.pathname.replace(/\/+$/, '') || '/')) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { status, login, signup } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 로그인 성공 시 이동도 여기 한 곳에서 처리한다 (status가 바뀌면 다시 렌더링되며 이동)
  if (status === 'authenticated') return <Navigate to={next} replace />

  const isSignup = mode === 'signup'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (isSignup) await signup({ email, password, nickname })
      else await login({ email, password })
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  const otherLink = `${isSignup ? '/login' : '/signup'}${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`

  return (
    <section className="auth-card">
      <h1>{isSignup ? '회원가입' : '로그인'}</h1>
      {!isSignup && <TestAccountLogin />}
      <form onSubmit={onSubmit} className="form" noValidate>
        <label>
          이메일
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        {isSignup && (
          <label>
            닉네임
            <input
              autoComplete="nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              minLength={2}
              maxLength={20}
              required
            />
            <small className="muted">2~20자</small>
          </label>
        )}
        <label>
          비밀번호
          <input
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={isSignup ? 8 : undefined}
            required
          />
          {isSignup && <small className="muted">8자 이상</small>}
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          {submitting ? '처리 중…' : isSignup ? '가입하기' : '로그인'}
        </button>
      </form>
      <p className="muted">
        {isSignup ? '이미 계정이 있나요? ' : '계정이 없나요? '}
        <Link to={otherLink}>{isSignup ? '로그인' : '회원가입'}</Link>
      </p>
    </section>
  )
}
