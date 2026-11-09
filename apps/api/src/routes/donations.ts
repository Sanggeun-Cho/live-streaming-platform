import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth/plugin.js'
import {
  DONATION_MAX,
  DONATION_MESSAGE_MAX,
  DONATION_MIN,
  DONATION_UNIT,
  type DonationService,
} from '../donations/service.js'
import { AppError } from '../errors.js'
import { idParams, parse, positiveId } from '../lib/validate.js'

const amountError = `후원 금액은 ${DONATION_MIN.toLocaleString('ko-KR')}원 이상 ${DONATION_MAX.toLocaleString('ko-KR')}원 이하, ${DONATION_UNIT.toLocaleString('ko-KR')}원 단위로 입력하세요`

const amount = z
  .number({ error: amountError })
  .int({ error: amountError })
  .min(DONATION_MIN, { error: amountError })
  .max(DONATION_MAX, { error: amountError })
  .refine((v) => v % DONATION_UNIT === 0, { error: amountError })

const createOrderBody = z.object({
  amount,
  message: z
    .string({ error: '후원 메시지는 문자열이어야 합니다' })
    .trim()
    .max(DONATION_MESSAGE_MAX, { error: `후원 메시지는 ${DONATION_MESSAGE_MAX}자 이하여야 합니다` })
    .default(''),
})

// 결제창 successUrl로 돌아온 쿼리 값 그대로 (amount는 문자열로 와도 받는다)
const confirmBody = z.object({
  orderId: z
    .string({ error: '주문번호가 없습니다' })
    .regex(/^[A-Za-z0-9_=-]{6,64}$/, { error: '주문번호가 올바르지 않습니다' }),
  paymentKey: z
    .string({ error: '결제 키가 없습니다' })
    .min(1, { error: '결제 키가 없습니다' })
    .max(200, { error: '결제 키가 올바르지 않습니다' }),
  amount: z.coerce.number({ error: '결제 금액이 올바르지 않습니다' }).int({ error: '결제 금액이 올바르지 않습니다' }),
})

const listQuery = z.object({
  cursor: positiveId('커서').optional(),
  limit: z.coerce
    .number({ error: '개수는 1~50 사이의 숫자여야 합니다' })
    .int({ error: '개수는 1~50 사이의 숫자여야 합니다' })
    .min(1, { error: '개수는 1~50 사이의 숫자여야 합니다' })
    .max(50, { error: '개수는 1~50 사이의 숫자여야 합니다' })
    .default(20),
})

// 토스 웹훅 본문. 결제 상태 변경 외의 이벤트는 무시한다 (본문 값은 조회 API로 다시 확인한다).
// parse() 대신 safeParse를 쓴다: 형식이 다른 본문에 400을 주면 토스가 같은 통지를 계속 재전송하므로 200으로 끝낸다
const webhookBody = z.object({
  eventType: z.string(),
  data: z.object({ paymentKey: z.string().min(1).max(200), orderId: z.string().min(1).max(64) }).partial().optional(),
})

// 주문 생성은 사용자당 분당 10회. 주문 행을 대량으로 만들어 DB를 채우는 것을 막는다 (정상 후원은 분당 몇 번이면 충분하다)
const orderRateLimit = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => (request.user ? `user:${request.user.id}` : `ip:${request.ip}`),
    },
  },
}
// 웹훅은 IP당 분당 60회. 통지마다 토스 조회 API를 부르므로, 위조 요청으로 외부 호출을 늘리는 것을 막는다
const webhookRateLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export type DonationSettings = {
  /** 후원 기능을 쓸 수 있는가 (토스 키가 있거나 가짜 결제 모드) */
  enabled: boolean
  /** 브라우저 결제창 SDK에 넘기는 클라이언트 키 (공개 값) */
  clientKey: string | null
  /** 개발용 가짜 결제: 웹이 결제창 없이 바로 성공 화면으로 간다 */
  fake: boolean
}

export const donationRoutes =
  ({ donations, settings }: { donations: DonationService; settings: DonationSettings }): FastifyPluginAsync =>
  async (app) => {
    const disabled = () =>
      new AppError(503, 'DONATION_DISABLED', '결제 설정이 없어 후원을 사용할 수 없습니다. 운영자에게 문의하세요', true)

    app.get('/donations/config', async () => ({
      ...settings,
      limits: { min: DONATION_MIN, max: DONATION_MAX, unit: DONATION_UNIT, messageMax: DONATION_MESSAGE_MAX },
    }))

    app.post('/broadcasts/:id/donation-orders', { preHandler: requireAuth, ...orderRateLimit }, async (request, reply) => {
      const { id } = parse(idParams, request.params)
      if (!settings.enabled) throw disabled()
      const input = parse(createOrderBody, request.body)
      return reply.code(201).send({ order: donations.createOrder(id, request.user!, input) })
    })

    app.post('/donations/confirm', { preHandler: requireAuth }, async (request) => {
      if (!settings.enabled) throw disabled()
      const input = parse(confirmBody, request.body)
      return donations.confirm(request.user!, input)
    })

    app.get('/broadcasts/:id/donations', async (request) => {
      const { id } = parse(idParams, request.params)
      return donations.list(id, parse(listQuery, request.query))
    })

    // 토스 웹훅 (개발자센터에 https://<도메인>/api/donations/webhook 등록). 로그인과 무관하게 받는다.
    // 2xx를 받지 못하면 토스가 다시 보내므로, 다시 받아도 의미 없는 경우는 200으로 끝낸다
    app.post('/donations/webhook', webhookRateLimit, async (request, reply) => {
      if (!settings.enabled) return reply.code(200).send({ result: 'ignored' })
      const body = webhookBody.safeParse(request.body)
      const data = body.success ? body.data.data : undefined
      if (!body.success || body.data.eventType !== 'PAYMENT_STATUS_CHANGED' || !data?.orderId || !data.paymentKey) {
        return reply.code(200).send({ result: 'ignored' })
      }
      const result = await donations.handlePaymentWebhook({ orderId: data.orderId, paymentKey: data.paymentKey })
      return reply.code(result === 'retry' ? 503 : 200).send({ result })
    })
  }
