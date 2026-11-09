// 토스페이먼츠 결제 API 클라이언트. 서버에서만 쓴다 (시크릿 키).
//   승인: https://docs.tosspayments.com/guides/v2/payment-widget/integration-window (결제창형 결제 3단계)
//   조회: https://docs.tosspayments.com/reference (GET /v1/payments/{paymentKey})
//   인증: https://docs.tosspayments.com/reference/using-api/authorization (Basic base64("secretKey:"))
//   멱등키: https://docs.tosspayments.com/reference/using-api/idempotency-key
//   예제: https://github.com/tosspayments/tosspayments-sample (express-javascript/server.js)
//
// 후원 서비스는 이 인터페이스에만 의존한다. 테스트와 개발용 가짜 결제는 다른 구현을 넣는다.

const TOSS_API_URL = 'https://api.tosspayments.com'

/** 응답 Payment 객체 중 검증에 쓰는 필드만 */
export type TossPayment = {
  paymentKey: string
  orderId: string
  /** 승인 완료는 DONE */
  status: string
  totalAmount: number
  currency?: string
}

/**
 * 토스 API 오류. status 0은 네트워크 오류·시간 초과다 (승인이 됐는지 알 수 없다).
 * code는 토스 오류 코드 (예: ALREADY_PROCESSED_PAYMENT, REJECT_CARD_COMPANY)
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

  /** 다시 시도하면 결과가 달라질 수 있는 오류 (네트워크, 토스 서버 오류, 이전 멱등 요청 처리 중) */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.code === 'IDEMPOTENT_REQUEST_PROCESSING'
  }
}

export type TossClient = {
  /** 결제 승인. 결제창 인증 후 10분 안에 호출해야 한다 */
  confirm(input: { paymentKey: string; orderId: string; amount: number }): Promise<TossPayment>
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
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok) {
      throw new TossApiError(
        res.status,
        typeof data?.code === 'string' ? data.code : 'UNKNOWN',
        typeof data?.message === 'string' ? data.message : `토스 API 오류 (HTTP ${res.status})`,
      )
    }
    return data as TossPayment
  }

  return {
    confirm: ({ paymentKey, orderId, amount }) =>
      call('/v1/payments/confirm', {
        method: 'POST',
        body: { paymentKey, orderId, amount },
        // 같은 주문의 승인 요청이 여러 번 가도 토스가 첫 응답을 그대로 돌려준다 (15일 유효).
        // 서버의 조건부 UPDATE와 별개로, 결제사 쪽에서도 중복 승인이 일어나지 않게 한다
        headers: { 'Idempotency-Key': `confirm-${orderId}` },
      }),
    getPayment: (paymentKey) => call(`/v1/payments/${encodeURIComponent(paymentKey)}`, { method: 'GET' }),
  }
}

/**
 * 개발·E2E용 가짜 결제 (TOSS_FAKE_PAYMENTS=true). 받은 값 그대로 승인된 것으로 응답한다.
 * 실제 결제창 자동화가 어려워서, 그 뒤의 서버 검증·멱등 적립·화면 흐름을 확인하는 데 쓴다.
 */
export function createFakeTossClient(): TossClient {
  const approved = new Map<string, TossPayment>()
  return {
    async confirm({ paymentKey, orderId, amount }) {
      const payment = { paymentKey, orderId, status: 'DONE', totalAmount: amount, currency: 'KRW' }
      approved.set(paymentKey, payment)
      return payment
    },
    async getPayment(paymentKey) {
      const payment = approved.get(paymentKey)
      if (!payment) throw new TossApiError(404, 'NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다.')
      return payment
    },
  }
}
