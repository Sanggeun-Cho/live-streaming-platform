import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { type Broadcast, listBroadcasts } from '../lib/broadcasts'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { Avatar } from './Avatar'

// 목록 새로고침 간격. 방송 시작·종료가 사이드바에 너무 늦게 반영되지 않게 한다
const REFRESH_MS = 15_000

/** 데스크톱 왼쪽의 "지금 라이브" 채널 목록. 좁은 화면에서는 그리지 않아 요청도 하지 않는다 */
export function LiveSidebar() {
  const wide = useMediaQuery('(min-width: 1100px)')
  return wide ? <LiveSidebarList /> : null
}

function LiveSidebarList() {
  const [items, setItems] = useState<Broadcast[] | null>(null)
  const { pathname } = useLocation()

  useEffect(() => {
    let controller = new AbortController()
    const load = () => {
      // 탭이 숨겨져 있으면 건너뛴다 (돌아오면 visibilitychange에서 바로 읽는다)
      if (document.visibilityState === 'hidden') return
      controller.abort()
      controller = new AbortController()
      listBroadcasts({ status: 'LIVE', limit: 20 }, controller.signal)
        .then((page) => setItems(page.items))
        .catch(() => undefined) // 사이드바는 보조 정보라 실패해도 조용히 다음 주기에 다시 읽는다
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    document.addEventListener('visibilitychange', load)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', load)
      controller.abort()
    }
    // 화면을 옮길 때마다 다시 읽는다 (방송을 시작·종료하고 이동하면 바로 반영)
  }, [pathname])

  return (
    <aside className="sidebar" aria-label="지금 라이브 중인 채널">
      <h2 className="sidebar-title">지금 라이브</h2>
      {items?.length === 0 && <p className="sidebar-empty">방송 중인 채널이 없습니다</p>}
      <ul>
        {items?.map((b) => (
          <li key={b.id}>
            <Link
              to={`/broadcasts/${b.id}`}
              className={`sidebar-item${pathname === `/broadcasts/${b.id}` ? ' active' : ''}`}
              aria-current={pathname === `/broadcasts/${b.id}` ? 'page' : undefined}
              title={b.title}
            >
              <Avatar id={b.streamer.id} name={b.streamer.nickname} size={32} />
              <span className="sidebar-text">
                <strong>{b.streamer.nickname}</strong>
                <span className="dim">{b.title}</span>
              </span>
              <span className="sidebar-viewers" aria-label={`시청자 ${b.viewers ?? 0}명`}>
                <span className="live-dot" aria-hidden="true" />
                {b.viewers ?? 0}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  )
}
