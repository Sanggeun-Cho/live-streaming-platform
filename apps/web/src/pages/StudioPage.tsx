import { Camera, CircleAlert, ExternalLink, Link2, Lock, Mic, MicOff, Monitor, SearchX, ShieldAlert, SwitchCamera } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useBlocker, useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { useAuthErrorRedirect } from '../auth/useAuthErrorRedirect'
import { ChatPanel } from '../components/ChatPanel'
import { DonationAlert } from '../components/Donations'
import { useFeedback } from '../feedback/context'
import { useBroadcast } from '../hooks/useBroadcast'
import { useBroadcastEvents } from '../hooks/useBroadcastEvents'
import { useComments } from '../hooks/useComments'
import { useDonations } from '../hooks/useDonations'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { EmptyState } from '../components/EmptyState'
import { Spinner } from '../components/Spinner'
import { ApiError } from '../lib/api'
import type { Broadcast } from '../lib/broadcasts'
import type { Comment } from '../lib/comments'
import { type Donation, formatWon } from '../lib/donations'
import { formatDuration } from '../lib/recordings'
import { formatDurationText } from '../lib/time'
import { captureFrame, uploadThumbnail } from '../lib/thumbnails'
import { isCameraSupported, isScreenShareSupported } from '../lib/webrtc/media'
import { MAX_RECONNECT, type Phase, Publisher, type PublisherState, SOURCE_ENDED_TIMEOUT_MS } from '../lib/webrtc/publisher'
import { type RtcSummary, summarize } from '../lib/webrtc/stats'
import './studio.css'

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

const ON_AIR: Phase[] = ['connecting', 'live', 'reconnecting', 'sourceEnded']
/** 서버의 방송 상태와 비교한 이 화면의 송출: 여기서 송출 중(또는 준비) / 끊겨서 이어 보낼 수 있음 / 다른 기기가 송출 중 */
type AirState = 'here' | 'resumable' | 'elsewhere'
const AIR_LABEL: Record<Exclude<AirState, 'here'>, string> = { resumable: '송출 끊김', elsewhere: 'LIVE · 다른 기기' }
const START_LABEL: Record<AirState, string> = { here: '방송 시작', resumable: '이어서 송출', elsewhere: '이 기기로 가져오기' }

// 송출 시작 뒤 화질이 자리 잡을 때까지 기다리는 시간
const QUALITY_WARMUP_MS = 15_000

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

// 홈·채널 카드의 썸네일: 송출이 안정된 뒤 한 장, 이후 주기적으로 갱신한다
const THUMBNAIL_FIRST_MS = 5_000
const THUMBNAIL_EVERY_MS = 60_000

