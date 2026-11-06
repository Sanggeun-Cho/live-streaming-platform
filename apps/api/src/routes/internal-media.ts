import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

// MediaMTX → api 내부 호출. Caddy는 /api/*만 프록시하므로 외부에서는 도달할 수 없다.
// #2 스파이크 단계: 호출 형식과 시점만 기록하고 모두 허용한다.
// TODO(#6): publish 토큰·path·방송 상태 검증, online/offline으로 상태 머신 전이, 공유 시크릿 검사

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


export const internalMediaRoutes: FastifyPluginAsync = async (app) => {
  app.post('/media/auth', async (request, reply) => {
    const parsed = authBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send()
    const { action, path, protocol, ip, query } = parsed.data
    request.log.info({ media: { action, path, protocol, ip, hasQuery: Boolean(query) } }, 'media auth')
    return reply.code(200).send()
  })

  app.post('/media/events', async (request, reply) => {
    const parsed = eventBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send()
    request.log.info({ mediaEvent: parsed.data }, 'media event')
    return reply.code(204).send()
  })
}
