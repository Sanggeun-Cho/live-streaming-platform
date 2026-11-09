// 권한 매트릭스 (DESIGN.md §5) 통합 테스트 (#13).
//
// 모든 쓰기 API와 공개 조회 API를 "비로그인 / 다른 사용자 / 소유자(작성자)"로 호출해 표의 칸과 같은지 확인한다.
// 표의 행을 그대로 옮겨 적어, 매트릭스가 바뀌면 이 표와 DESIGN §5를 함께 고치게 한다.
// 각 칸은 새 앱(메모리 DB)에서 독립적으로 실행한다 (쓰기가 다른 칸의 상태를 바꾸지 않게).
//
// 상태 전이 경계(종료·유예·동시 요청)는 internal-media.test.ts와 state-boundaries.test.ts,
// 후원 승인 세부(금액 대조·멱등)는 donations.test.ts에 있다. 여기서는 "누가 무엇을 할 수 있는가"만 본다.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TossClient } from '../src/payments/toss.js'
import { idleMediaControl, makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

const SECRET = 'test-internal-secret-0123456789'
const ENV = { INTERNAL_SECRET: SECRET, TOSS_CLIENT_KEY: 'test_gck_matrix', TOSS_SECRET_KEY: 'test_gsk_matrix' }

/** 받은 값 그대로 승인하는 토스 대역 (권한만 보므로 승인 세부는 donations.test.ts) */
const approvingToss: TossClient = {
  confirm: async ({ paymentKey, orderId, amount }) => ({ paymentKey, orderId, status: 'DONE', totalAmount: amount, currency: 'KRW' }),
  getPayment: async () => {
    throw new Error('not used')
  },
}

/** 테스트 세계: 방송자(streamer), 시청자(viewer: 댓글 작성자·후원자), 제3자(stranger) */
type World = {
  app: TestApp
  streamer: TestUser
  viewer: TestUser
  stranger: TestUser
  /** 상태별 방송 (모두 streamer 소유) */
  ready: number
  live: number
  ended: number
  deleted: number
  /** viewer가 ready 방송에 쓴 댓글 */
  commentId: number
  /** viewer가 live 방송에 만든 후원 주문 */
  orderId: string
}

type UserName = 'streamer' | 'viewer' | 'stranger'
type Actor = 'anon' | 'other' | 'owner' | 'broadcaster'
type Expected = number | [status: number, code: string]
type Send = (w: World, cookies: { sid: string } | undefined, actor: TestUser | undefined) => Promise<LightMyRequestResponse>

type Row = {
  /** DESIGN §5 표의 동작 이름 */
  action: string
  /** 이 행에서 "소유자/작성자"와 "다른 사용자"가 누구인가 */
  owner: UserName
  other: UserName
  send: Send
  expect: Partial<Record<Actor, Expected>>
}

const json = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, payload?: object): Send =>
  (w, cookies) => w.app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookies ? { cookies } : {}) })

const mediaAuth = (w: World, body: object) =>
  w.app.inject({
    method: 'POST',
    url: `/internal/media/auth?secret=${SECRET}`,
    payload: { protocol: 'webrtc', ip: '1.2.3.4', ...body },
  })

const U401: Expected = [401, 'UNAUTHORIZED']
const F403: Expected = [403, 'FORBIDDEN']

