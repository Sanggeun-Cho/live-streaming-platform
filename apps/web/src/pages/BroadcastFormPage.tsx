import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { errorMessage } from '../lib/api'
import { type Broadcast, createBroadcast, updateBroadcast } from '../lib/broadcasts'
import { useBroadcast } from '../hooks/useBroadcast'

const TITLE_MAX = 100
const DESCRIPTION_MAX = 2000

function BroadcastForm({ initial, onSubmit, submitLabel }: {
  initial?: Broadcast
  onSubmit: (input: { title: string; description: string }) => Promise<void>
  submitLabel: string
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError('제목을 입력하세요')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onSubmit({ title, description })
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="form" noValidate>
      <label>
        제목
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX} required autoFocus />
        <small className="muted">
          {title.length}/{TITLE_MAX}
        </small>
      </label>
      <label>
        설명 (선택)
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={DESCRIPTION_MAX}
          rows={5}
        />
        <small className="muted">
          {description.length}/{DESCRIPTION_MAX}
        </small>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? '저장 중…' : submitLabel}
      </button>
    </form>
  )
}

export function NewBroadcastPage() {
  const navigate = useNavigate()
  return (
    <section className="auth-card">
      <h1>새 방송 만들기</h1>
      <BroadcastForm
        submitLabel="만들기"
        onSubmit={async (input) => {
          const created = await createBroadcast(input)
          navigate(`/broadcasts/${created.id}`, { replace: true })
        }}
      />
    </section>
  )
}

export function EditBroadcastPage() {
  const id = Number(useParams().id)
  const { user } = useAuth()
  const navigate = useNavigate()
  const { broadcast, error } = useBroadcast(id)

  if (error) return <p className="error">{error.message}</p>
  if (!broadcast) return <p className="muted">불러오는 중…</p>
  if (user?.channelId !== broadcast.channel.id) {
    return (
      <section>
        <p className="error">본인 방송만 수정할 수 있습니다.</p>
        <Link to={`/broadcasts/${id}`}>방송으로 돌아가기</Link>
      </section>
    )
  }

  return (
    <section className="auth-card">
      <h1>방송 정보 수정</h1>
      <BroadcastForm
        initial={broadcast}
        submitLabel="저장"
        onSubmit={async (input) => {
          await updateBroadcast(id, input)
          navigate(`/broadcasts/${id}`, { replace: true })
        }}
      />
    </section>
  )
}
