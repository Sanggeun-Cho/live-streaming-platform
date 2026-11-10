import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/client.js'
import type { MediaControl } from '../src/media/control.js'
import type { TossClient } from '../src/payments/toss.js'

/** 테스트 기본값: MediaMTX에 송출이 하나도 없는 상태 */
export const idleMediaControl: MediaControl = {
  getSource: async () => null,
  listReadyPaths: async () => new Set(),
  kick: async () => {},
}

export type TestApp = Awaited<ReturnType<typeof buildApp>>

export async function makeApp(
  path = ':memory:',
  env: Record<string, string> = {},
  mediaControl: MediaControl = idleMediaControl,
  toss?: TossClient,
) {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: path, ...env })
  const db = createDb(path)
  const app = await buildApp({ config, db, mediaControl, toss })
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

export type SseEvent = { event: string; data: unknown }

/**
 * 실제 포트로 SSE를 연결하고, 조건에 맞는 이벤트가 올 때까지 읽는 함수를 돌려준다.
 * 앱이 아직 listen하지 않았으면 임의 포트로 연다. 끝나면 close()로 연결을 끊는다.
 * sid를 주면 그 사용자로 구독한다 (방송자 본인 연결 확인용).
 */
export async function openEvents(app: TestApp, broadcastId: number, sid?: string) {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as { port: number }
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/api/broadcasts/${broadcastId}/events`, {
    signal: controller.signal,
    headers: sid ? { cookie: `sid=${sid}` } : {},
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: SseEvent[] = []
  return {
    events,
    async waitFor(pred: (e: SseEvent) => boolean): Promise<SseEvent> {
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
    },
    close: () => controller.abort(),
  }
}
