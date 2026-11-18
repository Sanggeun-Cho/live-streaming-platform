import { ApiError, api } from './api'

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

// 도배 제한(서버: 10초에 10번)에 걸린 전송을 다시 보내기 전 기다리는 시간. 합계(15초)가 제한 창보다 길어
// 사람이 빠르게 친 채팅은 결국 보내지고, 그래도 막히면 실패로 돌려준다
const RATE_LIMIT_RETRY_MS = [1000, 2000, 3000, 4000, 5000]

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const isRateLimited = (e: unknown) => e instanceof ApiError && e.status === 429

/** 429면 잠시 기다렸다 다시 시도한다. 기다리기 시작할 때 onWait를 부른다 */
export async function retryRateLimited<T>(
  send: () => Promise<T>,
  onWait?: () => void,
  delays = RATE_LIMIT_RETRY_MS,
  sleep = wait,
): Promise<T> {
  for (const delay of delays) {
    try {
      return await send()
    } catch (e) {
      if (!isRateLimited(e)) throw e
      onWait?.()
      await sleep(delay)
    }
  }
  return send()
}

/** 채팅 옆에 붙이는 작성 시각. 다시보기에서는 지난 날짜의 채팅도 보이므로 오늘이 아니면 날짜를 붙인다 */
export function formatChatTime(iso: string, now = new Date()) {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}
