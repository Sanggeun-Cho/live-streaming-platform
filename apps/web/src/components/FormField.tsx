import { CircleAlert } from 'lucide-react'
import { type ReactNode, useId } from 'react'

/** 입력 요소에 그대로 펼쳐 넣는 접근성 속성 (라벨 연결, 오류·도움말 연결) */
export type FieldControlProps = {
  id: string
  'aria-invalid': boolean
  'aria-describedby': string | undefined
}

type Props = {
  label: string
  /** 입력 아래 도움말 (예: "8자 이상") */
  hint?: string
  /** 오른쪽 아래 글자 수 (예: "12/100") */
  count?: string
  error?: string | null
  children: (control: FieldControlProps) => ReactNode
}

/** 라벨 + 입력 + 도움말 + 필드별 오류. 오류는 해당 입력 바로 아래에 보이고 화면 낭독기에도 연결된다 */
export function FormField({ label, hint, count, error, children }: Props) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {(hint || count) && (
        <div className="field-foot">
          {hint && <span id={hintId}>{hint}</span>}
          {count && <span className="field-count">{count}</span>}
        </div>
      )}
      {error && (
        <p className="field-error" id={errorId} role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}
