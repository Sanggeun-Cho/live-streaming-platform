import { CircleAlert, Lock, SearchX } from 'lucide-react'
import { type FormEvent, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { EmptyState } from '../components/EmptyState'
import { FormField } from '../components/FormField'
import { Spinner } from '../components/Spinner'
import { useBroadcast } from '../hooks/useBroadcast'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { errorMessage } from '../lib/api'
import { type Broadcast, createBroadcast, updateBroadcast } from '../lib/broadcasts'

const TITLE_MAX = 100
const DESCRIPTION_MAX = 2000

type FormProps = {
  initial?: Broadcast
  onSubmit: (input: { title: string; description: string }) => Promise<void>
  submitLabel: string
  pendingLabel: string
  /** 있으면 "취소" 버튼을 보여주고 누르면 이 함수를 부른다 */
  onCancel?: () => void
}

function BroadcastForm({ initial, onSubmit, submitLabel, pendingLabel, onCancel }: FormProps) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [titleError, setTitleError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const redirectIfUnauthorized = useAuthErrorRedirect()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setTitleError('제목을 입력하세요')
      titleRef.current?.focus()
      return
    }
    setSubmitting(true)
    try {
      await onSubmit({ title: title.trim(), description })
    } catch (err) {
      setSubmitting(false)
      if (!redirectIfUnauthorized(err)) setError(errorMessage(err))
    }
  }

  const submit = (
    <button type="submit" disabled={submitting} aria-busy={submitting}>
      {submitting && <Spinner />}
      {submitting ? pendingLabel : submitLabel}
    </button>
  )

  return (
    <form onSubmit={handleSubmit} className="form" noValidate>
      <FormField label="제목" count={`${title.length}/${TITLE_MAX}`} error={titleError}>
        {(control) => (
          <input
            {...control}
            ref={titleRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleError(null)
            }}
            maxLength={TITLE_MAX}
            placeholder="예: 저녁 라이브 코딩"
            required
            autoFocus
          />
        )}
      </FormField>
      <FormField label="설명 (선택)" count={`${description.length}/${DESCRIPTION_MAX}`}>
        {(control) => (
          <textarea
            {...control}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={DESCRIPTION_MAX}
            rows={5}
            placeholder="시청자에게 보여줄 방송 소개를 적어 주세요"
          />
        )}
      </FormField>
      {error && (
        <p className="form-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          {error}
        </p>
      )}
      {onCancel ? (
        // 주 버튼이 오른쪽에 오도록 역순으로 놓는다 (CSS row-reverse)
        <div className="form-actions">
          {submit}
          <button type="button" onClick={onCancel} disabled={submitting}>
            취소
          </button>
        </div>
      ) : (
        submit
      )}
    </form>
  )
}

export function NewBroadcastPage() {
  const navigate = useNavigate()
  useDocumentTitle('새 방송 만들기')
  return (
    <section className="auth-card">
      <h1>새 방송 만들기</h1>
      <p className="auth-lead">방송을 만든 뒤 스튜디오에서 카메라나 화면을 골라 송출을 시작합니다.</p>
      <BroadcastForm
        submitLabel="만들기"
        pendingLabel="만드는 중…"
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
  useDocumentTitle(broadcast ? `${broadcast.title} 정보 수정` : '방송 정보 수정')

  if (error) {
    return (
      <EmptyState
        icon={SearchX}
        tone="error"
        as="h1"
        title={error.status === 404 ? '방송을 찾을 수 없습니다' : '방송 정보를 불러오지 못했습니다'}
        description={error.status === 404 ? '삭제되었거나 주소가 잘못되었습니다.' : error.message}
        action={
          <Link to="/" className="button">
            홈으로
          </Link>
        }
      />
    )
  }
  if (!broadcast) {
    return (
      <div className="empty-state">
        <Spinner label="방송 정보를 불러오는 중…" />
      </div>
    )
  }
  if (user?.channelId !== broadcast.channel.id) {
    return (
      <EmptyState
        icon={Lock}
        as="h1"
        title="본인 방송만 수정할 수 있습니다"
        description="다른 사람의 방송 정보는 바꿀 수 없습니다."
        action={
          <Link to={`/broadcasts/${id}`} className="button">
            방송으로 돌아가기
          </Link>
        }
      />
    )
  }

  return (
    <section className="auth-card">
      <h1>방송 정보 수정</h1>
      <p className="auth-lead">바꾼 제목과 설명은 시청자 화면에도 바로 반영됩니다.</p>
      <BroadcastForm
        initial={broadcast}
        submitLabel="저장"
        pendingLabel="저장하는 중…"
        onCancel={() => navigate(`/broadcasts/${id}`)}
        onSubmit={async (input) => {
          await updateBroadcast(id, input)
          navigate(`/broadcasts/${id}`, { replace: true })
        }}
      />
    </section>
  )
}
