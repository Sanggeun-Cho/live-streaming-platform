import { useEffect, useRef, useState } from 'react'
import { formatDuration, type Recording } from '../lib/recordings'

const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * 다시보기 플레이어 (#12 최소 버전). 재연결·송출 대체로 세그먼트가 여러 개면 시작 시각 순서로 이어서 재생한다.
 * 파일은 Caddy가 Range 요청으로 서빙하므로 <video>의 탐색이 그대로 동작한다.
 */
export function ReplayPlayer({ recordings }: { recordings: Recording[] }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 앞 세그먼트가 끝나서 넘어온 경우에만 다음 세그먼트를 자동으로 재생한다 (처음 열 때는 사용자가 누른다)
  const continueRef = useRef(false)
  const current = recordings[Math.min(index, recordings.length - 1)]!
  const position = recordings.indexOf(current)
  const total = recordings.reduce((sum, r) => sum + r.durationMs, 0)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !continueRef.current) return
    continueRef.current = false
    video.play().catch(() => {
      // 자동재생이 막히면 사용자가 재생 버튼을 누르면 된다 (controls 표시 중)
    })
  }, [current.url])

  function select(i: number, autoplay: boolean) {
    setError(null)
    continueRef.current = autoplay
    setIndex(i)
  }

  return (
    <section className="replay" aria-label="다시보기">
      <div className="player">
        <video
          ref={videoRef}
          key={current.url}
          src={current.url}
          controls
          playsInline
          preload="metadata"
          data-testid="replay-video"
          data-segment={position + 1}
          onEnded={() => {
            if (position + 1 < recordings.length) select(position + 1, true)
          }}
          onError={() => setError('영상을 불러오지 못했습니다. 네트워크를 확인하고 다시 시도하세요')}
        />
        {error && (
          <div className="player-error" role="alert">
            <p className="error">{error}</p>
            <button type="button" onClick={() => select(position, true)}>
              다시 시도
            </button>
          </div>
        )}
      </div>
      <p className="muted">
        다시보기 · 총 {formatDuration(total)}
        {recordings.length > 1 && ` · ${recordings.length}개 구간을 이어서 재생합니다`}
      </p>
      {recordings.length > 1 && (
        <ol className="segment-list" data-testid="segment-list">
          {recordings.map((r, i) => (
            <li key={r.id}>
              <button
                type="button"
                className={i === position ? 'link-button active' : 'link-button'}
                aria-current={i === position ? 'true' : undefined}
                onClick={() => select(i, true)}
              >
                {i + 1}구간 · {timeFormat.format(new Date(r.startedAt))} 시작 · {formatDuration(r.durationMs)}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
