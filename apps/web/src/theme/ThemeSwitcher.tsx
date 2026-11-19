import { setThemePreference, THEME_OPTIONS, useThemePreference } from './theme'

/** 테마를 고르는 세 칸짜리 선택지. 헤더 계정 메뉴와 푸터에서 같이 쓴다 */
export function ThemeSwitcher({ className = '' }: { className?: string }) {
  const current = useThemePreference()
  return (
    <div className={`theme-switcher ${className}`} role="group" aria-label="화면 테마">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
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
