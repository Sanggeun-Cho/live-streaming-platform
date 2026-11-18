import { Clock, Play, RotateCw, TriangleAlert, Users } from 'lucide-react'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type Broadcast, STATUS_LABEL } from '../lib/broadcasts'
import { errorMessage } from '../lib/api'
import { formatDuration, type Replay } from '../lib/recordings'
import { colorOf } from '../lib/avatar'
import { Avatar } from './Avatar'
import { EmptyState } from './EmptyState'
import { useNow } from '../hooks/useNow'
import { timeAgo } from '../lib/time'
import './broadcast-list.css'

export function StatusBadge({ status }: { status: Broadcast['status'] }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>
}


export type Item = Broadcast & Partial<Pick<Replay, 'recordingCount' | 'totalDurationMs'>>

/** 목록 한 페이지를 읽는 함수. cursor가 없으면 첫 페이지 */
export type PageFetcher = (
  cursor: number | undefined,
  signal?: AbortSignal,
) => Promise<{ items: Item[]; nextCursor: number | null }>

/**
 * listKey: 조건을 나타내는 문자열. 바뀌면 새로 마운트해 처음부터 다시 읽는다.
 * fetchPage·onLoad는 처음 받은 것을 계속 쓴다 (매 렌더 새 함수를 넘겨도 다시 읽지 않게)
 */
type Props = {
  listKey: string
  fetchPage: PageFetcher
  empty: ReactNode
  /** 첫 카드를 크게 보여준다 (홈의 라이브) */
  featured?: boolean
  /** 첫 페이지를 받으면 알린다 (화면 위쪽의 개수·바로가기용) */
  onLoad?: (page: { items: Item[]; hasMore: boolean }) => void
  /** 첫 로딩 동안 자리를 잡아 둘 카드 수 */
  skeletons?: number
  /** 받은 항목 중 카드로 보여줄 것 (예: 너무 짧은 다시보기 제외) */
  filter?: (item: Item) => boolean
}

/** 방송 목록 + 더 보기. 방송 목록·채널 방송·다시보기(#12)가 조회 함수만 바꿔 같이 쓴다 */
export function BroadcastList(props: Props) {
  return <BroadcastListInner key={props.listKey} {...props} />
}

