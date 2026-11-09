import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { BroadcastLifecycle } from '../broadcasts/lifecycle.js'
import { safeEqual } from '../lib/crypto.js'

// MediaMTX → api 내부 호출.
// - Caddy는 /api/*와 /live/*만 프록시하므로 외부에서는 /internal에 도달할 수 없다 (1차 방어).
// - 같은 Docker 네트워크의 다른 컨테이너가 호출하지 못하도록 공유 시크릿을 확인한다 (2차 방어).
//   인가 호출은 MediaMTX가 헤더를 붙일 수 없어 authHTTPAddress의 쿼리(?secret=)로, 훅은 헤더로 받는다.

// https://mediamtx.org/docs/features/authentication#http-based (v1.21 기준 필드)
const authBody = z.looseObject({
  action: z.string(),
  path: z.string(),
  protocol: z.string().optional(),
  ip: z.string().optional(),
  query: z.string().optional(),
  token: z.string().optional(),
})

const eventBody = z.object({
  type: z.enum(['online', 'offline', 'segment']),
  path: z.string(),
  sourceType: z.string().optional(),
  segmentPath: z.string().optional(),
  segmentDuration: z.string().optional(),
})

/** WHIP의 Authorization: Bearer는 token 필드로 온다. 쿼리 ?token=도 허용한다 */
function tokenOf(body: z.infer<typeof authBody>) {
  if (body.token) return body.token
  return new URLSearchParams(body.query ?? '').get('token') ?? undefined
}

export const internalMediaRoutes =
  ({ secret, lifecycle }: { secret: string; lifecycle: BroadcastLifecycle }): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', async (request: FastifyRequest<{ Querystring: { secret?: string } }>, reply) => {
      const given = request.headers['x-internal-secret'] ?? request.query.secret
      if (typeof given !== 'string' || !safeEqual(given, secret)) {
        request.log.warn({ url: request.routeOptions.url }, '내부 호출 시크릿 불일치')
        return reply.code(401).send()
      }
    })

    app.post('/media/auth', async (request, reply) => {
      const parsed = authBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send()
      const { action, path, ip } = parsed.data
      const decision = lifecycle.authorize(action, path, tokenOf(parsed.data))
      if (!decision.ok) {
        request.log.info({ media: { action, path, ip }, reason: decision.reason }, 'media auth 거절')
        return reply.code(decision.status).send()
      }
      return reply.code(200).send()
    })

    app.post('/media/events', async (request, reply) => {
      const parsed = eventBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send()
      const event = parsed.data
      request.log.info({ mediaEvent: event }, 'media event')
      if (event.type === 'online') await lifecycle.onOnline(event.path)
      if (event.type === 'offline') await lifecycle.onOffline(event.path)
      // segment: 녹화 등록은 #12
      return reply.code(204).send()
    })
  }
