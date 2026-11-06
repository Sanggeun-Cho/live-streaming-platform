import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError } from 'fastify'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { authPlugin } from './auth/plugin.js'
import { createAuthService } from './auth/service.js'
import { AppError } from './errors.js'
import { authRoutes } from './routes/auth.js'
import { healthRoutes } from './routes/health.js'
import { internalMediaRoutes } from './routes/internal-media.js'

export type AppDeps = {
  config: Config
  db: Db
}

export async function buildApp({ config, db }: AppDeps) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    // Caddy 뒤에서 동작하므로 X-Forwarded-* 헤더를 신뢰한다
    trustProxy: true,
  })

  app.setErrorHandler<FastifyError | AppError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error')
    }
    reply.code(statusCode).send({
      code: error.code ?? 'INTERNAL_ERROR',
      message: statusCode >= 500 ? '서버 오류가 발생했습니다' : error.message,
    })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ code: 'NOT_FOUND', message: '요청한 리소스를 찾을 수 없습니다' })
  })

  // 기본 text/plain 파서를 제거해 JSON 본문만 받는다.
  // 교차 사이트 <form enctype="text/plain"> 전송은 415로 막힌다 (SameSite=Lax와 함께 CSRF 방어).
  app.removeContentTypeParser('text/plain')

  // 로그인·가입은 IP당 시도 횟수를 제한한다 (라우트별 config.rateLimit로 켠다)
  await app.register(rateLimit, { global: false })

  const auth = createAuthService(db, { sessionTtlDays: config.SESSION_TTL_DAYS })
  auth.deleteExpiredSessions()
  const cleanup = setInterval(() => auth.deleteExpiredSessions(), 60 * 60 * 1000)
  cleanup.unref()
  await app.register(authPlugin, { config, auth })

  await app.register(healthRoutes(db), { prefix: '/api' })
  await app.register(authRoutes({ config, auth }), { prefix: '/api' })
  await app.register(internalMediaRoutes, { prefix: '/internal' })

  app.addHook('onClose', async () => {
    clearInterval(cleanup)
    db.sqlite.close()
  })

  return app
}
