import { and, desc, eq, isNull, lt, type SQL } from 'drizzle-orm'
import type { AuthUser } from '../auth/service.js'
import { broadcastNotFound } from '../broadcasts/service.js'
import type { Db } from '../db/client.js'
import { broadcasts, channels, comments, donations, users } from '../db/schema.js'
import { AppError, forbidden } from '../errors.js'

/**
 * 응답·SSE에 쓰는 댓글. 삭제된 댓글은 본문과 작성자를 모두 숨기고(null) 자리만 남긴다.
 * 작성자가 지운 흔적에 누가 썼는지까지 남기지 않는다.
 */
export type CommentView = {
  id: number
  broadcastId: number
  content: string | null
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
  author: { id: number; nickname: string } | null
  /** 방송자 본인이 쓴 댓글 (채팅에서 강조한다). 삭제된 댓글은 false */
  isStreamer: boolean
  /** 후원 채팅이면 후원 금액 (#40). content는 후원 메시지(없으면 빈 문자열)이고, 수정·삭제할 수 없다 */
  donation: { id: number; amount: number } | null
}

/** SSE `comment` 이벤트 데이터. 이벤트 이름 하나로 두고 type으로 구분해 클라이언트 구독을 단순하게 한다 */
export type CommentEvent = { type: 'created' | 'updated' | 'deleted'; comment: CommentView }

export type CommentListQuery = {
  /** 이 ID보다 오래된(작은) 댓글부터 */
  cursor?: number
  limit: number
}

export const commentNotFound = () =>
  new AppError(404, 'COMMENT_NOT_FOUND', '댓글을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다')

type Row = {
  id: number
  broadcastId: number
  content: string
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
  author: { id: number; nickname: string }
  streamerUserId: number
  donationId: number | null
  donationAmount: number | null
}

function toView({ streamerUserId, donationId, donationAmount, ...row }: Row): CommentView {
  if (row.deletedAt) return { ...row, content: null, author: null, isStreamer: false, donation: null }
  const donation = donationId !== null && donationAmount !== null ? { id: donationId, amount: donationAmount } : null
  return { ...row, isStreamer: row.author.id === streamerUserId, donation }
}

