import { FlaskConical, LoaderCircle, Lock, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { errorMessage } from '../lib/api'
import type { Broadcast } from '../lib/broadcasts'
import {
  amountError,
  DONATION_PRESETS,
  type DonationConfig,
  type DonationDraft,
  formatAmountInput,
  formatWon,
  isTestPayment,
  parseAmountInput,
} from '../lib/donations'
import './donations.css'

type Props = {
  broadcast: Broadcast
  config: DonationConfig
  /** 입력값은 패널이 들고 있어 시트를 닫았다 열거나 결제창을 취소해도 남는다 */
  draft: DonationDraft
  onDraftChange: (draft: DonationDraft) => void
  /** 주문을 만들고 결제를 시작한다. 실패하면 던진다 (시트 안에 안내) */
  onPay: () => Promise<void>
  onClose: () => void
}

/**
 * 후원 시트: 금액·메시지 입력 → 확인 → 결제.
 * 모달 <dialog>라 화면 어디에서 열어도 제출 버튼까지 한눈에 보인다 (모바일은 아래에서 올라오는 시트).
 */
export function DonationSheet({ broadcast, config, draft, onDraftChange, onPay, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<'form' | 'review'>('form')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const { limits } = config
  const { amount, message } = draft
  const invalid = amountError(amount, limits)
  const streamer = broadcast.streamer.nickname

  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    // 닫기(X)보다 지금 고른 금액에 포커스를 두어 바로 금액을 바꾸거나 Enter로 진행하게 한다
    dialog.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
    return () => dialog.close()
  }, [])

  const close = () => {
    if (!busy) onClose()
  }

  function onNext(e: FormEvent) {
    e.preventDefault()
    if (invalid) return
    setError(null)
    setStep('review')
  }

  async function pay() {
    setError(null)
    setBusy(true)
    try {
      await onPay()
    } catch (e) {
      if (!redirectIfUnauthorized(e)) setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="donation-sheet"
      aria-labelledby="donation-sheet-title"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      // 바깥(배경)을 누르면 닫는다. 입력값은 패널에 남는다
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="donation-sheet-body">
        <header className="donation-sheet-head">
          <h2 id="donation-sheet-title">{step === 'form' ? `${streamer}님에게 후원` : '후원 내용을 확인해 주세요'}</h2>
          <button type="button" className="icon-button" aria-label="닫기" onClick={close} disabled={busy}>
            <X size={20} aria-hidden />
          </button>
        </header>

        {step === 'form' ? (
          <form className="form donation-form" onSubmit={onNext} noValidate>
            <fieldset className="donation-presets">
              <legend>금액 선택</legend>
              {DONATION_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={amount === p}
                  className="preset"
                  onClick={() => onDraftChange({ ...draft, amount: p })}
                >
                  {formatWon(p)}
                </button>
              ))}
            </fieldset>
            <div className="donation-field">
              <label htmlFor="donation-amount">직접 입력</label>
              <div className="donation-amount-input">
                <input
                  id="donation-amount"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="금액"
                  value={formatAmountInput(amount)}
                  // 음수 기호·글자는 입력 자체를 막는다 (걸러서 받으면 "-1000"이 말없이 1,000원이 된다)
                  onBeforeInput={(e) => /[^\d,]/.test(e.data) && e.preventDefault()}
                  onPaste={(e) => /[^\d,\s원]/.test(e.clipboardData.getData('text')) && e.preventDefault()}
                  onChange={(e) => onDraftChange({ ...draft, amount: parseAmountInput(e.target.value) })}
                  aria-invalid={Boolean(invalid)}
                  aria-describedby="donation-amount-hint"
                />
                <span aria-hidden="true">원</span>
              </div>
              <small id="donation-amount-hint" className={invalid ? 'error' : 'muted'}>
                {invalid ?? `${formatWon(limits.min)} ~ ${formatWon(limits.max)}, ${formatWon(limits.unit)} 단위`}
              </small>
            </div>
            <div className="donation-field">
              <label htmlFor="donation-message">메시지 (선택)</label>
              <textarea
                id="donation-message"
                value={message}
                maxLength={limits.messageMax}
                rows={3}
                onChange={(e) => onDraftChange({ ...draft, message: e.target.value })}
                placeholder={`${streamer}님에게 보낼 응원 메시지`}
                aria-describedby="donation-message-count"
              />
              <small id="donation-message-count" className="muted donation-count">
                {message.length}/{limits.messageMax}
              </small>
            </div>
            <PaymentModeNote config={config} />
            <button type="submit" className="donation-submit" disabled={Boolean(invalid)}>
              {invalid || amount === null ? '금액을 확인해 주세요' : `${formatWon(amount)} 후원하기`}
            </button>
          </form>
        ) : (
          <div className="donation-review">
            <p className="donation-review-amount">
              <small>후원 금액</small>
              <strong data-testid="donation-review-amount">{formatWon(amount ?? 0)}</strong>
            </p>
            <dl className="donation-receipt">
              <div>
                <dt>받는 사람</dt>
                <dd>{streamer}</dd>
              </div>
              <div>
                <dt>방송</dt>
                <dd>{broadcast.title}</dd>
              </div>
              <div>
                <dt>메시지</dt>
                <dd className={message ? 'donation-quote' : 'muted'}>{message || '메시지 없음'}</dd>
              </div>
            </dl>
            <PaymentModeNote config={config} />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="donation-actions">
              <button type="button" onClick={() => setStep('form')} disabled={busy}>
                수정
              </button>
              <button type="button" className="primary" onClick={pay} disabled={busy} autoFocus>
                {busy ? (
                  <>
                    <LoaderCircle size={18} className="spin" aria-hidden />
                    결제 준비 중…
                  </>
                ) : (
                  `${formatWon(amount ?? 0)} 결제하기`
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  )
}

/** 결제 모드 안내. 테스트 결제는 배지로 분명히 알려 실제 돈이 나가는지 걱정하지 않게 한다 */
function PaymentModeNote({ config }: { config: DonationConfig }) {
  if (!isTestPayment(config)) {
    return (
      <p className="pay-note">
        <Lock size={14} aria-hidden />
        토스페이먼츠로 안전하게 결제합니다.
      </p>
    )
  }
  return (
    <p className="pay-note">
      <span className="test-badge">
        <FlaskConical size={13} aria-hidden />
        테스트 결제
      </span>
      {config.fake
        ? '결제창 없이 바로 승인되며 실제로 돈이 빠져나가지 않습니다.'
        : '토스페이먼츠 테스트 결제로, 실제로 돈이 빠져나가지 않습니다.'}
    </p>
  )
}
