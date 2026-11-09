import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDurationMs, parseSegmentStart, toRelativePath } from '../src/recordings/service.js'
import { makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

const SECRET = 'test-internal-secret-0123456789'
const ENV = { INTERNAL_SECRET: SECRET }

// MediaMTX recordPath(/recordings/%path/%Y-%m-%d_%H-%M-%S-%f_%z)가 만드는 이름
const seg = (id: number, time: string) => `/recordings/live/${id}/${time}-000000_+0000.mp4`

async function createBroadcast(app: TestApp, owner: TestUser, title = '녹화 테스트') {
  const res = await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title }, cookies: { sid: owner.sid } })
  return res.json().broadcast.id as number
}

const segmentHook = (app: TestApp, body: Record<string, string>, secret: string | null = SECRET) =>
  app.inject({
    method: 'POST',
    url: '/internal/media/events',
    headers: secret ? { 'x-internal-secret': secret } : {},
    payload: { type: 'segment', sourceType: '', segmentDuration: '12.5', segmentSize: '1048576', ...body },
  })

const authorize = (app: TestApp, uri: string | undefined, secret: string | null = SECRET) =>
  app.inject({
    method: 'GET',
    url: '/internal/recordings/authorize',
    headers: { ...(secret ? { 'x-internal-secret': secret } : {}), ...(uri ? { 'x-forwarded-uri': uri } : {}) },
  })

const recordingsOf = (app: TestApp, id: number) => app.inject({ method: 'GET', url: `/api/broadcasts/${id}/recordings` })

