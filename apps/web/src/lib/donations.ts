import { api } from './api'

export type DonationLimits = { min: number; max: number; unit: number; messageMax: number }

/** GET /api/donations/config */
export type DonationConfig = {
  /** 후원 기능을 쓸 수 있는가 (토스 키가 설정됐거나 개발용 가짜 결제) */
  enabled: boolean
  clientKey: string | null
  /** 개발용 가짜 결제: 결제창 없이 바로 성공 화면으로 간다 */
  fake: boolean
  limits: DonationLimits
}

export type Donation = {
  id: number
  broadcastId: number
  amount: number
  message: string
  createdAt: string
  donor: { id: number; nickname: string }
}

export type DonationTotal = { amount: number; count: number }

export type DonationPage = { items: Donation[]; total: DonationTotal; nextCursor: number | null }

export type DonationOrder = { orderId: string; amount: number; orderName: string; customerName: string }

/** SSE donation 이벤트 */
export type DonationEvent = { donation: Donation; total: DonationTotal }

/** 후원 시트의 금액 버튼 */
export const DONATION_PRESETS = [1_000, 5_000, 10_000, 50_000]

/** 후원 시트 입력값 (금액을 지우면 null) */
export type DonationDraft = { amount: number | null; message: string }

export const formatWon = (amount: number) => `${amount.toLocaleString('ko-KR')}원`

/** 서버(routes/donations.ts)와 같은 금액 규칙. 서버가 최종 검증한다. 통과하면 null */
export function amountError(amount: number | null, { min, max, unit }: DonationLimits): string | null {
  if (amount === null) return '후원 금액을 입력해 주세요.'
  if (amount < min) return `최소 ${formatWon(min)}부터 후원할 수 있습니다.`
  if (amount > max) return `최대 ${formatWon(max)}까지 후원할 수 있습니다.`
  if (!Number.isInteger(amount) || amount % unit !== 0) return `${formatWon(unit)} 단위로 입력해 주세요.`
  return null
}

/** 직접 입력칸의 글자("12,000", "12000원")를 금액으로. 숫자가 없으면 null */
export function parseAmountInput(text: string): number | null {
  // 자릿수를 제한해 아주 긴 붙여넣기도 "최대 금액" 안내로 끝나게 한다
  const digits = text.replace(/\D/g, '').slice(0, 10)
  return digits === '' ? null : Number(digits)
}

/** 금액을 입력칸에 보일 때 쓰는 천 단위 쉼표 표기 (단위 없이) */
export const formatAmountInput = (amount: number | null) => (amount === null ? '' : amount.toLocaleString('ko-KR'))

/** 실제 결제가 아닌 결제 모드인가 (가짜 결제, 토스 테스트 키) */
export const isTestPayment = (config: DonationConfig) => config.fake || Boolean(config.clientKey?.startsWith('test_'))

export const getDonationConfig = (signal?: AbortSignal) => api<DonationConfig>('/donations/config', { signal })

export const createDonationOrder = (broadcastId: number, body: { amount: number; message: string }) =>
  api<{ order: DonationOrder }>(`/broadcasts/${broadcastId}/donation-orders`, { method: 'POST', body }).then(
    (r) => r.order,
  )

export const confirmDonation = (body: { orderId: string; paymentKey: string; amount: number }) =>
  api<{ donation: Donation; alreadyConfirmed: boolean }>('/donations/confirm', { method: 'POST', body })

export function listDonations(broadcastId: number, cursor?: number, signal?: AbortSignal) {
  const qs = cursor ? `?cursor=${cursor}` : ''
  return api<DonationPage>(`/broadcasts/${broadcastId}/donations${qs}`, { signal })
}

/** 방송 화면으로 돌아가면서 후원 폼을 바로 열어 달라는 내비게이션 state ("다시 후원하기") */
export const REOPEN_DONATION_STATE = { openDonation: true } as const

export const wantsDonationForm = (state: unknown) =>
  typeof state === 'object' && state !== null && 'openDonation' in state && state.openDonation === true

/** 결제창으로 떠나기 전의 주문. 실패·취소 주소에는 금액이 오지 않아 결과 화면이 여기서 읽는다 */
export type PendingOrder = { orderId: string; amount: number; broadcastId: number }

const PENDING_ORDER_KEY = 'donation:pending-order'

export function rememberOrder(order: PendingOrder) {
  try {
    sessionStorage.setItem(PENDING_ORDER_KEY, JSON.stringify(order))
  } catch {
    // 저장소를 못 쓰면 결과 화면이 금액 없이 안내한다
  }
}

/** 결제창이 돌려준 orderId와 같은 주문일 때만 돌려준다 (이미 끝난 다른 주문의 금액을 보이지 않게) */
export function recallOrder(broadcastId: number, orderId: string | null): PendingOrder | null {
  if (!orderId) return null
  try {
    const order = JSON.parse(sessionStorage.getItem(PENDING_ORDER_KEY) ?? 'null') as PendingOrder | null
    return order?.broadcastId === broadcastId && order.orderId === orderId ? order : null
  } catch {
    return null
  }
}

/** 결제창에서 돌아올 주소. 결제 실패·취소 때 orderId가 없을 수 있어 방송 ID를 경로에 넣는다 */
export const donationReturnUrl = (broadcastId: number, result: 'success' | 'fail') =>
  `${window.location.origin}/broadcasts/${broadcastId}/donation/${result}`
