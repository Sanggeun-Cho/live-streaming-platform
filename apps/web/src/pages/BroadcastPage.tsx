import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { StatusBadge } from '../components/BroadcastList'
import { DonationAlert, DonationBoard, DonationPanel } from '../components/Donations'
import { LivePlayer } from '../components/LivePlayer'
import { useBroadcastEvents } from '../hooks/useBroadcastEvents'
import { useBroadcast } from '../hooks/useBroadcast'
import { useDonations } from '../hooks/useDonations'
import { errorMessage } from '../lib/api'
import { type BroadcastStatus, deleteBroadcast } from '../lib/broadcasts'
import type { Donation } from '../lib/donations'

const PLAYER_MESSAGE: Record<BroadcastStatus, string> = {
  READY: '방송 시작 전입니다',
  LIVE: '방송 화면 준비 중',
  ENDED: '방송이 종료되었습니다',
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
  })

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
    <article className="broadcast-detail">
      {broadcast.status === 'LIVE' && !broadcast.disconnectedAt && !isOwner ? (
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
      <div className="row">
        <h1>{broadcast.title}</h1>
        <span className="muted" data-testid="status-line">
          <StatusBadge status={broadcast.status} />
          {viewers !== null && broadcast.status === 'LIVE' && ` 시청자 ${viewers}명`}
        </span>
      </div>
      <p>
        <Link to={`/channels/${broadcast.channel.id}`}>{broadcast.streamer.nickname}</Link>
      </p>
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
    </article>
  )
}
