import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth/plugin.js'
import type { BroadcastService } from '../broadcasts/service.js'
import { BROADCAST_STATUSES } from '../db/schema.js'
import { idParams, parse, positiveId } from '../lib/validate.js'

const title = z
  .string({ error: '제목을 입력하세요' })
  .trim()
  .min(1, { error: '제목을 입력하세요' })
  .max(100, { error: '제목은 100자 이하여야 합니다' })
const description = z.string().trim().max(2000, { error: '설명은 2000자 이하여야 합니다' })

const createBody = z.object({ title, description: description.default('') })

const updateBody = z
  .object({ title: title.optional(), description: description.optional() })
  .refine((v) => v.title !== undefined || v.description !== undefined, { error: '변경할 항목이 없습니다' })

const listQuery = z.object({
  status: z.enum(BROADCAST_STATUSES, { error: '상태는 READY, LIVE, ENDED 중 하나여야 합니다' }).optional(),
  channelId: positiveId('채널 ID').optional(),
  cursor: positiveId('커서').optional(),
  limit: z.coerce
    .number({ error: '개수는 1~50 사이의 숫자여야 합니다' })
    .int({ error: '개수는 1~50 사이의 숫자여야 합니다' })
    .min(1, { error: '개수는 1~50 사이의 숫자여야 합니다' })
    .max(50, { error: '개수는 1~50 사이의 숫자여야 합니다' })
    .default(20),
})

export const broadcastRoutes =
  ({ broadcasts }: { broadcasts: BroadcastService }): FastifyPluginAsync =>
  async (app) => {
    // 목록·상세는 로그인 없이 조회한다
    app.get('/broadcasts', async (request) => broadcasts.list(parse(listQuery, request.query)))

    app.get('/broadcasts/:id', async (request) => {
      const { id } = parse(idParams, request.params)
      return { broadcast: broadcasts.get(id) }
    })

    app.post('/broadcasts', { preHandler: requireAuth }, async (request, reply) => {
      const input = parse(createBody, request.body)
      return reply.code(201).send({ broadcast: broadcasts.create(request.user!, input) })
    })

    app.patch('/broadcasts/:id', { preHandler: requireAuth }, async (request) => {
      const { id } = parse(idParams, request.params)
      const input = parse(updateBody, request.body)
      return { broadcast: broadcasts.update(id, request.user!, input) }
    })

    app.delete('/broadcasts/:id', { preHandler: requireAuth }, async (request, reply) => {
      const { id } = parse(idParams, request.params)
      broadcasts.remove(id, request.user!)
      return reply.code(204).send()
    })
  }
