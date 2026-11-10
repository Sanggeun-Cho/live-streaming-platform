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
    // LIVE 중 송출이 끊긴 시각. 유예 시간(기본 45초) 안에 재송출하면 지우고, 지나면 ENDED로 확정한다
    disconnectedAt: integer('disconnected_at', { mode: 'timestamp_ms' }),
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

// ---- 도네이션 (#11) ----

export const DONATION_ORDER_STATUSES = ['PENDING', 'DONE', 'FAILED'] as const
export type DonationOrderStatus = (typeof DONATION_ORDER_STATUSES)[number]

// 후원 주문. 결제창을 열기 전에 금액·대상·후원자를 서버에 먼저 저장해 두고, 승인할 때 이 값과 대조한다.
// PENDING → DONE(승인 확인, 원장 1건 생성) / PENDING → FAILED(승인 거절·금액 불일치)
export const donationOrders = sqliteTable(
  'donation_orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // 토스 결제창에 넘기는 주문번호. 추측할 수 없는 무작위 값이다
    orderId: text('order_id').notNull().unique(),
    broadcastId: integer('broadcast_id')
      .notNull()
      .references(() => broadcasts.id),
    donorId: integer('donor_id')
      .notNull()
      .references(() => users.id),
    amount: integer('amount').notNull(),
    message: text('message').notNull().default(''),
    status: text('status', { enum: DONATION_ORDER_STATUSES }).notNull().default('PENDING'),
    // 승인된 결제 키. 승인 전에는 비어 있다
    paymentKey: text('payment_key'),
    // FAILED가 된 이유 (토스 오류 코드 또는 내부 검증 코드). 운영 중 원인 확인용
    failureCode: text('failure_code'),
    // 토스 승인 시도 번호. 멱등키(confirm-{orderId}-{n})에 들어간다. 일시 오류로 승인되지 않은 것이 확인되면 1 올려
    // 다음 재시도가 토스에 캐시된 첫 오류 응답을 그대로 받지 않게 한다 (DESIGN §7)
    confirmAttempt: integer('confirm_attempt').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: nowMs('updated_at'),
  },
  (t) => [index('donation_orders_broadcast_id_idx').on(t.broadcastId)],
)

export type DonationOrder = typeof donationOrders.$inferSelect

// 후원 원장. 승인이 확인된 주문 1건당 정확히 1행만 생긴다(order_id 유니크). 삭제하지 않는다.
// 방송별 내역과 합계는 이 테이블에서만 집계한다.
export const donations = sqliteTable(
  'donations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .unique()
      .references(() => donationOrders.id),
    broadcastId: integer('broadcast_id')
      .notNull()
      .references(() => broadcasts.id),
    donorId: integer('donor_id')
      .notNull()
      .references(() => users.id),
    amount: integer('amount').notNull(),
    message: text('message').notNull().default(''),
    paymentKey: text('payment_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('donations_broadcast_id_id_idx').on(t.broadcastId, t.id)],
)

// 녹화 세그먼트 (#12). 방송 1 : N. 송출 세션(재연결·대체)마다, 그리고 recordSegmentDuration마다 하나씩 생긴다.
// 파일은 MediaMTX가 recordings 볼륨에 쓰고, DB에는 위치와 메타데이터만 둔다 (서버 재시작 후에도 조회).
export const recordings = sqliteTable(
  'recordings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    broadcastId: integer('broadcast_id')
      .notNull()
      .references(() => broadcasts.id, { onDelete: 'cascade' }),
    // 녹화 디렉터리 기준 상대 경로 (예: live/12/2026-11-09_12-00-00-000000.mp4).
    // 유니크라서 같은 파일의 훅이 두 번 와도 한 번만 등록된다
    filePath: text('file_path').notNull().unique(),
    // 세그먼트 녹화 시작 시각. 이어 재생 순서의 기준이다
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    sizeBytes: integer('size_bytes'),
    createdAt: createdAt(),
  },
  (t) => [index('recordings_broadcast_started_idx').on(t.broadcastId, t.startedAt)],
)

export type Recording = typeof recordings.$inferSelect

// 방송별 댓글 (#10). 삭제는 deleted_at으로 표시하고 목록에는 "삭제된 댓글"로 자리를 남긴다 (DESIGN.md §7).
// 본문은 DB에 남겨 신고·분쟁 때 확인할 수 있게 하고, 응답에서만 숨긴다.
export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    broadcastId: integer('broadcast_id')
      .notNull()
      .references(() => broadcasts.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: createdAt(),
    // 마지막으로 수정한 시각. 화면의 "(수정됨)" 표시에 쓴다
    editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  // 목록 조회: 방송별 최신 N개 (id 역순 + 커서)
  (t) => [index('comments_broadcast_id_id_idx').on(t.broadcastId, t.id)],
)
