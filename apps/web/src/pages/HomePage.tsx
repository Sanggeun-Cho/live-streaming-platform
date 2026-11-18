import { CalendarClock, Clapperboard, MessageCircleHeart, Monitor, Radio, Smartphone, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/context'
import { BroadcastList, type Item } from '../components/BroadcastList'
import { EmptyState } from '../components/EmptyState'
import { listBroadcasts } from '../lib/broadcasts'
import { listReplays } from '../lib/recordings'

// 송출을 시험하다 바로 끈 5초도 안 되는 녹화는 볼거리가 없어 홈 다시보기에서 뺀다 (채널·상세에서는 그대로 보인다)
const MIN_REPLAY_MS = 5_000
const isWatchableReplay = (item: Item) => (item.totalDurationMs ?? 0) >= MIN_REPLAY_MS
// 만들어 두고 하루 넘게 시작하지 않은 방송은 "예정"이라 보기 어렵다: 홈에서는 빼고 채널 화면에만 둔다
const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000
const isUpcoming = (item: Item) => Date.now() - Date.parse(item.createdAt) < UPCOMING_WINDOW_MS

type LiveCount = { count: number; hasMore: boolean }

export function HomePage() {
  const { user } = useAuth()
  const [live, setLive] = useState<LiveCount | null>(null)

  return (
    <>
      {/* 첫 화면에서 "무엇을 하는 곳인지"와 "지금 볼 것이 있는지"를 함께 알린다. 휴대폰에서는 한 줄로 줄어든다 */}
      <section className="home-intro" aria-labelledby="home-title">
        <div className="home-intro-text">
          {live?.count ? (
            // 휴대폰에서는 이 한 줄이 소개를 대신하므로 누르면 라이브 목록으로 내려간다
            <a href="#live-heading" className="home-kicker is-live">
              <span className="live-dot" aria-hidden="true" />
              {live.count}
              {live.hasMore ? '개 이상의' : '개'} 방송 진행 중
            </a>
          ) : (
            !user && <p className="home-kicker">로그인 없이 바로 시청할 수 있습니다.</p>
          )}
          <h1 id="home-title">누구나 바로 보고, 바로 방송합니다</h1>
          <p className="home-intro-desc">
            실시간 방송을 보며 채팅과 후원으로 방송자와 함께합니다. 방송은 설치 없이 PC 화면 공유나 휴대폰 카메라로
            시작합니다.
          </p>
        </div>
        {/* 헤더의 "방송하기"(초록)와 나란히 두 개의 주 버튼이 되지 않게 여기서는 보조 버튼으로 */}
        <div className="home-actions">
          <Link to="/broadcasts/new" className="button">
            <Radio size={18} aria-hidden="true" />
            방송 시작하기
          </Link>
          {user && (
            <Link to={`/channels/${user.channelId}`} className="button">
              <UserRound size={18} aria-hidden="true" />내 채널
            </Link>
          )}
        </div>
      </section>

      <section aria-labelledby="live-heading">
        <div className="section-head">
          <h2 id="live-heading" className="section-title">
            <span className="live-dot" aria-hidden="true" /> 지금 방송 중
          </h2>
          {live !== null && live.count > 0 && (
            <span className="section-count">
              {live.count}
              {live.hasMore ? '+' : ''}개 방송
            </span>
          )}
        </div>
        <BroadcastList
          listKey="live"
          featured
          skeletons={3}
          fetchPage={(cursor, signal) => listBroadcasts({ status: 'LIVE', cursor }, signal)}
          onLoad={({ items, hasMore }) => setLive({ count: items.length, hasMore })}
          empty={
            <EmptyState
              inline
              as="p"
              icon={Radio}
              title="지금은 방송 중인 채널이 없습니다"
              description="방송이 시작되면 이곳에 가장 먼저 보입니다. 아래에서 최근 다시보기를 볼 수 있습니다."
              action={
                <Link to="/broadcasts/new" className="button">
                  <Radio size={16} aria-hidden="true" />
                  방송하기
                </Link>
              }
            />
          }
        />
      </section>

      <section aria-labelledby="replays-heading">
        <h2 id="replays-heading" className="section-title">
          다시보기
        </h2>
        <BroadcastList
          listKey="replays"
          filter={isWatchableReplay}
          fullRows={4}
          fetchPage={(cursor, signal) => listReplays({ cursor, limit: 8 }, signal)}
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
      </section>

      <section aria-labelledby="ready-heading">
        {/* 위 두 섹션과 겹치지 않게 시작 전 방송만 보여준다 */}
        <h2 id="ready-heading" className="section-title">
          방송 예정
        </h2>
        <BroadcastList
          listKey="ready"
          filter={isUpcoming}
          fullRows={4}
          fetchPage={(cursor, signal) => listBroadcasts({ status: 'READY', cursor, limit: 8 }, signal)}
          empty={<EmptyState inline as="p" icon={CalendarClock} title="예정된 방송이 없습니다" />}
        />
      </section>

      <section aria-labelledby="guide-heading">
        <h2 id="guide-heading" className="section-title">
          방송하는 방법
        </h2>
        <ul className="home-guide">
          <li>
            <Monitor size={22} aria-hidden="true" />
            <div>
              <strong>PC는 화면 공유</strong>
              <p>탭·시스템 소리와 마이크를 함께 내보냅니다.</p>
            </div>
          </li>
          <li>
            <Smartphone size={22} aria-hidden="true" />
            <div>
              <strong>휴대폰은 카메라</strong>
              <p>앱 설치 없이 브라우저에서 바로 방송합니다.</p>
            </div>
          </li>
          <li>
            <MessageCircleHeart size={22} aria-hidden="true" />
            <div>
              <strong>채팅과 후원</strong>
              <p>시청자는 채팅으로 소통하고 후원으로 응원합니다.</p>
            </div>
          </li>
        </ul>
      </section>
    </>
  )
}
