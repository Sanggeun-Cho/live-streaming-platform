import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'info' | 'error'

export type ConfirmOptions = {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 되돌릴 수 없는 동작(종료·삭제)이면 확인 버튼을 빨간색으로 */
  danger?: boolean
}

export type Feedback = {
  /** 화면 아래에 잠깐 떴다 사라지는 알림 */
  toast: (message: string, tone?: ToastTone) => void
  /** 확인 대화상자. 확인을 누르면 true */
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

export const FeedbackContext = createContext<Feedback | null>(null)

export function useFeedback(): Feedback {
  const value = useContext(FeedbackContext)
  if (!value) throw new Error('FeedbackProvider 안에서만 쓸 수 있습니다')
  return value
}
