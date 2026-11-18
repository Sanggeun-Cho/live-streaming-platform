import { ArrowDown, HandCoins, MessagesSquare, Pencil, Send, Trash2 } from 'lucide-react'
import { type ClipboardEvent, type FormEvent, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { useFeedback } from '../feedback/context'
import type { CommentsState } from '../hooks/useComments'
import { errorMessage } from '../lib/api'
import { colorOf } from '../lib/avatar'
import type { BroadcastStatus } from '../lib/broadcasts'
import {
  type Comment,
  COMMENT_MAX_LENGTH,
  createComment,
  deleteComment,
  formatChatTime,
  isRateLimited,
  retryRateLimited,
  updateComment,
} from '../lib/comments'
import { formatWon } from '../lib/donations'
import './chat.css'

// 맨 아래에서 이만큼(px) 이내면 "맨 아래를 보는 중"으로 보고 새 채팅이 오면 따라 내려간다
const STICK_THRESHOLD_PX = 40
// 글자 수는 상한이 가까워질 때만 보여 준다 (평소 채팅에는 군더더기다)
const COUNTER_FROM = 250

const PLACEHOLDER: Record<BroadcastStatus, string> = {
  READY: '방송 전 인사를 남겨 보세요',
  LIVE: '채팅을 입력하세요',
  ENDED: '다시보기 감상을 남겨 보세요',
}

/** 붙여넣으면 maxLength에 걸려 뒷부분이 잘리는지 */
function pasteOverflows(e: ClipboardEvent<HTMLInputElement>) {
  const { value, selectionStart, selectionEnd } = e.currentTarget
  const replaced = (selectionEnd ?? 0) - (selectionStart ?? 0)
  return value.length - replaced + e.clipboardData.getData('text').length > COMMENT_MAX_LENGTH
}

const OVERFLOW_NOTICE = `채팅은 ${COMMENT_MAX_LENGTH}자까지 쓸 수 있어 넘친 부분은 붙여넣지 않았습니다.`

/** 채팅이 없을 때의 안내. 방송 상태·로그인 여부마다 할 수 있는 일이 달라 따로 쓴다 */
function emptyChat(status: BroadcastStatus, canWrite: boolean, ownerView: boolean): [string, string] {
  if (status === 'ENDED') return ['이 방송에는 채팅이 없었습니다', canWrite ? '다시보기 감상을 남겨 보세요.' : '']
  if (ownerView) return ['아직 채팅이 없습니다', '시청자 채팅이 이곳에 실시간으로 표시됩니다.']
  if (!canWrite) return ['아직 채팅이 없습니다', '로그인하면 채팅에 참여할 수 있습니다.']
  return ['아직 채팅이 없습니다', status === 'READY' ? '방송 전 인사를 남겨 보세요.' : '첫 채팅을 남겨 보세요.']
}

/**
 * 보내는 중인 채팅 (도배 제한으로 기다리는 동안에도 목록 맨 아래에 흐리게 먼저 보여 준다).
 * afterId: 보낼 때의 마지막 채팅 id. 응답보다 SSE가 먼저 오면 그 뒤에 온 같은 내용의 내 채팅으로 대신한다
 */
type Pending = { key: number; content: string; afterId: number }

/**
 * 방송 채팅 패널 (#10). 목록·실시간 반영은 페이지가 넘겨준 useComments 상태를 쓴다.
 * 높이는 부모가 정한다: 패널은 부모 높이를 채우고 목록만 스크롤한다 (시청 화면·방송 스튜디오에서 함께 쓴다).
 * 비로그인은 목록만 보고, 입력 자리에 "로그인하고 채팅하기"(로그인 후 이 방송으로 돌아옴)를 보여준다.
 * broadcastStatus를 주면 상황에 맞는 입력 안내를 보여준다 (종료 후에도 다시보기 감상을 쓸 수 있다).
 */
export function ChatPanel({
  broadcastId,
  chat,
  broadcastStatus,
  ownerView = false,
}: {
  broadcastId: number
  chat: CommentsState
  broadcastStatus?: BroadcastStatus
  /** 방송자가 보는 채팅(스튜디오): 빈 상태 문구를 방송자 입장으로 */
  ownerView?: boolean
}) {
  const { status, user } = useAuth()
  const { confirm, toast } = useFeedback()
  const location = useLocation()
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const listRef = useRef<HTMLDivElement>(null)
  // 사용자가 위로 스크롤해 지난 채팅을 읽는 중이면 새 채팅이 와도 끌어내리지 않는다
  const stickToBottom = useRef(true)
  // 위로 스크롤해 읽는 중일 때, 떠날 때 마지막이던 채팅 id. 그 뒤에 온 채팅 수를 "새 채팅 N개"로 보여준다
  const [readUpTo, setReadUpTo] = useState<number | null>(null)
  // 위에 댓글이 붙었을 때(이전 채팅 보기) 보던 위치를 유지하기 위한 기준: 직전 렌더의 첫 댓글과 그 위치.
  // 요청 시점이 아니라 실제로 붙은 렌더에서 비교하므로, 응답 전에 새 채팅이 와도·요청이 실패해도 기준이 어긋나지 않는다
  const anchor = useRef<{ id: number; top: number } | null>(null)
  const [text, setText] = useState('')
  // 도배 제한에 걸려 잠시 기다렸다 다시 보내는 중
  const [throttled, setThrottled] = useState(false)
  // 연달아 보낸 채팅이 입력한 순서대로 서버에 도착하도록 전송을 한 줄로 세운다
  const sendQueue = useRef<Promise<void>>(Promise.resolve())
  // 보내지 못한 채팅. 다음 전송이 오류 문구를 지워도 내용이 사라지지 않게 따로 보관한다
  const [failed, setFailed] = useState<string[]>([])
  const [pending, setPending] = useState<Pending[]>([])
  const pendingKey = useRef(0)
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
  }, [items, pending, trimToLatest])

  function onScroll() {
    const el = listRef.current!
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX
    const lastId = items.at(-1)?.id ?? 0
    setReadUpTo((prev) => (stickToBottom.current ? null : (prev ?? lastId)))
  }

  function scrollToLatest() {
    const el = listRef.current!
    stickToBottom.current = true
    setReadUpTo(null)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const unread = readUpTo === null ? 0 : items.filter((c) => c.id > readUpTo).length
  const sending = pending.filter(
    (p) => !items.some((c) => c.id > p.afterId && c.author?.id === user?.id && c.content === p.content),
  )

  async function onLoadOlder() {
    setError(null)
    try {
      await chat.loadOlder()
    } catch {
      setError('이전 채팅을 불러오지 못했습니다. 다시 눌러 주세요.')
    }
  }

  /** 요청 실패를 처리한다. 세션이 만료됐으면 로그인 화면으로 보낸다 */
  function fail(e: unknown) {
    if (!redirectIfUnauthorized(e)) setError(errorMessage(e))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const content = text.trim()
    if (!content) return
    // 보내는 즉시 입력창을 비운다. 응답을 기다리는 동안 이어서 입력한 다음 채팅이 지워지지 않게 하기 위해서다.
    // 실패한 채팅은 failed에 보관해 "입력창으로 되돌리기"로 다시 보낼 수 있게 한다
    setText('')
    setError(null)
    const key = ++pendingKey.current
    stickToBottom.current = true
    setPending((list) => [...list, { key, content, afterId: items.at(-1)?.id ?? 0 }])
    sendQueue.current = sendQueue.current.then(async () => {
      try {
        // 빠르게 연달아 보내다 도배 제한에 걸리면 줄을 세운 채 기다렸다 보내므로 순서가 유지된다
        const comment = await retryRateLimited(
          () => createComment(broadcastId, content),
          () => setThrottled(true),
        )
        // SSE로도 오지만 내 화면에는 응답으로 바로 보여준다 (같은 id라 한 번만 표시된다)
        stickToBottom.current = true
        chat.apply(comment)
      } catch (err) {
        if (!redirectIfUnauthorized(err)) {
          setFailed((list) => [...list, content])
          setError(isRateLimited(err) ? '채팅을 너무 빠르게 보냈습니다. 잠시 후 다시 보내 주세요.' : errorMessage(err))
        }
      } finally {
        setThrottled(false)
        setPending((list) => list.filter((p) => p.key !== key))
      }
    })
    await sendQueue.current
  }

  async function onDelete(comment: Comment) {
    const ok = await confirm({
      title: '채팅을 삭제할까요?',
      message: '삭제한 채팅은 되돌릴 수 없습니다.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
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
  const ended = broadcastStatus === 'ENDED'
  const [emptyTitle, emptyHint] = emptyChat(broadcastStatus ?? 'LIVE', status === 'authenticated', ownerView)

  return (
    <aside className="chat-panel" aria-label="채팅">
      <header className="chat-head">
        <h2 className="chat-title">채팅</h2>
        {/* 종료된 방송의 채팅은 지난 기록이므로 "실시간" 대신 기록임을 알린다 */}
        {ended ? (
          <span className="chat-conn">채팅 기록</span>
        ) : (
          <span className={`chat-conn${chat.connected ? ' is-live' : ''}`}>
            <span className="chat-conn-dot" aria-hidden="true" />
            {chat.connected ? '실시간' : '연결 중…'}
          </span>
        )}
      </header>

      <div className="chat-body">
        <div
          className="chat-list"
          ref={listRef}
          onScroll={onScroll}
          data-testid="chat-list"
          role="log"
          aria-label="채팅 메시지"
        >
          {chat.nextCursor !== null && (
            <button type="button" className="chat-older" onClick={() => void onLoadOlder()}>
              이전 채팅 보기
            </button>
          )}
          {chat.status === 'loading' && <ChatSkeleton />}
          {chat.status === 'error' && (
            <div className="chat-state" role="alert">
              <p>채팅을 불러오지 못했습니다.</p>
              <p className="muted">{chat.error}</p>
              <button type="button" onClick={chat.retry}>
                다시 시도
              </button>
            </div>
          )}
          {chat.status === 'ready' && items.length === 0 && sending.length === 0 && (
            <div className="chat-state">
              <MessagesSquare size={28} aria-hidden="true" />
              <p>{emptyTitle}</p>
              {emptyHint && <p className="muted">{emptyHint}</p>}
            </div>
          )}
          <ul className="chat-items">
            {items.map((c) => (
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
                onPasteOverflow={() => toast(OVERFLOW_NOTICE, 'info')}
              />
            ))}
            {sending.map((p) => (
              <li key={`pending-${p.key}`} className="chat-item chat-pending">
                <span className="chat-time">전송 중</span>
                <strong className="chat-author">{user?.nickname}</strong>
                <span className="chat-content">{p.content}</span>
              </li>
            ))}
          </ul>
        </div>
        {unread > 0 && (
          <div className="chat-jump-band">
            <button type="button" className="chat-jump" onClick={scrollToLatest}>
              새 채팅 {unread > 99 ? '99+' : unread}개
              <ArrowDown size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {failed.length > 0 && (
        <div className="chat-failed" role="alert">
          <span>
            보내지 못한 채팅 {failed.length}개: “{failed[0]}”{failed.length > 1 ? ' 외' : ''}
          </span>
          <button
            type="button"
            onClick={() => {
              setText((current) => [current.trim(), ...failed].filter(Boolean).join(' '))
              setFailed([])
            }}
          >
            입력창으로 되돌리기
          </button>
          <button type="button" className="link-button" onClick={() => setFailed([])}>
            버리기
          </button>
        </div>
      )}
      {status === 'authenticated' && (
        <form className="chat-form" onSubmit={onSubmit}>
          <div className="chat-input">
            <input
              aria-label="채팅 입력"
              placeholder={PLACEHOLDER[broadcastStatus ?? 'LIVE']}
              value={text}
              maxLength={COMMENT_MAX_LENGTH}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => pasteOverflows(e) && toast(OVERFLOW_NOTICE, 'info')}
              autoComplete="off"
              enterKeyHint="send"
            />
            {text.length >= COUNTER_FROM && (
              <span className={`chat-count${text.length >= COMMENT_MAX_LENGTH ? ' is-full' : ''}`} aria-live="polite">
                {text.length}/{COMMENT_MAX_LENGTH}
              </span>
            )}
            <button type="submit" className="chat-send" disabled={!text.trim()} aria-label="전송" title="전송 (Enter)">
              <Send size={18} aria-hidden="true" />
            </button>
          </div>
          {throttled && (
            <p className="chat-hint" role="status">
              채팅이 몰려 잠시 후 이어서 보냅니다…
            </p>
          )}
        </form>
      )}
      {status === 'anonymous' && (
        <p className="chat-login">
          <Link to={loginPath} className="button chat-login-button">
            {ended ? '로그인하고 감상 남기기' : '로그인하고 채팅하기'}
          </Link>
        </p>
      )}
      {status === 'error' && (
        <p className="muted chat-login">
          로그인 상태를 확인하지 못해 채팅을 쓸 수 없습니다. 위쪽의 "다시 시도"를 누르거나 새로고침해 주세요.
        </p>
      )}
    </aside>
  )
}

function ChatSkeleton() {
  return (
    <div className="chat-skeleton" role="status">
      <span className="chat-sr-only">채팅을 불러오는 중…</span>
      {[72, 48, 86, 60, 40, 78, 55].map((width, i) => (
        <span key={i} className="chat-skeleton-row" style={{ width: `${width}%` }} aria-hidden="true" />
      ))}
    </div>
  )
}

function ChatTime({ iso }: { iso: string }) {
  return (
    <time className="chat-time" dateTime={iso} title={new Date(iso).toLocaleString('ko-KR')}>
      {formatChatTime(iso)}
    </time>
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
  onPasteOverflow: () => void
}

function ChatItem({ comment, mine, editing, onStartEdit, onCancelEdit, onSave, onDelete, onPasteOverflow }: ItemProps) {
  const base = { 'data-testid': 'comment', 'data-comment-id': comment.id }
  if (comment.content === null) {
    return (
      <li className="chat-item chat-deleted" {...base}>
        <ChatTime iso={comment.createdAt} />
        <span>삭제된 채팅입니다.</span>
      </li>
    )
  }
  if (comment.donation) {
    // 후원 채팅: 후원 원장과 같은 기록이라 수정·삭제 버튼을 두지 않는다
    return (
      <li className="chat-item chat-donation" {...base}>
        <span className="chat-donation-head">
          <ChatTime iso={comment.createdAt} />
          <HandCoins size={15} aria-hidden="true" className="chat-donation-icon" />
          <strong className="chat-author">{comment.author?.nickname}</strong>
          <span className="chat-donation-amount">{formatWon(comment.donation.amount)} 후원</span>
        </span>
        {comment.content && <span className="chat-content">{comment.content}</span>}
      </li>
    )
  }
  const author = comment.author
  return (
    <li
      className={`chat-item${comment.isStreamer ? ' chat-streamer' : ''}${mine ? ' chat-mine' : ''}`}
      // 터치 화면에는 마우스 올림이 없으므로 내 채팅을 탭하면(포커스) 수정·삭제 버튼을 보인다
      tabIndex={mine && !editing ? -1 : undefined}
      {...base}
    >
      <ChatTime iso={comment.createdAt} />
      {comment.isStreamer && <span className="badge chat-badge">방송자</span>}
      <strong
        className="chat-author"
        style={comment.isStreamer || !author ? undefined : { color: colorOf(author.id) }}
      >
        {author?.nickname}
      </strong>
      {editing ? (
        <EditForm initial={comment.content} onSave={onSave} onCancel={onCancelEdit} onPasteOverflow={onPasteOverflow} />
      ) : (
        <>
          <span className="chat-content">
            {comment.content}
            {/* 본문 안에 두어 블록처럼 다음 줄로 밀리지 않고 본문 끝에 이어 붙는다 */}
            {comment.editedAt && <span className="chat-edited"> (수정됨)</span>}
          </span>
          {mine && (
            <span className="chat-actions">
              <button type="button" className="chat-icon-button" onClick={onStartEdit} aria-label="채팅 수정" title="수정">
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" className="chat-icon-button" onClick={onDelete} aria-label="채팅 삭제" title="삭제">
                <Trash2 size={14} aria-hidden="true" />
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
  onPasteOverflow,
}: {
  initial: string
  onSave: (content: string) => Promise<void>
  onCancel: () => void
  onPasteOverflow: () => void
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
        aria-label="채팅 수정 내용"
        value={value}
        maxLength={COMMENT_MAX_LENGTH}
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => pasteOverflows(e) && onPasteOverflow()}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        autoFocus
      />
      <button type="submit" className="primary" disabled={saving || !value.trim()}>
        저장
      </button>
      <button type="button" onClick={onCancel}>
        취소
      </button>
    </form>
  )
}
