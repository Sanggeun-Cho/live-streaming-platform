import { type FormEvent, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import type { CommentsState } from '../hooks/useComments'
import { errorMessage } from '../lib/api'
import { type Comment, COMMENT_MAX_LENGTH, createComment, deleteComment, updateComment } from '../lib/comments'

// 맨 아래에서 이만큼(px) 이내면 "맨 아래를 보는 중"으로 보고 새 채팅이 오면 따라 내려간다
const STICK_THRESHOLD_PX = 40

/**
 * 방송 채팅 패널 (#10). 목록·실시간 반영은 페이지가 넘겨준 useComments 상태를 쓴다.
 * 비로그인은 목록만 보고, 입력 자리에 "로그인하고 채팅하기"(로그인 후 이 방송으로 돌아옴)를 보여준다.
 */
export function ChatPanel({ broadcastId, chat }: { broadcastId: number; chat: CommentsState }) {
  const { status, user } = useAuth()
  const location = useLocation()
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const listRef = useRef<HTMLDivElement>(null)
  // 사용자가 위로 스크롤해 지난 채팅을 읽는 중이면 새 채팅이 와도 끌어내리지 않는다
  const stickToBottom = useRef(true)
  // 위에 댓글이 붙었을 때(이전 채팅 보기) 보던 위치를 유지하기 위한 기준: 직전 렌더의 첫 댓글과 그 위치.
  // 요청 시점이 아니라 실제로 붙은 렌더에서 비교하므로, 응답 전에 새 채팅이 와도·요청이 실패해도 기준이 어긋나지 않는다
  const anchor = useRef<{ id: number; top: number } | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)

  const { items, trimToLatest } = chat
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const firstEl = (id: number) => el.querySelector<HTMLElement>(`[data-comment-id="${id}"]`)
    const prev = anchor.current
    const prepended = prev !== null && items.length > 0 && items[0]!.id < prev.id
    const prevEl = prepended ? firstEl(prev.id) : null
    if (prev && prevEl) {
      // 붙은 높이만큼 내려 보던 댓글이 제자리에 있게 한다
      el.scrollTop += prevEl.offsetTop - prev.top
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight
      // 최신을 보고 있을 때만 오래된 댓글을 정리한다 (위에서 읽는 중에는 자르지 않는다)
      trimToLatest()
    }
    const first = items[0]
    const node = first ? firstEl(first.id) : null
    anchor.current = first && node ? { id: first.id, top: node.offsetTop } : null
  }, [items, trimToLatest])

  function onScroll() {
    const el = listRef.current!
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX
  }

  async function onLoadOlder() {
    setError(null)
    try {
      await chat.loadOlder()
    } catch (e) {
      setError(`이전 채팅을 불러오지 못했습니다. ${errorMessage(e)} "이전 채팅 보기"를 다시 눌러 주세요.`)
    }
  }

  /** 요청 실패를 처리한다. 세션이 만료됐으면 로그인 화면으로 보낸다 */
  function fail(e: unknown) {
    if (!redirectIfUnauthorized(e)) setError(errorMessage(e))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const content = text.trim()
    if (!content || sending) return
    setSending(true)
    setError(null)
    try {
      const comment = await createComment(broadcastId, content)
      // SSE로도 오지만 내 화면에는 응답으로 바로 보여준다 (같은 id라 한 번만 표시된다)
      stickToBottom.current = true
      chat.apply(comment)
      setText('')
    } catch (err) {
      fail(err)
    } finally {
      setSending(false)
    }
  }

  async function onDelete(comment: Comment) {
    if (!window.confirm('이 채팅을 삭제할까요?')) return
    setError(null)
    try {
      chat.apply(await deleteComment(comment.id))
    } catch (e) {
      fail(e)
    }
  }

  async function onEdit(comment: Comment, content: string) {
    setError(null)
    try {
      chat.apply(await updateComment(comment.id, content))
      setEditingId(null)
    } catch (e) {
      fail(e)
    }
  }

  const loginPath = `/login?next=${encodeURIComponent(location.pathname + location.search)}`

  return (
    <aside className="chat-panel" aria-label="채팅">
      <h2 className="chat-title">채팅</h2>
      <div className="chat-list" ref={listRef} onScroll={onScroll} data-testid="chat-list">
        {chat.nextCursor !== null && (
          <button type="button" className="link-button chat-older" onClick={() => void onLoadOlder()}>
            이전 채팅 보기
          </button>
        )}
        {chat.status === 'loading' && <p className="muted">채팅을 불러오는 중…</p>}
        {chat.status === 'error' && (
          <div role="alert">
            <p className="error">
              채팅을 불러오지 못했습니다. {chat.error} 잠시 후 아래 버튼으로 다시 시도하세요.
            </p>
            <button type="button" onClick={chat.retry}>
              다시 시도
            </button>
          </div>
        )}
        {chat.status === 'ready' && chat.items.length === 0 && (
          <p className="muted">아직 채팅이 없습니다. 첫 채팅을 남겨 보세요.</p>
        )}
        <ul className="chat-items">
          {chat.items.map((c) => (
            <ChatItem
              key={c.id}
              comment={c}
              mine={!!user && user.id === c.author?.id}
              editing={editingId === c.id}
              onStartEdit={() => {
                setError(null)
                setEditingId(c.id)
              }}
              onCancelEdit={() => setEditingId(null)}
              onSave={(content) => onEdit(c, content)}
              onDelete={() => void onDelete(c)}
            />
          ))}
        </ul>
      </div>

      {error && (
        <p className="error chat-error" role="alert">
          {error}
        </p>
      )}
      {status === 'authenticated' && (
        <form className="chat-form" onSubmit={onSubmit}>
          <input
            aria-label="채팅 입력"
            placeholder="채팅을 입력하세요"
            value={text}
            maxLength={COMMENT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" disabled={sending || !text.trim()}>
            {sending ? '전송 중…' : '전송'}
          </button>
        </form>
      )}
      {status === 'anonymous' && (
        <p className="chat-login">
          <Link to={loginPath}>로그인하고 채팅하기</Link>
        </p>
      )}
      {status === 'error' && <p className="muted chat-login">로그인 상태를 확인하지 못해 채팅을 쓸 수 없습니다. 위쪽의 "다시 시도"를 누르거나 새로고침하세요.</p>}
    </aside>
  )
}

