// 도네이션 (DESIGN.md §7). 주문 생성 → (브라우저) 토스 결제창 → 승인 확인 → 원장 1건 적립.
//
// 금액 조작 방지: 결제창을 열기 전에 금액·대상·후원자를 주문으로 저장하고, 승인 요청의 금액을 이 값과 대조한다.
// 토스 승인 응답도 그대로 믿지 않고 상태·금액·orderId·paymentKey를 다시 대조한다.
//
// 멱등성: 같은 승인 통지(새로고침으로 인한 confirm 재요청, 동시 요청, 웹훅)가 여러 번 와도
//   (1) 토스 승인 요청에 Idempotency-Key를 붙여 결제사 쪽 중복 승인을 막고,
//   (2) "status가 DONE이 아닌 주문만 DONE으로" 바꾸는 조건부 UPDATE가 1행을 바꿨을 때만 원장을 만들며,
//   (3) 원장의 order_id 유니크 제약이 마지막으로 막는다.
// 결제 도중 방송이 끝나도(주문 생성 시점에 LIVE였으므로) 승인을 확정한다. 원장은 삭제하지 않는다.

import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, inArray, lt, sum } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { AuthUser } from '../auth/service.js'
import { broadcastNotFound } from '../broadcasts/service.js'
import type { Db } from '../db/client.js'
import { broadcasts, type DonationOrder, donationOrders, donations, users } from '../db/schema.js'
import { AppError, forbidden } from '../errors.js'
import { type TossClient, TossApiError, type TossPayment } from '../payments/toss.js'
import type { EventHub } from '../realtime/hub.js'

export const DONATION_MIN = 1_000
export const DONATION_MAX = 1_000_000
export const DONATION_UNIT = 1_000
export const DONATION_MESSAGE_MAX = 100

export type DonationView = {
  id: number
  broadcastId: number
  amount: number
  message: string
  createdAt: Date
  donor: { id: number; nickname: string }
}

export type DonationTotal = { amount: number; count: number }

const donationColumns = {
  id: donations.id,
  broadcastId: donations.broadcastId,
  amount: donations.amount,
  message: donations.message,
  createdAt: donations.createdAt,
  donor: { id: users.id, nickname: users.nickname },
}

const orderNotFound = () =>
  new AppError(404, 'ORDER_NOT_FOUND', '후원 주문을 찾을 수 없습니다. 방송 화면에서 다시 후원하세요')

/** 승인 여부를 알 수 없는 경우. 주문은 PENDING으로 두고 같은 요청을 다시 보내게 한다 (멱등키로 중복 승인되지 않는다) */
const paymentUnavailable = () =>
  new AppError(
    502,
    'PAYMENT_UNAVAILABLE',
    '결제 승인 결과를 확인하지 못했습니다. 잠시 후 이 화면을 새로고침해 다시 확인하세요',
    true,
  )

// 사용자가 원인을 알고 다른 방법으로 다시 시도할 수 있는 토스 오류만 안내 문구로 바꾼다.
// 토스 원문 메시지는 내부 사정(키·상점 설정)을 담을 수 있어 그대로 보내지 않는다.
// 코드 목록: https://docs.tosspayments.com/reference/error-codes#결제-승인
const USER_FACING_REJECTIONS: Record<string, string> = {
  REJECT_CARD_COMPANY: '카드사에서 결제를 거절했습니다',
  REJECT_CARD_PAYMENT: '카드사에서 결제를 거절했습니다',
  INVALID_CARD_EXPIRATION: '카드 유효기간이 올바르지 않습니다',
  INVALID_STOPPED_CARD: '정지된 카드입니다',
  INVALID_CARD_LOST_OR_STOLEN: '분실 또는 도난 신고된 카드입니다',
  INVALID_CARD_NUMBER: '카드 번호가 올바르지 않습니다',
  EXCEED_MAX_DAILY_PAYMENT_COUNT: '하루 결제 가능 횟수를 넘었습니다',
  EXCEED_MAX_PAYMENT_AMOUNT: '결제 한도를 넘었습니다',
  EXCEED_MAX_AMOUNT: '결제 한도를 넘었습니다',
  NOT_AVAILABLE_PAYMENT: '지금은 이 결제수단을 쓸 수 없습니다',
  REJECT_ACCOUNT_PAYMENT: '잔액이 부족하거나 계좌 결제가 거절되었습니다',
  NOT_FOUND_PAYMENT_SESSION: '결제 시간(10분)이 지났습니다',
  PAY_PROCESS_CANCELED: '결제를 취소했습니다',
  PAY_PROCESS_ABORTED: '결제가 중단되었습니다',
}

