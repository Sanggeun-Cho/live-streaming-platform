import { Clock, Film, Layers, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatDuration, nextSegment, type Recording, segmentPosition } from '../lib/recordings'

const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * 다시보기 플레이어. 라이브 플레이어와 같은 틀·배지를 쓰고, 탐색은 브라우저 기본 컨트롤에 맡긴다. 재연결·송출 대체로 세그먼트가 여러 개면 시작 시각 순서로 이어서 재생한다.
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
  const position = segmentPosition(recordings, selectedId)
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
            const next = nextSegment(recordings, current.id)
            if (next) select(next)
          }}
          onError={() => setError('영상을 불러오지 못했습니다. 네트워크를 확인하고 다시 시도하세요.')}
        />
        <div className="player-top">
          <span className="badge">
            <Film size={12} aria-hidden="true" />
            다시보기
          </span>
          {recordings.length > 1 && (
            <span className="player-chip">
              {position + 1}/{recordings.length} 구간
            </span>
          )}
        </div>
        {error && (
          <div className="player-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => {
                setError(null)
                autoplayRef.current = true
                setAttempt((n) => n + 1)
              }}
            >
              <RotateCw size={16} aria-hidden="true" />
              다시 시도
            </button>
          </div>
        )}
      </div>
      <p className="replay-meta">
        <span>
          <Clock size={14} aria-hidden="true" />총 {formatDuration(total)}
        </span>
        {recordings.length > 1 && (
          <span>
            <Layers size={14} aria-hidden="true" />
            {recordings.length}개 구간을 이어서 재생합니다
          </span>
        )}
      </p>
      {recordings.length > 1 && (
        <ol className="segment-list" data-testid="segment-list" aria-label="구간 선택">
          {recordings.map((r, i) => (
            <li key={r.id}>
              <button type="button" aria-current={i === position ? 'true' : undefined} onClick={() => select(r)}>
                {i + 1}구간
                <small>
                  {timeFormat.format(new Date(r.startedAt))} 시작 · {formatDuration(r.durationMs)}
                </small>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
