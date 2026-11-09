import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { BroadcastLifecycle } from '../broadcasts/lifecycle.js'
import { safeEqual } from '../lib/crypto.js'
import type { EventHub } from '../realtime/hub.js'
import type { RecordingService } from '../recordings/service.js'

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
  // hooks/segment.sh가 웹용 변환 후 파일 크기(바이트)를 붙인다
  segmentSize: z.string().optional(),
})

/** WHIP의 Authorization: Bearer는 token 필드로 온다. 쿼리 ?token=도 허용한다 */
function tokenOf(body: z.infer<typeof authBody>) {
  if (body.token) return body.token
  return new URLSearchParams(body.query ?? '').get('token') ?? undefined
}

export const internalMediaRoutes =
  ({
    secret,
    lifecycle,
    recordings,
    hub,
  }: {
    secret: string
    lifecycle: BroadcastLifecycle
    recordings: RecordingService
    hub: EventHub
  }): FastifyPluginAsync =>
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
      if (event.type === 'segment') {
        const result = recordings.register(event)
        if (result.status === 'invalid') {
          // 경로 조작 시도이거나 설정(recordPath·RECORDINGS_DIR) 불일치. 등록하지 않는다
          request.log.warn({ mediaEvent: event, reason: result.reason }, '녹화 세그먼트 등록 거절')
          return reply.code(400).send()
        }
        if (result.status === 'unknown-broadcast') request.log.warn({ mediaEvent: event }, '없는 방송의 녹화 세그먼트')
        // 다시보기 화면을 보고 있는 시청자에게 새 세그먼트를 바로 알린다 ("준비 중" → 재생)
        if (result.status === 'registered') hub.publish(result.broadcastId, 'recording', result.recording)
      }
      return reply.code(204).send()
    })

    // Caddy forward_auth: /recordings/* 파일 요청마다 내보내도 되는지 묻는다 (204 허용, 404 거절).
    // 원래 요청 주소는 Caddy가 X-Forwarded-Uri로 넣는다. 시크릿은 Caddy가 header_up으로 붙인다.
    app.get('/recordings/authorize', async (request, reply) => {
      const uri = request.headers['x-forwarded-uri']
      const ok = typeof uri === 'string' && recordings.canServe(uri)
      return reply.code(ok ? 204 : 404).send()
    })
  }
