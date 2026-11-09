import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { BroadcastList } from '../components/BroadcastList'

export function ChannelPage() {
  const channelId = Number(useParams().channelId)
  const { user } = useAuth()
  const isMine = user?.channelId === channelId

  if (!Number.isInteger(channelId) || channelId <= 0) return <p className="error">잘못된 채널 주소입니다.</p>

  return (
    <section>
      <div className="row">
        <h1>{isMine ? '내 채널' : '채널'}</h1>
        {isMine && (
          <Link to="/broadcasts/new" className="button">
            새 방송 만들기
          </Link>
        )}
      </div>
      <BroadcastList
        params={{ channelId }}
        empty={isMine ? '아직 만든 방송이 없습니다. "새 방송 만들기"로 시작하세요.' : '이 채널에는 방송이 없습니다.'}
      />
    </section>
  )
}
