import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth/plugin.js'
import type { CommentEvent, CommentService } from '../comments/service.js'
import { idParams, parse, positiveId } from '../lib/validate.js'
import type { EventHub } from '../realtime/hub.js'

export const COMMENT_MAX_LENGTH = 300

const content = z
  .string({ error: '댓글 내용을 입력하세요' })
  .trim()
  .min(1, { error: '댓글 내용을 입력하세요' })
  .max(COMMENT_MAX_LENGTH, { error: `댓글은 ${COMMENT_MAX_LENGTH}자 이하로 입력하세요` })

const body = z.object({ content })

const limitError = '개수는 1~100 사이의 숫자여야 합니다'
const listQuery = z.object({
  cursor: positiveId('커서').optional(),
  limit: z.coerce
    .number({ error: limitError })
    .int({ error: limitError })
    .min(1, { error: limitError })
    .max(100, { error: limitError })
    .default(50),
})

export const commentRoutes =
  ({ comments, hub }: { comments: CommentService; hub: EventHub }): FastifyPluginAsync =>
  async (app) => {
    const publish = (event: CommentEvent) => hub.publish(event.comment.broadcastId, 'comment', event)

    // 도배 방지: 작성·수정·삭제를 합쳐 사용자당 10초에 10번. 사람이 채팅하기엔 충분하고 스크립트 도배는 막는다.
    // 핸들러 하나를 세 라우트가 함께 써서 카운터를 공유한다(라우트별 config로 두면 라우트마다 따로 센다).
    // requireAuth 뒤에 두어야 사용자 ID를 키로 쓸 수 있고, 비로그인은 429가 아니라 401을 받는다.
    const writeRateLimit = app.rateLimit({
      max: 10,
      timeWindow: '10 seconds',
      keyGenerator: (request: FastifyRequest) => `comment-write:${request.user!.id}`,
    })
    const writeGuard = { preHandler: [requireAuth, writeRateLimit] }

    // 목록은 로그인 없이 조회한다 (비로그인도 채팅을 볼 수 있다)
    app.get('/broadcasts/:id/comments', async (request) => {
      const { id } = parse(idParams, request.params)
      return comments.list(id, parse(listQuery, request.query))
    })

    app.post('/broadcasts/:id/comments', writeGuard, async (request, reply) => {
      const { id } = parse(idParams, request.params)
      const input = parse(body, request.body)
      const comment = comments.create(id, request.user!, input.content)
      publish({ type: 'created', comment })
      return reply.code(201).send({ comment })
    })

    app.patch('/comments/:id', writeGuard, async (request) => {
      const { id } = parse(idParams, request.params)
      const input = parse(body, request.body)
      const { comment, changed } = comments.update(id, request.user!, input.content)
      if (changed) publish({ type: 'updated', comment })
      return { comment }
    })

    // 삭제된 댓글(본문·작성자 숨김)을 돌려줘 화면이 바로 "삭제된 댓글입니다"로 바꿀 수 있게 한다
    app.delete('/comments/:id', writeGuard, async (request) => {
      const { id } = parse(idParams, request.params)
      const comment = comments.remove(id, request.user!)
      publish({ type: 'deleted', comment })
      return { comment }
    })
  }
