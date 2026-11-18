import { ChevronDown, LogOut, Monitor, Moon, Plus, Sun, UserRound, Video, WifiOff } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { useAuth } from '../auth/context'
import { useThemePreference } from '../theme/theme'
import { ThemeSwitcher } from '../theme/ThemeSwitcher'
import { Avatar } from './Avatar'
import { BrandMark } from './BrandMark'

/** 헤더의 주요 메뉴. 휴대폰에서는 하단 탭(TabBar)이 같은 곳으로 보낸다 */
const PRIMARY_NAV = [
  { to: '/', label: '홈', end: true },
  { to: '/lives', label: '라이브', end: false },
  { to: '/replays', label: '다시보기', end: false },
] as const

export function SiteHeader() {
  const { status, user, refresh } = useAuth()
  return (
    <header className="header">
      <div className="header-start">
        <Link to="/" className="brand" aria-label="galle LIVE 홈">
          <BrandMark className="brand-mark" />
          galle<span className="brand-live">LIVE</span>
        </Link>
        <nav className="header-nav" aria-label="주요 메뉴">
          {PRIMARY_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="header-nav-link">
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="nav">
        {/* 비로그인도 보인다: 누르면 로그인 후 새 방송 화면으로 돌아온다 */}
        <Link to="/broadcasts/new" className="button nav-cta" aria-label="방송하기" title="방송하기">
          <Video size={18} aria-hidden="true" />
          <span className="nav-label">방송하기</span>
          <span className="nav-label-short" aria-hidden="true">
            방송
          </span>
        </Link>
        {status === 'authenticated' && user && <AccountMenu />}
        {status === 'error' && (
          <>
            <span className="nav-error" role="status">
              <WifiOff size={16} aria-hidden="true" />
              <span className="nav-label">서버 연결 오류</span>
            </span>
            <button type="button" className="ghost" onClick={refresh}>
              다시 시도
            </button>
          </>
        )}
        {(status === 'anonymous' || status === 'error') && (
          <>
            <ThemeMenu />
            <Link to="/login" className="button">
              로그인
            </Link>
            <Link to="/signup" className="button nav-signup">
              회원가입
            </Link>
          </>
        )}
      </div>
    </header>
  )
}

function AccountMenu() {
  const { user, logout } = useAuth()
  if (!user) return null
  return (
    <Dropdown
      label={`${user.nickname} 계정 메뉴`}
      buttonClassName="nav-user"
      button={
        <>
          <Avatar id={user.id} name={user.nickname} size={30} />
          <span className="nav-nickname">{user.nickname}</span>
          <ChevronDown size={16} aria-hidden="true" className="nav-chevron" />
        </>
      }
    >
      <div className="menu-profile">
        <Avatar id={user.id} name={user.nickname} size={40} />
        <div>
          <strong>{user.nickname}</strong>
          <span>{user.email}</span>
        </div>
      </div>
      <Link to={`/channels/${user.channelId}`} className="menu-item">
        <UserRound size={18} aria-hidden="true" />내 채널
      </Link>
      <Link to="/broadcasts/new" className="menu-item">
        <Plus size={18} aria-hidden="true" />새 방송 만들기
      </Link>
      <div className="menu-section">
        <span className="menu-section-title">화면 테마</span>
        <ThemeSwitcher />
      </div>
      <button type="button" className="menu-item" onClick={() => void logout()}>
        <LogOut size={18} aria-hidden="true" />
        로그아웃
      </button>
    </Dropdown>
  )
}

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const

/** 비로그인 사용자용 테마 버튼: 계정 메뉴가 없으므로 따로 둔다 */
function ThemeMenu() {
  const Icon = THEME_ICON[useThemePreference()]
  return (
    <Dropdown label="화면 테마" buttonClassName="ghost icon-only" button={<Icon size={18} aria-hidden="true" />}>
      <div className="menu-section">
        <span className="menu-section-title">화면 테마</span>
        <ThemeSwitcher />
      </div>
    </Dropdown>
  )
}

/**
 * 헤더의 펼침 메뉴. 바깥을 누르거나 Esc를 누르거나 다른 화면으로 이동하면 닫힌다.
 * Esc로 닫으면 메뉴를 연 버튼으로 포커스를 돌려준다.
 */
function Dropdown({
  label,
  button,
  buttonClassName,
  children,
}: {
  label: string
  button: ReactNode
  buttonClassName: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const { pathname } = useLocation()

  // 화면을 옮기면 닫는다 (메뉴 안의 링크를 누른 경우 포함)
  const [openedAt, setOpenedAt] = useState(pathname)
  if (open && openedAt !== pathname) {
    setOpen(false)
    setOpenedAt(pathname)
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClassName}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpenedAt(pathname)
          setOpen((v) => !v)
        }}
      >
        {button}
      </button>
      <div id={menuId} className="dropdown-panel" hidden={!open}>
        {children}
      </div>
    </div>
  )
}
