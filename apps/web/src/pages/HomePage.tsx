import { CalendarClock, Clapperboard, MessageCircleHeart, Monitor, Radio, Smartphone, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/context'
import { BroadcastList, EmptyState, type Item } from '../components/BroadcastList'
import { listBroadcasts } from '../lib/broadcasts'
import { listReplays } from '../lib/recordings'

// 송출을 시험하다 바로 끈 5초도 안 되는 녹화는 볼거리가 없어 홈 다시보기에서 뺀다 (채널·상세에서는 그대로 보인다)
const MIN_REPLAY_MS = 5_000
const isWatchableReplay = (item: Item) => (item.totalDurationMs ?? 0) >= MIN_REPLAY_MS

type LiveCount = { count: number; hasMore: boolean }

export function HomePage() {
  const { user } = useAuth()
  const [live, setLive] = useState<LiveCount | null>(null)

  return (
    <>
      {/* 첫 화면에서 "무엇을 하는 곳인지"와 "지금 볼 것이 있는지"를 함께 알린다. 휴대폰에서는 한 줄로 줄어든다 */}
      <section className="home-intro" aria-labelledby="home-title">
        <div className="home-intro-text">
          <p className={`home-kicker${live?.count ? ' is-live' : ''}`}>
            {live?.count ? (
              <>
                <span className="live-dot" aria-hidden="true" />
                지금 {live.count}
                {live.hasMore ? '개 이상' : '개'} 채널이 방송 중입니다
              </>
            ) : (
              '로그인 없이 바로 시청합니다'
            )}
          </p>
          <h1 id="home-title">누구나 바로 보고, 바로 방송합니다</h1>
          <p className="home-intro-desc">
            실시간 방송을 보며 채팅과 후원으로 방송자와 함께합니다. 방송은 설치 없이 PC 화면 공유나 휴대폰 카메라로
            시작합니다.
          </p>
        </div>
        <div className="home-actions">
          <Link to="/broadcasts/new" className="button primary">
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
              {live.hasMore ? '+' : ''}개 채널
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
            <EmptyState icon={Radio} title="지금 방송 중인 채널이 없습니다">
              <p>방송을 시작하면 이곳에 가장 먼저 보입니다.</p>
              <Link to="/broadcasts/new" className="button primary">
                <Radio size={16} aria-hidden="true" />첫 방송 시작하기
              </Link>
            </EmptyState>
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
          fetchPage={(cursor, signal) => listReplays({ cursor, limit: 8 }, signal)}
          empty={
            <EmptyState icon={Clapperboard} title="아직 다시 볼 수 있는 방송이 없습니다">
              <p>방송이 끝나면 녹화본이 이곳에 올라옵니다.</p>
            </EmptyState>
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
          fetchPage={(cursor, signal) => listBroadcasts({ status: 'READY', cursor, limit: 8 }, signal)}
          empty={<EmptyState icon={CalendarClock} title="예정된 방송이 없습니다" />}
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
