import type { FastifyPluginAsync } from 'fastify'
import type { Db } from '../db/client.js'

export const healthRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  app.get('/health', async (request, reply) => {
    let dbStatus = 'ok'
    try {
      db.sqlite.prepare('SELECT 1').get()
    } catch (err) {
      request.log.error({ err }, 'DB health check failed')
      dbStatus = 'error'
    }
    const body = { status: dbStatus === 'ok' ? 'ok' : 'degraded', db: dbStatus, time: new Date().toISOString() }
    return reply.code(dbStatus === 'ok' ? 200 : 503).send(body)
  })
}
