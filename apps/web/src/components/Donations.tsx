import { type FormEvent, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { useDonationConfig, type useDonations } from '../hooks/useDonations'
import { errorMessage } from '../lib/api'
import type { Broadcast } from '../lib/broadcasts'
import { amountError, createDonationOrder, type Donation, donationReturnUrl, formatWon } from '../lib/donations'
import { openTossPaymentWindow, tossErrorCode } from '../lib/toss'

const PRESETS = [1_000, 5_000, 10_000, 50_000]

/** 후원 버튼과 금액 선택. 후원할 수 없으면 이유를 보여준다 */
export function DonationPanel({ broadcast, isOwner }: { broadcast: Broadcast; isOwner: boolean }) {
  const { status: authStatus } = useAuth()
  const { config, error: configError } = useDonationConfig()
  const location = useLocation()
  const navigate = useNavigate()
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const [open, setOpen] = useState(false)
  const [amountText, setAmountText] = useState(String(PRESETS[1]))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 후원할 수 없는 이유 (위에서부터 먼저 걸리는 것 하나만 보여준다)
  const reason = configError
    ? `후원 설정을 불러오지 못했습니다 (${configError}). 새로고침해 주세요`
    : !config
      ? null
      : !config.enabled
        ? '결제 설정이 없어 후원을 사용할 수 없습니다'
        : isOwner
          ? '본인 방송에는 후원할 수 없습니다'
          : broadcast.status === 'READY'
            ? '방송이 시작되면 후원할 수 있습니다'
            : broadcast.status === 'ENDED'
              ? '종료된 방송에는 후원할 수 없습니다'
              : null

  if (!config && !configError) return null

  if (!reason && authStatus === 'anonymous') {
    const next = encodeURIComponent(location.pathname + location.search)
    return (
      <section className="donation-panel" aria-label="후원">
        <p className="muted" data-testid="donation-reason">
          로그인하면 후원할 수 있습니다. <Link to={`/login?next=${next}`}>로그인하고 후원하기</Link>
        </p>
      </section>
    )
  }

  if (reason || !config) {
    return (
      <section className="donation-panel" aria-label="후원">
        <button type="button" disabled aria-describedby="donation-reason">
          후원하기
        </button>
        <small id="donation-reason" className="muted" data-testid="donation-reason">
          {reason}
        </small>
      </section>
    )
  }

  const amount = Number(amountText)
  const invalid = amountText === '' ? '후원 금액을 입력하세요' : amountError(amount, config.limits)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (invalid || !config) {
      setError(invalid)
      return
    }
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const order = await createDonationOrder(broadcast.id, { amount, message })
      if (config.fake) {
        // 개발용 가짜 결제: 결제창 대신 토스가 성공 주소로 보내 주는 것과 같은 쿼리로 이동한다
        const qs = new URLSearchParams({
          orderId: order.orderId,
          paymentKey: `fake_${order.orderId}`,
          amount: String(order.amount),
        })
        navigate(`/broadcasts/${broadcast.id}/donation/success?${qs}`)
        return
      }
      await openTossPaymentWindow({
        clientKey: config.clientKey!,
        amount: order.amount,
        orderId: order.orderId,
        orderName: order.orderName,
        customerName: order.customerName,
        successUrl: donationReturnUrl(broadcast.id, 'success'),
        failUrl: donationReturnUrl(broadcast.id, 'fail'),
        onCancel: () => {
          setBusy(false)
          setNotice('결제를 취소했습니다. 다시 후원하려면 후원하기를 누르세요')
        },
        onError: (err) => {
          setBusy(false)
          setError(`결제를 요청하지 못했습니다 (${errorMessage(err)}). 다시 시도하세요`)
        },
      })
    } catch (err) {
      setBusy(false)
      if (redirectIfUnauthorized(err)) return
      setError(tossErrorCode(err) ? `결제창을 열지 못했습니다 (${errorMessage(err)})` : errorMessage(err))
    }
  }

  return (
    <section className="donation-panel" aria-label="후원">
      {!open ? (
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          후원하기
        </button>
      ) : (
        <form className="form donation-form" onSubmit={onSubmit} noValidate>
          <fieldset className="presets">
            <legend>금액</legend>
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={amount === p}
                className={amount === p ? 'preset selected' : 'preset'}
                onClick={() => setAmountText(String(p))}
              >
                {formatWon(p)}
              </button>
            ))}
          </fieldset>
          <label>
            직접 입력 (원)
            <input
              type="number"
              inputMode="numeric"
              min={config.limits.min}
              max={config.limits.max}
              step={config.limits.unit}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={Boolean(invalid)}
              aria-describedby="donation-amount-hint"
            />
          </label>
          <small id="donation-amount-hint" className={invalid ? 'error' : 'muted'}>
            {invalid ??
              `${formatWon(config.limits.min)} ~ ${formatWon(config.limits.max)}, ${formatWon(config.limits.unit)} 단위`}
          </small>
          <label>
            메시지 (선택)
            <textarea
              value={message}
              maxLength={config.limits.messageMax}
              rows={2}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="방송자에게 보낼 메시지"
            />
          </label>
          <small className="muted">
            {message.length}/{config.limits.messageMax}
          </small>
          <div className="row">
            <button type="submit" disabled={busy || Boolean(invalid)}>
              {busy ? '결제 진행 중…' : invalid ? '후원하기' : `${formatWon(amount)} 후원하기`}
            </button>
            <button type="button" className="link-button" onClick={() => setOpen(false)} disabled={busy}>
              닫기
            </button>
          </div>
          {config.fake && <small className="muted">개발용 가짜 결제 모드입니다. 실제 결제창 없이 승인됩니다</small>}
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </section>
  )
}

/** 방송별 후원 합계와 내역 (최신순) */
export function DonationBoard({ donations }: { donations: ReturnType<typeof useDonations> }) {
  const { items, total, status, error, hasMore, loadMore, reload } = donations
  return (
    <section className="donation-board" aria-label="후원 내역">
      <h2>
        후원 <span data-testid="donation-total">{formatWon(total.amount)}</span>{' '}
        <small className="muted">({total.count}건)</small>
      </h2>
      {status === 'error' && (
        <p className="error" role="alert">
          후원 내역을 불러오지 못했습니다 ({error}){' '}
          <button type="button" className="link-button" onClick={reload}>
            다시 시도
          </button>
        </p>
      )}
      {status === 'loading' && items.length === 0 && <p className="muted">불러오는 중…</p>}
      {status === 'idle' && items.length === 0 && <p className="muted">아직 후원이 없습니다. 첫 후원을 남겨 보세요</p>}
      <ul className="donation-list" data-testid="donation-list">
        {items.map((d) => (
          <li key={d.id}>
            <strong>{d.donor.nickname}</strong> <span className="amount">{formatWon(d.amount)}</span>
            {d.message && <p className="donation-message">{d.message}</p>}
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" onClick={loadMore}>
          더 보기
        </button>
      )}
    </section>
  )
}

const ALERT_MS = 6000

/** 새 후원 알림. 같은 후원에는 한 번만 뜨고, 몇 초 뒤 사라진다 (key로 후원마다 새로 마운트) */
export function DonationAlert({ donation }: { donation: Donation }) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), ALERT_MS)
    return () => clearTimeout(timer)
  }, [])
  if (!visible) return null
  return (
    <div className="donation-alert" role="status" data-testid="donation-alert">
      <strong>{donation.donor.nickname}</strong>님이 <strong>{formatWon(donation.amount)}</strong> 후원했습니다!
      {donation.message && <p>{donation.message}</p>}
    </div>
  )
}
