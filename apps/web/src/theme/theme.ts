import { useSyncExternalStore } from 'react'

/** 사용자가 고른 테마. system은 기기(OS·브라우저)의 라이트/다크 설정을 따른다 */
export type ThemePreference = 'system' | 'light' | 'dark'

// index.html의 깜빡임 방지 스크립트와 같은 키를 쓴다
const STORAGE_KEY = 'galle-theme'
// 주소창·상태 표시줄 색: --bg-elev와 같게 둔다
const THEME_COLOR = { light: '#ffffff', dark: '#0e1117' } as const

const darkQuery = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')
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
  const resolved = preference === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = resolved
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved])
}

darkQuery?.addEventListener('change', () => {
  if (preference === 'system') apply()
})

export function setThemePreference(next: ThemePreference) {
  preference = next
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 저장하지 못해도 이번 방문 동안은 고른 테마를 쓴다
  }
  apply()
  listeners.forEach((notify) => notify())
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference)
}
