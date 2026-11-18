import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type Props = {
  icon: LucideIcon
  title: string
  description?: ReactNode
  /** 다음 행동 버튼·링크 (예: <Link to="/" className="button primary">홈으로</Link>) */
  action?: ReactNode
  /** 오류 안내면 'error' (아이콘이 빨간색) */
  tone?: 'default' | 'error'
  /** 화면 전체를 대신하는 안내(404 등)면 'h1' */
  as?: 'h1' | 'h2' | 'h3' | 'p'
  /** 목록 자리에 들어가는 작은 안내(점선 테두리) */
  inline?: boolean
}

/** 내용이 없거나 불러오지 못했을 때 보여주는 안내: 아이콘, 제목, 설명, 다음 행동 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'default',
  as: Heading = 'h2',
  inline = false,
}: Props) {
  return (
    <div className={`empty-state tone-${tone}${inline ? ' empty-state-inline' : ''}`}>
      <span className="empty-state-icon" aria-hidden="true">
        <Icon size={26} strokeWidth={1.75} />
      </span>
      <Heading className="empty-state-title">{title}</Heading>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
