// 지연 측정용 타임코드 영상.
// 송출 측: 현재 시각(ms)의 하위 24비트 + 8비트 체크섬을 8x4 흑백 칸으로 그린다.
// 시청 측: 받은 프레임에서 칸을 읽어 '지금 - 프레임 시각'으로 화면→화면 지연을 잰다.
// 두 기기의 시계가 다르면 그 차이만큼 오차가 생긴다 (같은 PC의 두 탭이면 정확).

const W = 640
const H = 360
const CELL = 32
const COLS = 8
const ROWS = 4
const ORIGIN = 16

function checksum(v: number): number {
  return ((v & 0xff) + ((v >> 8) & 0xff) + ((v >> 16) & 0xff)) & 0xff
}

export function createTimecodeStream(): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')!

  // 소리 경로 확인용 낮은 볼륨의 사인파
  const ctx = new AudioContext()
  void ctx.resume()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  gain.gain.value = 0.05
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain).connect(dest)
  osc.start()

  const draw = () => {
    const now = Date.now()
    const v = now & 0xffffff
    const bits = v | (checksum(v) << 24)
    g.fillStyle = `hsl(${(now / 20) % 360} 40% 30%)`
    g.fillRect(0, 0, W, H)
    for (let i = 0; i < COLS * ROWS; i++) {
      g.fillStyle = (bits >>> i) & 1 ? '#fff' : '#000'
      g.fillRect(ORIGIN + (i % COLS) * CELL, ORIGIN + Math.floor(i / COLS) * CELL, CELL, CELL)
    }
    g.fillStyle = '#fff'
    g.font = '28px monospace'
    g.fillText(new Date(now).toISOString().slice(11, 23), ORIGIN, H - 24)
  }
  // rAF는 탭이 뒤로 가면 멈추므로 타이머로 그린다 (송출 탭을 숨겨도 프레임 유지)
  const timer = setInterval(draw, 1000 / 30)

  const video = canvas.captureStream(30).getVideoTracks()[0]!
  const stream = new MediaStream([video, dest.stream.getAudioTracks()[0]!])
  return {
    stream,
    stop: () => {
      clearInterval(timer)
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
  }
}

/** video 요소의 현재 프레임에서 타임코드를 읽어 지연(ms)을 돌려준다. 읽기 실패 시 null */
export function readLatency(video: HTMLVideoElement, scratch: HTMLCanvasElement): number | null {
  if (video.videoWidth === 0) return null
  scratch.width = W
  scratch.height = H
  const g = scratch.getContext('2d', { willReadFrequently: true })!
  g.drawImage(video, 0, 0, W, H)
  let bits = 0
  for (let i = 0; i < COLS * ROWS; i++) {
    const x = ORIGIN + (i % COLS) * CELL + CELL / 2
    const y = ORIGIN + Math.floor(i / COLS) * CELL + CELL / 2
    const [r, gg, b] = g.getImageData(x, y, 1, 1).data
    if ((r! + gg! + b!) / 3 > 128) bits |= 1 << i
  }
  const v = bits & 0xffffff
  if (((bits >>> 24) & 0xff) !== checksum(v)) return null
  const now = Date.now() & 0xffffff
  return (now - v + 0x1000000) % 0x1000000
}
