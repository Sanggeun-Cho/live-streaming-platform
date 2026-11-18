import { Check, LoaderCircle, RotateCw, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { ApiError, errorMessage } from '../lib/api'
import { type Broadcast, getBroadcast } from '../lib/broadcasts'
import { confirmDonation, type Donation, formatWon, REOPEN_DONATION_STATE } from '../lib/donations'
import { formatDateTime } from '../lib/time'
import '../components/donations.css'

// 승인 확인이 이보다 오래 걸리면 기다려 달라는 안내를 덧붙인다
const SLOW_MS = 5000

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
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const orderId = params.get('orderId') ?? ''
  const paymentKey = params.get('paymentKey') ?? ''
  const amount = Number(params.get('amount'))
  const missing = !orderId || !paymentKey || !Number.isFinite(amount)

  const [state, setState] = useState<State>(
    missing
      ? { kind: 'error', message: '결제 정보가 없습니다. 방송 화면에서 다시 후원해 주세요', retryable: false }
      : { kind: 'confirming' },
  )
  // 영수증에 받는 사람·방송 제목을 보여주기 위한 정보 (못 읽어도 영수증은 보인다)
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null)
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
    const controller = new AbortController()
    getBroadcast(broadcastId, controller.signal)
      .then(setBroadcast)
      .catch(() => {})
    return () => controller.abort()
  }, [broadcastId])

  const back = `/broadcasts/${broadcastId}`

  if (state.kind === 'confirming') return <Confirming />

  if (state.kind === 'error') {
    return (
      <ResultCard tone="error" icon={<X size={30} />} title="후원을 완료하지 못했습니다">
        <p className="error" role="alert">
          {state.message}
        </p>
        <div className="result-actions">
          {state.retryable ? (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setState({ kind: 'confirming' })
                run()
              }}
            >
              <RotateCw size={18} aria-hidden />
              결제 결과 다시 확인
            </button>
          ) : (
            <Link to={back} state={REOPEN_DONATION_STATE} replace className="button primary">
              다시 후원하기
            </Link>
          )}
          <Link to={back} replace className="button">
            방송으로 돌아가기
          </Link>
        </div>
      </ResultCard>
    )
  }

  const { donation } = state
  return (
    <ResultCard tone="success" icon={<Check size={30} strokeWidth={3} />} title="후원 완료">
      <p className="result-amount">{formatWon(donation.amount)}</p>
      <p className="muted" data-testid="donation-done">
        {broadcast ? `${broadcast.streamer.nickname}님에게 ` : ''}
        {formatWon(donation.amount)}을 후원했습니다
      </p>
      <dl className="donation-receipt">
        {broadcast && (
          <>
            <div>
              <dt>받는 사람</dt>
              <dd>{broadcast.streamer.nickname}</dd>
            </div>
            <div>
              <dt>방송</dt>
              <dd>{broadcast.title}</dd>
            </div>
          </>
        )}
        {donation.message && (
          <div>
            <dt>메시지</dt>
            <dd className="donation-quote">{donation.message}</dd>
          </div>
        )}
        <div>
          <dt>일시</dt>
          <dd>{formatDateTime(donation.createdAt)}</dd>
        </div>
        <div>
          <dt>주문번호</dt>
          <dd className="receipt-code">{orderId}</dd>
        </div>
      </dl>
      <div className="result-actions">
        <Link to={back} replace className="button primary">
          방송으로 돌아가기
        </Link>
      </div>
    </ResultCard>
  )
}

/** 승인 확인 중: 중간에 화면을 떠나지 않도록 링크 없이 진행 상태만 보여준다 */
function Confirming() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <section className="donation-result" aria-live="polite" aria-busy="true">
      <LoaderCircle size={44} className="spin result-spinner" aria-hidden />
      <h1>결제를 확인하고 있습니다</h1>
      <p className="muted">이 화면을 닫지 마세요</p>
      {slow && <p className="result-slow">확인이 조금 오래 걸리고 있습니다. 잠시만 기다려 주세요</p>}
    </section>
  )
}

/** 토스 결제창의 failUrl. 구매자가 취소했거나 결제 인증이 실패했다 (결제는 이뤄지지 않았다) */
export function DonationFailPage() {
  const back = `/broadcasts/${Number(useParams().id)}`
  const [params] = useSearchParams()
  const code = params.get('code')
  const canceled = code === 'PAY_PROCESS_CANCELED'
  return (
    <ResultCard
      tone={canceled ? 'neutral' : 'error'}
      icon={<X size={30} />}
      title={canceled ? '결제를 취소했습니다' : '결제에 실패했습니다'}
    >
      {!canceled && (
        <p role="alert">{params.get('message') ?? '알 수 없는 오류가 발생했습니다'}</p>
      )}
      <p className="result-safe">결제는 이뤄지지 않았습니다</p>
      <div className="result-actions">
        <Link to={back} state={REOPEN_DONATION_STATE} replace className="button primary">
          다시 후원하기
        </Link>
        <Link to={back} replace className="button">
          방송으로 돌아가기
        </Link>
      </div>
      {!canceled && code && (
        <p className="result-code">
          문의 시 전달할 코드 <code>{code}</code>
        </p>
      )}
    </ResultCard>
  )
}

function ResultCard({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'success' | 'error' | 'neutral'
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section className="donation-result" aria-live="polite">
      <span className={`result-icon result-icon-${tone}`} aria-hidden="true">
        {icon}
      </span>
      <h1>{title}</h1>
      {children}
    </section>
  )
}
