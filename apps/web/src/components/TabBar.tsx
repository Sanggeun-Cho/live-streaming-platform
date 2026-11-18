import { Clapperboard, House, Radio, UserRound } from 'lucide-react'
import { NavLink } from 'react-router'
import { useAuth } from '../auth/context'

/** 휴대폰 하단 탭. 시청·방송 화면처럼 화면을 가득 쓰는 곳에서는 App이 그리지 않는다 */
export function TabBar() {
  const { user } = useAuth()
  const me = user ? { to: `/channels/${user.channelId}`, label: '내 채널' } : { to: '/login', label: '로그인' }
  const tabs = [
    { to: '/', label: '홈', icon: House, end: true },
    { to: '/lives', label: '라이브', icon: Radio, end: false },
    { to: '/replays', label: '다시보기', icon: Clapperboard, end: false },
    { ...me, icon: UserRound, end: false },
  ]
  return (
    <nav className="tab-bar" aria-label="하단 메뉴">
      {tabs.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} className="tab-bar-item">
          <Icon size={22} aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}
