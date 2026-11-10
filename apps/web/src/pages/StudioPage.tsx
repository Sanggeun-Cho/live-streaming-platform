import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { useBroadcast } from '../hooks/useBroadcast'
import { useBroadcastEvents } from '../hooks/useBroadcastEvents'
import { isCameraSupported, isScreenShareSupported } from '../lib/webrtc/media'
import { ApiError } from '../lib/api'
import { MAX_RECONNECT, type Phase, Publisher, SOURCE_ENDED_TIMEOUT_MS } from '../lib/webrtc/publisher'
import { type RtcSummary, summarize } from '../lib/webrtc/stats'

const PHASE_LABEL: Record<Phase, string> = {
  idle: '송출 준비',
  requesting: '권한 요청 중',
  preview: '미리보기',
  connecting: '연결 중',
  live: 'LIVE',
  reconnecting: '재연결 중',
  sourceEnded: '영상 소스 중지됨',
  takenOver: '다른 곳에서 송출 중',
  ended: '방송 종료',
}

/** 화면이 살아 있는 동안 송출 컨트롤러 하나를 유지하고, 상태를 React 상태로 내보낸다 */
function usePublisher(broadcastId: number) {
  const [publisher] = useState(() => new Publisher(broadcastId))
  const state = useSyncExternalStore(
    (cb) => publisher.subscribe(cb),
    () => publisher.snapshot,
  )
  // attach/해제를 effect 안에서 짝지어 StrictMode의 재마운트와 bfcache 복귀에도 같은 인스턴스를 다시 쓸 수 있다
  useEffect(() => publisher.attach(), [publisher])
  useEffect(() => {
    // 탭을 닫을 때도 WHIP 세션을 바로 지운다 (안 지우면 서버가 ICE 타임아웃 약 30초 뒤에야 끊김을 안다)
    const onPageHide = () => publisher.release()
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [publisher])
  return { publisher, state }
}

export function StudioPage() {
  const id = Number(useParams().id)
  const { user } = useAuth()
  const { broadcast, error } = useBroadcast(id)

  if (error) {
    return (
      <section>
        <p className="error">{error.status === 404 ? '방송을 찾을 수 없습니다.' : error.message}</p>
        <Link to="/">목록으로</Link>
      </section>
    )
  }
  if (!broadcast) return <p className="muted">불러오는 중…</p>
  if (user?.channelId !== broadcast.channel.id) {
    return (
      <section>
        <p className="error">본인 방송만 송출할 수 있습니다.</p>
        <Link to={`/broadcasts/${id}`}>방송 보러 가기</Link>
      </section>
    )
  }
  if (broadcast.status === 'ENDED') {
    return (
      <section>
        <p>이미 종료된 방송입니다. 다시 방송하려면 새 방송을 만드세요.</p>
        <Link to="/broadcasts/new" className="button">
          새 방송 만들기
        </Link>
      </section>
    )
  }
  if (!window.isSecureContext) {
    return <p className="error">카메라·마이크·화면 공유는 HTTPS 주소에서만 쓸 수 있습니다. https:// 로 접속하세요.</p>
  }
  // 방송이 바뀌면 송출 컨트롤러도 새로 만든다
  return <Studio key={id} broadcastId={id} title={broadcast.title} />
}

function Studio({ broadcastId, title }: { broadcastId: number; title: string }) {
  const { publisher, state } = usePublisher(broadcastId)
  const previewRef = useRef<HTMLVideoElement>(null)
  const [viewers, setViewers] = useState(0)
  const [stats, setStats] = useState<RtcSummary | null>(null)
  const [ending, setEnding] = useState(false)
  const { phase, stream } = state
  const onAir = phase === 'live' || phase === 'reconnecting' || phase === 'sourceEnded' || phase === 'connecting'
  const redirectIfUnauthorized = useAuthErrorRedirect()

  useEffect(() => {
    if (state.errorCode === 'UNAUTHORIZED') redirectIfUnauthorized(new ApiError(401, 'UNAUTHORIZED', ''))
  }, [state.errorCode, redirectIfUnauthorized])

  useBroadcastEvents(broadcastId, {
    // 다른 탭에서 종료했거나 유예 시간이 지나 서버가 종료했다
    status: (s) => s.status === 'ENDED' && publisher.handleServerEnded(),
    viewers: (v) => setViewers(v.count),
  })

  // 미리보기는 캡처 스트림이 바뀔 때마다 다시 붙인다 (소스 전환, 카메라 전환)
  useEffect(() => {
    if (previewRef.current && previewRef.current.srcObject !== stream) previewRef.current.srcObject = stream
  }, [stream])

  // 송출 품질 표시 (2초마다)
  useEffect(() => {
    if (phase !== 'live') return
    const timer = setInterval(() => {
      const pc = publisher.peerConnection
      if (pc) void summarize(pc).then(setStats)
    }, 2000)
    return () => clearInterval(timer)
  }, [phase, publisher])

  // 방송 중 새로고침·닫기 경고
  useEffect(() => {
    if (!onAir) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [onAir])

  async function onEnd() {
    if (!window.confirm('방송을 종료할까요? 종료한 방송은 다시 시작할 수 없습니다.')) return
    setEnding(true)
    await publisher.end().catch(() => undefined)
    setEnding(false)
  }

  const screenOk = isScreenShareSupported()
  const cameraOk = isCameraSupported()

  if (phase === 'ended') {
    return (
      <section className="studio">
        <h1>방송이 종료되었습니다</h1>
        <p className="muted">카메라·마이크·화면 공유를 모두 껐습니다.</p>
        <div className="row owner-actions">
          <Link to={`/broadcasts/${broadcastId}`} className="button">
            방송 화면으로
          </Link>
          <Link to="/broadcasts/new" className="button">
            새 방송 만들기
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className="studio">
      <div className="row">
        <h1>{title}</h1>
        <span className={`studio-phase phase-${phase}`} data-testid="studio-phase">
          {PHASE_LABEL[phase]}
          {phase === 'reconnecting' && ` (${state.reconnectAttempt}/${MAX_RECONNECT})`}
          {phase === 'live' && ` · 시청자 ${viewers}명`}
        </span>
      </div>

      <div className="studio-preview">
        <video ref={previewRef} autoPlay playsInline muted className="preview" data-testid="studio-preview" />
        {!stream && <p className="muted studio-empty">송출할 화면이나 카메라를 선택하세요</p>}
      </div>

      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}

      {phase === 'sourceEnded' && (
        <div className="notice" role="alert">
          <p>
            {state.source === 'camera' ? '카메라가 꺼져' : '화면 공유가 중지되어'} 송출을 멈췄습니다(마이크 포함).{' '}
            {SOURCE_ENDED_TIMEOUT_MS / 1000}초 안에 다시 선택하면 방송이 이어지고, 그렇지 않으면 방송이 자동으로 종료됩니다.
          </p>
          <div className="row owner-actions">
            <button type="button" onClick={() => void publisher.selectSource('screen')}>
              화면 다시 선택
            </button>
            <button type="button" onClick={() => void publisher.selectSource('camera')}>
              카메라로 전환
            </button>
          </div>
        </div>
      )}

      {phase === 'takenOver' && (
        <div className="notice" role="alert">
          <p>다른 탭이나 기기에서 이 방송을 송출하고 있어 이 화면의 송출을 멈췄습니다.</p>
          <button type="button" onClick={() => void publisher.takeBack()}>
            여기서 다시 송출
          </button>
        </div>
      )}

      <div className="studio-controls">
        <div className="row owner-actions">
          {screenOk && (
            <button type="button" onClick={() => void publisher.selectSource('screen')} disabled={phase === 'requesting'}>
              🖥 화면 공유{state.source === 'screen' ? ' 다시 선택' : ''}
            </button>
          )}
          {cameraOk && (
            <button type="button" onClick={() => void publisher.selectSource('camera')} disabled={phase === 'requesting'}>
              📷 카메라{state.source === 'camera' ? ' 다시 켜기' : ''}
            </button>
          )}
          {state.source === 'camera' && (
            <button type="button" onClick={() => void publisher.switchCamera()}>
              🔄 전면/후면 전환
            </button>
          )}
        </div>
        {!screenOk && cameraOk && (
          <p className="muted">이 브라우저는 화면 공유를 지원하지 않아 카메라로 송출합니다. (PC의 Chrome·Edge에서 화면 공유 가능)</p>
        )}
        {!screenOk && !cameraOk && (
          <p className="error">
            이 브라우저는 송출을 지원하지 않습니다. PC는 Chrome·Edge, 휴대폰은 Safari(iOS)·Chrome(Android)을 사용하세요.
          </p>
        )}

        {state.source === 'screen' && (
          <ul className="audio-status">
            <li>
              화면 소리:{' '}
              {state.hasDisplayAudio ? (
                <strong>포함됨</strong>
              ) : (
                <span className="warn">
                  없음 — 탭 소리는 "탭"(Chrome 탭·Edge 탭) 선택 후 "탭 오디오도 공유", Windows 전체 화면은 "시스템 오디오도 공유"를 켜고 다시
                  선택하세요
                </span>
              )}
              {state.hasDisplayAudio && (
                <label className="slider">
                  음량
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={state.displayVolume}
                    onChange={(e) => publisher.setDisplayVolume(Number(e.target.value))}
                  />
                </label>
              )}
            </li>
            <li>
              마이크: {state.hasMic ? <strong>{state.micMuted ? '꺼짐' : '켜짐'}</strong> : <span className="warn">없음(권한 거부 또는 장치 없음)</span>}
              {state.hasMic && (
                <label className="slider">
                  음량
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={state.micVolume}
                    onChange={(e) => publisher.setMicVolume(Number(e.target.value))}
                  />
                </label>
              )}
            </li>
          </ul>
        )}
        {state.source && state.hasMic && (
          <button type="button" onClick={() => publisher.setMicMuted(!state.micMuted)} aria-pressed={state.micMuted}>
            {state.micMuted ? '🎙 마이크 켜기' : '🔇 마이크 끄기'}
          </button>
        )}

        <div className="row owner-actions">
          {phase === 'preview' && (
            <button type="button" className="primary" onClick={() => void publisher.start()}>
              방송 시작
            </button>
          )}
          {(onAir || phase === 'takenOver') && (
            <button type="button" className="danger" onClick={onEnd} disabled={ending}>
              {ending ? '종료 중…' : '방송 종료'}
            </button>
          )}
          <Link to={`/broadcasts/${broadcastId}`} target="_blank" rel="noreferrer">
            시청 화면 새 탭으로 열기
          </Link>
        </div>

        {phase === 'live' && stats && (
          <p className="muted stats" data-testid="studio-stats">
            {stats.width}x{stats.height} · {stats.fps ?? '-'}fps · {stats.videoKbps !== undefined ? `${stats.videoKbps}kbps` : '비트레이트 측정 중'} · {stats.videoCodec ?? ''}
          </p>
        )}
        {state.source === 'camera' && onAir && (
          <p className="muted">송출 중에는 화면을 켜 두세요. 다른 앱으로 전환하면 송출이 멈출 수 있습니다.</p>
        )}
      </div>
    </section>
  )
}
