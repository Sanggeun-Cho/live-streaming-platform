import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { ApiError, errorMessage } from '../lib/api'
import { confirmDonation, type Donation, formatWon } from '../lib/donations'

// 후원 완료 뒤 방송 화면으로 돌아가기까지 기다리는 시간 (완료 문구를 읽을 시간)
const RETURN_DELAY_MS = 2500

type State =
  | { kind: 'confirming' }
  | { kind: 'done'; donation: Donation }
  | { kind: 'error'; message: string; retryable: boolean }

/**
 * 토스 결제창의 successUrl. 쿼리(orderId, paymentKey, amount)로 서버에 승인 확인을 요청한다.
 * 새로고침·뒤로 가기로 다시 열려도 서버가 같은 결과를 돌려주므로 중복 적립되지 않는다.
 */
export function DonationSuccessPage() {
  const broadcastId = Number(useParams().id)
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const orderId = params.get('orderId') ?? ''
  const paymentKey = params.get('paymentKey') ?? ''
  const amount = Number(params.get('amount'))
  const missing = !orderId || !paymentKey || !Number.isFinite(amount)

  const [state, setState] = useState<State>(
    missing
      ? { kind: 'error', message: '결제 정보가 없습니다. 방송 화면에서 다시 후원하세요', retryable: false }
      : { kind: 'confirming' },
  )
  const started = useRef(false)

  const run = useCallback(() => {
    confirmDonation({ orderId, paymentKey, amount })
      .then(({ donation }) => setState({ kind: 'done', donation }))
      .catch((e: unknown) => {
        if (redirectIfUnauthorized(e)) return
        // 결제사 장애로 결과를 모를 때만 같은 요청을 다시 보내게 한다. 나머지는 새로 후원해야 한다
        const retryable = e instanceof ApiError && (e.status === 0 || e.status === 502) && e.code === 'PAYMENT_UNAVAILABLE'
        setState({ kind: 'error', message: errorMessage(e), retryable })
      })
  }, [orderId, paymentKey, amount, redirectIfUnauthorized])

  useEffect(() => {
    // 개발 모드(StrictMode)의 이중 실행으로 요청을 두 번 보내지 않는다 (보내더라도 서버가 1번만 적립한다)
    if (started.current || missing) return
    started.current = true
    run()
  }, [missing, run])

  useEffect(() => {
    if (state.kind !== 'done') return
    const timer = setTimeout(() => navigate(`/broadcasts/${broadcastId}`, { replace: true }), RETURN_DELAY_MS)
    return () => clearTimeout(timer)
  }, [state.kind, broadcastId, navigate])

  return (
    <section className="donation-result" aria-live="polite">
      {state.kind === 'confirming' && <p>결제를 확인하는 중입니다. 이 화면을 닫지 마세요…</p>}
      {state.kind === 'done' && (
        <>
          <h1>후원 완료</h1>
          <p data-testid="donation-done">{formatWon(state.donation.amount)}을 후원했습니다. 잠시 후 방송 화면으로 돌아갑니다.</p>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <h1>후원을 완료하지 못했습니다</h1>
          <p className="error" role="alert">
            {state.message}
          </p>
          {state.retryable && (
            <button
              type="button"
              onClick={() => {
                setState({ kind: 'confirming' })
                run()
              }}
            >
              다시 확인
            </button>
          )}
        </>
      )}
      <p>
        <Link to={`/broadcasts/${broadcastId}`} replace>
          방송 화면으로 돌아가기
        </Link>
      </p>
    </section>
  )
}

/** 토스 결제창의 failUrl. 구매자가 취소했거나 결제 인증이 실패했다 (결제는 이뤄지지 않았다) */
export function DonationFailPage() {
  const broadcastId = Number(useParams().id)
  const [params] = useSearchParams()
  const code = params.get('code')
  const canceled = code === 'PAY_PROCESS_CANCELED'
  return (
    <section className="donation-result">
      <h1>{canceled ? '결제를 취소했습니다' : '결제에 실패했습니다'}</h1>
      {!canceled && (
        <p className="error" role="alert">
          {params.get('message') ?? '알 수 없는 오류가 발생했습니다'} {code && <small className="muted">({code})</small>}
        </p>
      )}
      <p className="muted">결제는 이뤄지지 않았습니다. 방송 화면에서 다시 후원할 수 있습니다.</p>
      <Link to={`/broadcasts/${broadcastId}`} replace>
        방송 화면으로 돌아가기
      </Link>
    </section>
  )
}
