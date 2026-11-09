import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { idParams, parse, positiveId } from '../lib/validate.js'
import type { RecordingService } from '../recordings/service.js'

const replayQuery = z.object({
  cursor: positiveId('커서').optional(),
  limit: z.coerce
    .number({ error: '개수는 1~50 사이의 숫자여야 합니다' })
    .int({ error: '개수는 1~50 사이의 숫자여야 합니다' })
    .min(1, { error: '개수는 1~50 사이의 숫자여야 합니다' })
    .max(50, { error: '개수는 1~50 사이의 숫자여야 합니다' })
    .default(20),
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
