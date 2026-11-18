/**
 * 돌아가는 원. label을 주면 화면 낭독기에도 읽히는 상태 문구와 함께 보이고,
 * 없으면 장식으로만 쓴다 (버튼 안처럼 옆 글자가 이미 상황을 설명할 때).
 */
export function Spinner({ label, size = 'md' }: { label?: string; size?: 'md' | 'lg' }) {
  const circle = <span className={size === 'lg' ? 'spinner spinner-lg' : 'spinner'} aria-hidden="true" />
  if (!label) return circle
  return (
    <span className="spinner-status" role="status">
      {circle}
      {label}
    </span>
  )
}