// ---- 쓰기 API (routes/*.ts의 POST·PATCH·DELETE 전부) ----
const writeRows: Row[] = [
  {
    action: '방송 등록 (POST /broadcasts)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', '/api/broadcasts', { title: '새 방송' })(w, c, undefined),
    expect: { anon: U401, other: 201, owner: 201 },
  },
  {
    action: '방송 수정 (PATCH /broadcasts/:id)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('PATCH', `/api/broadcasts/${w.ready}`, { title: '바꾼 제목' })(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200 },
  },
  {
    action: '방송 수정 — 종료된 방송도 소유자는 수정한다',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('PATCH', `/api/broadcasts/${w.ended}`, { description: '다시보기 설명' })(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200 },
  },
  {
    action: '방송 삭제 (DELETE /broadcasts/:id)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('DELETE', `/api/broadcasts/${w.ready}`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 204 },
  },
  {
    action: '방송 삭제 — LIVE 중',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('DELETE', `/api/broadcasts/${w.live}`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: [409, 'BROADCAST_LIVE'] },
  },
  {
    action: 'publish 토큰 발급 (READY)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ready}/publish-token`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200 },
  },
  {
    action: 'publish 토큰 발급 (LIVE, 재연결)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.live}/publish-token`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200 },
  },
  {
    action: 'publish 토큰 발급 (ENDED)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ended}/publish-token`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: [409, 'BROADCAST_ENDED'] },
  },
  {
    // 송출 = 토큰 발급을 시도한 뒤 그 토큰으로 MediaMTX 인가(publish)를 받는 전체 경로.
    // 토큰을 받지 못한 사람은 토큰 없이 시도한다 → MediaMTX 인가 401
    action: '송출 (MediaMTX publish 인가)',
    owner: 'streamer',
    other: 'viewer',
    send: async (w, c) => {
      const issued = await json('POST', `/api/broadcasts/${w.ready}/publish-token`)(w, c, undefined)
      const token = issued.statusCode === 200 ? (issued.json().token as string) : undefined
      return mediaAuth(w, { action: 'publish', path: `live/${w.ready}`, ...(token ? { token } : {}) })
    },
    expect: { anon: 401, other: 401, owner: 200 },
  },
  {
    action: '방송 종료 (READY)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ready}/end`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200 },
  },
  {
    action: '방송 종료 (LIVE)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.live}/end`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200 },
  },
  {
    action: '방송 종료 (이미 ENDED)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ended}/end`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: [409, 'BROADCAST_ENDED'] },
  },
  {
    // 댓글 작성은 "소유자"가 따로 없다: 방송자와 다른 사용자 모두 쓴다
    action: '댓글 작성 (POST /broadcasts/:id/comments)',
    owner: 'streamer',
    other: 'stranger',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ready}/comments`, { content: '안녕하세요' })(w, c, undefined),
    expect: { anon: U401, other: 201, owner: 201 },
  },
  {
    action: '댓글 작성 — 종료된 방송',
    owner: 'streamer',
    other: 'stranger',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ended}/comments`, { content: '다시보기 잘 봤어요' })(w, c, undefined),
    expect: { anon: U401, other: 201, owner: 201 },
  },
  {
    // 방송자도 남의 댓글은 수정·삭제할 수 없다 (관리 기능 없음)
    action: '댓글 수정 (PATCH /comments/:id)',
    owner: 'viewer',
    other: 'stranger',
    send: (w, c) => json('PATCH', `/api/comments/${w.commentId}`, { content: '고친 댓글' })(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200, broadcaster: F403 },
  },
  {
    action: '댓글 삭제 (DELETE /comments/:id)',
    owner: 'viewer',
    other: 'stranger',
    send: (w, c) => json('DELETE', `/api/comments/${w.commentId}`)(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200, broadcaster: F403 },
  },
  {
    // 후원의 "소유자"는 방송자다: 본인 방송에는 후원할 수 없다
    action: '후원 주문 (LIVE)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.live}/donation-orders`, { amount: 5000 })(w, c, undefined),
    expect: { anon: U401, other: 201, owner: F403 },
  },
  {
    action: '후원 주문 (READY)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ready}/donation-orders`, { amount: 5000 })(w, c, undefined),
    expect: { anon: U401, other: [409, 'BROADCAST_NOT_LIVE'], owner: F403 },
  },
  {
    action: '후원 주문 (ENDED)',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('POST', `/api/broadcasts/${w.ended}/donation-orders`, { amount: 5000 })(w, c, undefined),
    expect: { anon: U401, other: [409, 'BROADCAST_NOT_LIVE'], owner: F403 },
  },
  {
    // confirm의 "소유자"는 주문한 본인. 방송자도 남(후원자)의 주문은 확인할 수 없다
    action: '후원 승인 확인 (POST /donations/confirm)',
    owner: 'viewer',
    other: 'stranger',
    send: (w, c) =>
      json('POST', '/api/donations/confirm', { orderId: w.orderId, paymentKey: 'pk_matrix', amount: 5000 })(w, c, undefined),
    expect: { anon: U401, other: F403, owner: 200, broadcaster: F403 },
  },
  {
    // 토스 서버가 보내는 통지라 로그인과 무관하다. 본문은 믿지 않고 조회 API로 확인한다(donations.test.ts)
    action: '후원 웹훅 (POST /donations/webhook) — 공개',
    owner: 'viewer',
    other: 'stranger',
    send: (w, c) => json('POST', '/api/donations/webhook', { eventType: 'DEPOSIT_CALLBACK', data: {} })(w, c, undefined),
    expect: { anon: 200, other: 200, owner: 200 },
  },
  {
    action: '로그아웃 (POST /auth/logout) — 공개',
    owner: 'viewer',
    other: 'stranger',
    send: (w, c) => json('POST', '/api/auth/logout')(w, c, undefined),
    expect: { anon: 204, other: 204, owner: 204 },
  },
  {
    // 로그인한 상태에서 가입해도 된다 (이 브라우저의 이전 세션을 폐기하고 새 계정으로 로그인)
    action: '회원가입 (POST /auth/signup) — 공개',
    owner: 'viewer',
    other: 'stranger',
    send: (w, c) =>
      json('POST', '/api/auth/signup', {
        email: `new${Math.random().toString(36).slice(2)}@test.com`,
        password: 'password123',
        nickname: '새사용자',
      })(w, c, undefined),
    expect: { anon: 201, other: 201, owner: 201 },
  },
  {
    // MediaMTX 훅·인가는 공유 시크릿으로만 받는다. 사용자 세션은 아무 의미가 없다
    action: '내부 훅 (POST /internal/media/events) — 시크릿 없음',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) =>
      w.app.inject({
        method: 'POST',
        url: '/internal/media/events',
        payload: { type: 'online', path: `live/${w.ready}` },
        ...(c ? { cookies: c } : {}),
      }),
    expect: { anon: 401, other: 401, owner: 401 },
  },
]

