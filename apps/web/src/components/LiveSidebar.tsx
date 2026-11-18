import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { type Broadcast, listBroadcasts } from '../lib/broadcasts'
import { onLiveSignal } from '../lib/liveSignals'
import { Avatar } from './Avatar'

// 다른 채널의 시작·종료를 늦어도 이 간격 안에 반영한다. 지금 보는 방송은 SSE 알림으로 즉시 반영한다
const REFRESH_MS = 10_000

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
    window.addEventListener('focus', load)

    // 열려 있는 방송 화면이 받은 시청자 수·종료를 바로 반영한다 (본문 숫자와 어긋나지 않게)
    const off = onLiveSignal(({ broadcastId, viewers, live }) => {
      if (live === false) setItems((prev) => prev?.filter((b) => b.id !== broadcastId) ?? prev)
      else if (live === true) load() // 새로 시작한 방송은 목록에 없을 수 있어 다시 읽는다
      if (viewers !== undefined) {
        setItems((prev) => prev?.map((b) => (b.id === broadcastId ? { ...b, viewers } : b)) ?? prev)
      }
    })

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', load)
      window.removeEventListener('focus', load)
      off()
      controller.abort()
    }
    // 화면을 옮길 때마다 다시 읽는다 (방송을 시작·종료하고 이동하면 바로 반영)
  }, [pathname])

  return (
    <aside className="sidebar" aria-label="지금 라이브 중인 채널">
      <h2 className="sidebar-title">지금 라이브</h2>
      {items?.length === 0 && <p className="sidebar-empty">방송 중인 채널이 없습니다</p>}
      <ul>
        {items?.map((b) => {
          const current = pathname === `/broadcasts/${b.id}`
          const viewers = b.viewers ?? 0
          return (
            <li key={b.id}>
              <Link
                to={`/broadcasts/${b.id}`}
                className={`sidebar-item${current ? ' active' : ''}`}
                aria-current={current ? 'page' : undefined}
                title={b.title}
              >
                <Avatar id={b.streamer.id} name={b.streamer.nickname} size={32} />
                <span className="sidebar-text">
                  <strong>{b.streamer.nickname}</strong>
                  <span className="dim">{b.title}</span>
                </span>
                <span className="sidebar-viewers">
                  <span className="live-dot" aria-hidden="true" />
                  <span className="sr-only">시청자 </span>
                  {viewers.toLocaleString()}
                  <span className="sr-only">명</span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
