// 인증 서비스 내부 동작 중 HTTP 응답만으로는 드러나지 않는 것 (#31)
// - 없는 이메일 로그인도 해시 검증을 한 번 수행한다 (응답 시간으로 계정 존재 여부가 드러나지 않게)
// - 테스트 계정 시드는 "이미 있음(EMAIL_TAKEN)"만 무시하고 다른 오류는 기동을 막는다
// 시간을 재는 대신 argon2 verify 호출을 감시한다 (시간 측정은 CI에서 흔들린다)

import * as argon2 from '@node-rs/argon2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthService } from '../src/auth/service.js'
import { createDb } from '../src/db/client.js'
import { ensureTestAccounts, TEST_ACCOUNTS } from '../src/db/test-accounts.js'
import { AppError } from '../src/errors.js'

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>()
  return { ...actual, verify: vi.fn(actual.verify) }
})

describe('로그인 시간 균등화', () => {
  let db: ReturnType<typeof createDb>
  beforeEach(() => {
    db = createDb(':memory:')
    vi.mocked(argon2.verify).mockClear()
  })
  afterEach(() => db.sqlite.close())

  it('없는 이메일이어도 더미 해시로 비밀번호 검증을 한 번 수행하고 401', async () => {
    const auth = createAuthService(db, { sessionTtlDays: 30 })
    await expect(auth.verifyCredentials('nobody@example.com', 'whatever1')).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_CREDENTIALS',
    })
    expect(argon2.verify).toHaveBeenCalledTimes(1)
    const [hashed, password] = vi.mocked(argon2.verify).mock.calls[0]!
    // 실제 argon2 해시 문자열에 대해 같은 비용으로 검증한다
    expect(String(hashed)).toMatch(/^\$argon2id\$/)
    expect(password).toBe('whatever1')
  })

  it('있는 이메일·틀린 비밀번호도 검증을 한 번 수행한다 (두 경로의 비용이 같다)', async () => {
    const auth = createAuthService(db, { sessionTtlDays: 30 })
    await auth.signup({ email: 'a@example.com', password: 'password123', nickname: '에이' })
    await expect(auth.verifyCredentials('a@example.com', 'wrong-password')).rejects.toMatchObject({ statusCode: 401 })
    expect(argon2.verify).toHaveBeenCalledTimes(1)
  })
})

describe('테스트 계정 시드 (ensureTestAccounts)', () => {
  let db: ReturnType<typeof createDb>
  beforeEach(() => {
    db = createDb(':memory:')
  })
  afterEach(() => db.sqlite.close())

  const authWith = (signup: () => Promise<never>) =>
    ({ ...createAuthService(db, { sessionTtlDays: 30 }), signup }) as ReturnType<typeof createAuthService>

  it('확인과 생성 사이에 다른 프로세스가 먼저 만들었으면(EMAIL_TAKEN) 건너뛴다', async () => {
    const auth = authWith(async () => {
      throw new AppError(409, 'EMAIL_TAKEN', '이미 가입된 이메일입니다')
    })
    expect(await ensureTestAccounts(db, auth)).toEqual([])
  })

  it('그 밖의 오류(DB 장애 등)는 삼키지 않고 기동을 실패시킨다', async () => {
    const auth = authWith(async () => {
      throw new Error('disk I/O error')
    })
    await expect(ensureTestAccounts(db, auth)).rejects.toThrow('disk I/O error')
    const other = authWith(async () => {
      throw new AppError(400, 'VALIDATION_ERROR', '잘못된 입력')
    })
    await expect(ensureTestAccounts(db, other)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('없는 계정만 만들고 만든 이메일을 돌려준다', async () => {
    const auth = createAuthService(db, { sessionTtlDays: 30 })
    expect(await ensureTestAccounts(db, auth)).toEqual(TEST_ACCOUNTS.map((a) => a.email))
    expect(await ensureTestAccounts(db, auth)).toEqual([])
  })
})

describe('만료 세션 정리 (deleteExpiredSessions)', () => {
  let db: ReturnType<typeof createDb>
  beforeEach(() => {
    db = createDb(':memory:')
  })
  afterEach(() => {
    vi.useRealTimers()
    db.sqlite.close()
  })

  it('만료된 세션만 지우고 유효한 세션은 남긴다', async () => {
    const auth = createAuthService(db, { sessionTtlDays: 1 })
    const user = await auth.signup({ email: 'a@example.com', password: 'password123', nickname: '에이' })
    // 2일 전에 만든 세션(TTL 1일)은 이미 만료, 지금 만든 세션은 유효
    vi.useFakeTimers({ now: Date.now() - 2 * 24 * 60 * 60 * 1000, toFake: ['Date'] })
    const expired = auth.createSession(user.id)
    vi.useRealTimers()
    const valid = auth.createSession(user.id)

    expect(auth.deleteExpiredSessions()).toBe(1)
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 })
    expect(auth.findSession(valid.token)).toBeDefined()
    expect(auth.findSession(expired.token)).toBeUndefined()
  })
})
