import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type Broadcast, type ListParams, listBroadcasts, STATUS_LABEL } from '../lib/broadcasts'
import { errorMessage } from '../lib/api'

export function StatusBadge({ status }: { status: Broadcast['status'] }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>
}

type Props = { params: Omit<ListParams, 'cursor'>; empty: string }

/** 방송 목록 + 더 보기. 조건(params)이 바뀌면 key로 새로 마운트해 처음부터 다시 읽는다 */
export function BroadcastList(props: Props) {
  return <BroadcastListInner key={JSON.stringify(props.params)} {...props} />
}

function BroadcastListInner({ params, empty }: Props) {
  const [query] = useState(params)
  const [items, setItems] = useState<Broadcast[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [state, setState] = useState<'loading' | 'idle' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(
    (cursor: number | undefined, signal?: AbortSignal) =>
      listBroadcasts({ ...query, cursor }, signal)
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
    [query],
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
      {state !== 'loading' && items.length === 0 && <p className="muted">{empty}</p>}
      <ul className="broadcast-grid">
        {items.map((b) => (
          <li key={b.id}>
            <Link to={`/broadcasts/${b.id}`} className="broadcast-card">
              <div className="thumb">
                <StatusBadge status={b.status} />
              </div>
              <strong className="title">{b.title}</strong>
              <span className="muted">{b.streamer.nickname}</span>
            </Link>
          </li>
        ))}
      </ul>
      {state === 'loading' && <p className="muted">불러오는 중…</p>}
      {state === 'error' && items.length > 0 && <p className="error">더 불러오지 못했습니다: {error}</p>}
      {nextCursor && state !== 'loading' && (
        <button type="button" onClick={() => load(nextCursor)}>
          더 보기
        </button>
      )}
    </>
  )
}