/** 방송 중 미리보기 화면을 캡처해 썸네일로 올린다. 실패해도 방송에는 영향이 없으므로 조용히 넘긴다 */
function useLiveThumbnail(broadcastId: number, live: boolean, videoRef: RefObject<HTMLVideoElement | null>) {
  useEffect(() => {
    if (!live) return
    const upload = async () => {
      const video = videoRef.current
      const blob = video ? await captureFrame(video) : null
      if (blob) await uploadThumbnail(broadcastId, blob).catch(() => undefined)
    }
    const first = setTimeout(() => void upload(), THUMBNAIL_FIRST_MS)
    const timer = setInterval(() => void upload(), THUMBNAIL_EVERY_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [broadcastId, live, videoRef])
}

export function StudioPage() {
  const id = Number(useParams().id)
  const { user } = useAuth()
  const { broadcast, error, patch } = useBroadcast(id)
  useDocumentTitle(broadcast && `스튜디오 · ${broadcast.title}`)

  if (error) {
    return (
      <StudioMessage
        icon={error.status === 404 ? SearchX : CircleAlert}
        title={error.status === 404 ? '방송을 찾을 수 없습니다' : '방송을 불러오지 못했습니다'}
        text={error.message}
      >
        <Link to="/" className="button primary">
          홈으로
        </Link>
      </StudioMessage>
    )
  }
  if (!broadcast) return <Spinner label="방송 정보를 불러오는 중…" size="lg" />
  if (user?.channelId !== broadcast.channel.id) {
    return (
      <StudioMessage icon={Lock} title="본인 방송만 송출할 수 있습니다" text="이 방송의 방송자로 로그인했는지 확인하세요.">
        <Link to={`/broadcasts/${id}`} className="button primary">
          방송 보러 가기
        </Link>
      </StudioMessage>
    )
  }
  if (broadcast.status === 'ENDED') {
    return (
      <StudioMessage icon={CircleAlert} title="이미 종료된 방송입니다" text="종료한 방송은 다시 시작할 수 없습니다. 새 방송을 만들어 주세요.">
        <Link to="/broadcasts/new" className="button primary">
          새 방송 만들기
        </Link>
      </StudioMessage>
    )
  }
  if (!window.isSecureContext) {
    return (
      <StudioMessage
        icon={ShieldAlert}
        title="HTTPS 주소에서만 방송할 수 있습니다"
        text="카메라·마이크·화면 공유는 보안 연결에서만 쓸 수 있습니다. https:// 로 접속하세요."
      />
    )
  }
  // 방송이 바뀌면 송출 컨트롤러도 새로 만든다
  return <Studio key={id} broadcast={broadcast} patch={patch} />
}

function StudioMessage({ icon, title, text, children }: { icon: LucideIcon; title: string; text: string; children?: ReactNode }) {
  return <EmptyState icon={icon} as="h1" title={title} description={text} action={children} />
}

function Studio({ broadcast, patch }: { broadcast: Broadcast; patch: (changes: Partial<Broadcast>) => void }) {
  const broadcastId = broadcast.id
  const { publisher, state } = usePublisher(broadcastId)
  const { confirm, toast } = useFeedback()
  const redirectIfUnauthorized = useAuthErrorRedirect()
  const [viewers, setViewers] = useState(0)
  const [peakViewers, setPeakViewers] = useState(0)
  const [stats, setStats] = useState<RtcSummary | null>(null)
  const [ending, setEnding] = useState(false)
  const [latestDonation, setLatestDonation] = useState<Donation | null>(null)
  const donations = useDonations(broadcastId)
  const { phase } = state
  const onAir = ON_AIR.includes(phase)
  const previewRef = useRef<HTMLVideoElement>(null)
  useLiveThumbnail(broadcastId, phase === 'live', previewRef)

  const { connected } = useBroadcastEvents(broadcastId, {
    status: (s) => {
      // 종료(이 화면·다른 탭·유예 만료)는 송출 컨트롤러가 종료 요약 화면으로 바꾼다.
      // 방송 상태까지 ENDED로 바꾸면 "이미 종료된 방송" 안내가 요약을 덮는다
      if (s.status === 'ENDED') publisher.handleServerEnded()
      else patch(s)
    },
    viewers: ({ count }) => {
      setViewers(count)
      setPeakViewers((peak) => Math.max(peak, count))
    },
    comment: (data) => chat.apply(data.comment),
    donation: (data) => {
      donations.push(data)
      setLatestDonation(data.donation)
      // 휴대폰 방송자는 화면을 보지 않을 때도 많다: 진동으로도 알린다
      navigator.vibrate?.(200)
    },
  })
  const chat = useComments(broadcastId, connected)

  useEffect(() => {
    if (state.errorCode === 'UNAUTHORIZED') redirectIfUnauthorized(new ApiError(401, 'UNAUTHORIZED', ''))
  }, [state.errorCode, redirectIfUnauthorized])

  // 송출 품질 표시 (2초마다). WebRTC는 낮은 화질로 시작해 몇 초에 걸쳐 올리므로
  // 연결 직후는 "맞추는 중"으로 두고, 낮은 화질이 연속으로 관측될 때만 경고한다
  const [qualitySettled, setQualitySettled] = useState(false)
  useEffect(() => {
    if (phase !== 'live') return
    const settle = setTimeout(() => setQualitySettled(true), QUALITY_WARMUP_MS)
    const timer = setInterval(() => {
      const pc = publisher.peerConnection
      if (pc) void summarize(pc).then(setStats)
    }, 2000)
    return () => {
      clearTimeout(settle)
      clearInterval(timer)
      // 재연결 등으로 LIVE를 벗어나면 다음 LIVE에서 다시 맞추는 구간부터 시작한다
      setQualitySettled(false)
    }
  }, [phase, publisher])

  // 송출이 (다시) 시작된 순간을 알린다
  const prevPhase = useRef(phase)
  useEffect(() => {
    const prev = prevPhase.current
    prevPhase.current = phase
    if (phase !== 'live' || prev === 'live' || prev === 'requesting') return
    if (prev === 'connecting') toast('방송이 시작되었습니다')
    else toast('송출이 다시 연결되었습니다', 'info')
  }, [phase, toast])

  // 방송 중 새로고침·탭 닫기 경고 (브라우저 기본 창)
  useEffect(() => {
    if (!onAir) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [onAir])

  // 방송 중 앱 안의 링크로 이동하면 송출이 끊긴다: 먼저 묻는다
  const blocker = useBlocker(onAir)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    void confirm({
      title: '방송 중입니다',
      message: `이 화면을 떠나면 송출이 끊깁니다. ${SOURCE_ENDED_TIMEOUT_MS / 1000}초 안에 돌아와 이어서 송출하지 않으면 방송이 자동으로 종료됩니다.`,
      confirmLabel: '떠나기',
      cancelLabel: '계속 방송하기',
      danger: true,
    }).then((ok) => (ok ? blocker.proceed() : blocker.reset()))
  }, [blocker, confirm])

  async function onStart() {
    if (elsewhere) {
      const ok = await confirm({
        title: '이 기기로 송출을 가져올까요?',
        message: '지금 송출 중인 다른 기기의 송출이 끊기고 이 화면으로 바뀝니다. 시청자 연결은 이어집니다.',
        confirmLabel: '가져오기',
      })
      if (!ok) return
    }
    void publisher.start()
  }

  async function copyWatchLink() {
    const url = `${window.location.origin}/broadcasts/${broadcastId}`
    try {
      await navigator.clipboard.writeText(url)
      toast('시청 링크를 복사했습니다')
    } catch {
      toast(`복사하지 못했습니다. 주소: ${url}`, 'error')
    }
  }

  async function onEnd() {
    const ok = await confirm({
      title: '방송을 종료할까요?',
      message: '종료한 방송은 다시 시작할 수 없습니다. 녹화는 다시보기로 남습니다.',
      confirmLabel: '종료하기',
      danger: true,
    })
    if (!ok) return
    setEnding(true)
    await publisher.end().catch(() => undefined)
    setEnding(false)
  }

  if (phase === 'ended') {
    return (
      <EndedSummary
        broadcast={broadcast}
        peakViewers={peakViewers}
        donationTotal={donations.total}
        chatCount={chat.items.filter((c) => c.content !== null && !c.donation).length}
      />
    )
  }

  // 서버가 송출 끊김을 기록했고 이 화면도 송출하지 않는다: 스튜디오를 떠났다가 돌아온 경우다.
  // (다른 탭이 송출 중이면 끊긴 것이 아니므로 여기서 시작하면 그 탭에서 가져온다)
  const idleHere = broadcast.status === 'LIVE' && !onAir && phase !== 'takenOver'
  const resumable = idleHere && broadcast.disconnectedAt !== null
  // 서버에는 송출이 붙어 있는데 이 화면은 보내지 않는다: 다른 기기·탭이 송출 중이다
  const elsewhere = idleHere && broadcast.disconnectedAt === null
  const air: AirState = resumable ? 'resumable' : elsewhere ? 'elsewhere' : 'here'

  return (
    <div className={`studio-layout${onAir ? ' on-air' : ''}`}>
      <section className="studio-main" aria-label="방송 스튜디오">
        <div className="studio-head">
          <div className="studio-title">
            <h1>{broadcast.title}</h1>
            <div className="studio-links">
              <button type="button" className="link-button studio-watch-link" onClick={() => void copyWatchLink()}>
                <Link2 size={14} aria-hidden="true" /> 시청 링크 복사
              </button>
              <Link to={`/broadcasts/${broadcastId}`} target="_blank" rel="noreferrer" className="studio-watch-link">
                시청 화면 보기 <ExternalLink size={14} aria-hidden="true" />
              </Link>
            </div>
          </div>
          <OnAirStatus phase={phase} state={state} broadcast={broadcast} viewers={viewers} air={air} />
        </div>

        <Stage publisher={publisher} state={state} videoRef={previewRef}>
          {onAir && <ReactionOverlay chat={chat.items} donation={latestDonation} />}
          {onAir && (
            <div className="stage-status" aria-hidden="true">
              <OnAirStatus phase={phase} state={state} broadcast={broadcast} viewers={viewers} air={air} compact />
            </div>
          )}
        </Stage>

        {elsewhere && (
          <div className="notice" role="status">
            <p>
              <strong>다른 기기에서 송출 중입니다.</strong> 이 화면에서는 채팅과 후원을 확인할 수 있습니다. 이 기기로
              송출하려면 화면이나 카메라를 고른 뒤 "이 기기로 가져오기"를 눌러 주세요.
            </p>
          </div>
        )}
        {resumable && (
          <div className="notice" role="alert">
            <p>
              <strong>송출이 끊긴 상태입니다.</strong> 시청자는 다시 연결되기를 기다리고 있습니다. 화면이나 카메라를 선택해
              이어서 송출하거나 방송을 종료하세요.
            </p>
          </div>
        )}
        {state.error && phase !== 'sourceEnded' && state.stream && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {phase === 'sourceEnded' && (
          <div className="notice" role="alert">
            <p>
              {state.source === 'camera' ? '카메라가 꺼져' : '화면 공유가 중지되어'} 송출을 멈췄습니다(마이크 포함).{' '}
              {state.error && `${state.error} `}
              <SourceEndedCountdown /> 안에 다시 선택하면 방송이 이어지고, 그렇지 않으면 방송이 자동으로 종료됩니다.
            </p>
            <div className="row">
              {isScreenShareSupported() && (
                <button type="button" onClick={() => void publisher.selectSource('screen')}>
                  화면 다시 선택
                </button>
              )}
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

        <Toolbar
          publisher={publisher}
          state={state}
          air={air}
          canEnd={onAir || phase === 'takenOver' || resumable}
          onStart={() => void onStart()}
          ending={ending}
          onEnd={() => void onEnd()}
        />

        {state.source === 'screen' && <AudioMixer publisher={publisher} state={state} />}

        {phase === 'live' && stats?.height && <QualityLine stats={stats} settled={qualitySettled} />}
        {state.source === 'camera' && onAir && (
          <p className="muted studio-hint">송출 중에는 화면을 켜 두세요. 다른 앱으로 전환하면 송출이 멈출 수 있습니다.</p>
        )}
      </section>

      <aside className="studio-side" aria-label="시청자 반응">
        <div className="studio-donations">
          <span className="dim">받은 후원</span>
          <strong data-testid="studio-donation-total">{formatWon(donations.total.amount)}</strong>
          <span className="dim">{donations.total.count}건</span>
        </div>
        {latestDonation && <DonationAlert key={latestDonation.id} donation={latestDonation} />}
        <ChatPanel broadcastId={broadcastId} chat={chat} ownerView />
      </aside>
    </div>
  )
}

function OnAirStatus({
  phase,
  state,
  broadcast,
  viewers,
  air,
  compact = false,
}: {
  phase: Phase
  state: PublisherState
  broadcast: Broadcast
  viewers: number
  air: AirState
  /** 미리보기 위 칩(휴대폰 가로): 같은 정보를 한 번 더 그리므로 테스트용 id를 붙이지 않는다 */
  compact?: boolean
}) {
  const live = phase === 'live'
  // 경과 시간은 초 단위로 갱신한다
  const now = useNow(1000)
  const elapsed = live && broadcast.startedAt ? formatDuration(now - Date.parse(broadcast.startedAt)) : null
  return (
    <div className="studio-status">
      <span
        className={`studio-phase phase-${air === 'here' ? phase : air === 'resumable' ? 'reconnecting' : 'live'}`}
        data-testid={compact ? undefined : 'studio-phase'}
      >
        {(live || air === 'elsewhere') && <span className="live-dot" aria-hidden="true" />}
        {air === 'here' || phase === 'requesting' ? PHASE_LABEL[phase] : AIR_LABEL[air]}
        {phase === 'reconnecting' && ` (${state.reconnectAttempt}/${MAX_RECONNECT})`}
      </span>
      {elapsed && (
        <span className="studio-stat">
          <span className="sr-only">방송 시간</span>
          {elapsed}
        </span>
      )}
      {live && <span className="studio-stat">시청자 {viewers}명</span>}
    </div>
  )
}

/** 미리보기. 캡처가 없으면 무엇을 해야 하는지 단계로 안내한다 */
function Stage({
  publisher,
  state,
  videoRef,
  children,
}: {
  publisher: Publisher
  state: PublisherState
  videoRef: RefObject<HTMLVideoElement | null>
  children?: ReactNode
}) {
  // 세로 카메라(휴대폰)도 작게 보이지 않도록 미리보기 틀을 영상 비율에 맞춘다
  const [ratio, setRatio] = useState(16 / 9)
  const { stream, phase } = state

  useEffect(() => {
    const video = videoRef.current
    if (video && video.srcObject !== stream) video.srcObject = stream
  }, [stream, videoRef])

  const onResize = () => {
    const v = videoRef.current
    if (v?.videoWidth && v.videoHeight) setRatio(v.videoWidth / v.videoHeight)
  }
  // 전면 카메라는 거울처럼 보여야 구도를 잡기 쉽다 (송출 영상은 그대로)
  const mirrored = state.source === 'camera' && state.facing === 'user'

  return (
    <div className="studio-stage" style={{ '--ratio': ratio } as CSSProperties}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`preview${mirrored ? ' mirrored' : ''}`}
        data-testid="studio-preview"
        onLoadedMetadata={onResize}
        onResize={onResize}
      />
      {stream && phase === 'preview' && <span className="stage-badge">미리보기 · 아직 시청자에게 보이지 않습니다</span>}
      {stream && state.hasMic && state.micMuted && (
        <span className="stage-badge stage-mic-off" role="status">
          <MicOff size={14} aria-hidden="true" /> 마이크 꺼짐
        </span>
      )}
      {!stream && phase !== 'sourceEnded' && (
        <EmptyStage publisher={publisher} requesting={phase === 'requesting'} error={state.error} />
      )}
      {!stream && phase === 'sourceEnded' && <p className="stage-paused">영상이 멈췄습니다</p>}
      {children}
    </div>
  )
}

/** 휴대폰 방송자는 채팅 패널이 화면 밖에 있다: 미리보기 위에 최근 채팅과 새 후원을 겹쳐 보여 준다 */
function ReactionOverlay({ chat, donation }: { chat: Comment[]; donation: Donation | null }) {
  const recent = chat.filter((c) => c.content !== null && !c.donation).slice(-3)
  return (
    <div className="stage-overlay" aria-hidden="true">
      {donation && <DonationAlert key={donation.id} donation={donation} />}
      <ul className="overlay-chat">
        {recent.map((c) => (
          <li key={c.id}>
            <strong>{c.author?.nickname}</strong> {c.content}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 영상 소스가 멈춘 뒤 자동 종료까지 남은 시간 (이 화면에서 멈춘 것을 안 순간부터 센다) */
function SourceEndedCountdown() {
  const [deadline] = useState(() => Date.now() + SOURCE_ENDED_TIMEOUT_MS)
  const now = useNow(1000)
  return <strong className="countdown">{formatDuration(Math.max(0, deadline - now))}</strong>
}

function EmptyStage({ publisher, requesting, error }: { publisher: Publisher; requesting: boolean; error: string | null }) {
  const screenOk = isScreenShareSupported()
  const cameraOk = isCameraSupported()
  if (!screenOk && !cameraOk) {
    return (
      <div className="stage-empty">
        <p className="error">
          이 브라우저는 송출을 지원하지 않습니다. PC는 Chrome·Edge, 휴대폰은 Safari(iOS)·Chrome(Android)을 사용하세요.
        </p>
      </div>
    )
  }
  return (
    <div className="stage-empty">
      <ol className="stage-steps">
        <li className="current">{screenOk ? '화면 또는 카메라 선택' : '카메라 켜기'}</li>
        <li>소리 확인</li>
        <li>방송 시작</li>
      </ol>
      <div className="stage-sources">
        {screenOk && (
          <button type="button" className="source-button" onClick={() => void publisher.selectSource('screen')} disabled={requesting}>
            <Monitor size={28} aria-hidden="true" />
            <span>화면 공유</span>
            <small>게임·탭·창 + 시스템 소리</small>
          </button>
        )}
        {cameraOk && (
          <button type="button" className="source-button" onClick={() => void publisher.selectSource('camera')} disabled={requesting}>
            <Camera size={28} aria-hidden="true" />
            <span>카메라</span>
            <small>카메라 + 마이크</small>
          </button>
        )}
      </div>
      {error && (
        <p className="stage-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" /> {error}
        </p>
      )}
      {!screenOk && <p className="dim stage-note">이 브라우저는 화면 공유를 지원하지 않아 카메라로 송출합니다.</p>}
    </div>
  )
}

function Toolbar({
  publisher,
  state,
  air,
  canEnd,
  ending,
  onEnd,
  onStart,
}: {
  publisher: Publisher
  state: PublisherState
  air: AirState
  canEnd: boolean
  ending: boolean
  onEnd: () => void
  onStart: () => void
}) {
  const { phase, source } = state
  const busy = phase === 'requesting'
  return (
    <div className="studio-toolbar">
      <div className="toolbar-group">
        {source && isScreenShareSupported() && (
          <ToolButton
            icon={<Monitor size={18} aria-hidden="true" />}
            label={source === 'screen' ? '화면 공유 다시 선택' : '화면 공유'}
            short={source === 'screen' ? '화면 변경' : '화면 공유'}
            onClick={() => void publisher.selectSource('screen')}
            disabled={busy}
          />
        )}
        {source && isCameraSupported() && source !== 'camera' && (
          <ToolButton
            icon={<Camera size={18} aria-hidden="true" />}
            label="카메라로 전환"
            short="카메라"
            onClick={() => void publisher.selectSource('camera')}
            disabled={busy}
          />
        )}
        {/* 전면/후면은 휴대폰에만 의미가 있다 (화면 공유를 못 하는 브라우저 = 휴대폰) */}
        {source === 'camera' && !isScreenShareSupported() && (
          <ToolButton
            icon={<SwitchCamera size={18} aria-hidden="true" />}
            label="전면/후면 전환"
            short="전면/후면"
            onClick={() => void publisher.switchCamera()}
            disabled={phase === 'sourceEnded'}
          />
        )}
        {source && state.hasMic && (
          <ToolButton
            icon={state.micMuted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            label={state.micMuted ? '마이크 켜기' : '마이크 끄기'}
            short={state.micMuted ? '마이크 켜기' : '마이크 끄기'}
            off={state.micMuted}
            pressed={state.micMuted}
            onClick={() => publisher.setMicMuted(!state.micMuted)}
            disabled={phase === 'sourceEnded'}
          />
        )}
      </div>
      <div className="toolbar-group toolbar-main">
        {phase === 'preview' && (
          <button type="button" className="primary go-live" onClick={onStart}>
            {START_LABEL[air]}
          </button>
        )}
        {canEnd && (
          <button type="button" className="danger solid" onClick={onEnd} disabled={ending}>
            {ending ? '종료 중…' : '방송 종료'}
          </button>
        )}
      </div>
    </div>
  )
}

/** 넓은 화면은 전체 이름, 휴대폰은 짧은 이름을 보여 준다 (접근성 이름은 항상 전체 이름) */
function ToolButton({
  icon,
  label,
  short,
  off = false,
  pressed,
  onClick,
  disabled,
}: {
  icon: ReactNode
  label: string
  short: string
  off?: boolean
  pressed?: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`tool${off ? ' tool-off' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
    >
      {icon}
      <span className="label-full">{label}</span>
      <span className="label-short" aria-hidden="true">
        {short}
      </span>
    </button>
  )
}

const percent = (v: number) => `${Math.round(v * 100)}%`

/** 화면 공유: 화면 소리와 마이크를 따로 조절한다 */
function AudioMixer({ publisher, state }: { publisher: Publisher; state: PublisherState }) {
  return (
    <ul className="audio-status">
      <li>
        <span className="audio-label">화면 소리</span>
        {state.hasDisplayAudio ? (
          <label className="slider">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.displayVolume}
              aria-label="화면 소리 음량"
              onChange={(e) => publisher.setDisplayVolume(Number(e.target.value))}
            />
            <span className="slider-value">{percent(state.displayVolume)}</span>
          </label>
        ) : (
          <span className="warn">
            없음 — 탭 소리는 "탭" 선택 후 "탭 오디오도 공유", Windows 전체 화면은 "시스템 오디오도 공유"를 켜고 다시
            선택하세요
          </span>
        )}
      </li>
      <li>
        <span className="audio-label">마이크</span>
        {state.hasMic ? (
          <label className="slider">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.micVolume}
              aria-label="마이크 음량"
              disabled={state.micMuted}
              onChange={(e) => publisher.setMicVolume(Number(e.target.value))}
            />
            <span className="slider-value">{state.micMuted ? '꺼짐' : percent(state.micVolume)}</span>
          </label>
        ) : (
          <span className="warn">없음 — 주소창 왼쪽 아이콘에서 마이크를 허용한 뒤 화면을 다시 선택하세요</span>
        )}
      </li>
    </ul>
  )
}

/** 방송자에게는 수치보다 "괜찮은지"가 중요하다. 세부 수치는 툴팁으로 둔다 */
function QualityLine({ stats, settled }: { stats: RtcSummary; settled: boolean }) {
  // 브라우저가 대역폭·CPU 때문에 화질을 낮췄으면 "안정"이라고 하지 않는다
  // 해상도만 낮은 것은 장치(카메라) 특성일 수 있어 경고하지 않는다
  const low = stats.qualityLimitation === 'bandwidth' || stats.qualityLimitation === 'cpu'
  // 낮은 화질이 연속 3번(약 6초) 관측될 때만 경고한다 (잠깐 내려갔다 회복되는 것은 정상)
  const [lowStreak, setLowStreak] = useState(0)
  const [prevStats, setPrevStats] = useState(stats)
  if (prevStats !== stats) {
    setPrevStats(stats)
    setLowStreak(low ? lowStreak + 1 : 0)
  }
  const limited = settled && lowStreak >= 3
  const detail = [
    stats.width && stats.height && `${stats.width}x${stats.height}`,
    stats.fps !== undefined && `${stats.fps}fps`,
    stats.videoKbps !== undefined && `${stats.videoKbps}kbps`,
    stats.videoCodec,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <p className={`muted stats${limited ? ' stats-limited' : ''}`} data-testid="studio-stats" title={detail}>
      <span className="quality-dot" aria-hidden="true" />
      {!settled ? (
        '송출 시작 · 화질을 맞추는 중'
      ) : limited ? (
        <>
          화질 낮아짐 · {stats.height}p
          <span className="stats-hint">
            {stats.qualityLimitation === 'cpu' ? '기기 부하가 높습니다.' : '네트워크가 약합니다. Wi-Fi를 권장합니다.'}
          </span>
        </>
      ) : (
        `송출 안정 · ${stats.height}p`
      )}
    </p>
  )
}

function EndedSummary({
  broadcast,
  peakViewers,
  donationTotal,
  chatCount,
}: {
  broadcast: Broadcast
  peakViewers: number
  donationTotal: { amount: number; count: number }
  chatCount: number
}) {
  // 종료 시각은 이벤트로 바로 오지 않을 수 있어 지금을 기준으로 잰다
  const [endedAt] = useState(() => Date.now())
  const duration = broadcast.startedAt ? formatDurationText(endedAt - Date.parse(broadcast.startedAt)) : '-'
  return (
    <section className="center-card studio-ended">
      <h1>방송이 종료되었습니다</h1>
      <p className="dim">카메라·마이크·화면 공유를 모두 껐습니다. 녹화는 잠시 뒤 다시보기로 볼 수 있습니다.</p>
      <dl className="ended-stats">
        <div>
          <dt>방송 시간</dt>
          <dd>{duration}</dd>
        </div>
        <div>
          <dt>최고 시청자</dt>
          <dd>{peakViewers}명</dd>
        </div>
        <div>
          <dt>받은 후원</dt>
          <dd>
            {formatWon(donationTotal.amount)} <small className="dim">({donationTotal.count}건)</small>
          </dd>
        </div>
        <div>
          <dt>채팅</dt>
          <dd>{chatCount}개</dd>
        </div>
      </dl>
      <div className="row ended-actions">
        <Link to={`/broadcasts/${broadcast.id}`} className="button primary">
          다시보기 화면으로
        </Link>
        <Link to="/broadcasts/new" className="button">
          새 방송 만들기
        </Link>
      </div>
    </section>
  )
}