// ---- 공개 조회 API: 비로그인·다른 사용자·소유자 모두 200 ----
const readRows: Row[] = [
  ['방송 목록', (w: World) => '/api/broadcasts'],
  ['방송 목록 (채널별)', (w: World) => `/api/broadcasts?channelId=${w.streamer.user.channelId}`],
  ['방송 상세', (w: World) => `/api/broadcasts/${w.live}`],
  ['채널 정보', (w: World) => `/api/channels/${w.streamer.user.channelId}`],
  ['댓글 목록', (w: World) => `/api/broadcasts/${w.ready}/comments`],
  ['후원 내역·합계', (w: World) => `/api/broadcasts/${w.live}/donations`],
  ['후원 설정', () => '/api/donations/config'],
  ['다시보기 목록', () => '/api/replays'],
  ['녹화 목록 (다시보기)', (w: World) => `/api/broadcasts/${w.ended}/recordings`],
].map(([action, url]) => ({
  action: action as string,
  owner: 'streamer' as const,
  other: 'viewer' as const,
  send: ((w, c) => json('GET', (url as (w: World) => string)(w))(w, c, undefined)) as Send,
  expect: { anon: 200, other: 200, owner: 200 },
}))

readRows.push(
  {
    // 시청 인가(WHEP read): LIVE면 누구나. MediaMTX 요청에는 사용자 세션이 없으므로 행위자와 무관하다
    action: '시청 (MediaMTX read 인가, LIVE)',
    owner: 'streamer',
    other: 'viewer',
    send: (w) => mediaAuth(w, { action: 'read', path: `live/${w.live}` }),
    expect: { anon: 200, other: 200, owner: 200 },
  },
  {
    action: '시청 (MediaMTX read 인가, READY·ENDED는 소유자도 거절)',
    owner: 'streamer',
    other: 'viewer',
    send: async (w) => {
      const ready = await mediaAuth(w, { action: 'read', path: `live/${w.ready}` })
      const ended = await mediaAuth(w, { action: 'read', path: `live/${w.ended}` })
      expect(ended.statusCode).toBe(ready.statusCode)
      return ready
    },
    expect: { anon: 403, other: 403, owner: 403 },
  },
  {
    action: '내 정보 (GET /auth/me) — 로그인 필요',
    owner: 'streamer',
    other: 'viewer',
    send: (w, c) => json('GET', '/api/auth/me')(w, c, undefined),
    expect: { anon: U401, other: 200, owner: 200 },
  },
)