type ItemProps = {
  comment: Comment
  mine: boolean
  editing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (content: string) => Promise<void>
  onDelete: () => void
}

function ChatItem({ comment, mine, editing, onStartEdit, onCancelEdit, onSave, onDelete }: ItemProps) {
  if (comment.content === null) {
    return (
      <li className="chat-item chat-deleted" data-testid="comment" data-comment-id={comment.id}>
        <span className="muted">삭제된 댓글입니다</span>
      </li>
    )
  }
  return (
    <li
      className={`chat-item${comment.isStreamer ? ' chat-streamer' : ''}`}
      data-testid="comment"
      data-comment-id={comment.id}
    >
      <strong className="chat-author">
        {comment.author?.nickname}
        {comment.isStreamer && <span className="badge chat-badge">방송자</span>}
      </strong>{' '}
      {editing ? (
        <EditForm initial={comment.content} onSave={onSave} onCancel={onCancelEdit} />
      ) : (
        <>
          <span className="chat-content">{comment.content}</span>
          {comment.editedAt && <small className="muted"> (수정됨)</small>}
          {mine && (
            <span className="chat-actions">
              <button type="button" className="link-button" onClick={onStartEdit} aria-label="댓글 수정">
                수정
              </button>
              <button type="button" className="link-button" onClick={onDelete} aria-label="댓글 삭제">
                삭제
              </button>
            </span>
          )}
        </>
      )}
    </li>
  )
}

function EditForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  onSave: (content: string) => Promise<void>
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const content = value.trim()
    if (!content || saving) return
    // 바뀐 것이 없으면 요청하지 않는다
    if (content === initial) return onCancel()
    setSaving(true)
    await onSave(content)
    setSaving(false)
  }

  return (
    <form className="chat-edit" onSubmit={onSubmit}>
      <input
        aria-label="댓글 수정 내용"
        value={value}
        maxLength={COMMENT_MAX_LENGTH}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        autoFocus
      />
      <button type="submit" disabled={saving || !value.trim()}>
        저장
      </button>
      <button type="button" onClick={onCancel}>
        취소
      </button>
    </form>
  )
}
