import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { clearSessionCookie, requireAuth, SESSION_COOKIE, setSessionCookie } from '../auth/plugin.js'
import type { AuthService } from '../auth/service.js'
import type { Config } from '../config.js'
import { validationError } from '../errors.js'

const email = z
  .string({ error: '이메일을 입력하세요' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: '이메일 형식이 올바르지 않습니다' }).max(254, { error: '이메일이 너무 깁니다' }))

const signupBody = z.object({
  email,
  // argon2는 길이 제한이 없지만, 과도한 입력으로 해시 비용을 키우지 못하게 상한을 둔다
  password: z
    .string({ error: '비밀번호를 입력하세요' })
    .min(8, { error: '비밀번호는 8자 이상이어야 합니다' })
    .max(128, { error: '비밀번호는 128자 이하여야 합니다' }),
  nickname: z
    .string({ error: '닉네임을 입력하세요' })
    .trim()
    .min(2, { error: '닉네임은 2자 이상이어야 합니다' })
    .max(20, { error: '닉네임은 20자 이하여야 합니다' }),
})

const loginBody = z.object({
  email,
  password: z.string({ error: '비밀번호를 입력하세요' }).min(1, { error: '비밀번호를 입력하세요' }).max(128),
})

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {})
  if (!result.success) throw validationError(result.error)
  return result.data
}

export const authRoutes =
  ({ config, auth }: { config: Config; auth: AuthService }): FastifyPluginAsync =>
  async (app) => {
    app.post('/auth/signup', async (request, reply) => {
      const input = parse(signupBody, request.body)
      const user = await auth.signup(input)
      // 가입 직후 바로 로그인 상태로 만든다
      const session = auth.createSession(user.id)
      setSessionCookie(reply, config, session.token, session.expiresAt)
      return reply.code(201).send({ user })
    })

    app.post('/auth/login', async (request, reply) => {
      const input = parse(loginBody, request.body)
      const user = await auth.verifyCredentials(input.email, input.password)
      // 이전 세션 쿠키가 있으면 폐기하고 새로 발급한다 (세션 고정 방지)
      const previous = request.cookies[SESSION_COOKIE]
      if (previous) auth.deleteSession(previous)
      auth.deleteExpiredSessions()
      const session = auth.createSession(user.id)
      setSessionCookie(reply, config, session.token, session.expiresAt)
      return reply.send({ user })
    })

    app.post('/auth/logout', async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE]
      if (token) auth.deleteSession(token)
      clearSessionCookie(reply, config)
      return reply.code(204).send()
    })

    app.get('/auth/me', { preHandler: requireAuth }, async (request) => {
      return { user: request.user }
    })
  }