// ---- 삭제된 방송: 소유자를 포함해 모두 404 (쓰기는 비로그인이면 401이 먼저) ----
const deletedRows: Row[] = (
  [
    ['상세', 'GET', (w: World) => `/api/broadcasts/${w.deleted}`, undefined, false],
    ['수정', 'PATCH', (w: World) => `/api/broadcasts/${w.deleted}`, { title: 'x' }, true],
    ['삭제', 'DELETE', (w: World) => `/api/broadcasts/${w.deleted}`, undefined, true],
    ['publish 토큰', 'POST', (w: World) => `/api/broadcasts/${w.deleted}/publish-token`, undefined, true],
    ['종료', 'POST', (w: World) => `/api/broadcasts/${w.deleted}/end`, undefined, true],
    ['SSE 구독', 'GET', (w: World) => `/api/broadcasts/${w.deleted}/events`, undefined, false],
    ['댓글 목록', 'GET', (w: World) => `/api/broadcasts/${w.deleted}/comments`, undefined, false],
    ['댓글 작성', 'POST', (w: World) => `/api/broadcasts/${w.deleted}/comments`, { content: '안녕' }, true],
    ['후원 주문', 'POST', (w: World) => `/api/broadcasts/${w.deleted}/donation-orders`, { amount: 5000 }, true],
    ['후원 내역', 'GET', (w: World) => `/api/broadcasts/${w.deleted}/donations`, undefined, false],
    ['녹화 목록', 'GET', (w: World) => `/api/broadcasts/${w.deleted}/recordings`, undefined, false],
  ] as const
).map(([name, method, url, payload, needsAuth]) => ({
  action: `삭제된 방송 — ${name}`,
  owner: 'streamer' as const,
  other: 'viewer' as const,
  send: ((w, c) => json(method, url(w), payload)(w, c, undefined)) as Send,
  expect: {
    anon: needsAuth ? U401 : ([404, 'BROADCAST_NOT_FOUND'] as Expected),
    other: [404, 'BROADCAST_NOT_FOUND'] as Expected,
    owner: [404, 'BROADCAST_NOT_FOUND'] as Expected,
  },
}))

/** 행 × 행위자 → it.each 케이스 */
function cases(rows: Row[]) {
  return rows.flatMap((row) =>
    (Object.entries(row.expect) as Array<[Actor, Expected]>).map(([actor, expected]) => ({
      name: `${row.action} | ${actor}`,
      row,
      actor,
      expected,
    })),
  )
}

