// 토스페이먼츠 결제 API 클라이언트. 서버에서만 쓴다 (시크릿 키).
//   승인: https://docs.tosspayments.com/guides/v2/payment-widget/integration-window (결제창형 결제 3단계)
//   조회: https://docs.tosspayments.com/reference (GET /v1/payments/{paymentKey})
//   인증: https://docs.tosspayments.com/reference/using-api/authorization (Basic base64("secretKey:"))
//   멱등키: https://docs.tosspayments.com/reference/using-api/idempotency-key
//   예제: https://github.com/tosspayments/tosspayments-sample (express-javascript/server.js)
//
// 후원 서비스는 이 인터페이스에만 의존한다. 테스트와 개발용 가짜 결제는 다른 구현을 넣는다.

import { z } from 'zod'

const TOSS_API_URL = 'https://api.tosspayments.com'

// 응답 Payment 객체 중 검증에 쓰는 필드만. 형식이 다르면(빈 본문, 필드 누락) 승인 여부를 알 수 없는 것으로 본다
const paymentSchema = z.object({
  paymentKey: z.string(),
  orderId: z.string(),
  /** 승인 완료는 DONE */
  status: z.string(),
  totalAmount: z.number(),
  currency: z.string().optional(),
})

export type TossPayment = z.infer<typeof paymentSchema>

const errorSchema = z.object({ code: z.string(), message: z.string() })

// HTTP 상태와 무관하게 재시도 대상인 코드. https://docs.tosspayments.com/reference/error-codes
//   INVALID_RESPONSE: 토스 코드가 아니라 이 클라이언트가 붙이는 내부 코드 (성공 응답의 형식이 예상과 다름)
//   PROVIDER_ERROR(400): "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요"
//   FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING: "결제가 완료되지 않았어요. 다시 시도해주세요"
//   IDEMPOTENT_REQUEST_PROCESSING(409): 같은 멱등키의 이전 요청이 아직 처리 중
const RETRYABLE_CODES = new Set([
  'INVALID_RESPONSE',
  'IDEMPOTENT_REQUEST_PROCESSING',
  'PROVIDER_ERROR',
  'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING',
])

/**
 * 토스 API 오류. status 0은 네트워크 오류·시간 초과다 (승인이 됐는지 알 수 없다).
 * code는 토스 오류 코드 (예: ALREADY_PROCESSED_PAYMENT, REJECT_CARD_COMPANY).
 * message는 토스 원문이라 사용자에게 그대로 보내지 않는다 (로그용)
 */
export class TossApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TossApiError'
  }

  /**
   * 다시 시도하면 결과가 달라질 수 있는 오류 (네트워크, 응답 형식 오류, 요청 한도, 토스 서버 오류,
   * 같은 멱등키 요청 처리 중(409), 토스가 재시도하라고 안내하는 400 오류).
   * 이 오류로는 결제가 승인됐는지 알 수 없으므로 주문을 실패로 확정하지 않는다
   */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500 || RETRYABLE_CODES.has(this.code)
  }
}

export type ConfirmInput = { paymentKey: string; orderId: string; amount: number; idempotencyKey: string }

export type TossClient = {
  /**
   * 결제 승인. 결제창 인증 후 10분 안에 호출해야 한다.
   * idempotencyKey: 토스는 같은 키의 재요청에 첫 응답(오류 포함)을 그대로 돌려주고(15일), 처리 중이면 409를 준다
   */
  confirm(input: ConfirmInput): Promise<TossPayment>
  /** 결제 조회. 이미 승인된 결제(중복 승인 요청, 웹훅)의 실제 상태를 확인한다 */
  getPayment(paymentKey: string): Promise<TossPayment>
}

