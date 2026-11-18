import { Gift, Heart, HandHeart } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth/context'
import { useFeedback } from '../feedback/context'
import { useDonationConfig, type useDonations } from '../hooks/useDonations'
import { useNow } from '../hooks/useNow'
import { errorMessage } from '../lib/api'
import type { Broadcast, BroadcastStatus } from '../lib/broadcasts'
import {
  createDonationOrder,
  DONATION_PRESETS,
  type Donation,
  type DonationDraft,
  donationReturnUrl,
  formatWon,
  rememberOrder,
  wantsDonationForm,
} from '../lib/donations'
import { formatDateTime, timeAgo } from '../lib/time'
import { openTossPaymentWindow, tossErrorCode } from '../lib/toss'
import { Avatar } from './Avatar'
import { DonationSheet } from './DonationSheet'
import './donations.css'

/**
 * 후원 버튼과 후원 시트. 방송 중에만 보이고 방송자 본인에게는 보이지 않는다
 * (방송 전·종료 후의 안내는 후원 내역(DonationBoard)의 빈 문구가 맡는다).
 * 넓은 화면은 카드, 휴대폰은 제목 줄 오른쪽의 작은 버튼으로 보인다 (donations.css).
 */
export function DonationPanel({ broadcast, isOwner }: { broadcast: Broadcast; isOwner: boolean }) {
  const { status: authStatus } = useAuth()
  const { config, error: configError } = useDonationConfig()
  const location = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(() => wantsDonationForm(location.state))
  const [draft, setDraft] = useState<DonationDraft>({ amount: DONATION_PRESETS[1], message: '' })
  // 토스 결제창이 떠 있는 동안 (결제하면 성공/실패 주소로 페이지가 바뀐다)
  const [paying, setPaying] = useState(false)
  const { toast } = useFeedback()

  // "다시 후원하기"로 왔으면 state를 지워 새로고침했을 때 시트가 또 열리지 않게 한다
  useEffect(() => {
    if (wantsDonationForm(location.state)) navigate(location.pathname + location.search, { replace: true, state: null })
  }, [location, navigate])

  if (isOwner || broadcast.status !== 'LIVE' || (!config && !configError)) return null

  // 후원할 수 없는 이유 (위에서부터 먼저 걸리는 것 하나만 보여준다)
  const reason = configError
    ? `후원 설정을 불러오지 못했습니다(${configError}). 새로고침해 주세요.`
    : !config?.enabled
      ? '결제 설정이 없어 후원을 사용할 수 없습니다.'
      : null
  const title = `${broadcast.streamer.nickname}님 응원하기`

  if (!reason && authStatus === 'anonymous') {
    const next = encodeURIComponent(location.pathname + location.search)
    return (
      <section className="donation-panel" aria-label="후원">
        <PanelIcon />
        <div className="donation-panel-text">
          <strong>{title}</strong>
          <small className="muted" data-testid="donation-reason">
            로그인하면 후원할 수 있습니다.
          </small>
        </div>
        <Link to={`/login?next=${next}`} className="button primary">
          로그인하고 후원하기
        </Link>
      </section>
    )
  }

  if (reason || !config) {
    return (
      <section className="donation-panel" aria-label="후원">
        <PanelIcon />
        <div className="donation-panel-text">
          <strong>{title}</strong>
          <small id="donation-reason" className="muted" data-testid="donation-reason">
            {reason}
          </small>
        </div>
        <button type="button" className="primary" disabled aria-describedby="donation-reason" title={reason ?? undefined}>
          후원하기
        </button>
      </section>
    )
  }

  async function pay() {
    if (!config || draft.amount === null) return
    const order = await createDonationOrder(broadcast.id, { amount: draft.amount, message: draft.message })
    rememberOrder({ orderId: order.orderId, amount: order.amount, broadcastId: broadcast.id })
    if (config.fake) {
      // 가짜 결제: 결제창 대신 토스가 성공 주소로 보내 주는 것과 같은 쿼리로 이동한다
      const qs = new URLSearchParams({
        orderId: order.orderId,
        paymentKey: `fake_${order.orderId}`,
        amount: String(order.amount),
      })
      navigate(`/broadcasts/${broadcast.id}/donation/success?${qs}`)
      return
    }
    // 모달 시트가 열려 있으면 토스 결제창(iframe)이 그 아래에 깔려 누를 수 없으므로 먼저 확실히 닫는다
    flushSync(() => {
      setOpen(false)
      setPaying(true)
    })
    try {
      await openTossPaymentWindow({
        clientKey: config.clientKey!,
        amount: order.amount,
        orderId: order.orderId,
        orderName: order.orderName,
        customerName: order.customerName,
        successUrl: donationReturnUrl(broadcast.id, 'success'),
        failUrl: donationReturnUrl(broadcast.id, 'fail'),
        onCancel: () => {
          setPaying(false)
          toast('결제를 취소했습니다. 입력한 금액과 메시지는 그대로 남아 있습니다.', 'info')
        },
        onError: (err) => {
          setPaying(false)
          toast(`결제를 요청하지 못했습니다(${errorMessage(err)}). 다시 시도해 주세요.`, 'error')
        },
      })
    } catch (err) {
      setPaying(false)
      toast(tossErrorCode(err) ? `결제창을 열지 못했습니다(${errorMessage(err)}). 다시 시도해 주세요.` : errorMessage(err), 'error')
    }
  }

  return (
    <section className="donation-panel" aria-label="후원">
      <PanelIcon />
      <div className="donation-panel-text">
        <strong>{title}</strong>
        <small className="muted">후원 금액과 메시지가 방송 화면과 채팅에 함께 표시됩니다.</small>
      </div>
      <button
        type="button"
        className="primary"
        disabled={paying}
        onClick={() => setOpen(true)}
      >
        {paying ? '결제 진행 중…' : '후원하기'}
      </button>
      {open && (
        <DonationSheet
          broadcast={broadcast}
          config={config}
          draft={draft}
          onDraftChange={setDraft}
          onPay={pay}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  )
}

function PanelIcon() {
  return (
    <span className="donation-panel-icon" aria-hidden="true">
      <Heart size={20} />
    </span>
  )
}

/** 후원이 없을 때의 문구. 방송 상태마다 할 수 있는 일이 달라 따로 쓴다 */
function emptyText(status: BroadcastStatus, isOwner: boolean) {
  if (status === 'ENDED') return isOwner ? '이 방송에서 받은 후원이 없습니다.' : '이 방송에는 후원이 없었습니다.'
  if (isOwner) return '아직 받은 후원이 없습니다.'
  return status === 'READY' ? '방송이 시작되면 후원할 수 있습니다.' : '아직 후원이 없습니다. 첫 후원을 남겨 보세요.'
}

/** 방송별 후원 합계와 내역 (최신순) */
export function DonationBoard({
  donations,
  isOwner,
  broadcastStatus,
}: {
  donations: ReturnType<typeof useDonations>
  isOwner: boolean
  broadcastStatus: BroadcastStatus
}) {
  const { items, total, status, error, hasMore, loadMore, reload } = donations
  const now = useNow()
  return (
    <section className="donation-board" aria-label="후원 내역">
      <header className="donation-board-head">
        <h2>{isOwner ? '받은 후원' : '후원'}</h2>
        <p className="donation-board-total">
          <strong data-testid="donation-total">{formatWon(total.amount)}</strong>
          <small className="muted">{total.count.toLocaleString('ko-KR')}건</small>
        </p>
      </header>
      {status === 'error' && (
        <p className="error" role="alert">
          후원 내역을 불러오지 못했습니다({error}).{' '}
          <button type="button" className="link-button" onClick={reload}>
            다시 시도
          </button>
        </p>
      )}
      {status === 'loading' && items.length === 0 && <p className="muted">불러오는 중…</p>}
      {status === 'idle' && items.length === 0 && (
        <p className="donation-empty" data-testid="donation-reason">
          <HandHeart size={28} aria-hidden />
          {emptyText(broadcastStatus, isOwner)}
        </p>
      )}
      <ul className="donation-list" data-testid="donation-list">
        {items.map((d) => (
          <li key={d.id}>
            <Avatar id={d.donor.id} name={d.donor.nickname} size={36} />
            <div className="donation-item">
              <div className="donation-item-head">
                <strong className="donation-donor">{d.donor.nickname}</strong>
                <time dateTime={d.createdAt} title={formatDateTime(d.createdAt)} className="muted">
                  {timeAgo(d.createdAt, now)}
                </time>
                <span className="donation-amount">{formatWon(d.amount)}</span>
              </div>
              {d.message && <p className="donation-message">{d.message}</p>}
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" className="donation-more" onClick={loadMore}>
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
    <div
      className="donation-alert"
      role="status"
      data-testid="donation-alert"
      style={{ '--alert-ms': `${ALERT_MS}ms` } as CSSProperties}
    >
      <span className="donation-alert-icon" aria-hidden="true">
        <Gift size={22} />
      </span>
      <div className="donation-alert-text">
        <span>
          <strong>{donation.donor.nickname}</strong>님이 후원했습니다.
        </span>
        <strong className="donation-alert-amount">{formatWon(donation.amount)}</strong>
        {donation.message && <p>{donation.message}</p>}
      </div>
    </div>
  )
}
