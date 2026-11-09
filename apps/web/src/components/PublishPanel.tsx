import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/api'
import { type Broadcast, endBroadcast, issuePublishToken, type StatusPayload } from '../lib/broadcasts'
import { captureCamera, type Capture } from '../lib/webrtc/media'
import { publish, type WebRtcSession } from '../lib/webrtc/whip'

/**
 * 소유자 송출 패널 (#6 최소 버전: 카메라 송출 + 종료).
 * 화면 공유·마이크 믹싱·재연결 UI는 #7, 모바일 카메라 전환은 #8에서 이 패널을 대체한다.
 */
export function PublishPanel({ broadcast, onEnded }: { broadcast: Broadcast; onEnded: (s: StatusPayload) => void }) {
  const previewRef = useRef<HTMLVideoElement>(null)
  const captureRef = useRef<Capture | null>(null)
  const sessionRef = useRef<WebRtcSession | null>(null)
  const [state, setState] = useState<'idle' | 'starting' | 'publishing' | 'ending'>('idle')
  const [error, setError] = useState<string | null>(null)

  const stopLocal = () => {
    void sessionRef.current?.close()
    sessionRef.current = null
    captureRef.current?.stop()
    captureRef.current = null
  }

  // 화면을 떠나면 송출도 멈춘다 (서버는 유예 시간 뒤 종료로 확정).
  // 탭을 닫을 때는 React 정리 함수가 돌지 않으므로 pagehide에서 WHIP 세션을 지운다(DELETE, keepalive).
  // 지우지 않으면 MediaMTX가 ICE 타임아웃(약 30초)이 지나서야 끊김을 알아챈다.
  useEffect(() => {
    window.addEventListener('pagehide', stopLocal)
    return () => {
      window.removeEventListener('pagehide', stopLocal)
      stopLocal()
    }
  }, [])

  async function start() {
    setError(null)
    setState('starting')
    try {
      const capture = await captureCamera('user')
      captureRef.current = capture
      if (previewRef.current) previewRef.current.srcObject = capture.stream
      const { token, whipPath } = await issuePublishToken(broadcast.id)
      sessionRef.current = await publish(whipPath, capture.stream, { token })
      setState('publishing')
    } catch (e) {
      stopLocal()
      setError(errorMessage(e))
      setState('idle')
    }
  }

  async function end() {
    if (!window.confirm('방송을 종료할까요? 종료한 방송은 다시 시작할 수 없습니다.')) return
    setState('ending')
    try {
      const status = await endBroadcast(broadcast.id)
      stopLocal()
      onEnded(status)
      setState('idle')
    } catch (e) {
      setError(errorMessage(e))
      setState('publishing')
    }
  }

  if (broadcast.status === 'ENDED') return null

  return (
    <section className="publish-panel">
      <h2>송출</h2>
      <video ref={previewRef} autoPlay playsInline muted className="preview" />
      <div className="row owner-actions">
        {state === 'idle' && (
          <button type="button" onClick={start}>
            카메라로 방송 시작
          </button>
        )}
        {state === 'starting' && <span className="muted">연결 중…</span>}
        {(state === 'publishing' || broadcast.status === 'LIVE') && (
          <button type="button" className="danger" onClick={end} disabled={state === 'ending'}>
            {state === 'ending' ? '종료 중…' : '방송 종료'}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
