import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/api'
import { view, type ViewSession } from '../lib/webrtc/whip'

// 연결 실패·끊김 시 다시 시도하는 간격과 횟수. 방송자 재연결(유예 45초)보다 짧게 끝나지 않도록 넉넉히 둔다
const RETRY_DELAY_MS = 2000
const MAX_RETRIES = 5

/**
 * WHEP 시청 플레이어 (#6 최소 버전, #8에서 다듬는다).
 * - 자동재생 정책 때문에 음소거로 시작하고, 사용자가 소리를 켠다.
 * - 연결에 실패하거나 도중에 끊기면 몇 번 자동으로 다시 연결한다.
 */
export function LivePlayer({ broadcastId, reconnectKey }: { broadcastId: number; reconnectKey: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(true)
  const [attempt, setAttempt] = useState(0)
  // "다시 연결" 버튼을 누를 때마다 바뀌어 연결을 처음부터 다시 시도한다
  const [manualKey, setManualKey] = useState(0)

  useEffect(() => {
    let session: ViewSession | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const retry = (message: string) => {
      if (controller.signal.aborted) return
      if (attempt >= MAX_RETRIES) {
        setError(message)
        return
      }
      retryTimer = setTimeout(() => setAttempt((n) => n + 1), RETRY_DELAY_MS)
    }

    view(`/live/${broadcastId}/whep`)
      .then((s) => {
        if (controller.signal.aborted) return void s.close()
        session = s
        setError(null)
        if (videoRef.current) videoRef.current.srcObject = s.stream
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
  }, [broadcastId, reconnectKey, attempt, manualKey])

  return (
    <div className="player">
      <video ref={videoRef} autoPlay playsInline muted={muted} data-testid="live-video" />
      {muted && (
        <button type="button" className="unmute" onClick={() => setMuted(false)}>
          🔇 눌러서 소리 켜기
        </button>
      )}
      {error && (
        <div className="player-error" role="alert">
          <p className="error">영상을 불러오지 못했습니다: {error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null)
              setAttempt(0)
              setManualKey((k) => k + 1)
            }}
          >
            다시 연결
          </button>
        </div>
      )}
    </div>
  )
}
