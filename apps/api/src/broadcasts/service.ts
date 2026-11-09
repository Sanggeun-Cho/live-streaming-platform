import { and, desc, eq, isNull, lt, ne, type SQL } from 'drizzle-orm'
import type { AuthUser } from '../auth/service.js'
import type { Db } from '../db/client.js'
import { type BroadcastStatus, broadcasts, channels, users } from '../db/schema.js'
import { AppError, forbidden } from '../errors.js'

// 응답에 쓰는 방송 정보. 채널과 방송자 닉네임을 함께 내려 목록에서 추가 조회가 없게 한다
const broadcastColumns = {
  id: broadcasts.id,
  title: broadcasts.title,
  description: broadcasts.description,
  status: broadcasts.status,
  startedAt: broadcasts.startedAt,
  endedAt: broadcasts.endedAt,
  disconnectedAt: broadcasts.disconnectedAt,
  createdAt: broadcasts.createdAt,
  updatedAt: broadcasts.updatedAt,
  channel: { id: channels.id, name: channels.name },
  streamer: { id: users.id, nickname: users.nickname },
}

export type BroadcastView = {
  id: number
  title: string
  description: string
  status: BroadcastStatus
  startedAt: Date | null
  endedAt: Date | null
  /** LIVE 중 송출이 끊겨 재연결을 기다리는 중이면 그 시각 */
  disconnectedAt: Date | null
  createdAt: Date
  updatedAt: Date
  channel: { id: number; name: string }
  streamer: { id: number; nickname: string }
}

export type ListQuery = {
  status?: BroadcastStatus
  channelId?: number
  /** 이 ID보다 오래된(작은) 방송부터 */
  cursor?: number
  limit: number
}

export const broadcastNotFound = () => new AppError(404, 'BROADCAST_NOT_FOUND', '방송을 찾을 수 없습니다')

/** 삭제되지 않은 방송을 찾고, 요청자가 소유자인지 확인한다 (없으면 404, 소유자가 아니면 403) */
export function getOwned(db: Db, id: number, user: AuthUser) {
  const row = db.orm
    .select({ id: broadcasts.id, channelId: broadcasts.channelId })
    .from(broadcasts)
    .where(and(eq(broadcasts.id, id), isNull(broadcasts.deletedAt)))
    .get()
  if (!row) throw broadcastNotFound()
  if (row.channelId !== user.channelId) throw forbidden('본인 방송만 변경할 수 있습니다')
  return row
}

export function createBroadcastService(db: Db) {
  const { orm } = db

  const selectViews = () =>
    orm
      .select(broadcastColumns)
      .from(broadcasts)
      .innerJoin(channels, eq(channels.id, broadcasts.channelId))
      .innerJoin(users, eq(users.id, channels.userId))

  function findView(id: number): BroadcastView | undefined {
    return selectViews()
      .where(and(eq(broadcasts.id, id), isNull(broadcasts.deletedAt)))
      .get()
  }

  return {
    findView,

    get(id: number): BroadcastView {
      const view = findView(id)
      if (!view) throw broadcastNotFound()
      return view
    },

    list({ status, channelId, cursor, limit }: ListQuery): { items: BroadcastView[]; nextCursor: number | null } {
      const conditions: SQL[] = [isNull(broadcasts.deletedAt)]
      if (status) conditions.push(eq(broadcasts.status, status))
      if (channelId) conditions.push(eq(broadcasts.channelId, channelId))
      if (cursor) conditions.push(lt(broadcasts.id, cursor))
      // 다음 페이지가 있는지 알기 위해 하나 더 읽는다
      const rows = selectViews()
        .where(and(...conditions))
        .orderBy(desc(broadcasts.id))
        .limit(limit + 1)
        .all()
      const items = rows.slice(0, limit)
      return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null }
    },

    create(user: AuthUser, input: { title: string; description: string }): BroadcastView {
      const { id } = orm
        .insert(broadcasts)
        .values({ channelId: user.channelId, title: input.title, description: input.description })
        .returning({ id: broadcasts.id })
        .get()
      return findView(id)!
    },

    update(id: number, user: AuthUser, input: { title?: string; description?: string }): BroadcastView {
      getOwned(db, id, user)
      const result = orm
        .update(broadcasts)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(broadcasts.id, id), isNull(broadcasts.deletedAt)))
        .run()
      const view = result.changes > 0 ? findView(id) : undefined
      if (!view) throw broadcastNotFound()
      return view
    },

    /** Soft Delete. 방송 중에는 시청자가 있으므로 먼저 종료해야 한다 (409) */
    remove(id: number, user: AuthUser): void {
      getOwned(db, id, user)
      // 상태 확인과 삭제를 한 문장으로 처리해, 확인 직후 LIVE로 바뀌는 경합에서도 LIVE 방송이 지워지지 않게 한다
      const now = new Date()
      const result = orm
        .update(broadcasts)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(broadcasts.id, id), isNull(broadcasts.deletedAt), ne(broadcasts.status, 'LIVE')))
        .run()
      if (result.changes === 0) {
        // 조건에 걸린 이유를 구분한다: 그사이 삭제됐으면 404, 방송 중이면 409
        if (!findView(id)) throw broadcastNotFound()
        throw new AppError(409, 'BROADCAST_LIVE', '방송 중에는 삭제할 수 없습니다. 방송을 먼저 종료하세요')
      }
    },
  }
}

export type BroadcastService = ReturnType<typeof createBroadcastService>
