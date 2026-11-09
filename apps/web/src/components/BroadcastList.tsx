import { type CSSProperties, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type Broadcast, STATUS_LABEL } from '../lib/broadcasts'
import { errorMessage } from '../lib/api'
import { formatDuration, type Replay } from '../lib/recordings'
import { colorOf } from '../lib/avatar'
import { Avatar } from './Avatar'

export function StatusBadge({ status }: { status: Broadcast['status'] }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>
}

type Item = Broadcast & Partial<Pick<Replay, 'recordingCount' | 'totalDurationMs'>>

/** 목록 한 페이지를 읽는 함수. cursor가 없으면 첫 페이지 */
export type PageFetcher = (
  cursor: number | undefined,
  signal?: AbortSignal,
) => Promise<{ items: Item[]; nextCursor: number | null }>

/**
 * listKey: 조건을 나타내는 문자열. 바뀌면 새로 마운트해 처음부터 다시 읽는다.
 * fetchPage는 처음 받은 것을 계속 쓴다 (매 렌더 새 함수를 넘겨도 다시 읽지 않게)
 */
type Props = { listKey: string; fetchPage: PageFetcher; empty: string }

/** 방송 목록 + 더 보기. 방송 목록·채널 방송·다시보기(#12)가 조회 함수만 바꿔 같이 쓴다 */
export function BroadcastList(props: Props) {
  return <BroadcastListInner key={props.listKey} {...props} />
}

function BroadcastListInner({ fetchPage: initialFetch, empty }: Props) {
  const [fetchList] = useState(() => initialFetch)
  const [items, setItems] = useState<Item[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [state, setState] = useState<'loading' | 'idle' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(
    (cursor: number | undefined, signal?: AbortSignal) =>
      fetchList(cursor, signal)
        .then((page) => {
          setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
          setNextCursor(page.nextCursor)
          setState('idle')
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return
          setError(errorMessage(e))
          setState('error')
        }),
    [fetchList],
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
        <p className="error">목록을 불러오지 못했습니다: {error}</p>
        <button type="button" onClick={() => load(undefined)}>
          다시 시도
        </button>
      </div>
    )
  }

  return (
    <>
      {state !== 'loading' && items.length === 0 && <p className="empty">{empty}</p>}
      <ul className="broadcast-grid">
        {items.map((b) => (
          <li key={b.id}>
            <Link to={`/broadcasts/${b.id}`} className="broadcast-card">
              {/* 썸네일이 없으므로 방송자 색으로 만든 배경에 방송자 이니셜을 그린다 */}
              <div className="thumb" style={{ '--thumb-color': colorOf(b.streamer.id) } as CSSProperties}>
                <span className="thumb-initial" aria-hidden="true">
                  {b.streamer.nickname.charAt(0)}
                </span>
                <StatusBadge status={b.status} />
                {b.status === 'LIVE' && b.viewers !== undefined && (
                  <span className="thumb-viewers">시청자 {b.viewers.toLocaleString()}명</span>
                )}
                {b.totalDurationMs !== undefined && (
                  <span className="duration" aria-label="다시보기 길이">
                    ▶ {formatDuration(b.totalDurationMs)}
                  </span>
                )}
              </div>
              <div className="card-meta">
                <Avatar id={b.streamer.id} name={b.streamer.nickname} size={36} />
                <div className="card-text">
                  <strong className="title">{b.title}</strong>
                  <span className="dim">{b.streamer.nickname}</span>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {state === 'loading' && <p className="muted">불러오는 중…</p>}
      {state === 'error' && items.length > 0 && <p className="error">더 불러오지 못했습니다: {error}</p>}
      {nextCursor && state !== 'loading' && (
        <button type="button" className="more" onClick={() => load(nextCursor)}>
          더 보기
        </button>
      )}
    </>
  )
}
