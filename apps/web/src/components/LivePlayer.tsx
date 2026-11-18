import { Maximize, Minimize, Play, RotateCw, Users, Volume2, VolumeX } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/api'
import { view, type ViewSession } from '../lib/webrtc/whip'
import { useNow } from '../hooks/useNow'
import { formatDuration } from '../lib/recordings'
import { Spinner } from './Spinner'

// 시청 연결 실패·끊김 시 다시 시도하는 간격과 연속 실패 상한 (약 10초).
// 방송자 쪽 끊김·재송출은 SSE status 이벤트가 플레이어를 새로 연결하므로(reconnectKey) 여기서는 일시적인 실패만 다룬다
const RETRY_DELAY_MS = 2000
const MAX_RETRIES = 5

type Props = {
  broadcastId: number
  /** 지금 시청자 수 (SSE). 없으면 표시하지 않는다 */
  viewers?: number | null
  /** 방송 시작 시각. 있으면 경과 시간을 보여준다 */
  startedAt?: string | null
}

/**
 * WHEP 시청 플레이어.
 * - 자동재생 정책 때문에 음소거로 시작하고, 눈에 띄는 "소리 켜기" 버튼으로 사용자가 소리를 켠다.
 * - 첫 프레임이 나오기 전에는 스피너를 보여주고 조작 버튼을 숨긴다 (검은 화면에서 누를 게 없다).
 * - 연결에 실패하거나 도중에 끊기면 몇 번 자동으로 다시 연결한다.
 * 방송자가 다시 연결되면 부모가 key를 바꿔 플레이어를 새로 만든다.
 */
export function LivePlayer({ broadcastId, viewers, startedAt }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // 첫 프레임이 화면에 나왔는지. 연결을 다시 맺으면 다시 false
  const [showing, setShowing] = useState(false)
  // 브라우저가 자동재생을 막으면(저전력 모드 등) 사용자가 눌러서 재생한다
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(true)
  const fullscreen = useFullscreen(boxRef)
  // 바뀔 때마다 연결을 처음부터 다시 맺는다 (자동 재시도, "다시 연결" 버튼)
  const [retryKey, setRetryKey] = useState(0)
  // 연속 실패 횟수. 연결에 성공하면 0으로 돌린다
  const failures = useRef(0)

  useEffect(() => {
    let session: ViewSession | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const retry = (message: string) => {
      if (controller.signal.aborted) return
      if (failures.current >= MAX_RETRIES) {
        setError(message)
        return
      }
      failures.current += 1
      retryTimer = setTimeout(() => {
        setShowing(false)
        setRetryKey((n) => n + 1)
      }, RETRY_DELAY_MS)
    }

    view(`/live/${broadcastId}/whep`)
      .then((s) => {
        if (controller.signal.aborted) return void s.close()
        session = s
        failures.current = 0
        setError(null)
        const video = videoRef.current
        if (video) {
          video.srcObject = s.stream
          video.play().then(
            () => setBlocked(false),
            () => setBlocked(true),
          )
        }
        s.pc.addEventListener('connectionstatechange', () => {
          if (s.pc.connectionState === 'failed') retry('연결이 끊겼습니다')
        })
      })
      .catch((e: unknown) => retry(errorMessage(e)))

    return () => {
      controller.abort()
      clearTimeout(retryTimer)
      void session?.close()
    }
  }, [broadcastId, retryKey])

  const play = () =>
    void videoRef.current?.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    )

  const reconnect = () => {
    setError(null)
    setShowing(false)
    failures.current = 0
    setRetryKey((k) => k + 1)
  }

  return (
    <div className="player" ref={boxRef}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        data-testid="live-video"
        onLoadedData={() => setShowing(true)}
      />

      <div className="player-top">
        <span className="badge badge-live">
          <span className="live-dot" aria-hidden="true" />
          LIVE
        </span>
        {viewers != null && (
          <span className="player-chip">
            <Users size={13} aria-hidden="true" />
            <span className="sr-only">시청자</span>
            {viewers.toLocaleString()}
            <span className="sr-only">명</span>
          </span>
        )}
        {startedAt && <Elapsed since={startedAt} />}
      </div>

      {!showing && !error && (
        <div className="player-center">
          <Spinner size="lg" />
          <p className="player-status" role="status">
            {retryKey > 0 ? '연결이 끊겨 다시 연결하는 중…' : '방송에 연결하는 중…'}
          </p>
        </div>
      )}

      {showing && blocked && (
        <div className="player-center">
          <button type="button" className="player-play" onClick={play}>
            <Play size={20} fill="currentColor" aria-hidden="true" />
            눌러서 재생
          </button>
        </div>
      )}

      {showing && !error && (
        <div className={muted ? 'player-bar' : 'player-bar can-hide'}>
          {muted ? (
            <button type="button" className="player-unmute" onClick={() => setMuted(false)}>
              <VolumeX size={18} aria-hidden="true" />
              소리 켜기
            </button>
          ) : (
            <button
              type="button"
              className="player-icon-button"
              onClick={() => setMuted(true)}
              aria-label="소리 끄기"
              title="소리 끄기"
            >
              <Volume2 size={20} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="player-icon-button"
            onClick={() => void toggleFullscreen(boxRef.current, videoRef.current).catch(() => undefined)}
            aria-label={fullscreen ? '전체 화면 종료' : '전체 화면'}
            title={fullscreen ? '전체 화면 종료' : '전체 화면'}
          >
            {fullscreen ? <Minimize size={20} aria-hidden="true" /> : <Maximize size={20} aria-hidden="true" />}
          </button>
        </div>
      )}

      {error && (
        <div className="player-error" role="alert">
          <p>영상을 불러오지 못했습니다. {error}</p>
          <button type="button" onClick={reconnect}>
            <RotateCw size={16} aria-hidden="true" />
            다시 연결
          </button>
        </div>
      )}
    </div>
  )
}

/** 방송 경과 시간 (1초마다 갱신) */
function Elapsed({ since }: { since: string }) {
  const now = useNow(1000)
  return (
    <span className="player-chip">
      <span className="sr-only">방송 경과 시간</span>
      {formatDuration(now - new Date(since).getTime())}
    </span>
  )
}

/** 이 요소가 전체 화면인지 구독한다 (Esc로 나가도 버튼 문구가 맞게) */
function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const update = () => setActive(document.fullscreenElement !== null && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [ref])
  return active
}

/** 전체 화면. iOS Safari는 요소 전체 화면을 지원하지 않아 video 전용 API를 쓴다 */
async function toggleFullscreen(box: HTMLElement | null, video: HTMLVideoElement | null) {
  if (document.fullscreenElement) return document.exitFullscreen()
  if (box?.requestFullscreen) return box.requestFullscreen()
  ;(video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.()
}
