import { Clapperboard, Radio } from 'lucide-react'
import { Link } from 'react-router'
import { BroadcastList } from '../components/BroadcastList'
import { EmptyState } from '../components/EmptyState'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { listBroadcasts } from '../lib/broadcasts'
import { listReplays } from '../lib/recordings'

/** 지금 방송 중인 모든 채널 */
export function LivePage() {
  useDocumentTitle('라이브')
  return (
    <section aria-labelledby="browse-title" className="browse">
      <header className="browse-head">
        <h1 id="browse-title">라이브</h1>
        <p>지금 방송 중인 채널입니다. 로그인 없이 바로 볼 수 있습니다.</p>
      </header>
      <BroadcastList
        listKey="live-all"
        skeletons={8}
        fetchPage={(cursor, signal) => listBroadcasts({ status: 'LIVE', cursor, limit: 24 }, signal)}
        empty={
          <EmptyState
            icon={Radio}
            title="지금은 방송 중인 채널이 없습니다"
            description="직접 방송을 시작해 보세요. PC는 화면 공유, 휴대폰은 카메라로 바로 방송할 수 있습니다."
            action={
              <Link to="/broadcasts/new" className="button primary">
                방송 시작하기
              </Link>
            }
          />
        }
      />
    </section>
  )
}

/** 끝난 방송의 녹화본 */
export function ReplaysPage() {
  useDocumentTitle('다시보기')
  return (
    <section aria-labelledby="browse-title" className="browse">
      <header className="browse-head">
        <h1 id="browse-title">다시보기</h1>
        <p>끝난 방송은 녹화되어 이곳에 올라옵니다. 최근에 끝난 방송부터 보여 드립니다.</p>
      </header>
      <BroadcastList
        listKey="replays-all"
        skeletons={8}
        fetchPage={(cursor, signal) => listReplays({ cursor, limit: 24 }, signal)}
        empty={
          <EmptyState
            icon={Clapperboard}
            title="아직 다시 볼 수 있는 방송이 없습니다"
            description="방송이 끝나면 녹화본이 이곳에 올라옵니다."
            action={
              <Link to="/lives" className="button">
                지금 라이브 보기
              </Link>
            }
          />
        }
      />
    </section>
  )
}
