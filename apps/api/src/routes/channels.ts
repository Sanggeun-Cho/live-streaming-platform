import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { Db } from '../db/client.js'
import { channels, users } from '../db/schema.js'
import { AppError } from '../errors.js'
import { idParams, parse } from '../lib/validate.js'

// 채널 정보(이름, 방송자). 채널 화면에서 "채널이 없음"과 "방송이 없음"을 구분하는 데 쓴다
export const channelRoutes =
  (db: Db): FastifyPluginAsync =>
  async (app) => {
    app.get('/channels/:id', async (request) => {
      const { id } = parse(idParams, request.params)
      const channel = db.orm
        .select({ id: channels.id, name: channels.name, owner: { id: users.id, nickname: users.nickname } })
        .from(channels)
        .innerJoin(users, eq(users.id, channels.userId))
        .where(eq(channels.id, id))
        .get()
      if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', '채널을 찾을 수 없습니다')
      return { channel }
    })
  }
