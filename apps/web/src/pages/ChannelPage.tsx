import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { BroadcastList } from '../components/BroadcastList'
import { ApiError, api, errorMessage } from '../lib/api'
import { listBroadcasts } from '../lib/broadcasts'

type Channel = { id: number; name: string; owner: { id: number; nickname: string } }
type Result = { id: number; channel: Channel | null; error: { status: number; message: string } | null }

export function ChannelPage() {
  const channelId = Number(useParams().channelId)
  const valid = Number.isInteger(channelId) && channelId > 0
  const { user } = useAuth()
  const isMine = user?.channelId === channelId
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    if (!valid) return
    const controller = new AbortController()
    api<{ channel: Channel }>(`/channels/${channelId}`, { signal: controller.signal })
      .then(({ channel }) => setResult({ id: channelId, channel, error: null }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setResult({ id: channelId, channel: null, error: { status: e instanceof ApiError ? e.status : 0, message: errorMessage(e) } })
      })
    return () => controller.abort()
  }, [channelId, valid])

  const current = result?.id === channelId ? result : null
  if (!valid || current?.error?.status === 404) {
    return (
      <section>
        <p className="error">채널을 찾을 수 없습니다.</p>
        <Link to="/">목록으로</Link>
      </section>
    )
  }
  if (current?.error) return <p className="error">{current.error.message}</p>
  if (!current?.channel) return <p className="muted">불러오는 중…</p>

  return (
    <section>
      <div className="row">
        <h1>{isMine ? `내 채널 · ${current.channel.name}` : current.channel.name}</h1>
        {isMine && (
          <Link to="/broadcasts/new" className="button">
            새 방송 만들기
          </Link>
        )}
      </div>
      <BroadcastList
        listKey={`channel:${channelId}`}
        fetchPage={(cursor, signal) => listBroadcasts({ channelId, cursor }, signal)}
        empty={isMine ? '아직 만든 방송이 없습니다. "새 방송 만들기"로 시작하세요.' : '이 채널에는 아직 방송이 없습니다.'}
      />
    </section>
  )
}