function BroadcastListInner({ fetchPage: initialFetch, onLoad, empty, featured, skeletons = 4, filter }: Props) {
  const [fetchList] = useState(() => initialFetch)
  const [notify] = useState(() => onLoad)
  const [items, setItems] = useState<Item[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [state, setState] = useState<'loading' | 'idle' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  const fetchPage = useCallback(
    (cursor: number | undefined, signal?: AbortSignal) =>
      fetchList(cursor, signal)
        .then((page) => {
          setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
          setNextCursor(page.nextCursor)
          setState('idle')
          if (!cursor) notify?.({ items: page.items, hasMore: page.nextCursor !== null })
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return
          setError(errorMessage(e))
          setState('error')
        }),
    [fetchList, notify],
  )

  const load = (cursor?: number) => {
    setState('loading')
    void fetchPage(cursor)
  }

  useEffect(() => {
    const controller = new AbortController()
    void fetchPage(undefined, controller.signal)
    return () => controller.abort()
  }, [fetchPage])

  if (state === 'error' && items.length === 0) {
    return (
      <div role="alert">
        <EmptyState
          inline
          as="p"
          tone="error"
          icon={TriangleAlert}
          title="목록을 불러오지 못했습니다"
          description={error}
          action={
            <button type="button" onClick={() => load(undefined)}>
              <RotateCw size={16} aria-hidden="true" /> 다시 시도
            </button>
          }
        />
      </div>
    )
  }

  const visible = filter ? items.filter(filter) : items
  const loading = state === 'loading'
  if (!loading && visible.length === 0 && !nextCursor) return <>{empty}</>

  return (
    <>
      <ul className={`broadcast-grid${featured ? ' has-featured' : ''}`} aria-busy={loading}>
        {visible.map((b, i) => (
          <li key={b.id} className={featured && i === 0 ? 'featured' : undefined}>
            <BroadcastCard b={b} now={now} />
          </li>
        ))}
        {/* 카드와 같은 크기로 자리를 잡아 두어, 목록이 도착할 때 아래 내용이 밀리지 않게 한다 */}
        {loading &&
          Array.from({ length: items.length === 0 ? skeletons : 2 }, (_, i) => (
            <li key={`skeleton-${i}`} className="card-skeleton" aria-hidden="true">
              <div className="thumb" />
              <div className="card-meta">
                <span className="skeleton-line" />
                <span className="skeleton-line short" />
              </div>
            </li>
          ))}
      </ul>
      {loading && <span className="sr-only">불러오는 중…</span>}
      {state === 'error' && <p className="error">더 불러오지 못했습니다: {error}</p>}
      {nextCursor && !loading && (
        <button type="button" className="more" onClick={() => load(nextCursor)}>
          더 보기
        </button>
      )}
    </>
  )
}

function BroadcastCard({ b, now }: { b: Item; now: number }) {
  const [imageFailed, setImageFailed] = useState(false)
  const live = b.status === 'LIVE'
  const replay = b.totalDurationMs !== undefined
  const viewers = live && b.viewers !== undefined ? `시청자 ${b.viewers.toLocaleString()}명` : null
  const elapsed = live && b.startedAt ? formatElapsed(now - Date.parse(b.startedAt)) : null
  const duration = replay ? formatDuration(b.totalDurationMs!) : null

  const badge = live ? (
    <span className="badge badge-live">
      <span className="badge-dot" />
      LIVE
    </span>
  ) : b.status === 'READY' ? (
    <span className="badge badge-ready">방송 예정</span>
  ) : (
    <span className="badge badge-ended">{replay ? '다시보기' : STATUS_LABEL.ENDED}</span>
  )
  // 방송 중이면 경과 시간이 썸네일에 있으므로 따로 적지 않는다
  const when = live
    ? null
    : b.status === 'READY'
      ? `${timeAgo(b.createdAt, now)} 등록`
      : timeAgo(b.endedAt ?? b.updatedAt, now)
  // 카드 안의 글자(아바타 글자, 배지, 썸네일 제목)를 이어 읽지 않도록 링크 이름을 한 문장으로 정한다
  const state = live
    ? ['방송 중', viewers, elapsed && `${elapsed} 경과`]
    : b.status === 'READY'
      ? ['방송 예정']
      : [replay ? `다시보기 ${duration}` : '방송 종료', when]
  const label = [b.title, b.streamer.nickname, ...state].filter(Boolean).join(', ')

  return (
    <Link to={`/broadcasts/${b.id}`} className="broadcast-card" aria-label={label}>
      <div className="thumb" style={{ '--thumb-color': colorOf(b.streamer.id) } as CSSProperties} aria-hidden="true">
        {b.thumbnailUrl && !imageFailed ? (
          <img
            className="thumb-media"
            src={b.thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          // 화면이 없으면 방송자 색 배경에 제목을 크게 써서 카드마다 구분되게 한다
          <div className="thumb-media thumb-cover">
            <span className="thumb-cover-title">{b.title}</span>
            <span className="thumb-cover-by">{b.streamer.nickname}</span>
          </div>
        )}
        <span className="thumb-top">{badge}</span>
        {viewers && (
          <span className="thumb-chip thumb-left">
            <Users size={13} strokeWidth={2.5} />
            {b.viewers!.toLocaleString()}
          </span>
        )}
        {elapsed && (
          <span className="thumb-chip thumb-right">
            <Clock size={13} strokeWidth={2.5} />
            {elapsed}
          </span>
        )}
        {duration && (
          <span className="thumb-chip thumb-right">
            <Play size={12} strokeWidth={2.5} fill="currentColor" />
            {duration}
          </span>
        )}
      </div>
      <div className="card-meta" aria-hidden="true">
        <Avatar id={b.streamer.id} name={b.streamer.nickname} size={36} />
        <div className="card-text">
          <strong className="title">{b.title}</strong>
          <span className="card-sub">
            {b.streamer.nickname}
            {when && <span className="card-when">{when}</span>}
          </span>
        </div>
      </div>
    </Link>
  )
}

/** 방송 경과: 45분 / 1시간 5분 */
function formatElapsed(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분`
  return `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`
}

