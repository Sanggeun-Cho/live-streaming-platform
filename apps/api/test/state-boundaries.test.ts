// 방송 상태 전이 경계와 동시 요청 (#13).
//
// 이미 다른 파일에 있는 경계는 여기서 다시 쓰지 않는다:
//   - ENDED 토큰 발급 409, 종료된 방송의 유효 토큰 인가 403, READY 종료, 유예 중 재송출, 종료 후 늦은 online kick,
//     offline 확인 중 online 경합 → internal-media.test.ts
//   - LIVE 삭제 409 → broadcasts.test.ts / 결제 도중 방송 종료 시 확정 → donations.test.ts
//   - 삭제된 방송의 댓글 404 → comments.test.ts / 삭제된 방송의 녹화 조회·서빙 404 → recordings.test.ts
// 여기에는 그 밖의 빈칸(종료·삭제와 훅의 경합, 유예 확정 경합, 중복 요청, 삭제된 방송의 후원·늦은 녹화)을 둔다.

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { broadcasts, donationOrders, donations } from '../src/db/schema.js'
import type { MediaControl, PathSource } from '../src/media/control.js'
import type { TossClient, TossPayment } from '../src/payments/toss.js'
import { makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

const SECRET = 'test-internal-secret-0123456789'
const ENV = {
  INTERNAL_SECRET: SECRET,
  PUBLISH_GRACE_SECONDS: '45',
  TOSS_CLIENT_KEY: 'test_gck_boundary',
  TOSS_SECRET_KEY: 'test_gsk_boundary',
}
type Db = Awaited<ReturnType<typeof makeApp>>['db']

/**
 * MediaMTX Control API 대역. holdNext를 걸면 다음 getSource 한 번만 release()까지 멈춘다.
 * (모든 조회를 멈추면 경합 중인 다른 요청도 같이 멈춰 순서를 재현할 수 없다)
 */
function fakeControl() {
  const ready = new Map<string, PathSource>()
  const kicked: PathSource[] = []
  let gate: Promise<void> | null = null
  let release = () => {}
  // 멈춘 조회가 실제로 시작됐음을 알린다 (고정 대기 시간 대신 이것을 기다려야 부하가 있어도 순서가 재현된다)
  let markReached = () => {}
  let reached: Promise<void> = Promise.resolve()
  const control: MediaControl = {
    async getSource(path) {
      if (gate) {
        const g = gate
        gate = null
        markReached()
        await g
      }
      return ready.get(path) ?? null
    },
    async listReadyPaths() {
      return new Set(ready.keys())
    },
    async kick(source) {
      kicked.push(source)
      for (const [p, s] of ready) if (s.id === source.id) ready.delete(p)
    },
  }
  return {
    ready,
    kicked,
    control,
    holdNext() {
      gate = new Promise((r) => (release = r))
      reached = new Promise((r) => (markReached = r))
    },
    /** holdNext로 멈춘 조회에 도달할 때까지 기다린다 */
    reached: () => reached,
    release: () => release(),
  }
}

/** 토스 대역: 받은 값 그대로 승인하고, 승인한 결제는 조회에도 돌려준다 */
function fakeToss() {
  const approved = new Map<string, TossPayment>()
  const calls = { confirm: 0 }
  const client: TossClient = {
    async confirm({ paymentKey, orderId, amount }) {
      calls.confirm++
      const p = { paymentKey, orderId, status: 'DONE', totalAmount: amount, currency: 'KRW' }
      approved.set(paymentKey, p)
      return p
    },
    async getPayment(paymentKey) {
      const p = approved.get(paymentKey)
      if (!p) throw new Error('not found')
      return p
    },
  }
  return { client, calls, approved }
}

describe('상태 전이 경계 (#13)', () => {
  let app: TestApp
  let db: Db
  let media: ReturnType<typeof fakeControl>
  let toss: ReturnType<typeof fakeToss>
  let owner: TestUser
  let viewer: TestUser
  let id: number
  let path: string

  beforeEach(async () => {
    media = fakeControl()
    toss = fakeToss()
    ;({ app, db } = await makeApp(':memory:', ENV, media.control, toss.client))
    owner = await signupAs(app, 'owner')
    viewer = await signupAs(app, 'viewer')
    id = (await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: '경계' }, ...as(owner) })).json()
      .broadcast.id
    path = `live/${id}`
  })

  afterEach(async () => {
    await app.close()
  })

  const as = (u?: TestUser) => (u ? { cookies: { sid: u.sid } } : {})
  const row = () => db.orm.select().from(broadcasts).where(eq(broadcasts.id, id)).get()!
  const hook = (type: 'online' | 'offline') =>
    app.inject({
      method: 'POST',
      url: '/internal/media/events',
      headers: { 'x-internal-secret': SECRET },
      payload: { type, path, sourceType: 'webRTCSession' },
    })
  const goOnline = async (sourceId = 'session-1') => {
    media.ready.set(path, { type: 'webRTCSession', id: sourceId })
    await hook('online')
  }
  const goOffline = async () => {
    media.ready.delete(path)
    await hook('offline')
  }
  const end = (u = owner) => app.inject({ method: 'POST', url: `/api/broadcasts/${id}/end`, ...as(u) })
  const remove = () => app.inject({ method: 'DELETE', url: `/api/broadcasts/${id}`, ...as(owner) })
  const mediaAuth = (body: object) =>
    app.inject({ method: 'POST', url: `/internal/media/auth?secret=${SECRET}`, payload: { protocol: 'webrtc', ...body } })

  describe('종료·삭제와 훅의 경합', () => {
    it('재송출 online이 Control API 확인을 기다리는 사이 종료되면, ENDED를 유지하고 송출을 끊는다', async () => {
      await goOnline('s1')
      await goOffline()
      expect(row().disconnectedAt).not.toBeNull()

      // 재송출: online 처리가 "실제로 송출 중인지" 확인하는 동안 소유자가 종료를 누른다
      media.ready.set(path, { type: 'webRTCSession', id: 's2' })
      media.holdNext()
      const online = hook('online')
      await media.reached()
      const ended = await end()
      expect(ended.statusCode).toBe(200)
      media.release()
      await online

      expect(row().status).toBe('ENDED')
      expect(row().disconnectedAt).toBeNull()
      expect(media.kicked.map((s) => s.id)).toContain('s2')
    })

    it('삭제된 방송(READY)에 늦게 붙은 송출은 끊고, LIVE로 만들지 않는다', async () => {
      expect((await remove()).statusCode).toBe(204)
      await goOnline('late')
      expect(row().status).toBe('READY')
      expect(row().deletedAt).not.toBeNull()
      expect(media.kicked.map((s) => s.id)).toEqual(['late'])
    })

    it('online이 먼저 처리되면 삭제는 409 (LIVE 방송은 지워지지 않는다)', async () => {
      await goOnline()
      const res = await remove()
      expect(res.statusCode).toBe(409)
      expect(row().deletedAt).toBeNull()
    })

    it('같은 방송을 동시에 두 번 종료하면 하나만 성공하고 나머지는 409', async () => {
      await goOnline()
      const results = await Promise.all([end(), end()])
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
      expect(row().status).toBe('ENDED')
    })

    it('같은 방송을 동시에 두 번 삭제하면 하나만 204, 나머지는 404', async () => {
      const results = await Promise.all([remove(), remove()])
      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 404])
    })
  })

  describe('유예 시간', () => {
    it('유예 중(LIVE + 끊김)에는 소유자가 새 토큰을 받아 다시 송출할 수 있다', async () => {
      await goOnline()
      await goOffline()
      const issued = await app.inject({ method: 'POST', url: `/api/broadcasts/${id}/publish-token`, ...as(owner) })
      expect(issued.statusCode).toBe(200)
      const auth = await mediaAuth({ action: 'publish', path, token: issued.json().token })
      expect(auth.statusCode).toBe(200)
    })

    it('유예 확정이 Control API를 기다리는 사이 재송출 후 다시 끊기면, 새 끊김 기준으로 유예를 다시 센다', async () => {
      await goOnline()
      // 오래전에 끊긴 상태 (유예 시간 경과)
      const old = new Date(Date.now() - 60_000)
      db.orm.update(broadcasts).set({ disconnectedAt: old }).where(eq(broadcasts.id, id)).run()
      media.ready.delete(path)

      media.holdNext()
      const expiring = app.lifecycle.expireDisconnected()
      await media.reached()
      // 확정 직전: 재송출(online) → 곧바로 다시 끊김(offline). disconnectedAt이 방금 시각으로 바뀐다
      await goOnline('s2')
      expect(row().disconnectedAt).toBeNull()
      await goOffline()
      const fresh = row().disconnectedAt!
      expect(fresh.getTime()).toBeGreaterThan(old.getTime())
      media.release()
      await expiring

      // 이전 끊김 시각으로 판단해 바로 종료하면 안 된다 (새 끊김의 유예 45초가 남아 있다)
      expect(row().status).toBe('LIVE')
      expect(row().disconnectedAt).toEqual(fresh)
    })
  })

  describe('삭제된 방송의 후원·녹화', () => {
    const newOrder = async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/broadcasts/${id}/donation-orders`,
        payload: { amount: 3000 },
        ...as(viewer),
      })
      expect(res.statusCode).toBe(201)
      return res.json().order.orderId as string
    }
    const orderStatus = (orderId: string) =>
      db.orm.select().from(donationOrders).where(eq(donationOrders.orderId, orderId)).get()!.status

    it('결제창을 연 사이 방송이 종료·삭제되면 승인 요청을 하지 않고 404, 주문은 FAILED', async () => {
      await goOnline()
      const orderId = await newOrder()
      await end()
      expect((await remove()).statusCode).toBe(204)

      const res = await app.inject({
        method: 'POST',
        url: '/api/donations/confirm',
        payload: { orderId, paymentKey: 'pk_deleted', amount: 3000 },
        ...as(viewer),
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'BROADCAST_NOT_FOUND', message: expect.stringContaining('이 요청으로는 결제를 승인하지 않았습니다') })
      expect(toss.calls.confirm).toBe(0)
      expect(orderStatus(orderId)).toBe('FAILED')
      expect(db.orm.select().from(donations).all()).toHaveLength(0)
    })

    it('이미 승인된 결제는 방송이 삭제된 뒤 웹훅으로 와도 적립한다 (돈이 빠져나갔으므로)', async () => {
      await goOnline()
      const orderId = await newOrder()
      // 토스에서는 승인됐지만 브라우저가 confirm을 보내지 못한 상황
      await toss.client.confirm({ paymentKey: 'pk_hook', orderId, amount: 3000, idempotencyKey: 'manual' })
      await end()
      await remove()
      const res = await app.inject({
        method: 'POST',
        url: '/api/donations/webhook',
        payload: { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId, paymentKey: 'pk_hook' } },
      })
      expect(res.json()).toEqual({ result: 'settled' })
      expect(orderStatus(orderId)).toBe('DONE')
    })

    it('삭제 뒤 늦게 도착한 녹화 세그먼트는 등록하되 조회·다시보기·파일 서빙에는 나오지 않는다', async () => {
      await goOnline()
      await end()
      await remove()
      const file = `/recordings/live/${id}/2026-11-09_12-00-00-000000_+0000.mp4`
      const seg = await app.inject({
        method: 'POST',
        url: '/internal/media/events',
        headers: { 'x-internal-secret': SECRET },
        payload: { type: 'segment', path, segmentPath: file, segmentDuration: '10' },
      })
      expect(seg.statusCode).toBe(204)
      expect((await app.inject({ method: 'GET', url: `/api/broadcasts/${id}/recordings` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: '/api/replays' })).json().items).toEqual([])
      const serve = await app.inject({
        method: 'GET',
        url: '/internal/recordings/authorize',
        headers: { 'x-internal-secret': SECRET, 'x-forwarded-uri': file },
      })
      expect(serve.statusCode).toBe(404)
    })
  })
})
