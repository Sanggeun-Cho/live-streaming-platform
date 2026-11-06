// #2 스파이크 화면. 인증·방송 모델 없이 WHIP 송출 / WHEP 시청 / 지연을 검증한다.
// 운영 화면(#7, #8)이 생기면 삭제한다.
// 쿼리: ?mode=publish|view&source=screen|camera|timecode&path=live/1&auto=1

import { useEffect, useRef, useState } from 'react'
import { captureCamera, captureScreen, type Capture } from '../lib/webrtc/media'
import { summarize, type RtcSummary } from '../lib/webrtc/stats'
import { publish, view, type WebRtcSession } from '../lib/webrtc/whip'
import { createTimecodeStream, readLatency } from './timecode'

type Mode = 'publish' | 'view'
type Source = 'screen' | 'camera' | 'timecode'

type SpikeState = {
  status: string
  error?: string
  summary?: RtcSummary
  latencies: number[]
  capture?: { hasDisplayAudio: boolean; hasMic: boolean }
  /** 서버가 광고한 ICE 후보 (NAT 뒤 공인 주소 설정 확인용) */
  serverCandidates?: string[]
}

declare global {
  interface Window {
    __spike?: SpikeState
  }
}

const params = new URLSearchParams(window.location.search)

export function Spike() {
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode) ?? 'publish')
  const [source, setSource] = useState<Source>((params.get('source') as Source) ?? 'screen')
  const [path, setPath] = useState(params.get('path') ?? 'live/1')
  const [state, setState] = useState<SpikeState>({ status: 'idle', latencies: [] })
  const videoRef = useRef<HTMLVideoElement>(null)
  const sessionRef = useRef<WebRtcSession | null>(null)
  const stopSourceRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    window.__spike = state
  }, [state])

  const stop = async () => {
    await sessionRef.current?.close()
    sessionRef.current = null
    stopSourceRef.current?.()
    stopSourceRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setState((s) => ({ ...s, status: 'stopped' }))
  }

  const start = async () => {
    setState({ status: 'starting', latencies: [] })
    try {
      if (mode === 'publish') {
        let stream: MediaStream
        let capture: Capture | null = null
        if (source === 'timecode') {
          const tc = createTimecodeStream()
          stream = tc.stream
          stopSourceRef.current = tc.stop
        } else {
          capture = source === 'screen' ? await captureScreen() : await captureCamera()
          stream = capture.stream
          stopSourceRef.current = capture.stop
          capture.onEnded(() => void stop())
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.muted = true
        }
        sessionRef.current = await publish(`/${path}/whip`, stream, { maxVideoBitrate: 2_500_000 })
        setState((s) => ({
          ...s,
          status: 'publishing',
          capture: capture ? { hasDisplayAudio: capture.hasDisplayAudio, hasMic: capture.hasMic } : undefined,
        }))
      } else {
        const session = await view(`/${path}/whep`)
        sessionRef.current = session
        if (videoRef.current) {
          videoRef.current.srcObject = session.stream
          // 자동재생 정책: 음소거 상태로 시작한다
          videoRef.current.muted = true
          await videoRef.current.play().catch(() => undefined)
        }
        setState((s) => ({ ...s, status: 'viewing' }))
      }
    } catch (e) {
      await stop()
      setState((s) => ({ ...s, status: 'error', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }))
    }
  }

  // 1초마다 통계, 시청 중이면 프레임마다 타임코드 지연 측정
  useEffect(() => {
    const timer = setInterval(async () => {
      const pc = sessionRef.current?.pc
      if (!pc) return
      const summary = await summarize(pc)
      const serverCandidates = (pc.remoteDescription?.sdp ?? '')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('a=candidate:'))
        .map((l) => l.split(' ').slice(2, 6).join(' '))
      setState((s) => ({ ...s, summary, serverCandidates }))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (state.status !== 'viewing') return
    const video = videoRef.current
    if (!video) return
    const scratch = document.createElement('canvas')
    let handle = 0
    let cancelled = false
    const onFrame = () => {
      if (cancelled) return
      const ms = readLatency(video, scratch)
      if (ms !== null && ms < 10_000) {
        setState((s) => ({ ...s, latencies: [...s.latencies.slice(-299), ms] }))
      }
      handle = video.requestVideoFrameCallback(onFrame)
    }
    handle = video.requestVideoFrameCallback(onFrame)
    return () => {
      cancelled = true
      video.cancelVideoFrameCallback(handle)
    }
  }, [state.status])

  useEffect(() => {
    if (params.get('auto') === '1') void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lat = state.latencies
  const median = lat.length ? [...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)] : undefined
  const running = state.status === 'publishing' || state.status === 'viewing' || state.status === 'starting'

  return (
    <main className="container">
      <h1>WebRTC 스파이크 (#2)</h1>
      <fieldset disabled={running}>
        <label>
          모드{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="publish">송출 (WHIP)</option>
            <option value="view">시청 (WHEP)</option>
          </select>
        </label>{' '}
        {mode === 'publish' && (
          <label>
            소스{' '}
            <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
              <option value="screen">화면 공유 + 소리 + 마이크</option>
              <option value="camera">카메라 + 마이크</option>
              <option value="timecode">타임코드 (지연 측정)</option>
            </select>
          </label>
        )}{' '}
        <label>
          path <input value={path} onChange={(e) => setPath(e.target.value)} size={10} />
        </label>
      </fieldset>
      <p>
        <button onClick={() => void start()} disabled={running}>
          시작
        </button>{' '}
        <button onClick={() => void stop()} disabled={!running}>
          중지
        </button>{' '}
        {mode === 'view' && (
          <button onClick={() => videoRef.current && (videoRef.current.muted = !videoRef.current.muted)}>
            소리 켜기/끄기
          </button>
        )}
      </p>
      <p>
        상태: <b id="status">{state.status}</b>
        {state.error && <span className="error"> {state.error}</span>}
      </p>
      <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', maxWidth: 640, background: '#000' }} />
      <pre id="summary">
        {JSON.stringify(
          {
            ...state.summary,
            capture: state.capture,
            serverCandidates: state.serverCandidates,
            latencyMedianMs: median,
            latencySamples: lat.length,
          },
          null,
          2,
        )}
      </pre>
    </main>
  )
}
