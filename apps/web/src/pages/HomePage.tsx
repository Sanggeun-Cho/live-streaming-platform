import { CalendarClock, ChevronRight, Clapperboard, Radio } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { BroadcastList } from '../components/BroadcastList'
import type { Item } from '../components/BroadcastList'
import { EmptyState } from '../components/EmptyState'
import { FeaturedLive } from '../components/FeaturedLive'
import { listBroadcasts } from '../lib/broadcasts'
import type { Broadcast } from '../lib/broadcasts'
import { listReplays } from '../lib/recordings'

// 송출을 시험하다 바로 끈 5초도 안 되는 녹화는 볼거리가 없어 홈 다시보기에서 뺀다 (채널·상세에서는 그대로 보인다)
const MIN_REPLAY_MS = 5_000
const isWatchableReplay = (item: Item) => (item.totalDurationMs ?? 0) >= MIN_REPLAY_MS
// 만들어 두고 하루 넘게 시작하지 않은 방송은 "예정"이라 보기 어렵다: 홈에서는 빼고 채널 화면에만 둔다
const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000
const isUpcoming = (item: Item) => Date.now() - Date.parse(item.createdAt) < UPCOMING_WINDOW_MS

export function HomePage() {
  // 맨 위 추천 라이브용. 아래 "지금 방송 중" 목록은 따로 읽어 카드 그리드를 그린다
  const [lives, setLives] = useState<Broadcast[] | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    listBroadcasts({ status: 'LIVE', limit: 20 }, controller.signal)
      .then((page) => setLives(page.items))
      .catch(() => setLives([])) // 실패하면 아래 목록이 오류와 다시 시도를 보여준다
    return () => controller.abort()
  }, [])

  return (
    <>
      <h1 className="sr-only">galle LIVE 홈</h1>
      <FeaturedLive lives={lives} />

      {lives !== null && lives.length > 1 && (
        <HomeSection id="live" title="지금 방송 중" more="/lives" live>
          <BroadcastList
            listKey="live"
            skeletons={4}
            fullRows={4}
            paginate={false}
            fetchPage={(cursor, signal) => listBroadcasts({ status: 'LIVE', cursor, limit: 8 }, signal)}
            empty={<EmptyState inline as="p" icon={Radio} title="지금은 방송 중인 채널이 없습니다" />}
          />
        </HomeSection>
      )}

      <HomeSection id="replays" title="다시보기" more="/replays">
        <BroadcastList
          listKey="replays"
          filter={isWatchableReplay}
          fullRows={4}
          paginate={false}
          fetchPage={(cursor, signal) => listReplays({ cursor, limit: 12 }, signal)}
          empty={
            <EmptyState
              inline
              as="p"
              icon={Clapperboard}
              title="아직 다시 볼 수 있는 방송이 없습니다"
              description="방송이 끝나면 녹화본이 이곳에 올라옵니다."
            />
          }
        />
      </HomeSection>

      {/* 위 두 섹션과 겹치지 않게 시작 전 방송만 보여준다 */}
      <HomeSection id="ready" title="방송 예정">
        <BroadcastList
          listKey="ready"
          filter={isUpcoming}
          fullRows={4}
          paginate={false}
          fetchPage={(cursor, signal) => listBroadcasts({ status: 'READY', cursor, limit: 8 }, signal)}
          empty={<EmptyState inline as="p" icon={CalendarClock} title="예정된 방송이 없습니다" />}
        />
      </HomeSection>
    </>
  )
}

function HomeSection({
  id,
  title,
  more,
  live = false,
  children,
}: {
  id: string
  title: string
  more?: string
  live?: boolean
  children: ReactNode
}) {
  return (
    <section className="home-section" aria-labelledby={`${id}-heading`}>
      <div className="section-head">
        <h2 id={`${id}-heading`} className="section-title">
          {live && <span className="live-dot" aria-hidden="true" />}
          {title}
        </h2>
        {more && (
          <Link to={more} className="section-more">
            전체 보기
            <ChevronRight size={16} aria-hidden="true" />
            <span className="sr-only">: {title}</span>
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}
