import { BroadcastList } from '../components/BroadcastList'
import { listBroadcasts } from '../lib/broadcasts'
import { listReplays } from '../lib/recordings'

export function HomePage() {
  return (
    <>
      <section>
        <h2 className="section-title">
          <span className="live-dot" aria-hidden="true" /> 지금 방송 중
        </h2>
        <BroadcastList
          listKey="live"
          fetchPage={(cursor, signal) => listBroadcasts({ status: 'LIVE', cursor }, signal)}
          empty="지금 방송 중인 채널이 없습니다."
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
        <h2 className="section-title">전체 방송</h2>
        <BroadcastList
          listKey="all"
          fetchPage={(cursor, signal) => listBroadcasts({ cursor }, signal)}
          empty="아직 등록된 방송이 없습니다."
        />
      </section>
    </>
  )
}
