import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/client.js'

describe('GET /api/health', () => {
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    await close?.()
  })

  it('DB가 정상이면 200과 ok를 반환한다', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }),
      db: createDb(':memory:'),
    })
    close = () => app.close()

    const res = await app.inject({ method: 'GET', url: '/api/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' })
  })

  it('없는 경로는 404 에러 형식으로 응답한다', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }),
      db: createDb(':memory:'),
    })
    close = () => app.close()

    const res = await app.inject({ method: 'GET', url: '/api/nope' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'NOT_FOUND', message: '요청한 리소스를 찾을 수 없습니다' })
  })
})

describe('로그 마스킹', () => {
  it('secret·token 쿼리 값을 가린다', async () => {
    const { redactQuery } = await import('../src/app.js')
    expect(redactQuery('/internal/media/auth?secret=abc&x=1&token=t')).toBe(
      '/internal/media/auth?secret=[redacted]&x=1&token=[redacted]',
    )
  })
})
