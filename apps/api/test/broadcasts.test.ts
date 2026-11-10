import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { broadcasts } from '../src/db/schema.js'
import { makeApp, openEvents, signupAs, type TestApp, type TestUser } from './helpers.js'

type Db = Awaited<ReturnType<typeof makeApp>>['db']
type Item = { id: number; title: string }

describe('방송 API', () => {
  let app: TestApp
  let db: Db
  let owner: TestUser
  let other: TestUser

  beforeEach(async () => {
    ;({ app, db } = await makeApp())
    owner = await signupAs(app, 'owner')
    other = await signupAs(app, 'other')
  })

  afterEach(async () => {
    await app.close()
  })

  const as = (u?: TestUser) => (u ? { cookies: { sid: u.sid } } : {})
  const create = (u: TestUser | undefined, payload: object = { title: '첫 방송', description: '설명' }) =>
    app.inject({ method: 'POST', url: '/api/broadcasts', payload, ...as(u) })
  const get = (id: number | string) => app.inject({ method: 'GET', url: `/api/broadcasts/${id}` })
  const list = (query = '') => app.inject({ method: 'GET', url: `/api/broadcasts${query}` })
  const patch = (id: number, u: TestUser | undefined, payload: object) =>
    app.inject({ method: 'PATCH', url: `/api/broadcasts/${id}`, payload, ...as(u) })
  const del = (id: number, u?: TestUser) => app.inject({ method: 'DELETE', url: `/api/broadcasts/${id}`, ...as(u) })
  const setStatus = (id: number, status: 'READY' | 'LIVE' | 'ENDED') =>
    db.orm.update(broadcasts).set({ status }).where(eq(broadcasts.id, id)).run()
  const ids = (items: Item[]) => items.map((x) => x.id)

  async function createOwned(title = '첫 방송'): Promise<Item> {
    return (await create(owner, { title })).json().broadcast
  }

  describe('등록', () => {
    it('로그인한 사용자는 본인 채널에 READY 상태로 방송을 등록한다', async () => {
      const res = await create(owner, { title: '  첫 방송  ', description: '설명' })

      expect(res.statusCode).toBe(201)
      expect(res.json().broadcast).toMatchObject({
        title: '첫 방송',
        description: '설명',
        status: 'READY',
        startedAt: null,
        endedAt: null,
        channel: { id: owner.user.channelId },
        streamer: { id: owner.user.id, nickname: 'owner님' },
      })
    })

    it('비로그인은 401', async () => {
      const res = await create(undefined)
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('UNAUTHORIZED')
    })

    it.each([
      [{}, '제목을 입력하세요'],
      [{ title: '   ' }, '제목을 입력하세요'],
      [{ title: 'a'.repeat(101) }, '제목은 100자 이하여야 합니다'],
      [{ title: '제목', description: 'a'.repeat(2001) }, '설명은 2000자 이하여야 합니다'],
    ])('잘못된 입력 %j는 400', async (payload, message) => {
      const res = await create(owner, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'VALIDATION_ERROR', message })
    })
  })

  describe('조회', () => {
    it('비로그인도 상세를 조회한다', async () => {
      const { id } = await createOwned()
      const res = await get(id)
      expect(res.statusCode).toBe(200)
      expect(res.json().broadcast).toMatchObject({ id, title: '첫 방송' })
    })

    it('없는 방송은 404, 숫자가 아닌 ID는 400', async () => {
      const missing = await get(999)
      expect(missing.statusCode).toBe(404)
      expect(missing.json().code).toBe('BROADCAST_NOT_FOUND')
      expect((await get('abc')).statusCode).toBe(400)
    })

    it('목록은 최신순이고 상태·채널로 거르며 커서로 다음 페이지를 읽는다', async () => {
      const a = await createOwned('A')
      const b = await createOwned('B')
      const c: Item = (await create(other, { title: 'C' })).json().broadcast
      setStatus(b.id, 'LIVE')

      const all = (await list()).json()
      expect(all.items.map((x: Item) => x.title)).toEqual(['C', 'B', 'A'])
      expect(all.nextCursor).toBeNull()

      const liveItems = (await list('?status=LIVE')).json().items
      expect(ids(liveItems)).toEqual([b.id])
      expect(liveItems[0].viewers).toBe(0) // 방송 중이면 시청자 수(SSE 연결 수)를 함께 준다
      expect(ids((await list(`?channelId=${owner.user.channelId}`)).json().items)).toEqual([b.id, a.id])

      const page1 = (await list('?limit=2')).json()
      expect(ids(page1.items)).toEqual([c.id, b.id])
      expect(page1.nextCursor).toBe(b.id)
      const page2 = (await list(`?limit=2&cursor=${page1.nextCursor}`)).json()
      expect(ids(page2.items)).toEqual([a.id])
      expect(page2.nextCursor).toBeNull()
    })

    it('잘못된 목록 조건은 한국어 메시지와 함께 400', async () => {
      expect((await list('?limit=abc')).json()).toEqual({
        code: 'VALIDATION_ERROR',
        message: '개수는 1~50 사이의 숫자여야 합니다',
      })
      expect((await list('?channelId=-1')).json().message).toBe('채널 ID가 올바르지 않습니다')
      expect((await list('?status=PAUSED')).statusCode).toBe(400)
      expect((await list('?limit=0')).statusCode).toBe(400)
      expect((await list('?limit=51')).statusCode).toBe(400)
    })
  })

  describe('수정', () => {
    it('소유자는 제목과 설명을 수정하고, 보내지 않은 항목은 그대로 둔다', async () => {
      const { id } = (await create(owner, { title: '첫 방송', description: '원래 설명' })).json().broadcast
      const res = await patch(id, owner, { title: '바뀐 제목' })
      expect(res.statusCode).toBe(200)
      expect(res.json().broadcast).toMatchObject({ title: '바뀐 제목', description: '원래 설명' })
      expect((await get(id)).json().broadcast).toMatchObject({ title: '바뀐 제목', description: '원래 설명' })

      // 설명만 보내면 제목이 유지된다. 빈 설명('')은 "지우기"로 받는다
      expect((await patch(id, owner, { description: '새 설명' })).json().broadcast).toMatchObject({ title: '바뀐 제목', description: '새 설명' })
      expect((await patch(id, owner, { description: '' })).json().broadcast).toMatchObject({ title: '바뀐 제목', description: '' })
    })

    it('방송 중에도 제목을 바꿀 수 있다', async () => {
      const { id } = await createOwned()
      setStatus(id, 'LIVE')
      expect((await patch(id, owner, { title: '방송 중 변경' })).statusCode).toBe(200)
    })

    it('비로그인 401, 다른 사용자 403, 없는 방송 404, 빈 변경 400', async () => {
      const { id } = await createOwned()
      expect((await patch(id, undefined, { title: 'x' })).statusCode).toBe(401)
      const denied = await patch(id, other, { title: 'x' })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().code).toBe('FORBIDDEN')
      expect((await patch(999, owner, { title: 'x' })).statusCode).toBe(404)
      expect((await patch(id, owner, {})).json()).toEqual({ code: 'VALIDATION_ERROR', message: '변경할 항목이 없습니다' })
      expect((await get(id)).json().broadcast.title).toBe('첫 방송')
    })
  })

  it('검증 순서: 인증(401) → 형식(400) → 존재(404) → 소유권(403)', async () => {
    const { id } = await createOwned()
    // 형식이 틀리면 남의 방송이어도 400 (소유권을 확인하기 전에 거른다)
    expect((await patch(id, other, { title: '' })).statusCode).toBe(400)
    // 형식이 맞으면 없는 방송은 404, 남의 방송은 403
    expect((await patch(999, other, { title: 'x' })).statusCode).toBe(404)
    expect((await patch(id, other, { title: 'x' })).statusCode).toBe(403)
    // 로그인하지 않았으면 형식과 무관하게 401
    expect((await patch(id, undefined, { title: '' })).statusCode).toBe(401)
  })

  describe('삭제', () => {
    it('소유자가 삭제하면 204, 이후 상세·목록·수정에서 보이지 않는다', async () => {
      const { id } = await createOwned()
      expect((await del(id, owner)).statusCode).toBe(204)
      expect((await get(id)).statusCode).toBe(404)
      expect((await list()).json().items).toHaveLength(0)
      expect((await patch(id, owner, { title: 'x' })).statusCode).toBe(404)
      expect((await del(id, owner)).statusCode).toBe(404)
      // Soft Delete: 행은 남아 있다
      expect(db.orm.select().from(broadcasts).where(eq(broadcasts.id, id)).get()?.deletedAt).toBeInstanceOf(Date)
    })

    it('방송 중(LIVE)에는 409, 종료된 방송은 삭제할 수 있다', async () => {
      const { id } = await createOwned()
      setStatus(id, 'LIVE')
      const res = await del(id, owner)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('BROADCAST_LIVE')
      expect((await get(id)).statusCode).toBe(200)

      setStatus(id, 'ENDED')
      expect((await del(id, owner)).statusCode).toBe(204)
    })

    it('비로그인 401, 다른 사용자 403', async () => {
      const { id } = await createOwned()
      expect((await del(id)).statusCode).toBe(401)
      expect((await del(id, other)).statusCode).toBe(403)
      expect((await get(id)).statusCode).toBe(200)
    })
  })

  it('채널 정보는 공개 조회되고, 없는 채널은 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/channels/${owner.user.channelId}` })
    expect(res.json().channel).toEqual({
      id: owner.user.channelId,
      name: 'owner님의 채널',
      owner: { id: owner.user.id, nickname: 'owner님' },
    })
    const missing = await app.inject({ method: 'GET', url: '/api/channels/999' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().code).toBe('CHANNEL_NOT_FOUND')
  })

  it('목록의 시청자 수는 방송 중일 때 SSE 연결 수(방송자 제외), 아니면 0', async () => {
    const live = await createOwned('라이브')
    const ready = await createOwned('준비')
    setStatus(live.id, 'LIVE')
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const controller = new AbortController()
    const open = (bid: number) => fetch(`http://127.0.0.1:${port}/api/broadcasts/${bid}/events`, { signal: controller.signal })
    await open(live.id) // 비로그인 시청자 1
    await open(ready.id)
    const items = (await list()).json().items as Array<{ id: number; viewers: number }>
    expect(items.find((b) => b.id === live.id)?.viewers).toBe(1)
    expect(items.find((b) => b.id === ready.id)?.viewers).toBe(0)
    controller.abort()
  })

  it('방송자 본인의 SSE 연결은 시청자 수에서 빠지고, 다른 로그인 사용자는 센다 (목록·viewers 이벤트 모두)', async () => {
    const live = await createOwned('라이브')
    setStatus(live.id, 'LIVE')
    const ownerStream = await openEvents(app, live.id, owner.sid)
    const otherStream = await openEvents(app, live.id, other.sid)
    const anonStream = await openEvents(app, live.id)
    try {
      const viewers = async () => (await list()).json().items as Array<{ id: number; viewers: number }>
      expect((await viewers()).find((b) => b.id === live.id)?.viewers).toBe(2)
      // 시청자 수 이벤트도 본인을 뺀 값(2)에 도달한다. 디바운스 시점에 따라 중간값이 먼저 올 수 있어 조건으로 기다린다
      // (본인을 세면 3이 되어 여기서 시간 초과로 실패한다)
      const reached = await ownerStream.waitFor((e) => e.event === 'viewers' && (e.data as { count: number }).count === 2)
      otherStream.close()
      anonStream.close()
      await expect.poll(async () => (await viewers()).find((b) => b.id === live.id)?.viewers).toBe(0)
      // 방송자만 남으면 0 (2에 도달한 뒤의 이벤트만 본다)
      const after = (e: { event: string; data: unknown }) =>
        ownerStream.events.indexOf(e) > ownerStream.events.indexOf(reached) &&
        e.event === 'viewers' &&
        (e.data as { count: number }).count === 0
      await ownerStream.waitFor(after)
    } finally {
      ownerStream.close()
      otherStream.close()
      anonStream.close()
    }
  })

  it('서버를 재시작해도 방송 정보가 유지된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-broadcasts-'))
    const path = join(dir, 'app.db')
    try {
      const first = await makeApp(path)
      const u = await signupAs(first.app, 'persist')
      const created: Item = (
        await first.app.inject({
          method: 'POST',
          url: '/api/broadcasts',
          payload: { title: '저장 확인' },
          cookies: { sid: u.sid },
        })
      ).json().broadcast
      await first.app.close()

      const second = await makeApp(path)
      const res = await second.app.inject({ method: 'GET', url: `/api/broadcasts/${created.id}` })
      expect(res.json().broadcast).toMatchObject({ id: created.id, title: '저장 확인', status: 'READY' })
      await second.app.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
