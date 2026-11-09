import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashToken } from '../src/auth/service.js'
import type { createDb } from '../src/db/client.js'
import { channels, sessions } from '../src/db/schema.js'
import { makeApp, type TestApp } from './helpers.js'

type App = TestApp

const ACCOUNT = { email: 'Alice@Example.com', password: 'password123', nickname: '앨리스' }

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }) {
  return res.cookies.find((c) => c.name === 'sid')
}

describe('인증 API', () => {
  let app: App
  let db: ReturnType<typeof createDb>

  beforeEach(async () => {
    ;({ app, db } = await makeApp())
  })

  afterEach(async () => {
    await app.close()
  })

  const signup = (body: object = ACCOUNT) => app.inject({ method: 'POST', url: '/api/auth/signup', payload: body })
  const login = (body: object) => app.inject({ method: 'POST', url: '/api/auth/login', payload: body })
  const me = (sid?: string) =>
    app.inject({ method: 'GET', url: '/api/auth/me', cookies: sid ? { sid } : {} })

  it('회원가입하면 201, 채널이 생기고, 보안 속성을 가진 세션 쿠키로 로그인된다', async () => {
    const res = await signup()

    expect(res.statusCode).toBe(201)
    const { user } = res.json()
    expect(user).toMatchObject({ email: 'alice@example.com', nickname: '앨리스' })
    expect(user).not.toHaveProperty('passwordHash')

    const channel = db.orm.select().from(channels).all()
    expect(channel).toHaveLength(1)
    expect(channel[0]).toMatchObject({ id: user.channelId, userId: user.id })

    const cookie = sessionCookie(res)
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })

    const meRes = await me(cookie!.value)
    expect(meRes.statusCode).toBe(200)
    expect(meRes.json().user).toEqual(user)
  })

  it('DB에는 세션 토큰 원문이 아니라 해시만 저장한다', async () => {
    const token = sessionCookie(await signup())!.value
    const rows = db.orm.select().from(sessions).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(hashToken(token))
    expect(rows[0]!.id).not.toBe(token)
  })

  it('같은 이메일(대소문자 무관)로 다시 가입하면 409', async () => {
    await signup()
    const res = await signup({ ...ACCOUNT, email: 'ALICE@example.com' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'EMAIL_TAKEN' })
  })

  it.each([
    [{ ...ACCOUNT, email: 'not-an-email' }],
    [{ ...ACCOUNT, password: 'short' }],
    [{ ...ACCOUNT, nickname: 'a' }],
    [{}],
  ])('잘못된 입력은 400 VALIDATION_ERROR: %o', async (body) => {
    const res = await signup(body)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('올바른 비밀번호로 로그인하면 200과 새 세션', async () => {
    await signup()
    const res = await login({ email: 'alice@example.com', password: ACCOUNT.password })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe('alice@example.com')
    expect((await me(sessionCookie(res)!.value)).statusCode).toBe(200)
  })

  it('틀린 비밀번호와 없는 이메일은 같은 401 응답', async () => {
    await signup()
    const wrong = await login({ email: ACCOUNT.email, password: 'wrong-password' })
    const unknown = await login({ email: 'nobody@example.com', password: 'whatever1' })
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.json()).toEqual(unknown.json())
    expect(sessionCookie(wrong)).toBeUndefined()
  })

  it('로그인하면 요청에 실려 온 이전 세션은 폐기된다', async () => {
    const old = sessionCookie(await signup())!.value
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ACCOUNT.email, password: ACCOUNT.password },
      cookies: { sid: old },
    })
    expect(res.statusCode).toBe(200)
    expect((await me(old)).statusCode).toBe(401)
  })

  it('로그아웃하면 세션이 삭제되고 쿠키가 지워진다', async () => {
    const sid = sessionCookie(await signup())!.value
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { sid } })
    expect(res.statusCode).toBe(204)
    expect(sessionCookie(res)?.value).toBe('')
    expect((await me(sid)).statusCode).toBe(401)
  })

  it('쿠키가 없거나 위조된 세션이면 /me는 401', async () => {
    expect((await me()).statusCode).toBe(401)
    const forged = await me('forged-token')
    expect(forged.statusCode).toBe(401)
    expect(forged.json()).toMatchObject({ code: 'UNAUTHORIZED' })
    // 무효 쿠키는 지워 준다
    expect(sessionCookie(forged)?.value).toBe('')
  })

  it('JSON이 아닌 본문(text/plain, 폼)은 415로 거부한다', async () => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': contentType },
        payload: 'email=a@b.com&password=x',
      })
      expect(res.statusCode).toBe(415)
    }
  })

  it('로그인은 IP당 분당 10회를 넘으면 429 TOO_MANY_REQUESTS', async () => {
    const body = { email: 'nobody@example.com', password: 'whatever1' }
    for (let i = 0; i < 10; i++) {
      expect((await login(body)).statusCode).toBe(401)
    }
    const res = await login(body)
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' })
    expect(res.json().message).toMatch(/초 후 다시 시도/)
  })

  it('신뢰하지 않는 출처가 보낸 X-Forwarded-For로는 시도 제한을 우회할 수 없다', async () => {
    const body = { email: 'nobody@example.com', password: 'whatever1' }
    const spoofed = (i: number) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: body, headers: { 'x-forwarded-for': `10.0.0.${i}` } })
    for (let i = 0; i < 10; i++) {
      expect((await spoofed(i)).statusCode).toBe(401)
    }
    expect((await spoofed(99)).statusCode).toBe(429)
  })

  it('회원가입도 요청에 실려 온 이전 세션을 폐기한다', async () => {
    const old = sessionCookie(await signup())!.value
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { ...ACCOUNT, email: 'bob@example.com', nickname: '밥아저씨' },
      cookies: { sid: old },
    })
    expect(res.statusCode).toBe(201)
    expect((await me(old)).statusCode).toBe(401)
    expect((await me(sessionCookie(res)!.value)).json().user.email).toBe('bob@example.com')
  })

  it('만료된 세션은 거부된다', async () => {
    const sid = sessionCookie(await signup())!.value
    db.orm.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).run()
    expect((await me(sid)).statusCode).toBe(401)
  })

  it('남은 기간이 절반 이하인 세션은 만료가 연장되고 쿠키를 다시 내려준다', async () => {
    const sid = sessionCookie(await signup())!.value
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000)
    db.orm.update(sessions).set({ expiresAt: soon }).run()

    const res = await me(sid)
    expect(res.statusCode).toBe(200)
    expect(sessionCookie(res)?.value).toBe(sid)
    const row = db.orm.select().from(sessions).get()!
    expect(row.expiresAt.getTime()).toBeGreaterThan(soon.getTime())
  })
})

