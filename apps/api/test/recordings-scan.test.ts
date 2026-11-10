import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mp4DurationMs } from '../src/recordings/mp4.js'
import { makeApp, openEvents, signupAs, type TestApp, type TestUser } from './helpers.js'

// ---- ISO BMFF 박스를 직접 만들어 길이 계산을 검증한다 ----
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const u64 = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}
const full = (version: number, flags: number) => u32((version << 24) | flags)

/** mvhd(v0): timescale, duration */
const mvhd = (timescale: number, duration: number) => box('mvhd', full(0, 0), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80))
/** trak: tkhd(v0, track_ID) + mdia/mdhd(v1, timescale) */
const trak = (id: number, timescale: number) =>
  box(
    'trak',
    box('tkhd', full(0, 3), u32(0), u32(0), u32(id), Buffer.alloc(64)),
    box('mdia', box('mdhd', full(1, 0), u64(0), u64(0), u32(timescale), u64(0), u32(0))),
  )
const trex = (id: number, defaultDuration: number) => box('trex', full(0, 0), u32(id), u32(1), u32(defaultDuration), u32(0), u32(0))
/** moof/traf: tfdt(v1) + trun (durations가 있으면 샘플별 길이, 없으면 개수만) */
const moof = (id: number, base: number, durations: number[] | { count: number }) => {
  const perSample = Array.isArray(durations)
  const trun = perSample
    ? box('trun', full(0, 0x100 | 0x200), u32(durations.length), ...durations.flatMap((d) => [u32(d), u32(100)]))
    : box('trun', full(0, 0), u32(durations.count))
  return box('moof', box('mfhd', full(0, 0), u32(1)), box('traf', box('tfhd', full(0, 0x20000), u32(id)), box('tfdt', full(1, 0), u64(base)), trun))
}
const mdat = (n: number) => box('mdat', Buffer.alloc(n))
const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2'))

const SECRET = 'test-internal-secret-0123456789'

describe('mp4 길이 계산', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp4-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const file = (name: string, ...parts: Buffer[]) => {
    const p = join(dir, name)
    writeFileSync(p, Buffer.concat(parts))
    return p
  }

  it('일반 mp4(faststart)는 mvhd의 길이를 쓴다', async () => {
    expect(await mp4DurationMs(file('a.mp4', ftyp, box('moov', mvhd(1000, 6140), trak(1, 90000)), mdat(100)))).toBe(6140)
  })

  it('fragmented mp4(MediaMTX 원본)는 moof의 tfdt + 샘플 길이로 구한다 (긴 트랙 기준)', async () => {
    const p = file(
      'b.mp4',
      ftyp,
      box('moov', mvhd(1000, 0), trak(1, 90000), trak(2, 48000), box('mvex', trex(1, 3000), trex(2, 960))),
      // 영상: 90000Hz, 1초씩 두 조각 (샘플별 길이 3000 × 30)
      moof(1, 9000, Array(30).fill(3000)),
      mdat(10),
      moof(1, 99000, Array(30).fill(3000)),
      mdat(10),
      // 오디오: 48000Hz, 기본 길이(trex 960) × 50 = 1초 → 짧은 쪽이라 무시
      moof(2, 0, { count: 50 }),
      mdat(10),
    )
    expect(await mp4DurationMs(p)).toBe(2000)
  })

  it('mvhd version 1(64비트 시각·길이)도 읽는다', async () => {
    // v1: version/flags, creation(u64), modification(u64), timescale(u32), duration(u64)
    const mvhdV1 = box('mvhd', full(1, 0), u64(1), u64(2), u32(48000), u64(48000 * 3600 * 2 + 24000), Buffer.alloc(80))
    expect(await mp4DurationMs(file('v1.mp4', ftyp, box('moov', mvhdV1, trak(1, 90000)), mdat(10)))).toBe(7_200_500)
  })

  it('mp4가 아니거나 잘린 파일은 null', async () => {
    expect(await mp4DurationMs(file('c.mp4', Buffer.from('hello world, not an mp4')))).toBeNull()
    expect(await mp4DurationMs(file('d.mp4', ftyp, box('moov', mvhd(1000, 0))))).toBeNull()
  })
})

