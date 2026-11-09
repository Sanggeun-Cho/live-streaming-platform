// 송출 소스 캡처.
// PC: 화면 공유 영상 + (탭/시스템 소리 + 마이크)를 WebAudio로 섞은 오디오 트랙 1개
// 모바일: 카메라 + 마이크
// 오디오 트랙은 항상 1개를 보낸다. 소리 소스가 없어도 무음 트랙을 보내서
// 시청자·녹화 파일의 트랙 구성이 방송마다 달라지지 않게 한다.

export type Capture = {
  stream: MediaStream
  /** 화면 공유에 소리가 포함됐는지 (사용자가 '오디오 공유'를 끄면 false) */
  hasDisplayAudio: boolean
  hasMic: boolean
  setDisplayVolume: (v: number) => void
  setMicVolume: (v: number) => void
  /** 영상 트랙이 끝났을 때 (화면 공유를 브라우저 UI로 중지, 모바일에서 카메라를 빼앗김 등) */
  onEnded: (cb: () => void) => void
  /**
   * 카메라만: 전면/후면을 바꾼 새 영상 트랙을 돌려준다(stream 안의 트랙도 교체).
   * 휴대폰은 카메라 두 개를 동시에 열지 못하는 경우가 많아 이전 트랙을 먼저 끈 뒤 새로 연다.
   */
  switchFacing?: (facing: FacingMode) => Promise<MediaStreamTrack>
  stop: () => void
}

export function isScreenShareSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

export function isCameraSupported(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export class AudioBlockedError extends Error {
  constructor() {
    super('브라우저가 오디오 처리를 막았습니다. 버튼을 다시 눌러 주세요')
    this.name = 'AudioBlockedError'
  }
}

type Mixer = {
  track: MediaStreamTrack
  /** AudioContext가 실제로 돌아가는지 확인한다. 막혀 있으면 AudioBlockedError */
  ready: () => Promise<void>
  addSource: (stream: MediaStream) => GainNode
  close: () => void
}

// 반드시 클릭 핸들러 안에서, 첫 await보다 먼저 호출한다.
// AudioContext가 suspended 상태면 믹서 트랙이 RTP를 한 번도 보내지 않고, MediaMTX는 트랙 수집 시간
// (webrtcTrackGatherTimeout 2s) 안에 패킷이 없는 오디오 트랙을 버린다 → 방송 전체가 무음, 녹화도 영상만 남는다.
// (#2 스파이크에서 재현: "recording 1 track (H264)")
function createMixer(): Mixer {
  const ctx = new AudioContext()
  if (ctx.state !== 'running') void ctx.resume()
  const dest = ctx.createMediaStreamDestination()
  return {
    track: dest.stream.getAudioTracks()[0]!,
    ready: async () => {
      if (ctx.state !== 'running') await ctx.resume()
      if (ctx.state !== 'running') throw new AudioBlockedError()
    },
    addSource: (stream) => {
      const gain = ctx.createGain()
      ctx.createMediaStreamSource(stream).connect(gain).connect(dest)
      return gain
    },
    close: () => void ctx.close(),
  }
}

export async function captureScreen({ mic = true }: { mic?: boolean } = {}): Promise<Capture> {
  // 사용자 제스처가 살아 있을 때 만든다 (createMixer 주석 참고)
  const mixer = createMixer()
  let display: MediaStream
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      // 탭/시스템 소리는 원음 그대로 받는다 (에코 제거·잡음 억제를 끄지 않으면 음악이 뭉개진다)
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chrome 전용 힌트. 다른 브라우저는 무시한다
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions)
  } catch (e) {
    mixer.close()
    throw e
  }

  let micStream: MediaStream | null = null
  if (mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      // 마이크 권한을 거부해도 화면 송출은 계속한다
    }
  }

  try {
    await mixer.ready()
  } catch (e) {
    display.getTracks().forEach((t) => t.stop())
    micStream?.getTracks().forEach((t) => t.stop())
    mixer.close()
    throw e
  }
  const hasDisplayAudio = display.getAudioTracks().length > 0
  const displayGain = hasDisplayAudio ? mixer.addSource(new MediaStream(display.getAudioTracks())) : null
  const micGain = micStream ? mixer.addSource(micStream) : null

  const videoTrack = display.getVideoTracks()[0]!
  // 화면 공유는 글자 선명도가 중요하다. 대역폭이 부족하면 프레임을 먼저 줄인다
  videoTrack.contentHint = 'detail'

  const stop = () => {
    display.getTracks().forEach((t) => t.stop())
    micStream?.getTracks().forEach((t) => t.stop())
    mixer.track.stop()
    mixer.close()
  }

  return {
    stream: new MediaStream([videoTrack, mixer.track]),
    hasDisplayAudio,
    hasMic: micStream !== null,
    setDisplayVolume: (v) => displayGain && (displayGain.gain.value = v),
    setMicVolume: (v) => micGain && (micGain.gain.value = v),
    onEnded: (cb) => videoTrack.addEventListener('ended', cb, { once: true }),
    stop,
  }
}

export type FacingMode = 'user' | 'environment'

export async function captureCamera(facingMode: FacingMode = 'user'): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: cameraConstraints(facingMode),
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let videoTrack = stream.getVideoTracks()[0]!
  videoTrack.contentHint = 'motion'
  let endedCallback: (() => void) | null = null
  // 의도적으로 끈 트랙(카메라 전환)의 ended는 무시한다
  const watch = (track: MediaStreamTrack) =>
    track.addEventListener('ended', () => track === videoTrack && endedCallback?.(), { once: true })
  watch(videoTrack)

  return {
    stream,
    hasDisplayAudio: false,
    hasMic: stream.getAudioTracks().length > 0,
    setDisplayVolume: () => undefined,
    // 카메라 마이크는 WebAudio를 거치지 않으므로 켜고 끄기만 한다
    setMicVolume: (v) => stream.getAudioTracks().forEach((t) => (t.enabled = v > 0)),
    onEnded: (cb) => {
      endedCallback = cb
    },
    switchFacing: async (facing) => {
      const old = videoTrack
      stream.removeTrack(old)
      old.stop()
      let next: MediaStreamTrack
      try {
        next = (await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(facing) })).getVideoTracks()[0]!
      } catch (e) {
        // 새 카메라를 못 열면 원래 카메라로 되돌린다
        const restored = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: old.getSettings().facingMode ?? 'user' } })).getVideoTracks()[0]!
        restored.contentHint = 'motion'
        videoTrack = restored
        stream.addTrack(restored)
        watch(restored)
        throw e
      }
      next.contentHint = 'motion'
      videoTrack = next
      stream.addTrack(next)
      watch(next)
      return next
    },
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  }
}

function cameraConstraints(facingMode: FacingMode): MediaTrackConstraints {
  return { facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
}
