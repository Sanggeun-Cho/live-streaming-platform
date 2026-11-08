import { createHash, randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { channels, sessions, users } from '../db/schema.js'
import { AppError } from '../errors.js'

const DAY_MS = 24 * 60 * 60 * 1000

export type AuthUser = {
  id: number
  email: string
  nickname: string
  channelId: number
}

export type SessionInfo = {
  user: AuthUser
  expiresAt: Date
  // 만료 연장으로 쿠키를 다시 내려줘야 하면 true
  renewed: boolean
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

export function createAuthService(db: Db, opts: { sessionTtlDays: number }) {
  const ttlMs = opts.sessionTtlDays * DAY_MS
  const { orm } = db
  // 존재하지 않는 이메일로 로그인해도 해시 검증을 한 번 수행해 응답 시간으로 계정 존재 여부가 드러나지 않게 한다.
  // 첫 요청에서 해시 생성 비용이 더해지지 않도록 기동 시점에 미리 만든다.
  const dummyHash = hash('timing-equalizer-password')

  function loadUser(userId: number): AuthUser | undefined {
    return orm
      .select({ id: users.id, email: users.email, nickname: users.nickname, channelId: channels.id })
      .from(users)
      .innerJoin(channels, eq(channels.userId, users.id))
      .where(eq(users.id, userId))
      .get()
  }

  return {
    /** 사용자와 채널을 한 트랜잭션에서 만든다 */
    async signup(input: { email: string; password: string; nickname: string }): Promise<AuthUser> {
      const emailTaken = () => new AppError(409, 'EMAIL_TAKEN', '이미 가입된 이메일입니다')
      // 중복이면 비싼 argon2 해시 전에 끝낸다. 동시 가입 경합은 아래 UNIQUE 제약이 막는다.
      // 가입 단계에서 이메일 사용 여부가 드러나는 것은 허용한다 (시도 횟수 제한으로 대량 조회만 막는다).
      if (orm.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get()) {
        throw emailTaken()
      }
      const passwordHash = await hash(input.password)
      try {
        return orm.transaction((tx) => {
          const user = tx
            .insert(users)
            .values({ email: input.email, nickname: input.nickname, passwordHash })
            .returning({ id: users.id })
            .get()
          const channel = tx
            .insert(channels)
            .values({ userId: user.id, name: `${input.nickname}의 채널` })
            .returning({ id: channels.id })
            .get()
          return { id: user.id, email: input.email, nickname: input.nickname, channelId: channel.id }
        })
      } catch (err) {
        if (isUniqueViolation(err)) throw emailTaken()
        throw err
      }
    },

    async verifyCredentials(email: string, password: string): Promise<AuthUser> {
      const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다')
      const row = orm
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .get()
      if (!row) {
        await verify(await dummyHash, password)
        throw invalid()
      }
      if (!(await verify(row.passwordHash, password))) throw invalid()
      const user = loadUser(row.id)
      if (!user) throw invalid()
      return user
    },

    /** 새 세션을 만들고 쿠키에 담을 원본 토큰을 돌려준다. DB에는 해시만 저장한다. */
    createSession(userId: number): { token: string; expiresAt: Date } {
      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + ttlMs)
      orm.insert(sessions).values({ id: hashToken(token), userId, expiresAt }).run()
      return { token, expiresAt }
    },

    /** 유효한 세션이면 사용자를 돌려준다. 남은 기간이 절반 이하면 만료를 연장한다(슬라이딩). */
    findSession(token: string): SessionInfo | undefined {
      const id = hashToken(token)
      const now = Date.now()
      // 모든 /api 요청에서 호출되므로 세션·사용자·채널을 한 번의 조인으로 읽는다
      const row = orm
        .select({
          expiresAt: sessions.expiresAt,
          user: { id: users.id, email: users.email, nickname: users.nickname, channelId: channels.id },
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .innerJoin(channels, eq(channels.userId, users.id))
        .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date(now))))
        .get()
      if (!row) return undefined
      const { user, expiresAt: currentExpiry } = row

      if (currentExpiry.getTime() - now < ttlMs / 2) {
        const expiresAt = new Date(now + ttlMs)
        orm.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run()
        return { user, expiresAt, renewed: true }
      }
      return { user, expiresAt: currentExpiry, renewed: false }
    },

    deleteSession(token: string): void {
      orm.delete(sessions).where(eq(sessions.id, hashToken(token))).run()
    },

    deleteExpiredSessions(): number {
      return orm.delete(sessions).where(lt(sessions.expiresAt, new Date())).run().changes
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
