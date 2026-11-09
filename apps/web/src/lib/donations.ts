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

export const formatWon = (amount: number) => `${amount.toLocaleString('ko-KR')}원`

/** 서버(routes/donations.ts)와 같은 금액 규칙. 서버가 최종 검증한다. 통과하면 null */
export function amountError(amount: number, { min, max, unit }: DonationLimits): string | null {
  if (!Number.isInteger(amount) || amount < min || amount > max || amount % unit !== 0) {
    return `후원 금액은 ${formatWon(min)} 이상 ${formatWon(max)} 이하, ${formatWon(unit)} 단위로 입력하세요`
  }
  return null
}

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

/** 결제창에서 돌아올 주소. 결제 실패·취소 때 orderId가 없을 수 있어 방송 ID를 경로에 넣는다 */
export const donationReturnUrl = (broadcastId: number, result: 'success' | 'fail') =>
  `${window.location.origin}/broadcasts/${broadcastId}/donation/${result}`
