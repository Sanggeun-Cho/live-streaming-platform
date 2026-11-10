// 공통 에러 형식 (#13): /api의 모든 4xx·5xx는 { code, message(한국어) } 두 필드만 가진다.
// Fastify가 라우트 전에 내는 오류(잘못된 JSON, 415, 413, 잘못된 URL)와 처리하지 못한 예외(500)도 포함한다.
// /internal(MediaMTX·Caddy 전용)은 상태 코드만 본다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../src/errors.js'
import { makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

const ENV = { TOSS_CLIENT_KEY: 'test_gck_errors', TOSS_SECRET_KEY: 'test_gsk_errors' }

/** 공통 형식이고 메시지가 한국어인지 확인한다. 영어 기본 문구·내부 정보(SQLITE, stack)가 섞이면 실패한다 */
function expectError(res: { statusCode: number; body: string }, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status)
  const body = JSON.parse(res.body) as Record<string, unknown>
  expect(Object.keys(body).sort()).toEqual(['code', 'message'])
  expect(body.code).toBe(code)
  expect(body.message).toMatch(/[가-힣]/)
  expect(body.message).not.toMatch(/Body|Unsupported|Invalid input|expected|SQLITE|constraint|at \w+ \(/i)
}

describe('공통 에러 형식', () => {
  let app: TestApp
  let user: TestUser
  let broadcastId: number

  beforeEach(async () => {
    ;({ app } = await makeApp(':memory:', ENV))
    // 처리하지 못한 예외(500) 재현용 라우트. 실제로는 DB 제약 위반·버그에서 난다
    app.get('/api/test/boom', async () => {
      throw Object.assign(new Error('UNIQUE constraint failed: users.email'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
    })
    app.get('/api/test/app-500', async () => {
      throw new AppError(500, 'SOMETHING_INTERNAL', 'db path /data/app.db is locked')
    })
    user = await signupAs(app, 'err')
    broadcastId = (
      await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: '에러 형식' }, cookies: { sid: user.sid } })
    ).json().broadcast.id
  })

  afterEach(async () => {
    await app.close()
  })

  const post = (url: string, payload: string | object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers, cookies: { sid: user.sid } })

  describe('Fastify 본문·URL 오류', () => {
    it('없는 경로·지원하지 않는 메서드는 404 NOT_FOUND', async () => {
      expectError(await app.inject({ method: 'GET', url: '/api/nope' }), 404, 'NOT_FOUND')
      expectError(await app.inject({ method: 'PUT', url: `/api/broadcasts/${broadcastId}` }), 404, 'NOT_FOUND')
    })

    it('JSON이 아닌 본문은 400 INVALID_JSON (빈 본문 포함)', async () => {
      const ct = { 'content-type': 'application/json' }
      expectError(await post('/api/broadcasts', '{"title":', ct), 400, 'INVALID_JSON')
      expectError(await post('/api/broadcasts', '', ct), 400, 'INVALID_JSON')
      // 프로토타입 오염 시도도 JSON 단계에서 거절된다
      expectError(await post('/api/broadcasts', '{"__proto__":{"admin":true},"title":"x"}', ct), 400, 'INVALID_JSON')
    })

    it('JSON 객체가 아닌 본문(배열·문자열·숫자)은 400 VALIDATION_ERROR', async () => {
      const ct = { 'content-type': 'application/json' }
      for (const payload of ['[1,2]', '"title"', '42']) {
        const res = await post('/api/broadcasts', payload, ct)
        expectError(res, 400, 'VALIDATION_ERROR')
        expect(res.json().message).toBe('요청 본문은 JSON 객체여야 합니다')
      }
    })

    it('JSON이 아닌 Content-Type은 415 UNSUPPORTED_MEDIA_TYPE', async () => {
      expectError(await post('/api/broadcasts', 'title=x', { 'content-type': 'application/x-www-form-urlencoded' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
      expectError(await post('/api/broadcasts', 'x', { 'content-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    })

    it('1MB를 넘는 본문은 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await post(`/api/broadcasts/${broadcastId}/comments`, { content: 'x'.repeat(1_100_000) })
      expectError(res, 413, 'PAYLOAD_TOO_LARGE')
    })

    it('퍼센트 인코딩이 깨진 주소는 400 BAD_URL', async () => {
      expectError(await app.inject({ method: 'GET', url: '/api/broadcasts/%E0%A4%A' }), 400, 'BAD_URL')
    })

    it('100자를 넘는 경로 파라미터는 414 URI_TOO_LONG', async () => {
      expectError(await app.inject({ method: 'GET', url: `/api/broadcasts/${'1'.repeat(150)}` }), 414, 'URI_TOO_LONG')
    })
  })

  describe('검증 오류는 400 VALIDATION_ERROR + 한국어', () => {
    it('필드 타입이 틀리면 (규칙에 메시지가 없는 경우도) 한국어', async () => {
      expectError(await post('/api/broadcasts', { title: '제목', description: 123 }), 400, 'VALIDATION_ERROR')
      expectError(await post('/api/auth/login', { email: 'a@b.com', password: 'x'.repeat(200) }), 400, 'VALIDATION_ERROR')
    })

    it('매우 긴 문자열은 길이 규칙으로 400 (본문 한도 안이면 413이 아니다)', async () => {
      expectError(await post('/api/broadcasts', { title: 'x'.repeat(101) }), 400, 'VALIDATION_ERROR')
      expectError(await post('/api/broadcasts', { title: 'x', description: 'x'.repeat(2001) }), 400, 'VALIDATION_ERROR')
      expectError(await post(`/api/broadcasts/${broadcastId}/comments`, { content: '가'.repeat(100_000) }), 400, 'VALIDATION_ERROR')
    })

    it.each(['0', '-1', '1.5', '1e3', '0x10', '%201', 'abc', '1234567890123456'])(
      '경로 ID "%s"는 400 (10진수 양의 정수, 15자리 이하만)',
      async (raw) => {
        expectError(await app.inject({ method: 'GET', url: `/api/broadcasts/${raw}` }), 400, 'VALIDATION_ERROR')
      },
    )

    it('15자리 ID는 형식이 맞으므로 404', async () => {
      expectError(await app.inject({ method: 'GET', url: '/api/broadcasts/999999999999999' }), 404, 'BROADCAST_NOT_FOUND')
    })

    it.each(['limit=0', 'limit=51', 'limit=abc', 'limit=1&limit=2', 'cursor=-5', 'status=live'])(
      '목록 쿼리 %s는 400',
      async (query) => {
        expectError(await app.inject({ method: 'GET', url: `/api/broadcasts?${query}` }), 400, 'VALIDATION_ERROR')
      },
    )

    it.each([999, 1500, 1_001_000, 0, -1000, '5000', 1e21, null])('후원 금액 %s는 400', async (amount) => {
      const res = await post(`/api/broadcasts/${broadcastId}/donation-orders`, { amount })
      expectError(res, 400, 'VALIDATION_ERROR')
    })

    it('JSON의 매우 큰 수(1e400 → Infinity)도 400', async () => {
      const res = await post(`/api/broadcasts/${broadcastId}/donation-orders`, '{"amount":1e400}', {
        'content-type': 'application/json',
      })
      expectError(res, 400, 'VALIDATION_ERROR')
    })
  })

  describe('인증·권한·상태·제한', () => {
    it('401 UNAUTHORIZED, 403 FORBIDDEN, 409 상태 충돌', async () => {
      expectError(await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: 'x' } }), 401, 'UNAUTHORIZED')
      const other = await signupAs(app, 'other')
      expectError(
        await app.inject({ method: 'DELETE', url: `/api/broadcasts/${broadcastId}`, cookies: { sid: other.sid } }),
        403,
        'FORBIDDEN',
      )
      await post(`/api/broadcasts/${broadcastId}/end`, {})
      expectError(await post(`/api/broadcasts/${broadcastId}/end`, {}), 409, 'BROADCAST_ENDED')
    })

    it('429 TOO_MANY_REQUESTS (로그인 시도 제한, 댓글 도배 제한)', async () => {
      let res
      for (let i = 0; i < 11; i++) res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.com', password: 'wrong' } })
      expectError(res!, 429, 'TOO_MANY_REQUESTS')
      for (let i = 0; i < 11; i++) res = await post(`/api/broadcasts/${broadcastId}/comments`, { content: `도배 ${i}` })
      expectError(res!, 429, 'TOO_MANY_REQUESTS')
    })
  })

  describe('500: 내부 정보를 숨긴다', () => {
    it('처리하지 못한 예외는 code·message 모두 일반 문구 (SQLITE_* 코드도 숨긴다)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test/boom' })
      expectError(res, 500, 'INTERNAL_ERROR')
      expect(res.json().message).toBe('서버 오류가 발생했습니다')
    })

    it('노출을 명시하지 않은 AppError 5xx는 문구를 숨긴다', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test/app-500' })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ code: 'SOMETHING_INTERNAL', message: '서버 오류가 발생했습니다' })
    })
  })
})