describe('녹화 등록·다시보기 (#12)', () => {
  let app: TestApp
  let owner: TestUser
  let other: TestUser
  let id: number

  beforeEach(async () => {
    ;({ app } = await makeApp(':memory:', ENV))
    owner = await signupAs(app, 'owner')
    other = await signupAs(app, 'other')
    id = await createBroadcast(app, owner)
  })

  afterEach(async () => {
    await app.close()
  })

  const end = (bid = id) => app.inject({ method: 'POST', url: `/api/broadcasts/${bid}/end`, cookies: { sid: owner.sid } })

  it('segment 훅을 받으면 녹화를 등록하고, 상세에서 시작 시각 순서로 돌려준다 (훅 도착 순서와 무관)', async () => {
    // 두 번째 세그먼트의 훅이 먼저 도착한 경우
    expect((await segmentHook(app, { path: `live/${id}`, segmentPath: seg(id, '2026-11-09_12-10-00') })).statusCode).toBe(204)
    expect(
      (await segmentHook(app, { path: `live/${id}`, segmentPath: seg(id, '2026-11-09_12-00-00'), segmentDuration: '3s' }))
        .statusCode,
    ).toBe(204)

    const res = await recordingsOf(app, id)
    expect(res.statusCode).toBe(200)
    const list = res.json().recordings
    expect(list.map((r: { url: string }) => r.url)).toEqual([
      `/recordings/live/${id}/2026-11-09_12-00-00-000000_+0000.mp4`,
      `/recordings/live/${id}/2026-11-09_12-10-00-000000_+0000.mp4`,
    ])
    expect(list[0]).toMatchObject({ durationMs: 3000, sizeBytes: 1048576, startedAt: '2026-11-09T12:00:00.000Z' })
    expect(list[1].durationMs).toBe(12500)
  })

  it('종료(ENDED)된 방송에도 등록한다 — 세그먼트 훅은 offline·종료 뒤에 도착한다', async () => {
    expect((await end()).statusCode).toBe(200)
    expect((await segmentHook(app, { path: `live/${id}`, segmentPath: seg(id, '2026-11-09_12-00-00') })).statusCode).toBe(204)
    expect((await recordingsOf(app, id)).json().recordings).toHaveLength(1)
  })

  it('같은 파일의 훅이 반복되어도 한 번만 등록한다 (멱등)', async () => {
    const body = { path: `live/${id}`, segmentPath: seg(id, '2026-11-09_12-00-00') }
    for (let i = 0; i < 3; i++) expect((await segmentHook(app, body)).statusCode).toBe(204)
    expect((await recordingsOf(app, id)).json().recordings).toHaveLength(1)
  })

  it.each([
    ['녹화 디렉터리 밖', (i: number) => ({ path: `live/${i}`, segmentPath: `/etc/live/${i}/a.mp4` })],
    ['상위 디렉터리로 빠져나가는 경로', (i: number) => ({ path: `live/${i}`, segmentPath: `/recordings/live/${i}/../../etc/passwd.mp4` })],
    ['중간에 ..이 낀 경로', (i: number) => ({ path: `live/${i}`, segmentPath: `/recordings/live/${i}/../${i}/a.mp4` })],
    ['다른 방송의 디렉터리', (i: number) => ({ path: `live/${i}`, segmentPath: `/recordings/live/${i + 1}/a.mp4` })],
    ['live/{id}가 아닌 path', (i: number) => ({ path: `other/${i}`, segmentPath: `/recordings/other/${i}/a.mp4` })],
    ['mp4가 아닌 파일', (i: number) => ({ path: `live/${i}`, segmentPath: `/recordings/live/${i}/a.sh` })],
    ['segmentPath 없음', (i: number) => ({ path: `live/${i}` })],
    ['길이 형식 오류', (i: number) => ({ path: `live/${i}`, segmentPath: seg(i, '2026-11-09_12-00-00'), segmentDuration: 'abc' })],
  ])('%s는 거절한다 (400, 등록 안 함)', async (_name, body) => {
    expect((await segmentHook(app, body(id))).statusCode).toBe(400)
    expect((await recordingsOf(app, id)).json().recordings).toHaveLength(0)
  })

  it('시크릿 없는 segment 훅은 401', async () => {
    const res = await segmentHook(app, { path: `live/${id}`, segmentPath: seg(id, '2026-11-09_12-00-00') }, null)
    expect(res.statusCode).toBe(401)
    expect((await recordingsOf(app, id)).json().recordings).toHaveLength(0)
  })

  it('없는 방송의 세그먼트는 등록하지 않는다 (훅 재시도를 막으려고 204)', async () => {
    const res = await segmentHook(app, { path: 'live/9999', segmentPath: seg(9999, '2026-11-09_12-00-00') })
    expect(res.statusCode).toBe(204)
    expect((await recordingsOf(app, 9999)).statusCode).toBe(404)
  })

  it('녹화 목록은 비로그인·다른 사용자도 조회한다. 없는 방송·삭제된 방송은 404', async () => {
    await segmentHook(app, { path: `live/${id}`, segmentPath: seg(id, '2026-11-09_12-00-00') })
    expect((await recordingsOf(app, id)).statusCode).toBe(200)
    const asOther = await app.inject({ method: 'GET', url: `/api/broadcasts/${id}/recordings`, cookies: { sid: other.sid } })
    expect(asOther.statusCode).toBe(200)
    expect((await recordingsOf(app, 12345)).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/broadcasts/abc/recordings' })).statusCode).toBe(400)

    await end()
    await app.inject({ method: 'DELETE', url: `/api/broadcasts/${id}`, cookies: { sid: owner.sid } })
    const res = await recordingsOf(app, id)
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('BROADCAST_NOT_FOUND')
  })

  it('다시보기 목록: 녹화가 있는 종료된 방송만, 최신순, 세그먼트 수·총 길이 포함', async () => {
    const noRecording = await createBroadcast(app, owner, '녹화 없음')
    const liveWithSegment = await createBroadcast(app, owner, '방송 중')
    const deleted = await createBroadcast(app, owner, '삭제됨')
    const newer = await createBroadcast(app, other, '최근 방송')
    for (const [bid, time] of [
      [id, '2026-11-09_12-00-00'],
      [id, '2026-11-09_12-30-00'],
      [liveWithSegment, '2026-11-09_12-00-00'],
      [deleted, '2026-11-09_12-00-00'],
      [newer, '2026-11-09_13-00-00'],
    ] as const) {
      await segmentHook(app, { path: `live/${bid}`, segmentPath: seg(bid, time) })
    }
    await end(id)
    await end(noRecording)
    await end(deleted)
    await app.inject({ method: 'POST', url: `/api/broadcasts/${newer}/end`, cookies: { sid: other.sid } })
    await app.inject({ method: 'DELETE', url: `/api/broadcasts/${deleted}`, cookies: { sid: owner.sid } })

    const res = await app.inject({ method: 'GET', url: '/api/replays' })
    expect(res.statusCode).toBe(200)
    const { items, nextCursor } = res.json()
    expect(items.map((b: { id: number }) => b.id)).toEqual([newer, id])
    expect(items[1]).toMatchObject({ status: 'ENDED', recordingCount: 2, totalDurationMs: 25000, streamer: { nickname: 'owner님' } })
    expect(nextCursor).toBeNull()

    const page1 = (await app.inject({ method: 'GET', url: '/api/replays?limit=1' })).json()
    expect(page1.items.map((b: { id: number }) => b.id)).toEqual([newer])
    const page2 = (await app.inject({ method: 'GET', url: `/api/replays?limit=1&cursor=${page1.nextCursor}` })).json()
    expect(page2.items.map((b: { id: number }) => b.id)).toEqual([id])
    expect((await app.inject({ method: 'GET', url: '/api/replays?limit=0' })).statusCode).toBe(400)
  })

  it('파일 서빙 인가(forward_auth): 등록된 파일만 허용하고, 삭제된 방송·미등록·경로 조작은 404', async () => {
    const file = seg(id, '2026-11-09_12-00-00')
    await segmentHook(app, { path: `live/${id}`, segmentPath: file })
    expect((await authorize(app, file)).statusCode).toBe(204)
    // 쿼리가 붙거나 퍼센트 인코딩되어도 같은 파일로 본다
    expect((await authorize(app, `${file}?t=1`)).statusCode).toBe(204)
    expect((await authorize(app, file.replace('+', '%2B'))).statusCode).toBe(204)

    expect((await authorize(app, seg(id, '2026-11-09_13-00-00'))).statusCode).toBe(404) // 미등록(변환 중 등)
    expect((await authorize(app, `/recordings/live/${id}/../${id}/x.mp4`)).statusCode).toBe(404)
    expect((await authorize(app, '/recordings/')).statusCode).toBe(404)
    expect((await authorize(app, undefined)).statusCode).toBe(404)
    expect((await authorize(app, file, null)).statusCode).toBe(401)

    await end()
    await app.inject({ method: 'DELETE', url: `/api/broadcasts/${id}`, cookies: { sid: owner.sid } })
    expect((await authorize(app, file)).statusCode).toBe(404)
  })
})

describe('녹화 정보 영구 저장 (#12)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rec-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('서버를 재시작해도 녹화 목록과 다시보기 목록이 그대로 조회된다', async () => {
    const dbPath = join(dir, 'app.db')
    const first = (await makeApp(dbPath, ENV)).app
    const owner = await signupAs(first, 'owner')
    const id = await createBroadcast(first, owner)
    await segmentHook(first, { path: `live/${id}`, segmentPath: seg(id, '2026-11-09_12-00-00') })
    await first.inject({ method: 'POST', url: `/api/broadcasts/${id}/end`, cookies: { sid: owner.sid } })
    const before = (await recordingsOf(first, id)).json()
    await first.close()

    const second = (await makeApp(dbPath, ENV)).app
    try {
      expect((await recordingsOf(second, id)).json()).toEqual(before)
      expect((await second.inject({ method: 'GET', url: '/api/replays' })).json().items.map((b: { id: number }) => b.id)).toEqual([id])
      expect((await authorize(second, seg(id, '2026-11-09_12-00-00'))).statusCode).toBe(204)
    } finally {
      await second.close()
    }
  })
})

