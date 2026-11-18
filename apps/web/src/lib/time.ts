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

/** 무슨 일이 언제 있었는지 뜻이 분명하게: "방금 시작", "12분 전 시작", "2시간 전 종료" */
export function timeAgoOf(iso: string, action: string, now = Date.now()): string {
  const ago = timeAgo(iso, now)
  return ago === '방금 전' ? `방금 ${action}` : `${ago} ${action}`
}

/**
 * 요약에 쓰는 말로 된 길이: "48초", "12분 30초", "1시간 5분".
 * 재생 위치·경과처럼 계속 바뀌는 값은 시계 표기(lib/recordings의 formatDuration, 1:05)를 쓴다.
 */
export function formatDurationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`
  if (m > 0) return s > 0 ? `${m}분 ${s}초` : `${m}분`
  return `${s}초`
}
