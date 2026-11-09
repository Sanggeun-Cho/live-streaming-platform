import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { broadcasts } from '../src/db/schema.js'
import type { MediaControl, PathSource } from '../src/media/control.js'
import { createPublishTokenSigner } from '../src/media/token.js'
import { makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

const SECRET = 'test-internal-secret-0123456789'
type Db = Awaited<ReturnType<typeof makeApp>>['db']

/** MediaMTX Control API 대역. ready: 지금 송출 중인 path → source */
function fakeControl() {
  const ready = new Map<string, PathSource>()
  const kicked: PathSource[] = []
  // hold: 설정하면 getSource가 그 Promise가 끝날 때까지 기다린다 (훅 경합 재현용)
  const state: { fail: boolean; hold: Promise<void> | null } = { fail: false, hold: null }
  const guard = () => {
    if (state.fail) throw new Error('mediamtx down')
  }
  const control: MediaControl = {
    async getSource(path) {
      if (state.hold) await state.hold
      guard()
      return ready.get(path) ?? null
    },
    async listReadyPaths() {
      guard()
      return new Set(ready.keys())
    },
    async kick(source) {
      guard()
      kicked.push(source)
      for (const [path, s] of ready) if (s.id === source.id) ready.delete(path)
    },
  }
  return { ready, kicked, state, control }
}

describe('송출 제어 (#6)', () => {
  let app: TestApp
  let db: Db
  let media: ReturnType<typeof fakeControl>
  let owner: TestUser
  let other: TestUser
  let id: number
  let path: string

  beforeEach(async () => {
    media = fakeControl()
    ;({ app, db } = await makeApp(':memory:', { INTERNAL_SECRET: SECRET, PUBLISH_GRACE_SECONDS: '45' }, media.control))
    owner = await signupAs(app, 'owner')
    other = await signupAs(app, 'other')
    const res = await app.inject({
      method: 'POST',
      url: '/api/broadcasts',
      payload: { title: '송출 테스트' },
      cookies: { sid: owner.sid },
    })
    id = res.json().broadcast.id
    path = `live/${id}`
  })

  afterEach(async () => {
    await app.close()
  })

  const as = (u?: TestUser) => (u ? { cookies: { sid: u.sid } } : {})
  const issueToken = (u?: TestUser, bid = id) =>
    app.inject({ method: 'POST', url: `/api/broadcasts/${bid}/publish-token`, ...as(u) })
  const end = (u?: TestUser) => app.inject({ method: 'POST', url: `/api/broadcasts/${id}/end`, ...as(u) })
  const mediaAuth = (body: object, secret: string | null = SECRET) =>
    app.inject({
      method: 'POST',
      url: `/internal/media/auth${secret ? `?secret=${secret}` : ''}`,
      payload: { protocol: 'webrtc', ip: '1.2.3.4', ...body },
    })
  const hook = (type: 'online' | 'offline' | 'segment', p = path) =>
    app.inject({
      method: 'POST',
      url: '/internal/media/events',
      headers: { 'x-internal-secret': SECRET },
      payload: { type, path: p, sourceType: 'webRTCSession' },
    })
  const row = () => db.orm.select().from(broadcasts).where(eq(broadcasts.id, id)).get()!
  const goOnline = async (sourceId = 'session-1') => {
    media.ready.set(path, { type: 'webRTCSession', id: sourceId })
    await hook('online')
  }
  const goOffline = async () => {
    media.ready.delete(path)
    await hook('offline')
  }
  const validToken = async () => (await issueToken(owner)).json().token as string

  describe('내부 호출 보호', () => {
    it('시크릿이 없거나 틀리면 인가·훅 모두 401', async () => {
      expect((await mediaAuth({ action: 'read', path }, null)).statusCode).toBe(401)
      expect((await mediaAuth({ action: 'read', path }, 'wrong-secret-wrong-secret')).statusCode).toBe(401)
      const res = await app.inject({ method: 'POST', url: '/internal/media/events', payload: { type: 'online', path } })
      expect(res.statusCode).toBe(401)
      expect(row().status).toBe('READY')
    })

    it('형식이 틀린 훅은 400, /api 아래로는 노출되지 않는다', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: '/internal/media/events',
        headers: { 'x-internal-secret': SECRET },
        payload: { type: 'unknown', path },
      })
      expect(bad.statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url: '/api/internal/media/auth' })).statusCode).toBe(404)
    })
  })

  describe('publish 토큰 발급', () => {
    it('소유자에게 토큰과 WHIP 경로를 준다', async () => {
      const res = await issueToken(owner)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ token: expect.any(String), whipPath: `/live/${id}/whip` })
    })

    it('비로그인 401, 다른 사용자 403, 종료된 방송 409, 삭제된 방송 404', async () => {
      expect((await issueToken()).statusCode).toBe(401)
      expect((await issueToken(other)).statusCode).toBe(403)
      await end(owner)
      const ended = await issueToken(owner)
      expect(ended.statusCode).toBe(409)
      expect(ended.json().code).toBe('BROADCAST_ENDED')
      await app.inject({ method: 'DELETE', url: `/api/broadcasts/${id}`, ...as(owner) })
      expect((await issueToken(owner)).statusCode).toBe(404)
    })
  })

  describe('MediaMTX 인가', () => {
    it('publish: 이 방송용 유효 토큰만 허용한다 (Bearer 또는 ?token=)', async () => {
      const token = await validToken()
      expect((await mediaAuth({ action: 'publish', path, token })).statusCode).toBe(200)
      expect((await mediaAuth({ action: 'publish', path, query: `token=${token}` })).statusCode).toBe(200)
      expect((await mediaAuth({ action: 'publish', path })).statusCode).toBe(401)
      expect((await mediaAuth({ action: 'publish', path, token: `${token}x` })).statusCode).toBe(401)
    })

    it('publish: 다른 방송의 토큰, 만료된 토큰은 거절한다', async () => {
      const otherId = (
        await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: '다른 방송' }, ...as(other) })
      ).json().broadcast.id
      const otherToken = (await issueToken(other, otherId)).json().token
      expect((await mediaAuth({ action: 'publish', path, token: otherToken })).statusCode).toBe(401)

      const signer = createPublishTokenSigner(SECRET, 300)
      const expired = signer.issue(id, Date.now() - 301_000).token
      expect((await mediaAuth({ action: 'publish', path, token: expired })).statusCode).toBe(401)
      expect((await mediaAuth({ action: 'publish', path, token: signer.issue(id).token })).statusCode).toBe(200)
    })

    it('publish: 종료된 방송은 토큰이 유효해도 403 (재송출 불가)', async () => {
      const token = await validToken()
      await end(owner)
      expect((await mediaAuth({ action: 'publish', path, token })).statusCode).toBe(403)
    })

    it('read: 방송 중일 때만 누구나 허용, 그 밖의 path·action은 403', async () => {
      expect((await mediaAuth({ action: 'read', path })).statusCode).toBe(403)
      await goOnline()
      expect((await mediaAuth({ action: 'read', path })).statusCode).toBe(200)
      expect((await mediaAuth({ action: 'read', path: 'live/999' })).statusCode).toBe(403)
      expect((await mediaAuth({ action: 'read', path: 'other/1' })).statusCode).toBe(403)
      expect((await mediaAuth({ action: 'playback', path })).statusCode).toBe(403)
    })
  })

  describe('상태 머신', () => {
    it('online → LIVE, 시작 시각 기록', async () => {
      await goOnline()
      expect(row()).toMatchObject({ status: 'LIVE', disconnectedAt: null })
      expect(row().startedAt).toBeInstanceOf(Date)
    })

    it('대체 송출: 이전 세션의 offline이 늦게 와도, 송출 중이면 끊김으로 보지 않는다', async () => {
      await goOnline('old')
      media.ready.set(path, { type: 'webRTCSession', id: 'new' })
      await hook('online')
      await hook('offline') // 이전 세션의 offline이 새 online보다 늦게 도착
      expect(row()).toMatchObject({ status: 'LIVE', disconnectedAt: null })
    })

    it('끊긴 뒤 유예 시간 안에 재송출하면 LIVE를 유지하고 시작 시각은 그대로다', async () => {
      await goOnline()
      const startedAt = row().startedAt
      await goOffline()
      expect(row().disconnectedAt).toBeInstanceOf(Date)
      await app.lifecycle.expireDisconnected(Date.now() + 44_000)
      expect(row().status).toBe('LIVE')
      await goOnline('session-2')
      expect(row()).toMatchObject({ status: 'LIVE', disconnectedAt: null, startedAt })
    })

    it('유예 시간(45초)이 지나면 ENDED, 종료 시각은 끊긴 시각', async () => {
      await goOnline()
      await goOffline()
      const disconnectedAt = row().disconnectedAt
      await app.lifecycle.expireDisconnected(Date.now() + 46_000)
      expect(row()).toMatchObject({ status: 'ENDED', endedAt: disconnectedAt, disconnectedAt: null })
      const token = createPublishTokenSigner(SECRET, 300).issue(id).token
      expect((await mediaAuth({ action: 'publish', path, token })).statusCode).toBe(403)
    })

    it('유예 확정 직전에 실제로 송출 중이면(online 훅 유실) ENDED로 만들지 않는다', async () => {
      await goOnline()
      await goOffline()
      media.ready.set(path, { type: 'webRTCSession', id: 'session-2' }) // online 훅은 오지 않음
      await app.lifecycle.expireDisconnected(Date.now() + 46_000)
      expect(row()).toMatchObject({ status: 'LIVE', disconnectedAt: null })
    })

    it('offline 확인(Control API 조회) 중에 재송출 online이 먼저 처리되면 끊김으로 덮어쓰지 않는다', async () => {
      await goOnline('old')
      media.ready.delete(path)
      let release!: () => void
      media.state.hold = new Promise((r) => (release = r))
      const offline = hook('offline') // 조회가 멈춘 상태
      await new Promise((r) => setTimeout(r, 20))
      media.state.hold = null
      media.ready.set(path, { type: 'webRTCSession', id: 'new' })
      await hook('online')
      release()
      await offline
      expect(row()).toMatchObject({ status: 'LIVE', disconnectedAt: null })
    })

    it('끊긴 뒤 늦게 도착한 이전 online(실제 송출 없음)은 끊김을 해제하지 않는다', async () => {
      await goOnline()
      await goOffline()
      await hook('online') // ready에 없음 = 실제로는 송출이 없다
      expect(row().disconnectedAt).toBeInstanceOf(Date)
    })

    it('MediaMTX 조회가 실패하면 offline을 끊김으로 처리한다 (유예 시간이 보호)', async () => {
      await goOnline()
      media.state.fail = true
      await hook('offline')
      expect(row().disconnectedAt).toBeInstanceOf(Date)
    })
  })

  describe('방송 종료', () => {
    it('소유자가 종료하면 ENDED가 되고 송출을 강제로 끊는다', async () => {
      await goOnline()
      const res = await end(owner)
      expect(res.statusCode).toBe(200)
      expect(res.json().status).toMatchObject({ status: 'ENDED', disconnectedAt: null })
      expect(row().endedAt).toBeInstanceOf(Date)
      expect(media.kicked).toEqual([{ type: 'webRTCSession', id: 'session-1' }])
      expect(media.ready.has(path)).toBe(false)
    })

    it('비로그인 401, 다른 사용자 403, 이미 종료 409', async () => {
      await goOnline()
      expect((await end()).statusCode).toBe(401)
      expect((await end(other)).statusCode).toBe(403)
      expect(row().status).toBe('LIVE')
      await end(owner)
      const again = await end(owner)
      expect(again.statusCode).toBe(409)
      expect(again.json().code).toBe('BROADCAST_ENDED')
    })

    it('MediaMTX가 응답하지 않아도 종료는 확정되고, 주기 대조에서 남은 송출을 끊는다', async () => {
      await goOnline()
      media.state.fail = true
      expect((await end(owner)).statusCode).toBe(200)
      expect(row().status).toBe('ENDED')
      media.state.fail = false
      await app.lifecycle.reconcile()
      expect(media.kicked).toHaveLength(1)
    })

    it('종료 후 늦게 도착한 online(종료 직전에 인가된 송출)은 끊는다', async () => {
      await end(owner)
      await goOnline('late')
      expect(row().status).toBe('ENDED')
      expect(media.kicked).toEqual([{ type: 'webRTCSession', id: 'late' }])
    })

    it('방송 시작 전(READY)에도 종료할 수 있다', async () => {
      expect((await end(owner)).statusCode).toBe(200)
      expect(row().status).toBe('ENDED')
    })
  })

  describe('주기 대조 (훅 유실 보정)', () => {
    it('LIVE인데 송출이 없으면 끊김 처리, READY인데 송출 중이면 LIVE', async () => {
      media.ready.set(path, { type: 'webRTCSession', id: 's' }) // online 훅 유실
      await app.lifecycle.reconcile()
      expect(row().status).toBe('LIVE')
      media.ready.delete(path) // offline 훅 유실
      await app.lifecycle.reconcile()
      expect(row().disconnectedAt).toBeInstanceOf(Date)
    })

    it('MediaMTX가 응답하지 않으면 아무것도 바꾸지 않는다', async () => {
      await goOnline()
      media.ready.delete(path)
      media.state.fail = true
      await app.lifecycle.reconcile()
      expect(row()).toMatchObject({ status: 'LIVE', disconnectedAt: null })
    })
  })

  describe('실시간 이벤트 (SSE)', () => {
    it('구독하면 현재 상태를 받고, 상태·제목 변경과 시청자 수를 실시간으로 받는다', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const { port } = app.server.address() as { port: number }
      const controller = new AbortController()
      const res = await fetch(`http://127.0.0.1:${port}/api/broadcasts/${id}/events`, { signal: controller.signal })
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const events: Array<{ event: string; data: unknown }> = []
      const waitFor = async (pred: (e: { event: string; data: unknown }) => boolean) => {
        for (;;) {
          const found = events.find(pred)
          if (found) return found
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

      expect((await waitFor((e) => e.event === 'status')).data).toMatchObject({ status: 'READY' })
      await goOnline()
      await waitFor((e) => e.event === 'status' && (e.data as { status: string }).status === 'LIVE')
      await app.inject({ method: 'PATCH', url: `/api/broadcasts/${id}`, payload: { title: '새 제목' }, ...as(owner) })
      expect((await waitFor((e) => e.event === 'updated')).data).toMatchObject({ title: '새 제목' })
      expect((await waitFor((e) => e.event === "viewers")).data).toEqual({ count: 1 }) // 비로그인 구독자
      await end(owner)
      await waitFor((e) => e.event === 'status' && (e.data as { status: string }).status === 'ENDED')
      controller.abort()
    })

    it('방송이 삭제되면 서버가 연결을 닫는다', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const { port } = app.server.address() as { port: number }
      const res = await fetch(`http://127.0.0.1:${port}/api/broadcasts/${id}/events`)
      const reader = res.body!.getReader()
      await reader.read() // 첫 이벤트
      await app.inject({ method: 'DELETE', url: `/api/broadcasts/${id}`, ...as(owner) })
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    })

    it('IP당 동시 연결은 20개까지, 넘으면 429', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const { port } = app.server.address() as { port: number }
      const controller = new AbortController()
      const open = () => fetch(`http://127.0.0.1:${port}/api/broadcasts/${id}/events`, { signal: controller.signal })
      const streams = await Promise.all(Array.from({ length: 20 }, open))
      expect(streams.every((r) => r.status === 200)).toBe(true)
      const over = await open()
      expect(over.status).toBe(429)
      expect(((await over.json()) as { code: string }).code).toBe('TOO_MANY_REQUESTS')
      controller.abort()
    })

    it('없는 방송은 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/broadcasts/999/events' })
      expect(res.statusCode).toBe(404)
    })
  })
})

describe('publish 토큰 서명', () => {
  const signer = createPublishTokenSigner('secret-secret-secret', 60)

  it('서명을 바꾸거나 다른 키로 만든 토큰은 거절한다', () => {
    const { token } = signer.issue(7)
    expect(signer.verify(token, 7)).toBe(true)
    const [id, exp] = token.split('.')
    expect(signer.verify(`${id}.${Number(exp) + 1000}.${token.split('.')[2]}`, 7)).toBe(false)
    expect(signer.verify(createPublishTokenSigner('another-secret-value', 60).issue(7).token, 7)).toBe(false)
    expect(signer.verify('garbage', 7)).toBe(false)
  })
})
