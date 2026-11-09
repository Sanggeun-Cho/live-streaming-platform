import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { broadcasts, donationOrders, donations } from '../src/db/schema.js'
import { type TossClient, TossApiError, type TossPayment } from '../src/payments/toss.js'
import { idleMediaControl, makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

type Db = Awaited<ReturnType<typeof makeApp>>['db']

const KEYS = { TOSS_CLIENT_KEY: 'test_gck_unit', TOSS_SECRET_KEY: 'test_gsk_unit' }

/**
 * 토스 결제 API 가짜. 실제 토스처럼 한 번 승인된 paymentKey를 다시 승인하면 ALREADY_PROCESSED_PAYMENT를 준다.
 * next에 넣은 동작을 다음 confirm 한 번에 적용한다.
 */
function fakeToss() {
  const approved = new Map<string, TossPayment>()
  const calls = { confirm: 0, getPayment: 0 }
  const state: {
    next: null | 'reject' | 'rejectUnknown' | 'configError' | 'rateLimited' | 'transient' | 'wrongAmount' | 'approveButTimeout'
  } = { next: null }
  const client: TossClient = {
    async confirm({ paymentKey, orderId, amount }) {
      calls.confirm++
      // 동시 요청이 실제로 겹치게 한 틱 쉰다
      await new Promise((r) => setTimeout(r, 5))
      const next = state.next
      state.next = null
      if (next === 'reject') throw new TossApiError(400, 'REJECT_CARD_COMPANY', '카드사에서 거절했습니다.')
      if (next === 'rejectUnknown') throw new TossApiError(400, 'SOME_NEW_CODE', '내부 상점 설정 mid=secret-123')
      if (next === 'configError') throw new TossApiError(401, 'UNAUTHORIZED_KEY', '인증되지 않은 시크릿 키 혹은 클라이언트 키 입니다.')
      if (next === 'rateLimited') throw new TossApiError(429, 'TOO_MANY_REQUESTS', 'too many')
      if (next === 'transient') throw new TossApiError(0, 'NETWORK_ERROR', 'timeout')
      if (approved.has(paymentKey)) throw new TossApiError(400, 'ALREADY_PROCESSED_PAYMENT', '이미 처리된 결제 입니다.')
      const payment = {
        paymentKey,
        orderId,
        status: 'DONE',
        totalAmount: next === 'wrongAmount' ? amount + 1000 : amount,
        currency: 'KRW',
      }
      approved.set(paymentKey, payment)
      // 토스는 승인했지만 응답이 오지 않은 경우 (네트워크 끊김)
      if (next === 'approveButTimeout') throw new TossApiError(0, 'NETWORK_ERROR', 'timeout')
      return payment
    },
    async getPayment(paymentKey) {
      calls.getPayment++
      const payment = approved.get(paymentKey)
      if (!payment) throw new TossApiError(404, 'NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다.')
      return payment
    },
  }
  return { client, calls, state, approved }
}

describe('도네이션 API', () => {
  let app: TestApp
  let db: Db
  let toss: ReturnType<typeof fakeToss>
  let streamer: TestUser
  let viewer: TestUser
  let viewer2: TestUser
  let id: number

  beforeEach(async () => {
    toss = fakeToss()
    ;({ app, db } = await makeApp(':memory:', KEYS, idleMediaControl, toss.client))
    streamer = await signupAs(app, 'streamer')
    viewer = await signupAs(app, 'viewer')
    viewer2 = await signupAs(app, 'viewer2')
    id = (
      await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: '후원 방송' }, ...as(streamer) })
    ).json().broadcast.id
    setStatus(id, 'LIVE')
  })

  afterEach(async () => {
    await app.close()
  })

  const as = (u?: TestUser) => (u ? { cookies: { sid: u.sid } } : {})
  const setStatus = (bid: number, status: 'READY' | 'LIVE' | 'ENDED') =>
    db.orm.update(broadcasts).set({ status }).where(eq(broadcasts.id, bid)).run()
  const createOrder = (u: TestUser | undefined, payload: object = { amount: 5000, message: '응원해요' }, bid = id) =>
    app.inject({ method: 'POST', url: `/api/broadcasts/${bid}/donation-orders`, payload, ...as(u) })
  const confirm = (u: TestUser | undefined, payload: object) =>
    app.inject({ method: 'POST', url: '/api/donations/confirm', payload, ...as(u) })
  const list = (query = '', bid = id) => app.inject({ method: 'GET', url: `/api/broadcasts/${bid}/donations${query}` })
  const orderRow = (orderId: string) =>
    db.orm.select().from(donationOrders).where(eq(donationOrders.orderId, orderId)).get()!
  const ledgerCount = () => db.orm.select().from(donations).all().length
  const webhook = (data: object, eventType = 'PAYMENT_STATUS_CHANGED') =>
    app.inject({
      method: 'POST',
      url: '/api/donations/webhook',
      payload: { eventType, createdAt: '2026-11-09T12:00:00.000000', data },
    })

  async function newOrder(u = viewer, amount = 5000) {
    const res = await createOrder(u, { amount, message: '응원해요' })
    expect(res.statusCode).toBe(201)
    return res.json().order as { orderId: string; amount: number; orderName: string }
  }

  describe('설정', () => {
    it('키가 있으면 클라이언트 키와 금액 규칙을 내려준다 (시크릿 키는 내려주지 않는다)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/donations/config' })
      expect(res.json()).toEqual({
        enabled: true,
        clientKey: 'test_gck_unit',
        fake: false,
        limits: { min: 1000, max: 1_000_000, unit: 1000, messageMax: 100 },
      })
      expect(res.body).not.toContain('test_gsk_unit')
    })

    it('키가 없으면 꺼지고, 주문·승인은 503으로 안내한다', async () => {
      const off = await makeApp()
      try {
        const s = await signupAs(off.app, 's')
        const v = await signupAs(off.app, 'v')
        const bid = (
          await off.app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: 't' }, cookies: { sid: s.sid } })
        ).json().broadcast.id
        expect((await off.app.inject({ method: 'GET', url: '/api/donations/config' })).json()).toMatchObject({
          enabled: false,
          clientKey: null,
        })
        const res = await off.app.inject({
          method: 'POST',
          url: `/api/broadcasts/${bid}/donation-orders`,
          payload: { amount: 1000 },
          cookies: { sid: v.sid },
        })
        expect(res.statusCode).toBe(503)
        expect(res.json()).toMatchObject({ code: 'DONATION_DISABLED', message: expect.stringContaining('결제 설정이 없어') })
      } finally {
        await off.app.close()
      }
    })

    it('키를 한쪽만 넣거나, 운영에서 가짜 결제를 켜거나, 키와 가짜 결제를 함께 켜면 기동하지 않는다', () => {
      expect(() => loadConfig({ NODE_ENV: 'test', TOSS_CLIENT_KEY: 'test_gck_x' })).toThrow(/함께 설정/)
      expect(() =>
        loadConfig({ NODE_ENV: 'production', INTERNAL_SECRET: 'x'.repeat(20), TOSS_FAKE_PAYMENTS: 'true' }),
      ).toThrow(/가짜 결제/)
      expect(() => loadConfig({ NODE_ENV: 'test', ...KEYS, TOSS_FAKE_PAYMENTS: 'true' })).toThrow(/함께 설정할 수 없습니다/)
    })

    it('결제창형 테스트 키(test_gck_/test_gsk_)만 받는다: 라이브 키·API 개별 연동 키는 거부', () => {
      expect(() => loadConfig({ NODE_ENV: 'test', TOSS_CLIENT_KEY: 'live_gck_x', TOSS_SECRET_KEY: 'live_gsk_x' })).toThrow(
        /test_gck_/,
      )
      expect(() => loadConfig({ NODE_ENV: 'test', TOSS_CLIENT_KEY: 'test_ck_x', TOSS_SECRET_KEY: 'test_sk_x' })).toThrow(
        /test_gsk_/,
      )
      expect(loadConfig({ NODE_ENV: 'test', ...KEYS }).TOSS_SECRET_KEY).toBe('test_gsk_unit')
    })
  })

  describe('주문 생성', () => {
    it('다른 사용자는 LIVE 방송에 PENDING 주문을 만든다', async () => {
      const res = await createOrder(viewer, { amount: 10_000, message: '  화이팅  ' })
      expect(res.statusCode).toBe(201)
      const { order } = res.json()
      expect(order).toMatchObject({ amount: 10_000, orderName: '후원 방송 후원', customerName: 'viewer님' })
      expect(order.orderId).toMatch(/^[A-Za-z0-9_=-]{6,64}$/)
      expect(orderRow(order.orderId)).toMatchObject({
        status: 'PENDING',
        broadcastId: id,
        donorId: viewer.user.id,
        amount: 10_000,
        message: '화이팅',
      })
    })

    it('비로그인 401, 본인 방송 403, 없는 방송 404', async () => {
      expect((await createOrder(undefined)).statusCode).toBe(401)
      const own = await createOrder(streamer)
      expect(own.statusCode).toBe(403)
      expect(own.json().message).toBe('본인 방송에는 후원할 수 없습니다')
      expect((await createOrder(viewer, { amount: 1000 }, 9999)).statusCode).toBe(404)
    })

    it('LIVE가 아니면 409와 상태별 안내', async () => {
      setStatus(id, 'READY')
      const ready = await createOrder(viewer)
      expect(ready.statusCode).toBe(409)
      expect(ready.json()).toMatchObject({ code: 'BROADCAST_NOT_LIVE', message: expect.stringContaining('시작되면') })
      setStatus(id, 'ENDED')
      expect((await createOrder(viewer)).json().message).toBe('종료된 방송에는 후원할 수 없습니다')
    })

    it.each([
      [999, '최소 미만'],
      [1_001_000, '최대 초과'],
      [1500, '1,000원 단위가 아님'],
      ['5000', '숫자가 아님'],
      [5000.5, '정수가 아님'],
    ] as Array<[unknown, string]>)('금액 %s(%s)는 400과 규칙 안내', async (amount) => {
      const res = await createOrder(viewer, { amount })
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toBe('후원 금액은 1,000원 이상 1,000,000원 이하, 1,000원 단위로 입력하세요')
    })

    it('사용자당 분당 10건을 넘으면 429', async () => {
      for (let i = 0; i < 10; i++) expect((await createOrder(viewer)).statusCode).toBe(201)
      const res = await createOrder(viewer)
      expect(res.statusCode).toBe(429)
      expect(res.json().code).toBe('TOO_MANY_REQUESTS')
      // 다른 사용자는 영향받지 않는다
      expect((await createOrder(viewer2)).statusCode).toBe(201)
    })

    it('경계값 1,000원과 1,000,000원은 허용, 메시지 100자 초과는 400', async () => {
      expect((await createOrder(viewer, { amount: 1000 })).statusCode).toBe(201)
      expect((await createOrder(viewer, { amount: 1_000_000, message: 'a'.repeat(100) })).statusCode).toBe(201)
      const long = await createOrder(viewer, { amount: 1000, message: 'a'.repeat(101) })
      expect(long.statusCode).toBe(400)
      expect(long.json().message).toBe('후원 메시지는 100자 이하여야 합니다')
    })
  })

  describe('승인 (confirm)', () => {
    it('금액이 맞으면 토스 승인 후 원장에 적립하고 방송별 합계에 반영한다', async () => {
      const order = await newOrder()
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: '5000' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        alreadyConfirmed: false,
        donation: { broadcastId: id, amount: 5000, message: '응원해요', donor: { id: viewer.user.id, nickname: 'viewer님' } },
      })
      expect(orderRow(order.orderId)).toMatchObject({ status: 'DONE', paymentKey: 'pk_1' })
      expect((await list()).json()).toMatchObject({ total: { amount: 5000, count: 1 }, items: [{ amount: 5000 }] })
    })

    it('같은 승인 통지가 반복돼도(재요청) 1번만 적립하고 같은 결과를 돌려준다', async () => {
      const order = await newOrder()
      const body = { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 }
      const first = await confirm(viewer, body)
      const second = await confirm(viewer, body)
      const third = await confirm(viewer, body)
      expect(second.statusCode).toBe(200)
      expect(second.json()).toMatchObject({ alreadyConfirmed: true, donation: { id: first.json().donation.id } })
      expect(third.json().alreadyConfirmed).toBe(true)
      expect(ledgerCount()).toBe(1)
      // 완료된 주문은 토스에 다시 묻지 않는다
      expect(toss.calls.confirm).toBe(1)
    })

    it('동시에 들어온 승인 요청도 1번만 적립한다', async () => {
      const order = await newOrder()
      const body = { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 }
      const results = await Promise.all([confirm(viewer, body), confirm(viewer, body), confirm(viewer, body)])
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200])
      expect(results.filter((r) => r.json().alreadyConfirmed === false)).toHaveLength(1)
      expect(ledgerCount()).toBe(1)
      expect((await list()).json().total).toEqual({ amount: 5000, count: 1 })
    })

    it('결제창에서 돌아온 금액이 주문과 다르면 토스에 승인 요청을 하지 않고 실패로 남긴다', async () => {
      const order = await newOrder()
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 1000 })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('AMOUNT_MISMATCH')
      expect(toss.calls.confirm).toBe(0)
      expect(orderRow(order.orderId)).toMatchObject({ status: 'FAILED', failureCode: 'AMOUNT_MISMATCH' })
      // 실패한 주문은 금액을 고쳐 다시 보내도 승인하지 않는다
      const retry = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      expect(retry.statusCode).toBe(409)
      expect(ledgerCount()).toBe(0)
    })

    it('토스 승인 응답의 금액이 주문과 다르면 적립하지 않는다', async () => {
      const order = await newOrder()
      toss.state.next = 'wrongAmount'
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      expect(res.statusCode).toBe(502)
      expect(res.json().code).toBe('PAYMENT_VERIFICATION_FAILED')
      expect(orderRow(order.orderId).status).toBe('FAILED')
      expect(ledgerCount()).toBe(0)
    })

    it('토스가 거절하면 400 + 토스 사유, 주문은 FAILED', async () => {
      const order = await newOrder()
      toss.state.next = 'reject'
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      expect(res.statusCode).toBe(400)
      // 토스 원문이 아니라 정해 둔 안내 문구를 보낸다
      expect(res.json()).toEqual({
        code: 'PAYMENT_REJECTED',
        message: '결제가 승인되지 않았습니다 (카드사에서 결제를 거절했습니다). 방송 화면에서 다시 후원하세요',
      })
      expect(orderRow(order.orderId)).toMatchObject({ status: 'FAILED', failureCode: 'REJECT_CARD_COMPANY' })
    })

    it('모르는 거절 코드는 원문을 숨기고 일반 안내만 보낸다', async () => {
      const order = await newOrder()
      toss.state.next = 'rejectUnknown'
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toBe('결제가 승인되지 않았습니다. 방송 화면에서 다시 후원하세요')
      expect(res.body).not.toContain('secret-123')
    })

    it('키 설정 오류는 "결제 설정 오류"로 안내하고 주문은 PENDING으로 둔다', async () => {
      const order = await newOrder()
      toss.state.next = 'configError'
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'PAYMENT_CONFIG_ERROR', message: expect.stringContaining('결제 설정 오류') })
      expect(res.body).not.toContain('시크릿 키')
      expect(orderRow(order.orderId).status).toBe('PENDING')
    })

    it('토스 요청 한도(429)는 일시 오류: PENDING 유지, 다시 확인하면 적립', async () => {
      const order = await newOrder()
      const body = { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 }
      toss.state.next = 'rateLimited'
      expect((await confirm(viewer, body)).json().code).toBe('PAYMENT_UNAVAILABLE')
      expect(orderRow(order.orderId).status).toBe('PENDING')
      expect((await confirm(viewer, body)).statusCode).toBe(200)
      expect(ledgerCount()).toBe(1)
    })

    it('네트워크 오류로 결과를 모르면 PENDING으로 두고, 다시 확인하면 1번만 적립한다', async () => {
      const order = await newOrder()
      const body = { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 }
      // 토스는 승인했지만 응답을 받지 못했다
      toss.state.next = 'approveButTimeout'
      const res = await confirm(viewer, body)
      expect(res.statusCode).toBe(502)
      expect(res.json()).toMatchObject({ code: 'PAYMENT_UNAVAILABLE', message: expect.stringContaining('새로고침') })
      expect(orderRow(order.orderId).status).toBe('PENDING')
      // 재요청: 토스는 이미 처리된 결제라고 답하고, 서버는 조회 API로 확인해 적립한다
      const retry = await confirm(viewer, body)
      expect(retry.statusCode).toBe(200)
      expect(retry.json().alreadyConfirmed).toBe(false)
      expect(toss.calls.getPayment).toBe(1)
      expect(ledgerCount()).toBe(1)
    })

    it('결제 도중 방송이 종료돼도 승인을 확정한다', async () => {
      const order = await newOrder()
      setStatus(id, 'ENDED')
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      expect(res.statusCode).toBe(200)
      expect(ledgerCount()).toBe(1)
    })

    it('비로그인 401, 남의 주문 403, 없는 주문 404, 형식 오류 400', async () => {
      const order = await newOrder()
      const body = { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 }
      expect((await confirm(undefined, body)).statusCode).toBe(401)
      expect((await confirm(viewer2, body)).statusCode).toBe(403)
      expect((await confirm(viewer, { ...body, orderId: 'don_doesnotexist' })).statusCode).toBe(404)
      const bad = await confirm(viewer, { ...body, orderId: 'a b' })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().message).toBe('주문번호가 올바르지 않습니다')
      expect(ledgerCount()).toBe(0)
    })

    it('완료된 주문에 다른 결제 키로 승인을 요청하면 409', async () => {
      const order = await newOrder()
      await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      const res = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_other', amount: 5000 })
      expect(res.statusCode).toBe(409)
      expect(ledgerCount()).toBe(1)
    })
  })

  describe('웹훅', () => {
    it('본문을 믿지 않는다: 토스 조회에서 확인되지 않은 결제는 적립하지 않는다', async () => {
      const order = await newOrder()
      const res = await webhook({ orderId: order.orderId, paymentKey: 'forged', status: 'DONE', totalAmount: 5000 })
      expect(res.statusCode).toBe(200)
      expect(res.json().result).toBe('ignored')
      expect(ledgerCount()).toBe(0)
      expect(orderRow(order.orderId).status).toBe('PENDING')
    })

    it('브라우저가 confirm을 못 보내도 웹훅이 조회로 확인해 적립하고, 반복 통지·confirm과 겹쳐도 1번만 적립한다', async () => {
      const order = await newOrder()
      // 토스는 승인했지만 응답을 받지 못한 상황을 만든다
      toss.state.next = 'approveButTimeout'
      await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      const data = { orderId: order.orderId, paymentKey: 'pk_1', status: 'DONE' }
      expect((await webhook(data)).json().result).toBe('settled')
      expect((await webhook(data)).json().result).toBe('ignored')
      const again = await confirm(viewer, { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 })
      expect(again.json().alreadyConfirmed).toBe(true)
      expect(ledgerCount()).toBe(1)
    })

    it('조회한 결제가 주문과 다르면(남의 주문에 자기 결제 키) 무시하고 주문 상태를 바꾸지 않는다', async () => {
      const victim = await newOrder(viewer, 5000)
      // 공격자가 자기 주문으로 실제 승인받은 결제
      const attackerOrder = await newOrder(viewer2, 1000)
      await confirm(viewer2, { orderId: attackerOrder.orderId, paymentKey: 'pk_attacker', amount: 1000 })
      const res = await webhook({ orderId: victim.orderId, paymentKey: 'pk_attacker', status: 'DONE' })
      expect(res.json().result).toBe('ignored')
      expect(orderRow(victim.orderId)).toMatchObject({ status: 'PENDING', failureCode: null })
      expect(ledgerCount()).toBe(1)
    })

    it('조회한 금액이 주문과 달라도 무시하고 주문 상태를 바꾸지 않는다', async () => {
      const order = await newOrder()
      toss.approved.set('pk_odd', { paymentKey: 'pk_odd', orderId: order.orderId, status: 'DONE', totalAmount: 1000 })
      expect((await webhook({ orderId: order.orderId, paymentKey: 'pk_odd' })).json().result).toBe('ignored')
      expect(orderRow(order.orderId)).toMatchObject({ status: 'PENDING', failureCode: null })
      expect(ledgerCount()).toBe(0)
    })

    it('다른 이벤트·형식이 다른 본문은 무시한다', async () => {
      expect((await webhook({}, 'DEPOSIT_CALLBACK')).json().result).toBe('ignored')
      const res = await app.inject({ method: 'POST', url: '/api/donations/webhook', payload: { foo: 1 } })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('방송별 내역·합계', () => {
    it('누구나 조회한다. 최신순, 커서 페이지, 합계는 전체 원장 기준', async () => {
      for (const [i, amount] of [1000, 2000, 3000].entries()) {
        const order = await newOrder(i === 1 ? viewer2 : viewer, amount)
        await confirm(i === 1 ? viewer2 : viewer, { orderId: order.orderId, paymentKey: `pk_${i}`, amount })
      }
      // 승인되지 않은 주문은 합계에 들어가지 않는다
      await newOrder(viewer, 9000)

      const page1 = (await list('?limit=2')).json()
      expect(page1.items.map((d: { amount: number }) => d.amount)).toEqual([3000, 2000])
      expect(page1.items[1].donor.nickname).toBe('viewer2님')
      expect(page1.total).toEqual({ amount: 6000, count: 3 })
      const page2 = (await list(`?limit=2&cursor=${page1.nextCursor}`)).json()
      expect(page2.items.map((d: { amount: number }) => d.amount)).toEqual([1000])
      expect(page2.nextCursor).toBeNull()
    })

    it('후원이 없으면 빈 목록과 0원, 없는 방송은 404', async () => {
      expect((await list()).json()).toEqual({ items: [], total: { amount: 0, count: 0 }, nextCursor: null })
      expect((await list('', 9999)).statusCode).toBe(404)
    })
  })

  it('적립되면 SSE donation 이벤트로 후원자 닉네임·금액·메시지와 새 합계를 보낸다 (중복 통지는 다시 보내지 않는다)', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/broadcasts/${id}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const events: Array<{ event: string; data: unknown }> = []
    const readUntil = async (pred: () => boolean) => {
      while (!pred()) {
        const { value, done } = await reader.read()
        if (done) throw new Error('stream closed')
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const event = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (event && data) events.push({ event, data: JSON.parse(data) })
        }
      }
    }
    await readUntil(() => events.some((e) => e.event === 'status'))

    const order = await newOrder()
    const body = { orderId: order.orderId, paymentKey: 'pk_1', amount: 5000 }
    await confirm(viewer, body)
    await confirm(viewer, body)
    // 두 번째 승인 뒤에 일부러 다른 이벤트를 하나 더 보내, 그 사이에 중복 donation이 없었는지 확인한다
    await app.inject({ method: 'PATCH', url: `/api/broadcasts/${id}`, payload: { title: '끝' }, ...as(streamer) })
    await readUntil(() => events.some((e) => e.event === 'updated'))

    const donationEvents = events.filter((e) => e.event === 'donation')
    expect(donationEvents).toHaveLength(1)
    expect(donationEvents[0]!.data).toMatchObject({
      donation: { amount: 5000, message: '응원해요', donor: { nickname: 'viewer님' } },
      total: { amount: 5000, count: 1 },
    })
    controller.abort()
  })
})
