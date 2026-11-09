import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/client.js'

describe('MediaMTX 내부 훅', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' })
    app = await buildApp({ config, db: createDb(config.DATABASE_PATH) })
  })
  afterAll(() => app.close())

  it('authHTTPAddress 요청 형식을 받는다', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/media/auth',
      payload: { user: '', password: '', token: '', ip: '172.18.0.1', action: 'publish', path: 'live/1', protocol: 'webrtc', id: null, query: '' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('notify.sh 이벤트를 받고, 형식이 틀리면 400', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/internal/media/events',
      payload: { type: 'online', path: 'live/1', sourceType: 'webRTCSession', segmentPath: '', segmentDuration: '' },
    })
    expect(ok.statusCode).toBe(204)

    const bad = await app.inject({ method: 'POST', url: '/internal/media/events', payload: { type: 'ready', path: 'live/1' } })
    expect(bad.statusCode).toBe(400)
  })

  it('/internal은 Caddy가 프록시하지 않는 경로다 (/api 아래에 없음)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/internal/media/auth', payload: {} })
    expect(res.statusCode).toBe(404)
  })
})
