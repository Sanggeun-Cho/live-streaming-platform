import type { FastifyPluginAsync } from 'fastify'
import type { Db } from '../db/client.js'

// 이미지 빌드 때 넣은 커밋(GIT_SHA). 자동 배포가 운영에 새 버전이 올라갔는지 이 값으로 확인한다
const version = process.env.APP_VERSION || 'dev'

export const healthRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  app.get('/health', async (request, reply) => {
    let dbStatus = 'ok'
    try {
      db.sqlite.prepare('SELECT 1').get()
    } catch (err) {
      request.log.error({ err }, 'DB health check failed')
      dbStatus = 'error'
    }
    const body = { status: dbStatus === 'ok' ? 'ok' : 'degraded', db: dbStatus, version, time: new Date().toISOString() }
    return reply.code(dbStatus === 'ok' ? 200 : 503).send(body)
  })
}
