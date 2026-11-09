import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { Avatar } from '../components/Avatar'
import { StatusBadge } from '../components/BroadcastList'
import { ChatPanel } from '../components/ChatPanel'
import { DonationAlert, DonationBoard, DonationPanel } from '../components/Donations'
import { LivePlayer } from '../components/LivePlayer'
import { ReplayPlayer } from '../components/ReplayPlayer'
import { useBroadcastEvents } from '../hooks/useBroadcastEvents'
import { useBroadcast } from '../hooks/useBroadcast'
import { useComments } from '../hooks/useComments'
import { useDonations } from '../hooks/useDonations'
import { useRecordings } from '../hooks/useRecordings'
import { errorMessage } from '../lib/api'
import { type BroadcastStatus, deleteBroadcast } from '../lib/broadcasts'
import type { Donation } from '../lib/donations'

const PLAYER_MESSAGE: Record<BroadcastStatus, string> = {
  READY: '방송 시작 전입니다',
  LIVE: '방송 화면 준비 중',
  ENDED: '방송이 종료되었습니다',
}

/** 종료된 방송: 녹화가 있으면 다시보기, 막 끝났으면 준비 중 안내 (#12) */
function EndedPlayer({ replay, everLive }: { replay: ReturnType<typeof useRecordings>; everLive: boolean }) {
  const { recordings, error, preparing, reload } = replay
  if (recordings && recordings.length > 0) return <ReplayPlayer recordings={recordings} />

  let message = PLAYER_MESSAGE.ENDED
  if (!recordings && error) message = `다시보기를 불러오지 못했습니다: ${error}`
  else if (!recordings) message = '다시보기를 불러오는 중…'
  else if (preparing) message = '녹화 파일을 준비하고 있습니다. 준비가 끝나면 이 화면에서 바로 재생됩니다'
  else if (everLive) message = '방송이 종료되었습니다. 저장된 녹화가 없습니다'

  return (
    <div className="player-placeholder" data-testid="player-placeholder">
      <StatusBadge status="ENDED" />
      <p className="muted" role={error ? 'alert' : undefined}>
        {message}
      </p>
      {!recordings && error && (
        <button type="button" onClick={reload}>
          다시 시도
        </button>
      )}
    </div>
  )
}