// 우리 쪽 설정 문제(키 불일치 등). 사용자가 할 수 있는 일이 없으므로 운영자 문의로 안내하고 주문은 PENDING으로 둔다
const CONFIG_ERRORS = new Set(['UNAUTHORIZED_KEY', 'INVALID_API_KEY', 'NOT_SUPPORTED_WIDGET_KEY', 'FORBIDDEN_REQUEST'])

/** 토스 승인 응답을 주문과 대조한다. 어긋난 항목들을 돌려준다 (빈 배열이면 통과) */
function paymentMismatches(order: DonationOrder, payment: TossPayment, paymentKey: string): string[] {
  const checks: Array<[ok: boolean, label: string]> = [
    [payment.status === 'DONE', `status=${payment.status}`],
    [payment.orderId === order.orderId, `orderId=${payment.orderId}`],
    [payment.totalAmount === order.amount, `amount=${payment.totalAmount}`],
    [payment.paymentKey === paymentKey, 'paymentKey'],
    [(payment.currency ?? 'KRW') === 'KRW', `currency=${payment.currency}`],
  ]
  return checks.filter(([ok]) => !ok).map(([, label]) => label)
}

/** 토스 결제창의 orderId 규칙(6~64자, 영문·숫자·-·_·=)을 따르는 추측 불가능한 값 */
const newOrderId = () => `don_${randomBytes(18).toString('base64url')}`

