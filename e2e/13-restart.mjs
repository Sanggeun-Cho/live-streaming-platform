// #13 서버 재시작 내구성 (docker compose 전체 구성 필요: E2E_BASE_URL=https://localhost)
//   .env에 NODE_ENV=development, TOSS_FAKE_PAYMENTS=true를 넣어 가짜 결제로 후원 내역을 만든다.
//   다른 프로젝트 이름으로 띄웠다면 같은 COMPOSE_PROJECT_NAME으로 실행한다 (스크립트가 docker compose를 직접 부른다).
//
// 1. 방송(송출·종료) · 댓글 · 후원 · 녹화를 만든다
// 2. `docker compose restart api` 뒤 같은 내용이 조회되고, 로그인 세션·녹화 파일 서빙도 유지된다
// 3. `docker compose down` → `up -d`(볼륨 유지) 뒤에도 같다
// 4. MediaMTX만 재시작한 직후(0·2·4초 뒤) 새 방송 송출이 성공하는지 확인한다 (WORKLOG "선택 기능 통합 확인")
import { spawnSync } from 'node:child_process'
import { anonPage, BASE, expectEqual, finish, launch, signedUpPage, startCameraBroadcast, step } from './lib.mjs'

const ROOT = new URL('..', import.meta.url)
const compose = (...args) => {
  const r = spawnSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')} 실패: ${r.stderr}`)
  return r.stdout
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const api = (page, path, init) =>
  page.evaluate(
    async ([p, i]) => {
      const res = await fetch(p, i?.body ? { ...i, headers: { 'Content-Type': 'application/json' } } : i)
      return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null }
    },
    [path, init],
  )

/** api가 다시 응답할 때까지 기다린다 (Caddy 경유) */
async function waitForApi(page, timeoutMs = 90_000) {
  const start = Date.now()
  for (;;) {
    try {
      const res = await api(page, '/api/health')
      if (res.status === 200) return Date.now() - start
    } catch {
      // 페이지 컨텍스트의 fetch 실패 (프록시 502 등)
    }
    if (Date.now() - start > timeoutMs) throw new Error('api가 응답하지 않습니다')
    await sleep(1000)
  }
}

const browser = await launch()
let owner = await signedUpPage(browser, '재시작방송')
const viewer = await signedUpPage(browser, '재시작시청')
const anon = await anonPage(browser)
await anon.goto(BASE)
let id
let snapshot

async function createBroadcast(page, title) {
  const res = await api(page, '/api/broadcasts', { method: 'POST', body: JSON.stringify({ title }) })
  expectEqual(res.status, 201, '방송 등록')
  return res.body.broadcast.id
}

/** 재시작 전후로 비교할 공개 조회 결과와 세션·파일 서빙 */
async function capture() {
  const b = await api(anon, `/api/broadcasts/${id}`)
  const comments = await api(anon, `/api/broadcasts/${id}/comments`)
  const donations = await api(anon, `/api/broadcasts/${id}/donations`)
  const recordings = await api(anon, `/api/broadcasts/${id}/recordings`)
  const replays = await api(anon, '/api/replays?limit=50')
  const file = recordings.body.recordings[0]?.url
  const fileStatus = file
    ? await anon.evaluate(async (u) => (await fetch(u, { headers: { Range: 'bytes=0-99' } })).status, file)
    : null
  return {
    broadcast: { title: b.body.broadcast.title, status: b.body.broadcast.status, endedAt: b.body.broadcast.endedAt },
    comments: comments.body.items.map((c) => [c.author?.nickname, c.content]),
    donations: { total: donations.body.total, items: donations.body.items.map((d) => [d.donor.nickname, d.amount, d.message]) },
    recordings: recordings.body.recordings.map((r) => [r.url, r.durationMs]),
    inReplays: replays.body.items.some((r) => r.id === id),
    fileStatus,
    viewerSession: (await api(viewer, '/api/auth/me')).status,
  }
}

