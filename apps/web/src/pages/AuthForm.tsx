import { CircleAlert } from 'lucide-react'
import { type FormEvent, useRef, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/context'
import { FormField } from '../components/FormField'
import { Spinner } from '../components/Spinner'
import { TestAccountLogin } from '../components/TestAccountLogin'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { ApiError, errorMessage } from '../lib/api'

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

/** 어디서 넘어왔는지(next)에 따라 로그인하면 무엇을 할 수 있는지 알려준다 */
function leadText(next: string, isSignup: boolean): string {
  const verb = isSignup ? '가입하면' : '로그인하면'
  if (next.startsWith('/broadcasts/new') || next.endsWith('/studio')) return `${verb} 바로 방송을 시작할 수 있습니다.`
  if (next.startsWith('/broadcasts/')) return `${verb} 보던 방송으로 돌아가 바로 채팅과 후원에 참여할 수 있습니다.`
  return isSignup ? '이메일로 가입하고 채팅·후원·방송을 시작하세요.' : '다시 오신 것을 환영합니다.'
}

type Field = 'email' | 'nickname' | 'password'
type FieldErrors = Partial<Record<Field, string>>

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(input: { email: string; password: string; nickname: string }, isSignup: boolean): FieldErrors {
  const errors: FieldErrors = {}
  if (!input.email.trim()) errors.email = '이메일을 입력하세요'
  else if (!EMAIL_PATTERN.test(input.email.trim())) errors.email = '이메일 형식이 올바르지 않습니다'
  if (isSignup) {
    const nickname = input.nickname.trim()
    if (!nickname) errors.nickname = '닉네임을 입력하세요'
    else if (nickname.length < 2 || nickname.length > 20) errors.nickname = '닉네임은 2~20자로 입력하세요'
  }
  if (!input.password) errors.password = '비밀번호를 입력하세요'
  else if (isSignup && input.password.length < 8) errors.password = '비밀번호는 8자 이상이어야 합니다'
  return errors
}

const FIELD_ORDER: Field[] = ['email', 'nickname', 'password']

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { status, login, signup } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const isSignup = mode === 'signup'
  useDocumentTitle(isSignup ? '회원가입' : '로그인')

  const [values, setValues] = useState({ email: '', password: '', nickname: '' })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({})

  // 로그인 성공 시 이동도 여기 한 곳에서 처리한다 (status가 바뀌면 다시 렌더링되며 이동)
  if (status === 'authenticated') return <Navigate to={next} replace />

  const change = (field: Field, value: string) => {
    setValues((v) => ({ ...v, [field]: value }))
    // 고치기 시작하면 그 칸의 오류는 지운다
    if (fieldErrors[field]) setFieldErrors((e) => ({ ...e, [field]: undefined }))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const errors = validate(values, isSignup)
    setFieldErrors(errors)
    const firstInvalid = FIELD_ORDER.find((f) => errors[f])
    if (firstInvalid) {
      inputs.current[firstInvalid]?.focus()
      return
    }
    setSubmitting(true)
    try {
      const email = values.email.trim()
      if (isSignup) await signup({ email, password: values.password, nickname: values.nickname.trim() })
      else await login({ email, password: values.password })
    } catch (err) {
      setSubmitting(false)
      // 이미 가입된 이메일은 이메일 칸의 문제로 보여준다
      if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
        setFieldErrors({ email: err.message })
        inputs.current.email?.focus()
      } else {
        setError(errorMessage(err))
      }
    }
  }

  const otherLink = `${isSignup ? '/login' : '/signup'}${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`

  return (
    <section className="auth-card">
      <h1>{isSignup ? '회원가입' : '로그인'}</h1>
      <p className="auth-lead">{leadText(next, isSignup)}</p>
      {!isSignup && <TestAccountLogin />}
      <form onSubmit={onSubmit} className="form" noValidate>
        <FormField label="이메일" error={fieldErrors.email}>
          {(control) => (
            <input
              {...control}
              ref={(el) => {
                inputs.current.email = el
              }}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={values.email}
              onChange={(e) => change('email', e.target.value)}
              required
            />
          )}
        </FormField>
        {isSignup && (
          <FormField label="닉네임" hint="2~20자, 채팅과 채널에 보이는 이름입니다" error={fieldErrors.nickname}>
            {(control) => (
              <input
                {...control}
                ref={(el) => {
                  inputs.current.nickname = el
                }}
                autoComplete="nickname"
                value={values.nickname}
                onChange={(e) => change('nickname', e.target.value)}
                maxLength={20}
                required
              />
            )}
          </FormField>
        )}
        <FormField label="비밀번호" hint={isSignup ? '8자 이상' : undefined} error={fieldErrors.password}>
          {(control) => (
            <input
              {...control}
              ref={(el) => {
                inputs.current.password = el
              }}
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              value={values.password}
              onChange={(e) => change('password', e.target.value)}
              required
            />
          )}
        </FormField>
        {error && (
          <p className="form-error" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting && <Spinner />}
          {submitting ? (isSignup ? '가입하는 중…' : '로그인하는 중…') : isSignup ? '가입하기' : '로그인'}
        </button>
      </form>
      <p className="auth-switch">
        {isSignup ? '이미 계정이 있으신가요?' : '아직 계정이 없으신가요?'}
        <Link to={otherLink}>{isSignup ? '로그인' : '회원가입'}</Link>
      </p>
    </section>
  )
}