describe('리버스 프록시 신뢰 (TRUST_PROXY)', () => {
  it('신뢰하는 프록시(Caddy)가 전달한 클라이언트 IP별로 시도 횟수를 센다', async () => {
    // inject 요청의 소켓 주소는 127.0.0.1이다. 운영에서는 Caddy 컨테이너 IP가 이 자리에 온다.
    const { app } = await makeApp(':memory:', { TRUST_PROXY: '127.0.0.1' })
    const body = { email: 'nobody@example.com', password: 'whatever1' }
    const from = (ip: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: body, headers: { 'x-forwarded-for': ip } })
    for (let i = 0; i < 10; i++) {
      expect((await from('203.0.113.1')).statusCode).toBe(401)
    }
    expect((await from('203.0.113.1')).statusCode).toBe(429)
    // 다른 사용자는 영향을 받지 않는다
    expect((await from('203.0.113.2')).statusCode).toBe(401)
    await app.close()
  })
})

describe('세션 영속성', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-auth-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('서버를 재시작해도 로그인이 유지된다', async () => {
    const path = join(dir, 'app.db')

    const first = await makeApp(path)
    const res = await first.app.inject({ method: 'POST', url: '/api/auth/signup', payload: ACCOUNT })
    const sid = sessionCookie(res)!.value
    await first.app.close()

    const second = await makeApp(path)
    const meRes = await second.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { sid } })
    await second.app.close()

    expect(meRes.statusCode).toBe(200)
    expect(meRes.json().user.email).toBe('alice@example.com')
  })
})