export function createDonationService(deps: { db: Db; toss: TossClient; hub: EventHub; log: FastifyBaseLogger }) {
  const { db, toss, hub, log } = deps
  const { orm } = db

  /** 삭제되지 않은 방송 (없으면 404) */
  function loadBroadcast(broadcastId: number) {
    const row = orm
      .select({ channelId: broadcasts.channelId, status: broadcasts.status, title: broadcasts.title, deletedAt: broadcasts.deletedAt })
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId))
      .get()
    if (!row || row.deletedAt) throw broadcastNotFound()
    return row
  }

  const isDeleted = (broadcastId: number) =>
    orm.select({ deletedAt: broadcasts.deletedAt }).from(broadcasts).where(eq(broadcasts.id, broadcastId)).get()?.deletedAt != null

  const findOrder = (orderId: string) => orm.select().from(donationOrders).where(eq(donationOrders.orderId, orderId)).get()

  const findDonationByOrder = (orderRowId: number): DonationView | undefined =>
    orm
      .select(donationColumns)
      .from(donations)
      .innerJoin(users, eq(users.id, donations.donorId))
      .where(eq(donations.orderId, orderRowId))
      .get()

  function totalOf(broadcastId: number): DonationTotal {
    const row = orm
      .select({ amount: sum(donations.amount).mapWith(Number), count: count() })
      .from(donations)
      .where(eq(donations.broadcastId, broadcastId))
      .get()
    return { amount: row?.amount ?? 0, count: row?.count ?? 0 }
  }

  /** PENDING일 때만 FAILED로 바꾼다 (이미 DONE이 된 주문을 실패로 덮지 않는다) */
  function markFailed(order: DonationOrder, failureCode: string) {
    orm
      .update(donationOrders)
      .set({ status: 'FAILED', failureCode, updatedAt: new Date() })
      .where(and(eq(donationOrders.id, order.id), eq(donationOrders.status, 'PENDING')))
      .run()
  }

  /**
   * 대조를 통과한 결제를 원장에 1번만 적립한다.
   * FAILED 주문도 DONE으로 바꿀 수 있다: 토스에서 실제로 승인된 결제(예: 동시 요청 중 한쪽이 실패로 기록)는 돈이 빠져 나갔으므로 적립이 맞다.
   */
  function record(order: DonationOrder, paymentKey: string): { donation: DonationView; created: boolean } {
    const created = orm.transaction((tx) => {
      const { changes } = tx
        .update(donationOrders)
        .set({ status: 'DONE', paymentKey, failureCode: null, updatedAt: new Date() })
        .where(and(eq(donationOrders.id, order.id), inArray(donationOrders.status, ['PENDING', 'FAILED'])))
        .run()
      if (changes !== 1) return false
      tx.insert(donations)
        .values({
          orderId: order.id,
          broadcastId: order.broadcastId,
          donorId: order.donorId,
          amount: order.amount,
          message: order.message,
          paymentKey,
        })
        .run()
      return true
    })

    const donation = findDonationByOrder(order.id)!
    if (created) {
      hub.publish(order.broadcastId, 'donation', { donation, total: totalOf(order.broadcastId) })
    }
    return { donation, created }
  }

  async function lookupForConfirm(paymentKey: string): Promise<TossPayment> {
    try {
      return await toss.getPayment(paymentKey)
    } catch (e) {
      log.warn({ err: e }, 'toss payment lookup failed (already processed)')
      throw paymentUnavailable()
    }
  }

  /** 승인 API 오류를 사용자 안내로 바꾼다. 거절이 확정된 경우만 주문을 FAILED로 둔다 */
  function rejectionError(order: DonationOrder, e: TossApiError): AppError {
    if (e.transient) {
      log.warn({ orderId: order.orderId, code: e.code, status: e.status }, 'toss confirm transient error')
      return paymentUnavailable()
    }
    if (CONFIG_ERRORS.has(e.code)) {
      log.error({ orderId: order.orderId, code: e.code, message: e.message }, 'toss configuration error')
      return new AppError(
        503,
        'PAYMENT_CONFIG_ERROR',
        '결제 설정 오류로 승인하지 못했습니다. 결제는 이뤄지지 않았으니 운영자에게 문의하세요',
        true,
      )
    }
    markFailed(order, e.code)
    const reason = USER_FACING_REJECTIONS[e.code]
    if (!reason) log.warn({ orderId: order.orderId, code: e.code, message: e.message }, 'toss confirm rejected')
    return new AppError(
      400,
      'PAYMENT_REJECTED',
      `결제가 승인되지 않았습니다${reason ? ` (${reason})` : ''}. 방송 화면에서 다시 후원하세요`,
    )
  }

  return {
    totalOf,

    /** 후원 주문 생성: 로그인, 본인 방송 아님, LIVE 상태를 확인한다 */
    createOrder(broadcastId: number, user: AuthUser, input: { amount: number; message: string }) {
      const broadcast = loadBroadcast(broadcastId)
      if (broadcast.channelId === user.channelId) throw forbidden('본인 방송에는 후원할 수 없습니다')
      if (broadcast.status !== 'LIVE') {
        throw new AppError(
          409,
          'BROADCAST_NOT_LIVE',
          broadcast.status === 'READY'
            ? '아직 방송이 시작되지 않았습니다. 방송이 시작되면 후원할 수 있습니다'
            : '종료된 방송에는 후원할 수 없습니다',
        )
      }
      const orderId = newOrderId()
      orm
        .insert(donationOrders)
        .values({ orderId, broadcastId, donorId: user.id, amount: input.amount, message: input.message })
        .run()
      // 결제창에 보이는 주문명 (토스 제한 100자)
      const orderName = `${broadcast.title} 후원`.slice(0, 100)
      return { orderId, amount: input.amount, orderName, customerName: user.nickname.slice(0, 100) }
    },

    /** 결제 승인 확인. 같은 주문으로 여러 번 호출해도 원장은 1건이다 */
    async confirm(user: AuthUser, input: { orderId: string; paymentKey: string; amount: number }) {
      const order = findOrder(input.orderId)
      if (!order) throw orderNotFound()
      if (order.donorId !== user.id) throw forbidden('본인이 요청한 후원만 확인할 수 있습니다')

      if (order.status === 'DONE') {
        // 새로고침·뒤로 가기로 같은 승인 통지가 다시 온 경우. 기존 결과를 그대로 돌려준다
        if (order.paymentKey !== input.paymentKey) {
          throw new AppError(409, 'ORDER_ALREADY_DONE', '이미 다른 결제로 완료된 후원 주문입니다')
        }
        return { donation: findDonationByOrder(order.id)!, alreadyConfirmed: true }
      }
      if (order.status === 'FAILED') {
        throw new AppError(409, 'ORDER_FAILED', '결제가 실패한 주문입니다. 방송 화면에서 다시 후원하세요')
      }
      // 결제창을 연 사이에 방송이 삭제됐으면 승인하지 않는다 (승인 전이라 돈이 빠지지 않는다).
      // 종료는 확정하지만(DESIGN §7-5) 삭제된 방송의 후원은 내역 조회가 404라 방송자도 후원자도 볼 수 없다.
      // 이미 승인된 결제가 웹훅으로 오면 돈이 빠져나갔으므로 적립한다 (handlePaymentWebhook은 이 확인을 하지 않는다)
      if (isDeleted(order.broadcastId)) {
        markFailed(order, 'BROADCAST_DELETED')
        throw new AppError(
          404,
          'BROADCAST_NOT_FOUND',
          '방송이 삭제되어 후원할 수 없습니다. 이 요청으로는 결제를 승인하지 않았습니다 (이미 승인된 결제가 있으면 확인 후 적립됩니다)',
        )
      }
      // 결제창에서 돌아온 금액이 주문 금액과 다르면 승인 요청 자체를 하지 않는다 (승인 전이라 돈이 빠지지 않는다)
      if (input.amount !== order.amount) {
        markFailed(order, 'AMOUNT_MISMATCH')
        throw new AppError(
          400,
          'AMOUNT_MISMATCH',
          '결제 금액이 주문 금액과 다릅니다. 결제는 승인되지 않았으니 방송 화면에서 다시 후원하세요',
        )
      }

      let payment: TossPayment
      try {
        payment = await toss.confirm({ paymentKey: input.paymentKey, orderId: order.orderId, amount: order.amount })
      } catch (e) {
        if (!(e instanceof TossApiError)) throw e
        // 다른 요청이 먼저 승인했다. 실제 결제 상태를 조회해 같은 경로로 적립한다
        if (e.code === 'ALREADY_PROCESSED_PAYMENT') payment = await lookupForConfirm(input.paymentKey)
        else throw rejectionError(order, e)
      }

      const mismatches = paymentMismatches(order, payment, input.paymentKey)
      if (mismatches.length > 0) {
        // 승인 응답이 주문과 다르다. 적립하지 않고 원인을 남긴다 (자동 취소는 미연동: 운영자가 토스 상점관리자에서 확인·취소)
        log.error({ orderId: order.orderId, mismatches }, 'donation payment verification failed')
        markFailed(order, 'VERIFICATION_FAILED')
        throw new AppError(
          502,
          'PAYMENT_VERIFICATION_FAILED',
          '결제 정보가 주문과 일치하지 않아 후원을 저장하지 않았습니다. 결제가 완료되었다면 운영자에게 문의하세요',
          true,
        )
      }
      const { donation, created } = record(order, input.paymentKey)
      return { donation, alreadyConfirmed: !created }
    },

    /**
     * 토스 웹훅(PAYMENT_STATUS_CHANGED). 본문은 누구나 보낼 수 있으므로 믿지 않고,
     * 결제 조회 API로 실제 상태를 확인한 뒤 confirm과 같은 경로로 적립한다.
     * 대조가 어긋나도 주문 상태는 바꾸지 않는다: 남의 orderId에 자기 결제 키를 붙여 보내 남의 주문을 실패로 만들 수 없게 한다.
     * 돌려준 값이 'retry'면 토스가 다시 보내도록 실패 응답을 준다.
     */
    async handlePaymentWebhook(input: { orderId: string; paymentKey: string }): Promise<'settled' | 'ignored' | 'retry'> {
      const order = findOrder(input.orderId)
      if (!order || order.status === 'DONE') return 'ignored'
      let payment: TossPayment
      try {
        payment = await toss.getPayment(input.paymentKey)
      } catch (e) {
        if (e instanceof TossApiError && !e.transient) return 'ignored'
        log.warn({ err: e, orderId: order.orderId }, 'toss payment lookup failed (webhook)')
        return 'retry'
      }
      // 취소·만료 등 승인 완료가 아닌 상태는 적립과 무관하다
      if (payment.status !== 'DONE') return 'ignored'
      const mismatches = paymentMismatches(order, payment, payment.paymentKey)
      if (mismatches.length > 0) {
        log.warn({ orderId: order.orderId, mismatches }, 'donation webhook ignored: payment does not match order')
        return 'ignored'
      }
      record(order, payment.paymentKey)
      return 'settled'
    },

    /** 방송별 후원 내역(최신순, 커서 페이지)과 합계. 원장에서만 집계한다 */
    list(broadcastId: number, { cursor, limit }: { cursor?: number; limit: number }) {
      loadBroadcast(broadcastId)
      const conditions = [eq(donations.broadcastId, broadcastId)]
      if (cursor) conditions.push(lt(donations.id, cursor))
      const rows = orm
        .select(donationColumns)
        .from(donations)
        .innerJoin(users, eq(users.id, donations.donorId))
        .where(and(...conditions))
        .orderBy(desc(donations.id))
        .limit(limit + 1)
        .all()
      const items = rows.slice(0, limit)
      return {
        items,
        total: totalOf(broadcastId),
        nextCursor: rows.length > limit ? items[items.length - 1]!.id : null,
      }
    },
  }
}

export type DonationService = ReturnType<typeof createDonationService>
