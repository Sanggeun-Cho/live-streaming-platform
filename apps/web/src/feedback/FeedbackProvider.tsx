import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './feedback.css'
import { type ConfirmOptions, FeedbackContext, type ToastTone } from './context'

type Toast = { id: number; message: string; tone: ToastTone }
type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void }

const TOAST_MS = 3500

/**
 * 화면 전체에서 쓰는 피드백: 확인 대화상자(window.confirm 대체)와 토스트 알림.
 * 대화상자는 <dialog>로 띄워 포커스 가두기·Esc 닫기를 브라우저 기본 동작에 맡긴다.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const nextId = useRef(0)

  const toast = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = ++nextId.current
    setToasts((list) => [...list.slice(-2), { id, message, tone }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  // 대화상자가 떠 있는 동안 새 확인이 오면(예: 이동 확인과 종료 확인이 겹침) 앞의 것은 취소로 끝낸다.
  // 그냥 덮어쓰면 앞 호출의 await가 영원히 끝나지 않는다
  const pendingRef = useRef<PendingConfirm | null>(null)
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false)
        const next = { ...options, resolve }
        pendingRef.current = next
        setPending(next)
      }),
    [],
  )

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm])

  return (
    <FeedbackContext value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
      {pending && (
        <ConfirmDialog
          {...pending}
          onClose={(ok) => {
            pending.resolve(ok)
            pendingRef.current = null
            setPending(null)
          }}
        />
      )}
    </FeedbackContext>
  )
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = '확인',
  cancelLabel = '취소',
  danger = false,
  onClose,
}: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose(false)
      }}
      // 바깥(배경)을 누르면 취소
      onClick={(e) => e.target === e.currentTarget && onClose(false)}
    >
      <h2 id="confirm-title">{title}</h2>
      {message && <p className="dim">{message}</p>}
      <div className="confirm-actions">
        <button type="button" onClick={() => onClose(false)} autoFocus>
          {cancelLabel}
        </button>
        <button type="button" className={danger ? 'danger solid' : 'primary'} onClick={() => onClose(true)}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
