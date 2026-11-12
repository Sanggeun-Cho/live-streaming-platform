import { api } from './api'

/** 서버 검증과 같은 값 (api/src/routes/comments.ts) */
export const COMMENT_MAX_LENGTH = 300

export type Comment = {
  id: number
  broadcastId: number
  /** 삭제된 댓글은 null */
  content: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  /** 삭제된 댓글은 null (누가 썼는지도 숨긴다) */
  author: { id: number; nickname: string } | null
  /** 방송자 본인이 쓴 댓글 */
  isStreamer: boolean
  /** 후원 채팅이면 후원 금액 (#40). content는 후원 메시지(없으면 빈 문자열)이고 수정·삭제할 수 없다 */
  donation: { id: number; amount: number } | null
}

/** SSE `comment` 이벤트 데이터 */
export type CommentEvent = { type: 'created' | 'updated' | 'deleted'; comment: Comment }

export type CommentPage = { items: Comment[]; nextCursor: number | null }

export function listComments(broadcastId: number, cursor?: number, signal?: AbortSignal) {
  const query = cursor ? `?cursor=${cursor}` : ''
  return api<CommentPage>(`/broadcasts/${broadcastId}/comments${query}`, { signal })
}

export const createComment = (broadcastId: number, content: string) =>
  api<{ comment: Comment }>(`/broadcasts/${broadcastId}/comments`, { method: 'POST', body: { content } }).then(
    (r) => r.comment,
  )

export const updateComment = (id: number, content: string) =>
  api<{ comment: Comment }>(`/comments/${id}`, { method: 'PATCH', body: { content } }).then((r) => r.comment)

export const deleteComment = (id: number) =>
  api<{ comment: Comment }>(`/comments/${id}`, { method: 'DELETE' }).then((r) => r.comment)
