import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth/plugin.js'
import { THUMBNAIL_MAX_BYTES, type ThumbnailService } from '../broadcasts/thumbnails.js'
import { AppError } from '../errors.js'
import { idParams, parse } from '../lib/validate.js'

// 썸네일은 방송 상세가 아니라 목록 카드에 쓰이고 수시로 바뀐다. 주소에 ?v=가 붙지만 삭제가 빨리 반영되게 짧게 둔다
const CACHE_SECONDS = 60

/** 방송 중 화면(썸네일). 스튜디오가 주기적으로 올리고, 목록 카드가 읽는다 */
export const thumbnailRoutes =
  (thumbnails: ThumbnailService): FastifyPluginAsync =>
  async (app) => {
    // 이 플러그인 안에서만 JSON이 아닌 본문을 Buffer로 받는다. 형식 확인은 핸들러가 한다
    // (Fastify 기본 415 문구는 "JSON이어야 합니다"라 이미지 업로드에는 맞지 않는다)
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: THUMBNAIL_MAX_BYTES }, (_request, body, done) =>
      done(null, body),
    )

    // 로그인·소유·상태는 본문을 받기 전에 확인한다. 남의 방송에 큰 본문을 보내도 읽지 않고 거절한다
    const ownerOnly = async (request: FastifyRequest) => {
      const { id } = parse(idParams, request.params)
      thumbnails.assertUploadable(id, request.user!)
    }

    app.put('/broadcasts/:id/thumbnail', { onRequest: [requireAuth, ownerOnly] }, async (request) => {
      const { id } = parse(idParams, request.params)
      const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
      if (type !== 'image/jpeg' || !Buffer.isBuffer(request.body)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '썸네일은 JPEG 이미지(Content-Type: image/jpeg)여야 합니다')
      }
      return thumbnails.save(id, request.user!, request.body)
    })

    app.get('/broadcasts/:id/thumbnail', async (request, reply) => {
      const { id } = parse(idParams, request.params)
      const jpeg = await thumbnails.read(id)
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', `public, max-age=${CACHE_SECONDS}`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(jpeg)
    })
  }
