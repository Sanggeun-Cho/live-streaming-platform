import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { StatusBadge } from '../components/BroadcastList'
import { useBroadcast } from '../hooks/useBroadcast'
import { errorMessage } from '../lib/api'
import { type BroadcastStatus, deleteBroadcast } from '../lib/broadcasts'

const PLAYER_MESSAGE: Record<BroadcastStatus, string> = {
  READY: '방송 시작 전입니다',
  LIVE: '방송 화면 준비 중',
  ENDED: '방송이 종료되었습니다',
}

export function BroadcastPage() {
  const id = Number(useParams().id)
  const { user } = useAuth()
  const navigate = useNavigate()
  const { broadcast, error } = useBroadcast(id)
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const redirectIfUnauthorized = useAuthErrorRedirect()

  if (error) {
    return (
      <section>
        <p className="error">{error.status === 404 ? '방송을 찾을 수 없습니다. 삭제되었을 수 있습니다.' : error.message}</p>
        <Link to="/">목록으로</Link>
      </section>
    )
  }
  if (!broadcast) return <p className="muted">불러오는 중…</p>

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
      <div className="player-placeholder">
        <StatusBadge status={broadcast.status} />
        <p className="muted">{PLAYER_MESSAGE[broadcast.status]}</p>
      </div>
      <h1>{broadcast.title}</h1>
      <p>
        <Link to={`/channels/${broadcast.channel.id}`}>{broadcast.streamer.nickname}</Link>
      </p>
      {broadcast.description && <p className="description">{broadcast.description}</p>}

      {isOwner && (
        <div className="row owner-actions">
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
