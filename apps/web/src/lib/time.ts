const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const dateTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
const monthDay = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' })

/** "2026. 11. 18. 오후 7:05" */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso))

/** "방금 전", "3분 전", "2시간 전", "4일 전", 일주일이 넘으면 "11월 3일" */
export function timeAgo(iso: string, now = Date.now()): string {
  // 서버와 시계가 조금 어긋나 미래 시각이 와도 "방금 전"으로 보인다
  const diff = Math.max(0, now - new Date(iso).getTime())
  if (diff < MINUTE) return '방금 전'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}분 전`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}일 전`
  return monthDay.format(new Date(iso))
}
