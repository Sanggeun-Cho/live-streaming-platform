import { CalendarClock, CircleAlert, Clapperboard, Play, Plus, Radio, SearchX } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { Avatar } from '../components/Avatar'
import { EmptyState } from '../components/EmptyState'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { BroadcastList, ListEmpty, type Item } from '../components/BroadcastList'
import { ApiError, api, errorMessage } from '../lib/api'
import { colorOf } from '../lib/avatar'
import { type BroadcastStatus, listBroadcasts } from '../lib/broadcasts'

type Channel = { id: number; name: string; owner: { id: number; nickname: string } }
type Result = { id: number; channel: Channel | null; error: { status: number; message: string } | null }

export function ChannelPage() {
  const channelId = Number(useParams().channelId)
  const valid = Number.isInteger(channelId) && channelId > 0
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
  useDocumentTitle(current?.channel ? `${current.channel.owner.nickname}의 채널` : null)
  if (!valid || current?.error?.status === 404) {
    return (
      <EmptyState
        icon={SearchX}
        as="h1"
        title="채널을 찾을 수 없습니다"
        description="삭제되었거나 주소가 바뀌었을 수 있습니다."
        action={
          <Link to="/" className="button primary">
            지금 방송 중인 라이브 보기
          </Link>
        }
      />
    )
  }
  if (current?.error) {
    return (
      <EmptyState
        icon={CircleAlert}
        tone="error"
        as="h1"
        title="채널을 불러오지 못했습니다"
        description={current.error.message}
        action={
          <button type="button" onClick={() => window.location.reload()}>
            다시 시도
          </button>
        }
      />
    )
  }
  if (!current?.channel) {
    return (
      <div className="channel-header" aria-busy="true">
        <span className="sr-only">채널을 불러오는 중…</span>
      </div>
    )
  }
  // 채널이 바뀌면 상태별 개수를 처음부터 다시 센다
  return <ChannelBody key={channelId} channel={current.channel} />
}

type Section = { count: number; hasMore: boolean; first: Item | undefined }

function ChannelBody({ channel }: { channel: Channel }) {
  const { user } = useAuth()
  const isMine = user?.channelId === channel.id
  const [sections, setSections] = useState<Partial<Record<BroadcastStatus, Section>>>({})
  const { LIVE: live, READY: ready, ENDED: ended } = sections
  const liveNow = live?.first

  const listOf = (status: BroadcastStatus) => ({
    listKey: `channel:${channel.id}:${status}`,
    fetchPage: (cursor: number | undefined, signal?: AbortSignal) =>
      listBroadcasts({ channelId: channel.id, status, cursor }, signal),
    onLoad: ({ items, hasMore }: { items: Item[]; hasMore: boolean }) =>
      setSections((prev) => ({ ...prev, [status]: { count: items.length, hasMore, first: items[0] } })),
  })
  const countText = (s: Section | undefined) => (s ? `${s.count}${s.hasMore ? '+' : ''}개` : '…')

  // 다른 상태 목록이 다 도착한 뒤에 문구를 정해, "끝난 방송 없음"이 잠깐 보였다가 "방송 없음"으로 바뀌지 않게 한다
  const othersLoaded = live !== undefined && ready !== undefined
  const nothingAtAll = othersLoaded && live.count === 0 && ready.count === 0
  const endedEmpty = !othersLoaded ? null : nothingAtAll ? (
    isMine ? (
      <ListEmpty icon={Radio} title="아직 만든 방송이 없습니다">
        <p>"새 방송 만들기"로 첫 방송을 준비하세요.</p>
      </ListEmpty>
    ) : (
      <ListEmpty icon={Radio} title="이 채널에는 아직 방송이 없습니다" />
    )
  ) : (
    <ListEmpty icon={Clapperboard} title="아직 끝난 방송이 없습니다">
      <p>방송이 끝나면 다시보기가 이곳에 쌓입니다.</p>
    </ListEmpty>
  )

  return (
    <>
      <section
        className="channel-header"
        style={{ '--channel-color': colorOf(channel.owner.id) } as CSSProperties}
        aria-labelledby="channel-title"
      >
        <div className={`channel-avatar${liveNow ? ' is-live' : ''}`}>
          <Avatar id={channel.owner.id} name={channel.owner.nickname} size={76} />
          {liveNow && <span className="badge badge-live">LIVE</span>}
        </div>
        <div className="channel-info">
          <h1 id="channel-title">
            {channel.owner.nickname}
            {isMine && <span className="badge channel-mine">내 채널</span>}
          </h1>
          <p className="channel-stats">
            <span>{channel.name}</span>
            {liveNow ? <strong>지금 방송 중</strong> : live && <span>지금은 방송하지 않습니다</span>}
            <span>
              지난 방송 <strong>{countText(ended)}</strong>
            </span>
            {ready && ready.count > 0 && (
              <span>
                예정 <strong>{countText(ready)}</strong>
              </span>
            )}
          </p>
        </div>
        <div className="channel-actions">
          {liveNow && (
            <Link to={`/broadcasts/${liveNow.id}`} className="button live">
              <Play size={16} fill="currentColor" aria-hidden="true" />
              지금 보러 가기
            </Link>
          )}
          {isMine && (
            <Link to="/broadcasts/new" className="button primary">
              <Plus size={18} aria-hidden="true" />새 방송 만들기
            </Link>
          )}
        </div>
      </section>

      {/* 방송 중·예정은 있을 때만 보인다. 목록은 숨긴 채로 받아 와 개수를 센다 */}
      <section aria-labelledby="channel-live" hidden={!live?.count}>
        <h2 id="channel-live" className="section-title">
          <span className="live-dot" aria-hidden="true" /> 방송 중
        </h2>
        <BroadcastList {...listOf('LIVE')} skeletons={1} empty={null} />
      </section>
      <section aria-labelledby="channel-ready" hidden={!ready?.count}>
        <h2 id="channel-ready" className="section-title">
          <CalendarClock size={18} aria-hidden="true" /> 방송 예정
        </h2>
        <BroadcastList {...listOf('READY')} skeletons={1} empty={null} />
      </section>
      <section aria-labelledby="channel-ended">
        <h2 id="channel-ended" className="section-title">
          지난 방송
        </h2>
        <BroadcastList {...listOf('ENDED')} empty={endedEmpty} />
      </section>
    </>
  )
}
