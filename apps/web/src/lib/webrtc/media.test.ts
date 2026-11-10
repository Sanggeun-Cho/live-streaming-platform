// 카메라 캡처: 처음부터 끝난 영상 트랙 거르기, 끊긴 카메라 다시 열기
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureCamera, captureScreen } from './media'

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended'
  contentHint = ''
  enabled = true
  readonly kind: 'audio' | 'video'
  constructor(kind: 'audio' | 'video', readyState: 'live' | 'ended' = 'live') {
    super()
    this.kind = kind
    this.readyState = readyState
  }
  stop() {
    this.readyState = 'ended'
  }
  getSettings() {
    return { facingMode: 'user' }
  }
}

class FakeStream {
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }
  getTracks() {
    return [...this.tracks]
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t)
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t)
  }
}

const getUserMedia = vi.fn()
const streamOf = (video: 'live' | 'ended', audio = true) =>
  new FakeStream([new FakeTrack('video', video), ...(audio ? [new FakeTrack('audio')] : [])])

beforeEach(() => {
  vi.useFakeTimers()
  getUserMedia.mockReset()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('captureScreen', () => {
  it('화면 공유 캡처에는 카메라 복구 수단(restartVideo·switchFacing)이 없다 → 공유 중지는 항상 sourceEnded로 간다', async () => {
    const mixed = new FakeTrack('audio')
    class FakeAudioContext {
      state = 'running'
      async resume() {}
      async close() {}
      createMediaStreamDestination() {
        return { stream: new FakeStream([mixed]) }
      }
      createGain() {
        const node = { gain: { value: 1 }, connect: () => node }
        return node
      }
      createMediaStreamSource() {
        return { connect: (n: unknown) => n }
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('MediaStream', FakeStream)
    const display = streamOf('live')
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([new FakeTrack('audio')])), getDisplayMedia: vi.fn(async () => display) },
    })
    const capture = await captureScreen({ mic: true })
    expect(capture.restartVideo).toBeUndefined()
    expect(capture.switchFacing).toBeUndefined()
    const ended = vi.fn()
    capture.onEnded(ended)
    display.getVideoTracks()[0]!.dispatchEvent(new Event('ended'))
    expect(ended).toHaveBeenCalledTimes(1)
  })
})

describe('captureCamera', () => {
  it('처음부터 끝난 영상 트랙을 받으면 그 스트림을 끄고 다시 연다', async () => {
    const dead = streamOf('ended')
    const ok = streamOf('live')
    getUserMedia.mockResolvedValueOnce(dead).mockResolvedValueOnce(ok)
    const capturing = captureCamera('user')
    await vi.advanceTimersByTimeAsync(1000)
    const capture = await capturing
    expect(capture.stream).toBe(ok)
    expect(dead.getTracks().every((t) => t.readyState === 'ended')).toBe(true)
  })

  it('계속 끝난 트랙만 받으면 NotReadableError로 실패한다', async () => {
    getUserMedia.mockImplementation(async () => streamOf('ended'))
    const capturing = captureCamera('user').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5000)
    const err = await capturing
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('NotReadableError')
    expect(getUserMedia).toHaveBeenCalledTimes(3)
  })

  it('영상 트랙이 끝나면 onEnded를 부르고, restartVideo는 같은 방향 카메라로 트랙을 바꾼다', async () => {
    const first = streamOf('live')
    getUserMedia.mockResolvedValueOnce(first)
    const capture = await captureCamera('environment')
    const ended = vi.fn()
    capture.onEnded(ended)
    const oldTrack = first.getVideoTracks()[0]!
    oldTrack.dispatchEvent(new Event('ended'))
    expect(ended).toHaveBeenCalledTimes(1)

    const fresh = streamOf('live', false)
    getUserMedia.mockResolvedValueOnce(fresh)
    const track = await capture.restartVideo!()
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: expect.objectContaining({ facingMode: 'environment' }) })
    expect(track).toBe(fresh.getVideoTracks()[0])
    expect(capture.stream.getVideoTracks()).toEqual([track])
    expect(capture.stream.getAudioTracks()).toHaveLength(1)
    // 새 트랙이 끝나도 다시 알린다
    ;(track as unknown as FakeTrack).dispatchEvent(new Event('ended'))
    expect(ended).toHaveBeenCalledTimes(2)
  })

  it('restartVideo가 끝난 트랙을 받으면 실패하고 기존 스트림은 그대로 둔다', async () => {
    getUserMedia.mockResolvedValueOnce(streamOf('live'))
    const capture = await captureCamera('user')
    const before = capture.stream.getVideoTracks()[0]
    getUserMedia.mockResolvedValueOnce(streamOf('ended', false))
    await expect(capture.restartVideo!()).rejects.toMatchObject({ name: 'NotReadableError' })
    expect(capture.stream.getVideoTracks()[0]).toBe(before)
  })
})
