import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth/plugin.js'
import type { BroadcastLifecycle } from '../broadcasts/lifecycle.js'
import { broadcastNotFound, type BroadcastService } from '../broadcasts/service.js'
import { BROADCAST_STATUSES } from '../db/schema.js'
import { AppError } from '../errors.js'
import { idParams, pageLimit, parse, positiveId } from '../lib/validate.js'
import type { EventHub } from '../realtime/hub.js'

// SSE 연결을 유지하기 위한 주석 전송 간격. 프록시·모바일 망의 유휴 연결 종료(보통 30~60초)보다 짧게 둔다
const SSE_HEARTBEAT_MS = 20_000
// IP당 동시 SSE 연결 상한. 한 사람이 여러 탭을 열어도 충분하고, 연결을 대량으로 열어 자원을 소모시키는 것은 막는다
const SSE_MAX_PER_IP = 20

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
  limit: pageLimit(),
})

export const broadcastRoutes =
  ({
    broadcasts,
    lifecycle,
    hub,
  }: {
    broadcasts: BroadcastService
    lifecycle: BroadcastLifecycle
    hub: EventHub
  }): FastifyPluginAsync =>
  async (app) => {
    const sseByIp = new Map<string, number>()

    // 목록·상세는 로그인 없이 조회한다
    // 목록 카드에 시청자 수를 보여준다 (방송 중인 것만, SSE 연결 수 기준)
    app.get('/broadcasts', async (request) => {
      const page = broadcasts.list(parse(listQuery, request.query))
      return {
        ...page,
        items: page.items.map((b) => ({ ...b, viewers: b.status === 'LIVE' ? hub.count(b.id) : 0 })),
      }
    })

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
      const broadcast = broadcasts.update(id, request.user!, input)
      hub.publish(id, 'updated', { title: broadcast.title, description: broadcast.description })
      return { broadcast }
    })

    app.delete('/broadcasts/:id', { preHandler: requireAuth }, async (request, reply) => {
      const { id } = parse(idParams, request.params)
      broadcasts.remove(id, request.user!)
      hub.publish(id, 'deleted', {})
      // 삭제된 방송의 연결은 더 받을 이벤트가 없으므로 닫는다
      hub.closeBroadcast(id)
      return reply.code(204).send()
    })

    // ---- 송출 제어 (#6) ----

    // 송출을 시작(또는 재연결)할 때마다 호출한다. 토큰은 WHIP 요청의 Authorization: Bearer로 MediaMTX에 전달된다
    app.post('/broadcasts/:id/publish-token', { preHandler: requireAuth }, async (request) => {
      const { id } = parse(idParams, request.params)
      return lifecycle.issuePublishToken(id, request.user!)
    })

    app.post('/broadcasts/:id/end', { preHandler: requireAuth }, async (request) => {
      const { id } = parse(idParams, request.params)
      return { status: await lifecycle.end(id, request.user!) }
    })

    // 실시간 이벤트 (SSE). 로그인 없이 구독한다.
    //   status: 상태 변경, viewers: 시청자 수, updated: 제목·설명 변경, deleted: 방송 삭제,
    //   donation: 후원 적립 (routes/donations.ts → donations/service.ts)
    //   comment: 댓글 작성·수정·삭제 (routes/comments.ts)
    app.get('/broadcasts/:id/events', async (request, reply) => {
      const { id } = parse(idParams, request.params)
      const view = broadcasts.findView(id)
      if (!view) throw broadcastNotFound()
      const ip = request.ip
      const opened = sseByIp.get(ip) ?? 0
      if (opened >= SSE_MAX_PER_IP) {
        throw new AppError(429, 'TOO_MANY_REQUESTS', '연결이 너무 많습니다. 열려 있는 방송 탭을 닫고 다시 시도하세요')
      }
      sseByIp.set(ip, opened + 1)
      // 방송자 본인의 연결은 시청자 수에 넣지 않는다
      const isOwner = request.user?.channelId === view.channel.id

      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // 프록시 버퍼링을 끈다 (Caddy는 SSE를 자동으로 흘려보내지만 다른 프록시 대비)
        'X-Accel-Buffering': 'no',
      })
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      // 연결이 끊겼다가 다시 붙으면(EventSource 자동 재연결) 그 사이 놓친 상태를 현재 값으로 맞춘다
      res.write('retry: 3000\n\n')
      const { status, startedAt, endedAt, disconnectedAt } = view
      send('status', { status, startedAt, endedAt, disconnectedAt })

      const unsubscribe = hub.subscribe(id, { send, close: () => res.end(), viewer: !isOwner })
      const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS)
      heartbeat.unref()
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        clearInterval(heartbeat)
        unsubscribe()
        const left = (sseByIp.get(ip) ?? 1) - 1
        if (left > 0) sseByIp.set(ip, left)
        else sseByIp.delete(ip)
      }
      res.on('close', cleanup)
      res.on('error', cleanup)
    })
  }
