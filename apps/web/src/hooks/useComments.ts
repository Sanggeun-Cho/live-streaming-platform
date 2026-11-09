import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/api'
import { type Comment, type CommentPage, listComments } from '../lib/comments'

// 화면에 들고 있는 댓글 상한. 오래 켜 둔 탭에서 목록이 끝없이 커지지 않게 한다.
// 자르기는 사용자가 맨 아래(최신)를 보고 있을 때만 trimToLatest로 한다. 위에서 지난 채팅을 읽는 중에 자르면
// "이전 채팅 보기"로 읽은 댓글이 다음 새 채팅에 바로 사라진다. 잘린 댓글은 "이전 채팅 보기"로 다시 읽는다.
const MAX_ITEMS = 500
// SSE가 이 시간 안에 연결되지 않으면(연결 상한 초과 등) 실시간 없이라도 목록을 읽는다
const LOAD_WITHOUT_EVENTS_MS = 2000

type State = {
  broadcastId: number
  items: Comment[]
  /** 더 오래된 댓글을 읽을 커서. 없으면 null */
  nextCursor: number | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

const initial = (broadcastId: number): State => ({
  broadcastId,
  items: [],
  nextCursor: null,
  status: 'loading',
  error: null,
})

const editedTime = (c: Comment) => (c.editedAt ? Date.parse(c.editedAt) : 0)

/**
 * 같은 댓글의 두 버전 중 최신을 고른다. 목록 응답과 SSE 이벤트는 순서가 뒤섞여 도착할 수 있는데,
 * 댓글은 작성 → 수정(editedAt 증가) → 삭제로만 바뀌므로 삭제 여부와 수정 시각으로 판단할 수 있다.
 */
function newer(a: Comment, b: Comment): Comment {
  if (a.deletedAt) return a
  if (b.deletedAt) return b
  return editedTime(a) > editedTime(b) ? a : b
}

/** id 순으로 합친다 */
function mergeItems(items: Comment[], incoming: Comment[]): Comment[] {
  const byId = new Map(items.map((c) => [c.id, c]))
  for (const c of incoming) {
    const prev = byId.get(c.id)
    byId.set(c.id, prev ? newer(prev, c) : c)
  }
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/**
 * 최신 페이지(처음 읽기·재연결)를 반영한다.
 * - 처음: 페이지를 그대로 쓰고 커서도 받는다 (그사이 이벤트로 받은 댓글은 합친다).
 * - 재연결인데 페이지가 들고 있던 목록과 겹치지 않으면: 끊긴 동안 댓글이 페이지 크기보다 많이 쌓여 사이가 비었다.
 *   빈 구간을 숨긴 채 이어 붙이지 않도록 목록을 새 페이지로 바꾸고 커서도 새 값으로 한다 (빈 구간은 "이전 채팅 보기"로 읽는다).
 * - 겹치면: 합치고 들고 있던 커서(더 오래된 쪽까지 읽었을 수 있다)를 유지한다.
 */
function applyLatestPage(state: State, page: CommentPage): State {
  const pageOldest = page.items[0]?.id
  const known = state.items.filter((c) => c.id <= (page.items.at(-1)?.id ?? 0))
  const gap =
    state.status !== 'ready' ||
    (page.nextCursor !== null && pageOldest !== undefined && !known.some((c) => c.id >= pageOldest))
  if (gap) {
    // 페이지보다 새로운 댓글(요청 중 이벤트로 받은 것)만 남긴다
    const newerThanPage = state.items.filter((c) => pageOldest === undefined || c.id >= pageOldest)
    return { ...state, items: mergeItems(newerThanPage, page.items), nextCursor: page.nextCursor, status: 'ready', error: null }
  }
  return { ...state, items: mergeItems(state.items, page.items), status: 'ready', error: null }
}

/**
 * 방송의 댓글 목록. 실시간 반영은 페이지가 이미 연 SSE 연결(useBroadcastEvents)에서 받은 댓글을 apply로 넘긴다
 * (연결을 하나 더 열면 시청자 수가 두 번 세어진다).
 * SSE가 연결될 때마다(최초 연결, 끊긴 뒤 재연결) 최신 목록을 읽는다. 구독이 시작된 뒤에 읽으므로 그 사이 댓글을 놓치지 않는다.
 */
export function useComments(broadcastId: number | null, connected: boolean) {
  const [state, setState] = useState<State | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const olderRequest = useRef<AbortController | null>(null)
  // 목록을 한 번이라도 읽은 방송. 연결이 끊길 때(connected=false)는 다시 읽지 않는다
  const loadedFor = useRef<number | null>(null)

  /** 지금 보고 있는 방송의 상태에만 반영한다 (응답이 늦게 와도 다른 방송의 목록을 덮지 않는다) */
  const update = useCallback(
    (id: number, fn: (s: State) => State) =>
      setState((prev) => fn(prev?.broadcastId === id ? prev : initial(id))),
    [],
  )

  useEffect(() => {
    if (broadcastId === null || (!connected && loadedFor.current === broadcastId)) return
    const controller = new AbortController()
    const load = () =>
      listComments(broadcastId, undefined, controller.signal)
        .then((page) => {
          loadedFor.current = broadcastId
          update(broadcastId, (s) => applyLatestPage(s, page))
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return
          update(broadcastId, (s) => (s.status === 'ready' ? s : { ...s, status: 'error', error: errorMessage(e) }))
        })
    // 연결되면 바로 읽고, 연결 전이면 잠시 기다려 본다 (대부분 곧 연결되어 한 번만 읽는다)
    const timer = connected ? undefined : setTimeout(load, LOAD_WITHOUT_EVENTS_MS)
    if (connected) void load()
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [broadcastId, connected, reloadKey, update])

  // 방송이 바뀌면 진행 중인 "이전 채팅" 요청을 취소한다
  useEffect(() => () => olderRequest.current?.abort(), [broadcastId])

  /** 실시간 이벤트나 내 요청의 응답으로 받은 댓글을 반영한다 */
  const apply = useCallback(
    (comment: Comment) => {
      if (comment.broadcastId === broadcastId) {
        update(comment.broadcastId, (s) => ({ ...s, items: mergeItems(s.items, [comment]) }))
      }
    },
    [broadcastId, update],
  )

  const nextCursor = state?.broadcastId === broadcastId ? (state?.nextCursor ?? null) : null

  /** 더 오래된 댓글을 읽어 위에 붙인다. 실패하면 오류를 던진다 (화면이 안내한다) */
  const loadOlder = useCallback(async () => {
    if (broadcastId === null || nextCursor === null || olderRequest.current) return
    const controller = new AbortController()
    olderRequest.current = controller
    try {
      const page = await listComments(broadcastId, nextCursor, controller.signal)
      update(broadcastId, (s) => ({ ...s, items: mergeItems(s.items, page.items), nextCursor: page.nextCursor }))
    } catch (e) {
      if (!controller.signal.aborted) throw e
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null
    }
  }, [broadcastId, nextCursor, update])

  /** 맨 아래를 보고 있을 때 화면이 부른다. 상한을 넘으면 오래된 것부터 버린다 */
  const trimToLatest = useCallback(() => {
    if (broadcastId === null) return
    setState((prev) => {
      if (prev?.broadcastId !== broadcastId || prev.items.length <= MAX_ITEMS) return prev
      const items = prev.items.slice(prev.items.length - MAX_ITEMS)
      return { ...prev, items, nextCursor: items[0]!.id }
    })
  }, [broadcastId])

  const current = state?.broadcastId === broadcastId ? state : null
  return {
    items: current?.items ?? [],
    nextCursor,
    status: current?.status ?? 'loading',
    error: current?.error ?? null,
    apply,
    loadOlder,
    trimToLatest,
    retry: () => setReloadKey((k) => k + 1),
  }
}

export type CommentsState = ReturnType<typeof useComments>