await step('방송을 송출·종료하고 댓글·후원·녹화를 남긴다', async () => {
  id = await createBroadcast(owner, `재시작 E2E ${Date.now()}`)
  await startCameraBroadcast(owner, id)
  await sleep(6_000)
  expectEqual(
    (await api(viewer, `/api/broadcasts/${id}/comments`, { method: 'POST', body: JSON.stringify({ content: '재시작 전 댓글' }) }))
      .status,
    201,
    '댓글',
  )
  const order = await api(viewer, `/api/broadcasts/${id}/donation-orders`, {
    method: 'POST',
    body: JSON.stringify({ amount: 3000, message: '재시작 전 후원' }),
  })
  expectEqual(order.status, 201, '후원 주문 (TOSS_FAKE_PAYMENTS=true 필요)')
  const confirmed = await api(viewer, '/api/donations/confirm', {
    method: 'POST',
    body: JSON.stringify({ orderId: order.body.order.orderId, paymentKey: `fake_${Date.now()}`, amount: 3000 }),
  })
  expectEqual(confirmed.status, 200, '후원 승인')
  expectEqual((await api(owner, `/api/broadcasts/${id}/end`, { method: 'POST' })).status, 200, '종료')
  // 마지막 세그먼트는 오디오 변환 뒤 등록된다
  for (let i = 0; i < 60; i++) {
    const r = await api(anon, `/api/broadcasts/${id}/recordings`)
    if (r.body.recordings.length > 0) break
    await sleep(1000)
  }
  snapshot = await capture()
  if (snapshot.recordings.length === 0) throw new Error('녹화가 등록되지 않았습니다')
  expectEqual([snapshot.fileStatus, snapshot.inReplays, snapshot.viewerSession], [206, true, 200], '녹화 파일·다시보기·세션')
  return `id=${id}, 댓글 ${snapshot.comments.length}, 후원 ${snapshot.donations.total.amount}원, 녹화 ${snapshot.recordings.length}구간`
})

await step('docker compose restart api 뒤에도 방송·댓글·후원·녹화·세션이 그대로다', async () => {
  compose('restart', 'api')
  const waited = await waitForApi(anon)
  expectEqual(await capture(), snapshot, '재시작 후')
  return `api 복구 ${waited}ms`
})

await step('docker compose down → up -d (볼륨 유지) 뒤에도 그대로다', async () => {
  compose('down')
  compose('up', '-d')
  const waited = await waitForApi(anon)
  expectEqual(await capture(), snapshot, 'down/up 후')
  return `api 복구 ${waited}ms`
})

// MediaMTX만 재시작한 직후의 송출. 스튜디오는 첫 연결 실패를 자동으로 다시 시도한다
for (const delayMs of [0, 2_000, 4_000]) {
  await step(`MediaMTX 재시작 ${delayMs / 1000}초 뒤 새 방송 송출이 LIVE가 된다`, async () => {
    compose('restart', 'mediamtx')
    await sleep(delayMs)
    owner = await owner.context().newPage()
    await owner.goto(BASE)
    const bid = await createBroadcast(owner, `MediaMTX 재시작 ${delayMs}`)
    const started = Date.now()
    try {
      await startCameraBroadcast(owner, bid)
    } catch (e) {
      const phase = await owner.getByTestId('studio-phase').textContent().catch(() => '?')
      const error = await owner.getByRole('alert').first().textContent().catch(() => '')
      throw new Error(`송출 실패: phase=${phase} ${error} (${String(e.message).split('\n')[0]})`)
    }
    const took = Date.now() - started
    // 서버 상태도 LIVE인지 (훅이 api에 도착했는지)
    let status
    for (let i = 0; i < 10; i++) {
      status = (await api(anon, `/api/broadcasts/${bid}`)).body.broadcast.status
      if (status === 'LIVE') break
      await sleep(1000)
    }
    expectEqual(status, 'LIVE', '서버 상태')
    await api(owner, `/api/broadcasts/${bid}/end`, { method: 'POST' })
    await owner.close()
    return `LIVE까지 ${took}ms`
  })
}

await browser.close()
finish()