export function BroadcastPage() {
  const id = Number(useParams().id)
  const { user } = useAuth()
  const navigate = useNavigate()
  const { broadcast, error, patch } = useBroadcast(id)
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [viewers, setViewers] = useState<number | null>(null)
  const [deleted, setDeleted] = useState(false)
  // 송출이 다시 붙을 때마다 플레이어를 새로 연결한다
  const [playerKey, setPlayerKey] = useState(0)
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const donations = useDonations(broadcast ? id : null)
  // 화면에 띄울 최신 후원 알림
  const [latestDonation, setLatestDonation] = useState<Donation | null>(null)
  // 종료된 방송만 녹화를 읽는다 (방송 중에 생긴 세그먼트는 종료 후 한꺼번에 보여준다)
  const replay = useRecordings(id, broadcast?.status === 'ENDED', broadcast?.endedAt ?? null)

  const { connected } = useBroadcastEvents(broadcast ? id : null, {
    status: (data) => {
      if (data.status === 'LIVE' && !data.disconnectedAt) setPlayerKey((k) => k + 1)
      patch(data)
    },
    updated: (data) => patch(data),
    viewers: (data) => setViewers(data.count),
    deleted: () => setDeleted(true),
    donation: (data) => {
      donations.push(data)
      setLatestDonation(data.donation)
    },
    recording: (data) => replay.add(data),
    comment: (data) => chat.apply(data.comment),
  })
  // 댓글은 같은 SSE 연결로 받는다. 연결(재연결)될 때마다 목록을 다시 읽어 놓친 변경을 맞춘다
  const chat = useComments(broadcast ? id : null, connected)

  // 실시간 연결이 끊겼다 다시 붙으면 그 사이 놓친 후원을 다시 읽는다 (첫 연결은 처음 읽은 목록으로 충분하다)
  const everConnected = useRef(false)
  const { reload: reloadDonations } = donations
  useEffect(() => {
    if (!connected) return
    if (everConnected.current) reloadDonations()
    everConnected.current = true
  }, [connected, reloadDonations])

  if (error) {
    return (
      <section>
        <p className="error">{error.status === 404 ? '방송을 찾을 수 없습니다. 삭제되었을 수 있습니다.' : error.message}</p>
        <Link to="/">목록으로</Link>
      </section>
    )
  }
  if (!broadcast) return <p className="muted">불러오는 중…</p>
  if (deleted) {
    return (
      <section>
        <p className="error">방송자가 이 방송을 삭제했습니다.</p>
        <Link to="/">목록으로</Link>
      </section>
    )
  }

  const isOwner = user?.channelId === broadcast.channel.id

  async function onDelete() {
    if (!window.confirm('이 방송을 삭제할까요? 삭제한 방송은 목록에서 사라집니다.')) return
    setActionError(null)
    setDeleting(true)
    try {
      await deleteBroadcast(id)
      navigate(`/channels/${broadcast!.channel.id}`, { replace: true })
    } catch (e) {
      setDeleting(false)
      if (!redirectIfUnauthorized(e)) setActionError(errorMessage(e))
    }
  }

  return (
    <div className="broadcast-layout">
      <article className="broadcast-detail">
        {broadcast.status === 'ENDED' ? (
          <EndedPlayer replay={replay} everLive={broadcast.startedAt !== null} />
        ) : broadcast.status === 'LIVE' && !broadcast.disconnectedAt && !isOwner ? (
          <LivePlayer key={playerKey} broadcastId={id} />
        ) : (
          <div className="player-placeholder" data-testid="player-placeholder">
            <StatusBadge status={broadcast.status} />
            <p className="muted">
              {broadcast.disconnectedAt
                ? '방송자의 연결이 끊겼습니다. 다시 연결되기를 기다리는 중…'
                : isOwner && broadcast.status === 'LIVE'
                  ? '방송 중입니다. 송출 화면은 방송 스튜디오에서 확인하세요'
                  : PLAYER_MESSAGE[broadcast.status]}
            </p>
          </div>
        )}
        <div className="broadcast-body">
          <div className="broadcast-info">
            <Link to={`/channels/${broadcast.channel.id}`} aria-label={`${broadcast.streamer.nickname} 채널`}>
              <Avatar id={broadcast.streamer.id} name={broadcast.streamer.nickname} size={48} />
            </Link>
            <div className="broadcast-info-text">
              <h1>{broadcast.title}</h1>
              <div className="broadcast-meta">
                <Link to={`/channels/${broadcast.channel.id}`} className="streamer-name">
                  {broadcast.streamer.nickname}
                </Link>
                <span data-testid="status-line">
                  <StatusBadge status={broadcast.status} />
                  {viewers !== null && broadcast.status === 'LIVE' && ` 시청자 ${viewers}명`}
                </span>
              </div>
            </div>
          </div>
          {broadcast.description && <p className="description">{broadcast.description}</p>}

          {latestDonation && <DonationAlert key={latestDonation.id} donation={latestDonation} />}
          <DonationPanel broadcast={broadcast} isOwner={isOwner} />
          <DonationBoard donations={donations} />

          {isOwner && (
            <div className="row owner-actions">
              {broadcast.status !== 'ENDED' && (
                <Link to={`/broadcasts/${id}/studio`} className="button primary">
                  {broadcast.status === 'LIVE' ? '방송 스튜디오로 돌아가기' : '방송 시작하기'}
                </Link>
              )}
              <Link to={`/broadcasts/${id}/edit`} className="button">
                정보 수정
              </Link>
              {/* 방송 중에는 시청자가 있어 삭제할 수 없다 (서버도 409로 막는다) */}
              <button
                type="button"
                className="danger"
                onClick={onDelete}
                disabled={deleting || broadcast.status === 'LIVE'}
                aria-describedby={broadcast.status === 'LIVE' ? 'delete-hint' : undefined}
              >
                {deleting ? '삭제 중…' : '삭제'}
              </button>
              {broadcast.status === 'LIVE' && (
                <small id="delete-hint" className="muted">
                  방송을 종료한 뒤 삭제할 수 있습니다
                </small>
              )}
            </div>
          )}
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
        </div>
      </article>
      <ChatPanel broadcastId={id} chat={chat} />
    </div>
  )
}
