import cookie from '@fastify/cookie'
import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { Config } from '../config.js'
import { unauthorized } from '../errors.js'
import type { AuthService, AuthUser } from './service.js'

export const SESSION_COOKIE = 'sid'

declare module 'fastify' {
  interface FastifyRequest {
    /** 로그인한 사용자. 비로그인이면 null */
    user: AuthUser | null
  }
}

export type AuthPluginOptions = {
  config: Config
  auth: AuthService
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax' })
}

/** 라우트 preHandler: 로그인하지 않았으면 401 */
export async function requireAuth(request: FastifyRequest) {
  if (!request.user) throw unauthorized()
}

/**
 * 모든 요청에서 세션 쿠키를 읽어 request.user를 채운다.
 * 세션이 없거나 만료됐으면 쿠키를 지우고 비로그인으로 처리한다.
 */
export const authPlugin = fp<AuthPluginOptions>(async (app, { config, auth }) => {
  await app.register(cookie)
  app.decorateRequest('user', null)

  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (!token) return
    const session = auth.findSession(token)
    if (!session) {
      clearSessionCookie(reply, config)
      return
    }
    request.user = session.user
    if (session.renewed) {
      setSessionCookie(reply, config, token, session.expiresAt)
    }
  })
})
