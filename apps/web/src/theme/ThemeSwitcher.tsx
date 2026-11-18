import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { setThemePreference, useThemePreference } from './theme'
import type { ThemePreference } from './theme'

const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: '시스템', icon: Monitor },
  { value: 'light', label: '라이트', icon: Sun },
  { value: 'dark', label: '다크', icon: Moon },
]

/** 테마를 고르는 세 칸짜리 선택지. 헤더 계정 메뉴와 푸터에서 같이 쓴다 */
export function ThemeSwitcher({ className = '' }: { className?: string }) {
  const current = useThemePreference()
  return (
    <div className={`theme-switcher ${className}`} role="group" aria-label="화면 테마">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={current === value}
          className="theme-option"
          onClick={() => setThemePreference(value)}
        >
          <Icon size={15} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  )
}
