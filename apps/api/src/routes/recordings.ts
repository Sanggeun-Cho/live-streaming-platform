import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { idParams, pageLimit, parse, positiveId } from '../lib/validate.js'
import type { RecordingService } from '../recordings/service.js'

const replayQuery = z.object({
  cursor: positiveId('커서').optional(),
  limit: pageLimit(),
})

// 다시보기는 로그인 없이 조회한다 (방송 목록·상세와 같은 공개 범위)
export const recordingRoutes =
  (recordings: RecordingService): FastifyPluginAsync =>
  async (app) => {
    app.get('/replays', async (request) => recordings.listReplays(parse(replayQuery, request.query)))

    app.get('/broadcasts/:id/recordings', async (request) => {
      const { id } = parse(idParams, request.params)
      return { recordings: recordings.listForBroadcast(id) }
    })
  }
