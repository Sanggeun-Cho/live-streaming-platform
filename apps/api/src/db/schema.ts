import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// 시각은 모두 epoch 밀리초(integer)로 저장한다.
const nowMs = (name: string) =>
  integer(name, { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
const createdAt = () => nowMs('created_at')

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 소문자로 정규화해서 저장한다
  email: text('email').notNull().unique(),
  nickname: text('nickname').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
})

// 사용자 1명당 채널 1개. 회원가입 시 자동 생성한다.
export const channels = sqliteTable('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const sessions = sqliteTable(
  'sessions',
  {
    // 쿠키에 담긴 토큰의 SHA-256 해시. DB가 유출되어도 세션을 바로 탈취할 수 없다.
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId), index('sessions_expires_at_idx').on(t.expiresAt)],
)

export type User = typeof users.$inferSelect

export const BROADCAST_STATUSES = ['READY', 'LIVE', 'ENDED'] as const
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number]

// 방송 회차. READY → LIVE → ENDED 로만 전이한다 (DESIGN.md §4). 삭제는 deleted_at으로 표시한다.
export const broadcasts = sqliteTable(
  'broadcasts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: BROADCAST_STATUSES }).notNull().default('READY'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: nowMs('updated_at'),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('broadcasts_channel_id_idx').on(t.channelId),
    // 목록 조회: 상태 필터 + 최신순
    index('broadcasts_status_id_idx').on(t.status, t.id),
  ],
)

export type Broadcast = typeof broadcasts.$inferSelect