// better-sqlite3는 동기라 한 요청 안의 "확인 → 변경"이 다른 요청이 끼어들지 않는다.
// 그래서 확인을 통과한 뒤의 UPDATE·INSERT는 대상이 사라졌을 경우를 따로 처리하지 않는다.
export function createCommentService(db: Db) {
  const { orm } = db

  // 방송이 삭제되면 그 방송의 댓글도 함께 보이지 않게 한다 (방송 Soft Delete와 같은 기준)
  const selectRows = () =>
    orm
      .select({
        id: comments.id,
        broadcastId: comments.broadcastId,
        content: comments.content,
        createdAt: comments.createdAt,
        editedAt: comments.editedAt,
        deletedAt: comments.deletedAt,
        author: { id: users.id, nickname: users.nickname },
        streamerUserId: channels.userId,
        donationId: comments.donationId,
        donationAmount: donations.amount,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.userId))
      .leftJoin(donations, eq(donations.id, comments.donationId))
      .innerJoin(broadcasts, eq(broadcasts.id, comments.broadcastId))
      .innerJoin(channels, eq(channels.id, broadcasts.channelId))

  const findRow = (id: number) =>
    selectRows()
      .where(and(eq(comments.id, id), isNull(broadcasts.deletedAt)))
      .get()

  /** 응답·SSE용 댓글 (방송이 삭제됐으면 undefined) */
  function view(id: number): CommentView | undefined {
    const row = findRow(id)
    return row ? toView(row) : undefined
  }
  // 방금 만들거나 바꾼 댓글처럼 있는 것이 확실할 때
  const findView = (id: number) => view(id)!

  function assertBroadcastExists(broadcastId: number) {
    const row = orm
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(and(eq(broadcasts.id, broadcastId), isNull(broadcasts.deletedAt)))
      .get()
    if (!row) throw broadcastNotFound()
  }

  /** 삭제되지 않은 댓글을 찾고 작성자인지 확인한다 (없으면 404, 작성자가 아니면 403) */
  function getAuthored(id: number, user: AuthUser, action: '수정' | '삭제'): Row {
    const row = findRow(id)
    if (!row || row.deletedAt) throw commentNotFound()
    if (row.author.id !== user.id) throw forbidden(`본인이 작성한 댓글만 ${action}할 수 있습니다`)
    // 후원 채팅은 후원 원장과 같은 기록이라 후원자도 바꾸거나 지울 수 없다
    if (row.donationId !== null) throw forbidden(`후원 채팅은 ${action}할 수 없습니다`)
    return row
  }

  return {
    /** 후원 채팅을 만든 뒤 이벤트로 보낼 때 쓴다 */
    get: view,

    /**
     * 후원 채팅 (#40). 후원 원장을 적립하는 트랜잭션(tx) 안에서 불러, 원장과 채팅이 함께 생기게 한다.
     * 작성자는 후원자, 본문은 후원 메시지(없으면 빈 문자열)다. 만든 댓글 ID를 돌려준다
     */
    insertDonationChat(
      tx: Pick<typeof orm, 'insert'>,
      donation: { id: number; broadcastId: number; donorId: number; message: string },
    ): number {
      return tx
        .insert(comments)
        .values({
          broadcastId: donation.broadcastId,
          userId: donation.donorId,
          content: donation.message,
          donationId: donation.id,
        })
        .returning({ id: comments.id })
        .get().id
    },

    /**
     * 최신 댓글 limit개를 오래된 것부터(채팅 순서) 돌려준다. 더 오래된 댓글이 있으면 nextCursor로 이어 읽는다.
     * 삭제된 댓글도 "삭제된 댓글입니다" 자리로 포함한다 (대화 흐름이 끊기지 않게).
     */
    list(broadcastId: number, { cursor, limit }: CommentListQuery): { items: CommentView[]; nextCursor: number | null } {
      assertBroadcastExists(broadcastId)
      const conditions: SQL[] = [eq(comments.broadcastId, broadcastId)]
      if (cursor) conditions.push(lt(comments.id, cursor))
      // 다음 페이지가 있는지 알기 위해 하나 더 읽는다
      const rows = selectRows()
        .where(and(...conditions))
        .orderBy(desc(comments.id))
        .limit(limit + 1)
        .all()
      const page = rows.slice(0, limit)
      return {
        items: page.map(toView).reverse(),
        nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      }
    },

    /** 방송 상태(READY·LIVE·ENDED)와 관계없이 작성할 수 있다. 방송 전 대기 채팅과 종료 후 다시보기 감상을 막을 이유가 없다 */
    create(broadcastId: number, user: AuthUser, content: string): CommentView {
      assertBroadcastExists(broadcastId)
      const { id } = orm
        .insert(comments)
        .values({ broadcastId, userId: user.id, content })
        .returning({ id: comments.id })
        .get()
      return findView(id)
    },

    /** 내용이 그대로면 아무것도 바꾸지 않는다 (changed: false). "(수정됨)" 표시와 불필요한 이벤트를 막는다 */
    update(id: number, user: AuthUser, content: string): { comment: CommentView; changed: boolean } {
      const row = getAuthored(id, user, '수정')
      if (row.content === content) return { comment: toView(row), changed: false }
      orm.update(comments).set({ content, editedAt: new Date() }).where(eq(comments.id, id)).run()
      return { comment: findView(id), changed: true }
    },

    /** Soft Delete. 삭제된 댓글(본문·작성자 숨김)을 돌려준다 */
    remove(id: number, user: AuthUser): CommentView {
      getAuthored(id, user, '삭제')
      orm.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, id)).run()
      return findView(id)
    },
  }
}

export type CommentService = ReturnType<typeof createCommentService>
