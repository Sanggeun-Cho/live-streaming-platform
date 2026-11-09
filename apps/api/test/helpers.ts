import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/client.js'

export type TestApp = Awaited<ReturnType<typeof buildApp>>

export async function makeApp(path = ':memory:', env: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: path, ...env })
  const db = createDb(path)
  const app = await buildApp({ config, db })
  return { app, db, config }
}

export type TestUser = {
  sid: string
  user: { id: number; email: string; nickname: string; channelId: number }
}

/** 회원가입하고 세션 쿠키 값을 돌려준다 */
export async function signupAs(app: TestApp, name: string): Promise<TestUser> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: `${name}@test.com`, password: 'password123', nickname: `${name}님` },
  })
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`)
  const sid = res.cookies.find((c) => c.name === 'sid')!.value
  return { sid, user: res.json().user }
}
