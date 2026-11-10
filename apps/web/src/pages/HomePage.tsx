import { Link } from 'react-router'
import { useAuth } from '../auth/context'
import { BroadcastList } from '../components/BroadcastList'
import { listBroadcasts } from '../lib/broadcasts'
import { listReplays } from '../lib/recordings'

export function HomePage() {
  const { user } = useAuth()
  return (
    <>
      {/* 첫 방문자가 "볼 수 있는 것"과 "방송하는 방법"을 바로 알 수 있게 한다 */}
      <section className="hero">
        <div>
          <h1>지금 라이브를 보거나, 바로 방송하세요</h1>
          <p className="dim">
            로그인 없이 시청할 수 있어요. 방송은 PC에서는 화면 공유(+탭·시스템 소리, 마이크), 휴대폰에서는 카메라로
            시작합니다.
          </p>
        </div>
        <div className="hero-actions">
          <Link to="/broadcasts/new" className="button primary">
            ● 방송 시작하기
          </Link>
          {user && (
            <Link to={`/channels/${user.channelId}`} className="button">
              내 채널
            </Link>
          )}
        </div>
      </section>
      <section>
        <h2 className="section-title">
          <span className="live-dot" aria-hidden="true" /> 지금 방송 중
        </h2>
        <BroadcastList
          listKey="live"
          fetchPage={(cursor, signal) => listBroadcasts({ status: 'LIVE', cursor }, signal)}
          empty="지금 방송 중인 채널이 없습니다. 첫 방송을 시작해 보세요!"
        />
      </section>
      <section aria-labelledby="replays-heading">
        <h2 id="replays-heading" className="section-title">
          다시보기
        </h2>
        <BroadcastList
          listKey="replays"
          fetchPage={(cursor, signal) => listReplays({ cursor, limit: 8 }, signal)}
          empty="아직 다시 볼 수 있는 방송이 없습니다."
        />
      </section>
      <section>
        {/* 위 두 섹션과 겹치지 않게 시작 전 방송만 보여준다 */}
        <h2 className="section-title">방송 예정</h2>
        <BroadcastList
          listKey="ready"
          fetchPage={(cursor, signal) => listBroadcasts({ status: 'READY', cursor, limit: 8 }, signal)}
          empty="예정된 방송이 없습니다."
        />
      </section>
    </>
  )
}
