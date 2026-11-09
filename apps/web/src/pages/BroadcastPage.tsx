import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { StatusBadge } from '../components/BroadcastList'
import { useBroadcast } from '../hooks/useBroadcast'
import { errorMessage } from '../lib/api'
import { deleteBroadcast } from '../lib/broadcasts'

export function BroadcastPage() {
  const id = Number(useParams().id)
  const { user } = useAuth()
  const navigate = useNavigate()
  const { broadcast, error } = useBroadcast(id)
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

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
      setActionError(errorMessage(e))
      setDeleting(false)
    }
  }

  return (
    <article className="broadcast-detail">
      <div className="player-placeholder">
        <StatusBadge status={broadcast.status} />
        <p className="muted">
          {broadcast.status === 'LIVE' && '방송 화면 준비 중'}
          {broadcast.status === 'READY' && '방송 시작 전입니다'}
          {broadcast.status === 'ENDED' && '방송이 종료되었습니다'}
        </p>
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
          <button type="button" className="danger" onClick={onDelete} disabled={deleting}>
            {deleting ? '삭제 중…' : '삭제'}
          </button>
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
