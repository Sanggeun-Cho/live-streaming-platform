import { Clapperboard, Play, Radio, Users } from 'lucide-react'
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import { useNow } from '../hooks/useNow'
import { colorOf } from '../lib/avatar'
import type { Broadcast } from '../lib/broadcasts'
import { timeAgoOf } from '../lib/time'
import { Avatar } from './Avatar'

/**
 * 홈 맨 위: 시청자가 가장 많은 라이브 하나를 크게 보여준다. 라이브가 없으면 방송을 시작하거나
 * 다시보기로 가는 안내로 바뀐다. lives가 null이면 아직 불러오는 중이다.
 */
export function FeaturedLive({ lives }: { lives: Broadcast[] | null }) {
  if (lives === null) return <div className="featured-live is-loading" aria-hidden="true" />
  const top = [...lives].sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0))[0]
  return top ? <FeaturedCard b={top} others={lives.length - 1} /> : <IdleHero />
}

function FeaturedCard({ b, others }: { b: Broadcast; others: number }) {
  const now = useNow()
  const [imageFailed, setImageFailed] = useState(false)
  const viewers = b.viewers ?? 0
  return (
    <article className="featured-live" aria-labelledby="featured-title">
      <Link
        to={`/broadcasts/${b.id}`}
        className="featured-media"
        style={{ '--thumb-color': colorOf(b.streamer.id) } as CSSProperties}
        tabIndex={-1}
        aria-hidden="true"
      >
        {b.thumbnailUrl && !imageFailed ? (
          <img src={b.thumbnailUrl} alt="" decoding="async" onError={() => setImageFailed(true)} />
        ) : (
          // 첫 화면 캡처(시작 5초 뒤)가 올라오기 전: 제목은 옆에 있으므로 방송자 아바타만 크게 둔다
          <span className="featured-placeholder">
            <Avatar id={b.streamer.id} name={b.streamer.nickname} size={96} />
          </span>
        )}
        <span className="featured-play">
          <Play size={28} fill="currentColor" />
        </span>
      </Link>
      <div className="featured-body">
        <p className="featured-status">
          <span className="badge badge-live">
            <span className="live-dot" aria-hidden="true" />
            LIVE
          </span>
          <span>
            <Users size={14} aria-hidden="true" /> {viewers.toLocaleString()}명 시청 중
          </span>
        </p>
        <h2 id="featured-title" className="featured-title">
          <Link to={`/broadcasts/${b.id}`}>{b.title}</Link>
        </h2>
        <Link to={`/channels/${b.channel.id}`} className="featured-channel">
          <Avatar id={b.streamer.id} name={b.streamer.nickname} size={36} />
          <span>
            <strong>{b.streamer.nickname}</strong>
            <span className="dim">{b.startedAt && timeAgoOf(b.startedAt, '시작', now)}</span>
          </span>
        </Link>
        {b.description && <p className="featured-desc">{b.description}</p>}
        <div className="featured-actions">
          <Link to={`/broadcasts/${b.id}`} className="button primary">
            <Play size={16} aria-hidden="true" fill="currentColor" />
            지금 시청하기
          </Link>
          {others > 0 && (
            <Link to="/lives" className="button">
              다른 라이브 {others}개
            </Link>
          )}
        </div>
      </div>
    </article>
  )
}

function IdleHero() {
  return (
    <section className="idle-hero" aria-labelledby="idle-title">
      <div>
        <h2 id="idle-title">지금은 방송 중인 채널이 없습니다</h2>
        <p>
          첫 방송을 시작해 보세요. PC는 화면 공유, 휴대폰은 카메라로 설치 없이 바로 방송할 수 있습니다. 끝난 방송은
          다시보기에서 볼 수 있습니다.
        </p>
      </div>
      <div className="idle-actions">
        <Link to="/broadcasts/new" className="button primary">
          <Radio size={18} aria-hidden="true" />
          방송 시작하기
        </Link>
        <Link to="/replays" className="button">
          <Clapperboard size={18} aria-hidden="true" />
          다시보기 둘러보기
        </Link>
      </div>
    </section>
  )
}
