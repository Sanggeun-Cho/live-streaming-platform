import Fastify, { type FastifyError } from 'fastify'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
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

  app.setErrorHandler<FastifyError>((error, request, reply) => {
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

  await app.register(healthRoutes(db), { prefix: '/api' })
  await app.register(internalMediaRoutes, { prefix: '/internal' })

  app.addHook('onClose', async () => {
    db.sqlite.close()
  })

  return app
}
