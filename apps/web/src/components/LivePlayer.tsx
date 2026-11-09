import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/api'
import { view, type ViewSession } from '../lib/webrtc/whip'

// 시청 연결 실패·끊김 시 다시 시도하는 간격과 연속 실패 상한 (약 10초).
// 방송자 쪽 끊김·재송출은 SSE status 이벤트가 플레이어를 새로 연결하므로(reconnectKey) 여기서는 일시적인 실패만 다룬다
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
      retryTimer = setTimeout(() => setRetryKey((n) => n + 1), RETRY_DELAY_MS)
    }

    view(`/live/${broadcastId}/whep`)
      .then((s) => {
        if (controller.signal.aborted) return void s.close()
        session = s
        failures.current = 0
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
  }, [broadcastId, reconnectKey, retryKey])

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
              failures.current = 0
              setRetryKey((k) => k + 1)
            }}
          >
            다시 연결
          </button>
        </div>
      )}
    </div>
  )
}
