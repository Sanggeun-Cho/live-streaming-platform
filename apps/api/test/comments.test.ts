import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { broadcasts, comments } from '../src/db/schema.js'
import { makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

type Db = Awaited<ReturnType<typeof makeApp>>['db']
type Comment = {
  id: number
  content: string | null
  editedAt: string | null
  deletedAt: string | null
  author: { id: number; nickname: string } | null
  isStreamer: boolean
}

describe('댓글 API', () => {
  let app: TestApp
  let db: Db
  let owner: TestUser
  let viewer: TestUser
  let other: TestUser
  let broadcastId: number

  beforeEach(async () => {
    ;({ app, db } = await makeApp())
    owner = await signupAs(app, 'owner')
    viewer = await signupAs(app, 'viewer')
    other = await signupAs(app, 'other')
    const res = await app.inject({
      method: 'POST',
      url: '/api/broadcasts',
      payload: { title: '방송' },
      cookies: { sid: owner.sid },
    })
    broadcastId = res.json().broadcast.id
  })

  afterEach(async () => {
    await app.close()
  })

  const as = (u?: TestUser) => (u ? { cookies: { sid: u.sid } } : {})
  const post = (u: TestUser | undefined, payload: object, bid = broadcastId) =>
    app.inject({ method: 'POST', url: `/api/broadcasts/${bid}/comments`, payload, ...as(u) })
  const list = (query = '', bid: number | string = broadcastId) =>
    app.inject({ method: 'GET', url: `/api/broadcasts/${bid}/comments${query}` })
  const patch = (id: number, u: TestUser | undefined, payload: object) =>
    app.inject({ method: 'PATCH', url: `/api/comments/${id}`, payload, ...as(u) })
  const del = (id: number, u?: TestUser) => app.inject({ method: 'DELETE', url: `/api/comments/${id}`, ...as(u) })
  const write = async (u: TestUser, content: string): Promise<Comment> => (await post(u, { content })).json().comment
  const deleteBroadcast = () =>
    db.orm.update(broadcasts).set({ deletedAt: new Date() }).where(eq(broadcasts.id, broadcastId)).run()

  describe('작성', () => {
    it('로그인한 사용자는 댓글을 쓰고, 작성자 닉네임과 방송자 여부를 함께 받는다', async () => {
      const res = await post(viewer, { content: '  안녕하세요  ' })
      expect(res.statusCode).toBe(201)
      expect(res.json().comment).toMatchObject({
        broadcastId,
        content: '안녕하세요',
        editedAt: null,
        deletedAt: null,
        author: { id: viewer.user.id, nickname: 'viewer님' },
        isStreamer: false,
      })

      const mine = await write(owner, '방송자입니다')
      expect(mine.isStreamer).toBe(true)
    })

    it('비로그인은 401', async () => {
      const res = await post(undefined, { content: '안녕' })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('UNAUTHORIZED')
    })

    it.each([
      [{}, '댓글 내용을 입력하세요'],
      [{ content: '   ' }, '댓글 내용을 입력하세요'],
      [{ content: 'a'.repeat(301) }, '댓글은 300자 이하로 입력하세요'],
    ])('잘못된 입력 %j는 400', async (payload, message) => {
      const res = await post(viewer, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'VALIDATION_ERROR', message })
    })

    it('300자는 허용한다', async () => {
      expect((await post(viewer, { content: 'a'.repeat(300) })).statusCode).toBe(201)
    })

    it('없는 방송·삭제된 방송에는 404', async () => {
      expect((await post(viewer, { content: '안녕' }, 9999)).json().code).toBe('BROADCAST_NOT_FOUND')
      deleteBroadcast()
      const res = await post(viewer, { content: '안녕' })
      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe('BROADCAST_NOT_FOUND')
    })

    it('종료된 방송에도 쓸 수 있다 (다시보기 감상)', async () => {
      db.orm.update(broadcasts).set({ status: 'ENDED' }).where(eq(broadcasts.id, broadcastId)).run()
      expect((await post(viewer, { content: '잘 봤습니다' })).statusCode).toBe(201)
    })

    it('사용자당 10초에 10번까지만 쓸 수 있다 (도배 방지). 다른 사용자는 영향받지 않는다', async () => {
      for (let i = 0; i < 10; i++) expect((await post(viewer, { content: `${i}` })).statusCode).toBe(201)
      const res = await post(viewer, { content: '도배' })
      expect(res.statusCode).toBe(429)
      expect(res.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' })
      expect(res.json().message).toMatch(/초 후 다시 시도하세요/)
      expect((await post(other, { content: '저는 괜찮아요' })).statusCode).toBe(201)
    })

    it('도배 제한은 작성·수정·삭제를 합쳐 센다', async () => {
      const c = await write(viewer, '원래') // 1
      for (let i = 0; i < 4; i++) await patch(c.id, viewer, { content: `고침 ${i}` }) // 5
      for (let i = 0; i < 4; i++) await write(viewer, `${i}`) // 9
      expect((await del(c.id, viewer)).statusCode).toBe(200) // 10
      expect((await post(viewer, { content: '11번째' })).statusCode).toBe(429)
      expect((await patch(c.id, viewer, { content: '11번째' })).statusCode).toBe(429)
    })
  })

  describe('목록', () => {
    it('비로그인도 조회하며, 최신 N개를 오래된 것부터(채팅 순서) 돌려주고 커서로 이전 댓글을 읽는다', async () => {
      const ids: number[] = []
      for (const n of [1, 2, 3, 4, 5]) ids.push((await write(n % 2 ? viewer : other, `댓글 ${n}`)).id)

      const first = await list('?limit=3')
      expect(first.statusCode).toBe(200)
      const page1 = first.json()
      expect(page1.items.map((c: Comment) => c.content)).toEqual(['댓글 3', '댓글 4', '댓글 5'])
      expect(page1.nextCursor).toBe(ids[2])

      const page2 = (await list(`?limit=3&cursor=${page1.nextCursor}`)).json()
      expect(page2.items.map((c: Comment) => c.content)).toEqual(['댓글 1', '댓글 2'])
      expect(page2.nextCursor).toBeNull()
    })

    it('다른 방송의 댓글은 섞이지 않는다', async () => {
      await write(viewer, '여기')
      const otherBroadcast = (
        await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: '다른' }, ...as(other) })
      ).json().broadcast.id
      await post(viewer, { content: '저기' }, otherBroadcast)
      expect((await list()).json().items.map((c: Comment) => c.content)).toEqual(['여기'])
    })

    it('삭제된 댓글은 본문·작성자 없이 자리만 남는다', async () => {
      const c = await write(owner, '지울 댓글')
      await del(c.id, owner)
      const [item] = (await list()).json().items
      expect(item).toMatchObject({ id: c.id, content: null, author: null, isStreamer: false })
      expect(item.deletedAt).not.toBeNull()
      // 본문은 DB에 남는다 (신고·분쟁 확인용)
      expect(db.orm.select().from(comments).where(eq(comments.id, c.id)).get()?.content).toBe('지울 댓글')
    })

    it('없는 방송·삭제된 방송은 404, 잘못된 쿼리는 400', async () => {
      expect((await list('', 9999)).statusCode).toBe(404)
      expect((await list('?limit=0')).json()).toEqual({
        code: 'VALIDATION_ERROR',
        message: '개수는 1~100 사이의 숫자여야 합니다',
      })
      expect((await list('', 'abc')).statusCode).toBe(400)
      deleteBroadcast()
      expect((await list()).statusCode).toBe(404)
    })
  })

  describe('수정', () => {
    it('작성자는 수정하고 editedAt이 채워진다', async () => {
      const c = await write(viewer, '원래')
      const res = await patch(c.id, viewer, { content: ' 고침 ' })
      expect(res.statusCode).toBe(200)
      expect(res.json().comment).toMatchObject({ id: c.id, content: '고침' })
      expect(res.json().comment.editedAt).not.toBeNull()
      expect((await list()).json().items[0].content).toBe('고침')
    })

    it('같은 내용으로 수정하면 아무것도 바뀌지 않는다 (editedAt 그대로)', async () => {
      const c = await write(viewer, '그대로')
      const res = await patch(c.id, viewer, { content: '  그대로 ' })
      expect(res.statusCode).toBe(200)
      expect(res.json().comment).toMatchObject({ id: c.id, content: '그대로', editedAt: null })
    })

    it('비로그인 401, 다른 사용자 403(방송자라도), 내용은 바뀌지 않는다', async () => {
      const c = await write(viewer, '원래')
      expect((await patch(c.id, undefined, { content: '탈취' })).statusCode).toBe(401)
      const res = await patch(c.id, other, { content: '탈취' })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'FORBIDDEN', message: '본인이 작성한 댓글만 수정할 수 있습니다' })
      expect((await patch(c.id, owner, { content: '탈취' })).statusCode).toBe(403)
      expect((await list()).json().items[0].content).toBe('원래')
    })

    it('빈 내용은 400, 없는 댓글·삭제된 댓글·삭제된 방송의 댓글은 404', async () => {
      const c = await write(viewer, '원래')
      expect((await patch(c.id, viewer, { content: ' ' })).statusCode).toBe(400)
      expect((await patch(9999, viewer, { content: '고침' })).json().code).toBe('COMMENT_NOT_FOUND')
      await del(c.id, viewer)
      expect((await patch(c.id, viewer, { content: '되살리기' })).statusCode).toBe(404)

      const d = await write(viewer, '방송 삭제 전')
      deleteBroadcast()
      expect((await patch(d.id, viewer, { content: '고침' })).statusCode).toBe(404)
    })
  })

  describe('삭제', () => {
    it('작성자는 삭제하고, 응답은 본문을 숨긴 댓글이다', async () => {
      const c = await write(viewer, '지울 댓글')
      const res = await del(c.id, viewer)
      expect(res.statusCode).toBe(200)
      expect(res.json().comment).toMatchObject({ id: c.id, content: null, author: null })
      expect(res.json().comment.deletedAt).not.toBeNull()
    })

    it('비로그인 401, 다른 사용자 403(방송자라도), 댓글은 남는다', async () => {
      const c = await write(viewer, '남을 댓글')
      expect((await del(c.id)).statusCode).toBe(401)
      const res = await del(c.id, other)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'FORBIDDEN', message: '본인이 작성한 댓글만 삭제할 수 있습니다' })
      expect((await del(c.id, owner)).statusCode).toBe(403)
      expect((await list()).json().items[0].content).toBe('남을 댓글')
    })

    it('이미 삭제된 댓글은 404', async () => {
      const c = await write(viewer, '지울 댓글')
      await del(c.id, viewer)
      expect((await del(c.id, viewer)).json().code).toBe('COMMENT_NOT_FOUND')
    })
  })

  it('작성·수정·삭제가 방송 SSE에 comment 이벤트로 전파된다', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/broadcasts/${broadcastId}/events`, {
      signal: controller.signal,
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const received: Array<{ type: string; comment: Comment }> = []
    const next = async () => {
      for (;;) {
        const found = received.shift()
        if (found) return found
        const { value, done } = await reader.read()
        if (done) throw new Error('stream closed')
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (/^event: comment$/m.test(block) && data) received.push(JSON.parse(data))
        }
      }
    }
    // 구독이 등록된 뒤에 작성한다 (연결 직후 status 이벤트가 먼저 온다)
    await reader.read()

    const c = await write(viewer, '실시간')
    expect(await next()).toMatchObject({ type: 'created', comment: { id: c.id, content: '실시간', isStreamer: false } })
    await patch(c.id, viewer, { content: '수정됨' })
    expect(await next()).toMatchObject({ type: 'updated', comment: { id: c.id, content: '수정됨' } })
    await del(c.id, viewer)
    expect(await next()).toMatchObject({ type: 'deleted', comment: { id: c.id, content: null, author: null } })
    controller.abort()
  })
})
