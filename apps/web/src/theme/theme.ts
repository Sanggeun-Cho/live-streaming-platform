import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'

/** 사용자가 고른 테마. system은 기기(OS·브라우저)의 라이트/다크 설정을 따른다 */
export type ThemePreference = 'system' | 'light' | 'dark'

/** 테마 선택지와 아이콘: 선택 UI와 헤더의 테마 버튼이 같이 쓴다 */
export const THEME_OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: '시스템', icon: Monitor },
  { value: 'light', label: '라이트', icon: Sun },
  { value: 'dark', label: '다크', icon: Moon },
]

// index.html의 깜빡임 방지 스크립트와 같은 키를 쓴다
const STORAGE_KEY = 'galle-theme'
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 기기 설정을 따른다
  }
  return 'system'
}

let preference = readPreference()

function apply() {
  const resolved = preference === 'system' ? (darkQuery.matches ? 'dark' : 'light') : preference
  const root = document.documentElement
  root.dataset.theme = resolved
  // 주소창·상태 표시줄 색은 헤더 배경 토큰을 그대로 쓴다
  const color = getComputedStyle(root).getPropertyValue('--bg-elev').trim()
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', color)
}

function update(next: ThemePreference) {
  preference = next
  apply()
  listeners.forEach((notify) => notify())
}

darkQuery.addEventListener('change', () => {
  if (preference === 'system') apply()
})

// 다른 탭에서 바꾼 테마도 바로 따라간다
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY || e.key === null) update(readPreference())
})

export function setThemePreference(next: ThemePreference) {
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 저장하지 못해도 이번 방문 동안은 고른 테마를 쓴다
  }
  update(next)
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference)
}