describe('권한 매트릭스 (DESIGN §5)', () => {
  let w: World
  // 준비(가입 3명의 argon2 해시 등)를 칸마다 반복하면 느리고 전체 테스트에서 시간 초과가 난다.
  // 한 번 만든 DB 파일을 칸마다 복사해 새 앱으로 연다 (세션도 DB에 있어 쿠키가 그대로 유효하다)
  let dir: string
  let template: string
  let fixture: Omit<World, 'app'>
  let seq = 0

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'authz-matrix-'))
    template = join(dir, 'template.db')
    const { app } = await makeApp(template, ENV, idleMediaControl, approvingToss)
    const streamer = await signupAs(app, 'streamer')
    const viewer = await signupAs(app, 'viewer')
    const stranger = await signupAs(app, 'stranger')
    const as = (u: TestUser) => ({ cookies: { sid: u.sid } })
    const create = async (title: string) =>
      (await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title }, ...as(streamer) })).json().broadcast
        .id as number
    const hook = (type: 'online', id: number) =>
      app.inject({
        method: 'POST',
        url: '/internal/media/events',
        headers: { 'x-internal-secret': SECRET },
        payload: { type, path: `live/${id}` },
      })

    const ready = await create('대기 방송')
    const live = await create('방송 중')
    await hook('online', live)
    const ended = await create('종료된 방송')
    await app.inject({ method: 'POST', url: `/api/broadcasts/${ended}/end`, ...as(streamer) })
    const deleted = await create('삭제된 방송')
    await app.inject({ method: 'DELETE', url: `/api/broadcasts/${deleted}`, ...as(streamer) })

    const comment = await app.inject({
      method: 'POST',
      url: `/api/broadcasts/${ready}/comments`,
      payload: { content: '시청자 댓글' },
      ...as(viewer),
    })
    const order = await app.inject({
      method: 'POST',
      url: `/api/broadcasts/${live}/donation-orders`,
      payload: { amount: 5000 },
      ...as(viewer),
    })
    fixture = {
      streamer,
      viewer,
      stranger,
      ready,
      live,
      ended,
      deleted,
      commentId: comment.json().comment.id,
      orderId: order.json().order.orderId,
    }
    // 세계가 의도한 상태인지 먼저 확인한다 (준비가 틀리면 아래 칸이 엉뚱한 이유로 통과할 수 있다)
    const status = async (id: number) => (await app.inject({ method: 'GET', url: `/api/broadcasts/${id}` })).json().broadcast.status
    expect([await status(ready), await status(live), await status(ended)]).toEqual(['READY', 'LIVE', 'ENDED'])
    // 닫으면 WAL이 본 파일에 합쳐져 파일 하나만 복사하면 된다
    await app.close()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    const path = join(dir, `case-${++seq}.db`)
    copyFileSync(template, path)
    const { app } = await makeApp(path, ENV, idleMediaControl, approvingToss)
    w = { app, ...fixture }
  })

  afterEach(async () => {
    await w.app.close()
  })

  async function run(row: Row, actor: Actor) {
    const user =
      actor === 'anon' ? undefined : actor === 'owner' ? w[row.owner] : actor === 'other' ? w[row.other] : w.streamer
    return row.send(w, user ? { sid: user.sid } : undefined, user)
  }

  function check(res: LightMyRequestResponse, expected: Expected) {
    const [status, code] = Array.isArray(expected) ? expected : [expected, undefined]
    expect(res.statusCode, res.body).toBe(status)
    if (code) {
      // 4xx는 모두 공통 형식 {code, message(한국어)}
      expect(res.json()).toEqual({ code, message: expect.stringMatching(/[가-힣]/) })
    }
  }

  describe('쓰기', () => {
    it.each(cases(writeRows))('$name', async ({ row, actor, expected }) => {
      check(await run(row, actor), expected)
    })
  })

  describe('공개 조회', () => {
    it.each(cases(readRows))('$name', async ({ row, actor, expected }) => {
      check(await run(row, actor), expected)
    })
  })

  describe('삭제된 방송', () => {
    it.each(cases(deletedRows))('$name', async ({ row, actor, expected }) => {
      check(await run(row, actor), expected)
    })
  })

  // ---- 거절된 요청은 아무것도 바꾸지 않는다 ----

  it('거절된 수정·삭제·종료는 방송을 바꾸지 않는다', async () => {
    const before = (await w.app.inject({ method: 'GET', url: `/api/broadcasts/${w.live}` })).json().broadcast
    for (const u of [undefined, w.viewer]) {
      const cookies = u ? { cookies: { sid: u.sid } } : {}
      await w.app.inject({ method: 'PATCH', url: `/api/broadcasts/${w.live}`, payload: { title: '탈취' }, ...cookies })
      await w.app.inject({ method: 'POST', url: `/api/broadcasts/${w.live}/end`, ...cookies })
      await w.app.inject({ method: 'DELETE', url: `/api/broadcasts/${w.live}`, ...cookies })
    }
    const after = (await w.app.inject({ method: 'GET', url: `/api/broadcasts/${w.live}` })).json().broadcast
    expect(after).toEqual(before)
  })

  it('다른 사용자가 방송을 등록하면 자기 채널에 만들어진다 (남의 채널을 지정할 수 없다)', async () => {
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/broadcasts',
      payload: { title: '내 방송', channelId: w.streamer.user.channelId },
      cookies: { sid: w.viewer.sid },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().broadcast.channel.id).toBe(w.viewer.user.channelId)
  })

  it('다른 방송의 publish 토큰으로는 송출할 수 없다', async () => {
    const token = (
      await w.app.inject({ method: 'POST', url: `/api/broadcasts/${w.live}/publish-token`, cookies: { sid: w.streamer.sid } })
    ).json().token as string
    const res = await mediaAuth(w, { action: 'publish', path: `live/${w.ready}`, token })
    expect(res.statusCode).toBe(401)
  })

  it('세션이 위조됐거나 로그아웃한 쿠키는 비로그인과 같다 (401)', async () => {
    const forged = await w.app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: 'x' }, cookies: { sid: 'forged' } })
    expect(forged.statusCode).toBe(401)
    await w.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { sid: w.viewer.sid } })
    const loggedOut = await w.app.inject({
      method: 'POST',
      url: `/api/broadcasts/${w.ready}/comments`,
      payload: { content: '로그아웃 후' },
      cookies: { sid: w.viewer.sid },
    })
    expect(loggedOut.statusCode).toBe(401)
  })
})
