import { type FormEvent, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/context'
import { errorMessage } from '../lib/api'

// 외부 주소로의 오픈 리다이렉트를 막기 위해 같은 사이트 내부 경로만 허용한다
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { status, login, signup } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (status === 'authenticated' && !submitting) return <Navigate to={next} replace />

  const isSignup = mode === 'signup'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (isSignup) await signup({ email, password, nickname })
      else await login({ email, password })
      navigate(next, { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  const otherLink = `${isSignup ? '/login' : '/signup'}${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`

  return (
    <section className="auth-card">
      <h1>{isSignup ? '회원가입' : '로그인'}</h1>
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