export function createTossClient(secretKey: string, { timeoutMs = 10_000, baseUrl = TOSS_API_URL } = {}): TossClient {
  // 시크릿 키를 사용자 이름으로, 비밀번호는 비워 둔다 (콜론 뒤가 빈 값)
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`

  async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> }) {
    let res: Response
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: authorization,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new TossApiError(0, 'NETWORK_ERROR', `토스 API에 연결하지 못했습니다: ${String(e)}`)
    }
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const err = errorSchema.safeParse(data)
      throw new TossApiError(
        res.status,
        err.success ? err.data.code : 'UNKNOWN',
        err.success ? err.data.message : `토스 API 오류 (HTTP ${res.status})`,
      )
    }
    const payment = paymentSchema.safeParse(data)
    if (!payment.success) {
      throw new TossApiError(res.status, 'INVALID_RESPONSE', '토스 API 응답 형식이 예상과 다릅니다')
    }
    return payment.data
  }

  return {
    confirm: ({ paymentKey, orderId, amount, idempotencyKey }) =>
      call('/v1/payments/confirm', {
        method: 'POST',
        body: { paymentKey, orderId, amount },
        // 같은 키의 요청이 여러 번 가도 토스가 첫 응답을 그대로 돌려준다 (15일 유효).
        // 서버의 조건부 UPDATE와 별개로, 결제사 쪽에서도 중복 승인이 일어나지 않게 한다
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    getPayment: (paymentKey) => call(`/v1/payments/${encodeURIComponent(paymentKey)}`, { method: 'GET' }),
  }
}

/**
 * 가짜 결제용: 토스의 멱등키 동작을 흉내 낸다 (실제 토스 API로 확인한 동작).
 *   - 같은 키로 다시 요청하면 첫 응답을 그대로 돌려준다. 오류 응답도 그대로다
 *   - 같은 키의 첫 요청이 아직 처리 중이면 409 IDEMPOTENT_REQUEST_PROCESSING
 * 키를 붙이지 않은 요청 본문 비교 등 나머지 규칙은 흉내 내지 않는다.
 */
export function withFakeIdempotency<I extends ConfirmInput>(
  confirm: (input: I) => Promise<TossPayment>,
): (input: I) => Promise<TossPayment> {
  const responses = new Map<string, { settled: boolean; result: Promise<TossPayment> }>()
  return (input) => {
    const cached = responses.get(input.idempotencyKey)
    if (cached && !cached.settled) {
      return Promise.reject(new TossApiError(409, 'IDEMPOTENT_REQUEST_PROCESSING', '이전 멱등 요청이 처리 중입니다.'))
    }
    if (cached) return cached.result
    const entry = { settled: false, result: confirm(input) }
    responses.set(input.idempotencyKey, entry)
    // 첫 요청자가 결과를 받으므로 여기서는 완료 표시만 한다
    entry.result.then(
      () => (entry.settled = true),
      () => (entry.settled = true),
    )
    return entry.result
  }
}

/**
 * 개발·E2E용 가짜 결제 (TOSS_FAKE_PAYMENTS=true). 받은 값 그대로 승인된 것으로 응답한다.
 * 실제 결제창 자동화가 어려워서, 그 뒤의 서버 검증·멱등 적립·화면 흐름을 확인하는 데 쓴다.
 * 실제 토스처럼 멱등키 응답을 재사용하고, 다른 키로 같은 결제를 다시 승인하면 ALREADY_PROCESSED_PAYMENT를 준다.
 */
export function createFakeTossClient(): TossClient {
  const approved = new Map<string, TossPayment>()
  return {
    confirm: withFakeIdempotency(async ({ paymentKey, orderId, amount }) => {
      if (approved.has(paymentKey)) throw new TossApiError(400, 'ALREADY_PROCESSED_PAYMENT', '이미 처리된 결제 입니다.')
      const payment = { paymentKey, orderId, status: 'DONE', totalAmount: amount, currency: 'KRW' }
      approved.set(paymentKey, payment)
      return payment
    }),
    async getPayment(paymentKey) {
      const payment = approved.get(paymentKey)
      if (!payment) throw new TossApiError(404, 'NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다.')
      return payment
    },
  }
}

/** 후원이 꺼져 있을 때(키 없음). 라우트가 먼저 막지만, 혹시 불려도 승인된 것으로 처리되지 않게 항상 실패한다 */
export const disabledTossClient: TossClient = {
  confirm: async () => {
    throw new TossApiError(0, 'DISABLED', '결제 설정이 없습니다')
  },
  getPayment: async () => {
    throw new TossApiError(0, 'DISABLED', '결제 설정이 없습니다')
  },
}