describe('녹화 경로·메타데이터 해석', () => {
  it('녹화 디렉터리 기준 상대 경로만 받는다', () => {
    expect(toRelativePath('/recordings', '/recordings/live/3/a.mp4')).toEqual({ relative: 'live/3/a.mp4', broadcastId: 3 })
    expect(toRelativePath('/recordings/', '/recordings/live/3/a.mp4')).toEqual({ relative: 'live/3/a.mp4', broadcastId: 3 })
    expect(toRelativePath('/recordings', '/recordings2/live/3/a.mp4')).toBeNull()
    expect(toRelativePath('/recordings', '/recordings/live/3/.hidden.mp4')).toBeNull()
    expect(toRelativePath('/recordings', '/recordings/live/03/a.mp4')).toBeNull()
    expect(toRelativePath('/recordings', '/recordings/live/3/sub/a.mp4')).toBeNull()
    expect(toRelativePath('/recordings', '/recordings//live/3/a.mp4')).toBeNull()
  })

  it.each([
    ['23.18', 23180],
    ['23.18s', 23180],
    ['1m2.5s', 62500],
    ['1h0m0s', 3_600_000],
    ['500ms', 500],
    ['', null],
    ['abc', null],
    ['10x', null],
  ])('길이 %s → %s ms', (raw, ms) => {
    expect(parseDurationMs(raw)).toBe(ms)
  })

  it('파일 이름에서 시작 시각을 읽는다 (시간대 포함)', () => {
    expect(parseSegmentStart('live/1/2026-11-09_12-00-00-123456_+0900.mp4')?.toISOString()).toBe('2026-11-09T03:00:00.123Z')
    expect(parseSegmentStart('live/1/2026-11-09_12-00-00-123456_Z.mp4')?.toISOString()).toBe('2026-11-09T12:00:00.123Z')
    expect(parseSegmentStart('live/1/2026-11-09_12-00-00-123456.mp4')?.toISOString()).toBe('2026-11-09T12:00:00.123Z')
    expect(parseSegmentStart('live/1/garbage.mp4')).toBeNull()
  })
})
