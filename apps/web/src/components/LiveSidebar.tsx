import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { type Broadcast, listBroadcasts } from '../lib/broadcasts'
import { Avatar } from './Avatar'

// 목록 새로고침 간격. 방송 시작·종료가 사이드바에 너무 늦게 반영되지 않게 한다
const REFRESH_MS = 30_000

/** 데스크톱 왼쪽의 "지금 라이브" 채널 목록. 좁은 화면에서는 CSS로 숨긴다 */
export function LiveSidebar() {
  const [items, setItems] = useState<Broadcast[] | null>(null)
  const { pathname } = useLocation()

  useEffect(() => {
    let controller = new AbortController()
    const load = () => {
      controller.abort()
      controller = new AbortController()
      listBroadcasts({ status: 'LIVE', limit: 20 }, controller.signal)
        .then((page) => setItems(page.items))
        .catch(() => undefined) // 사이드바는 보조 정보라 실패해도 조용히 다음 주기에 다시 읽는다
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [])

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
              title={b.title}
            >
              <Avatar id={b.streamer.id} name={b.streamer.nickname} size={32} />
              <span className="sidebar-text">
                <strong>{b.streamer.nickname}</strong>
                <span className="dim">{b.title}</span>
              </span>
              <span className="sidebar-viewers">
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