describe('녹화 복구 스캔 (#12)', () => {
  let dir: string
  let app: TestApp
  let owner: TestUser
  let id: number

  beforeEach(async () => {
    // 훅의 segmentPath는 슬래시 경로라 Windows에서도 슬래시로 맞춘다
    dir = mkdtempSync(join(tmpdir(), 'rec-scan-')).replaceAll('\\', '/')
    ;({ app } = await makeApp(':memory:', { INTERNAL_SECRET: SECRET, RECORDINGS_DIR: dir }))
    owner = await signupAs(app, 'owner')
    const res = await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: '스캔' }, cookies: { sid: owner.sid } })
    id = res.json().broadcast.id
    await app.inject({ method: 'POST', url: `/api/broadcasts/${id}/end`, cookies: { sid: owner.sid } })
  })
  afterEach(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const OLD = Date.now() / 1000 - 3600
  /** 녹화 파일을 만들고 mtime을 1시간 전으로 둔다 (fresh면 지금) */
  const put = (bid: number, name: string, content: Buffer, { fresh = false } = {}) => {
    const d = join(dir, 'live', String(bid))
    mkdirSync(d, { recursive: true })
    const p = join(d, name)
    writeFileSync(p, content)
    if (!fresh) utimesSync(p, OLD, OLD)
    return p
  }
  const mp4 = (ms: number) => Buffer.concat([ftyp, box('moov', mvhd(1000, ms)), mdat(50)])
  const listed = async () => (await app.inject({ method: 'GET', url: `/api/broadcasts/${id}/recordings` })).json().recordings

  it('훅이 유실된 세그먼트를 등록하고, 다시 돌려도 중복 등록하지 않는다', async () => {
    put(id, '2026-11-09_12-00-00-000000_Z.mp4', mp4(5000))
    put(id, '2026-11-09_12-10-00-000000_Z.mp4', mp4(7000))
    const first = await app.recordings.scan()
    expect(first.registered.map((r) => r.recording.durationMs).sort()).toEqual([5000, 7000])
    expect(await listed()).toHaveLength(2)
    expect((await listed())[0]).toMatchObject({ startedAt: '2026-11-09T12:00:00.000Z', durationMs: 5000 })
    expect((await app.recordings.scan()).registered).toHaveLength(0)
    expect(await listed()).toHaveLength(2)
  })

  it('훅으로 이미 등록된 파일은 건너뛴다', async () => {
    const name = '2026-11-09_12-00-00-000000_Z.mp4'
    put(id, name, mp4(5000))
    await app.inject({
      method: 'POST',
      url: '/internal/media/events',
      headers: { 'x-internal-secret': SECRET },
      payload: { type: 'segment', path: `live/${id}`, segmentPath: `${dir}/live/${id}/${name}`, segmentDuration: '5' },
    })
    expect((await app.recordings.scan()).registered).toHaveLength(0)
    expect(await listed()).toHaveLength(1)
  })

  it('녹화 중(최근 수정)·변환 중(임시 파일이 최근)·임시 파일·mp4가 아닌 파일·형식이 다른 이름은 건너뛴다', async () => {
    put(id, '2026-11-09_12-00-00-000000_Z.mp4', mp4(5000), { fresh: true }) // 녹화 중
    put(id, '2026-11-09_12-10-00-000000_Z.mp4', mp4(5000)) // 원본은 오래됐지만
    put(id, '.2026-11-09_12-10-00-000000_Z.web.tmp.mp4', mp4(1), { fresh: true }) // 변환 중
    put(id, '2026-11-09_12-20-00-000000_Z.mp4', Buffer.from('broken')) // 길이를 알 수 없음
    put(id, 'notes.txt', Buffer.from('x'))
    put(id, '.hidden.mp4', mp4(5000))
    const result = await app.recordings.scan()
    expect(result.registered).toHaveLength(0)
    expect(result.skipped).toBe(3)
  })

  it('변환 임시 파일이 오래 남아 있으면(변환이 죽음) 원본을 그대로 등록한다', async () => {
    put(id, '2026-11-09_12-10-00-000000_Z.mp4', mp4(5000))
    put(id, '.2026-11-09_12-10-00-000000_Z.web.tmp.mp4', mp4(1))
    expect((await app.recordings.scan()).registered).toHaveLength(1)
  })

  it('변환 차례를 기다리는 동안(빈 임시 파일)은 원본을 등록하지 않는다', async () => {
    // segment.sh는 flock을 잡기 전에 빈 임시 파일을 만들어 둔다
    const name = '2026-11-09_12-10-00-000000_Z.mp4'
    put(id, name, mp4(5000))
    put(id, `.${name.replace(/\.mp4$/, '')}.web.tmp.mp4`, Buffer.alloc(0), { fresh: true })
    expect(await app.recordings.scan()).toEqual({ registered: [], skipped: 1 })
  })

  it('스캔이 변환 전 원본을 먼저 등록했어도, 변환 후 훅이 크기·길이를 고치고 recording 이벤트를 다시 보낸다', async () => {
    // segment.sh가 flock 대기로 35분 넘게 밀리면 스캔이 Opus 원본을 먼저 등록할 수 있다 (#31)
    const name = '2026-11-09_12-00-00-000000_Z.mp4'
    const original = mp4(5000)
    put(id, name, original)
    const [scanned] = (await app.recordings.scan()).registered
    expect(scanned!.recording).toMatchObject({ durationMs: 5000, sizeBytes: original.length })

    const stream = await openEvents(app, id)
    try {
      await stream.waitFor((e) => e.event === 'status')
      const hook = (segmentSize: string) =>
        app.inject({
          method: 'POST',
          url: '/internal/media/events',
          headers: { 'x-internal-secret': SECRET },
          payload: { type: 'segment', path: `live/${id}`, segmentPath: `${dir}/live/${id}/${name}`, segmentDuration: '5.02', segmentSize },
        })
      expect((await hook('4321')).statusCode).toBe(204)
      const event = await stream.waitFor((e) => e.event === 'recording')
      expect(event.data).toMatchObject({ id: scanned!.recording.id, durationMs: 5020, sizeBytes: 4321 })
      expect(await listed()).toEqual([event.data])

      // 같은 값의 훅이 다시 오면 아무것도 바꾸지 않는다. 크기를 못 읽은 훅(빈 값)은 있던 크기를 지우지 않는다
      await hook('4321')
      await hook('')
      expect((await listed())[0]).toMatchObject({ durationMs: 5020, sizeBytes: 4321 })
      await app.inject({ method: 'PATCH', url: `/api/broadcasts/${id}`, payload: { title: '표시' }, cookies: { sid: owner.sid } })
      await stream.waitFor((e) => e.event === 'updated')
      expect(stream.events.filter((e) => e.event === 'recording')).toHaveLength(1)
    } finally {
      stream.close()
    }
  })

  it('없는 방송의 디렉터리·live/{id}가 아닌 디렉터리는 등록하지 않는다', async () => {
    put(9999, '2026-11-09_12-00-00-000000_Z.mp4', mp4(5000))
    mkdirSync(join(dir, 'live', 'abc'), { recursive: true })
    writeFileSync(join(dir, 'live', 'abc', '2026-11-09_12-00-00-000000_Z.mp4'), mp4(5000))
    expect((await app.recordings.scan()).registered).toHaveLength(0)
  })

  it('녹화 디렉터리가 없으면(개발 모드) 아무것도 하지 않는다', async () => {
    rmSync(dir, { recursive: true, force: true })
    expect(await app.recordings.scan()).toEqual({ registered: [], skipped: 0 })
  })
})
