import { useEffect, useRef, useState } from 'react'
import { formatDuration, type Recording } from '../lib/recordings'

const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * 다시보기 플레이어 (#12 최소 버전). 재연결·송출 대체로 세그먼트가 여러 개면 시작 시각 순서로 이어서 재생한다.
 * 파일은 Caddy가 Range 요청으로 서빙하므로 <video>의 탐색이 그대로 동작한다.
 * 재생 중인 구간은 배열 위치가 아니라 녹화 id로 기억한다: SSE로 앞쪽 구간이 늦게 끼어들어도 보던 구간이 바뀌지 않는다.
 */
export function ReplayPlayer({ recordings }: { recordings: Recording[] }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // 처음 연 순간의 첫 구간으로 고정한다 (이후 목록이 바뀌어도 같은 구간)
  const [selectedId, setSelectedId] = useState(() => recordings[0]!.id)
  // "다시 시도"마다 늘려 <video>를 새로 만든다 (같은 src로는 브라우저가 다시 받지 않는다)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 앞 구간이 끝났거나 사용자가 고른 경우에만 자동 재생한다 (처음 열 때는 사용자가 누른다)
  const autoplayRef = useRef(false)
  const position = Math.max(
    0,
    recordings.findIndex((r) => r.id === selectedId),
  )
  const current = recordings[position]!
  const total = recordings.reduce((sum, r) => sum + r.durationMs, 0)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !autoplayRef.current) return
    autoplayRef.current = false
    video.play().catch(() => {
      // 자동재생이 막히면 사용자가 재생 버튼을 누르면 된다 (controls 표시 중)
    })
  }, [current.id, attempt])

  function select(recording: Recording) {
    setError(null)
    autoplayRef.current = true
    setSelectedId(recording.id)
  }

  return (
    <section className="replay" aria-label="다시보기">
      <div className="player">
        <video
          ref={videoRef}
          key={`${current.id}:${attempt}`}
          src={current.url}
          controls
          playsInline
          preload="metadata"
          data-testid="replay-video"
          data-segment={position + 1}
          onEnded={() => {
            const next = recordings[position + 1]
            if (next) select(next)
          }}
          onError={() => setError('영상을 불러오지 못했습니다. 네트워크를 확인하고 다시 시도하세요')}
        />
        {error && (
          <div className="player-error" role="alert">
            <p className="error">{error}</p>
            <button
              type="button"
              onClick={() => {
                setError(null)
                autoplayRef.current = true
                setAttempt((n) => n + 1)
              }}
            >
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
                onClick={() => select(r)}
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
