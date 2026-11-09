// #12 녹화·다시보기 시나리오 (docker compose 전체 구성 필요: E2E_BASE_URL=https://localhost)
// 가짜 카메라로 송출 → 재연결(세그먼트 2개) → 종료 → 다시보기 목록 → 상세 재생(오디오 포함) → 다음 구간 자동 재생
// → api 컨테이너 재시작 후에도 조회 → 삭제하면 파일 접근도 막힘
// 결과 파일의 코덱은 mediamtx 컨테이너의 ffprobe로 확인해 출력한다 (WORKLOG 기록용)
import { spawnSync } from 'node:child_process'
import { anonPage, BASE, expectEqual, finish, launch, signedUpPage, startCameraBroadcast, step } from './lib.mjs'

const ROOT = new URL('..', import.meta.url)
const compose = (...args) => {
  const r = spawnSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')} 실패: ${r.stderr}`)
  return r.stdout
}

const browser = await launch()
let owner = await signedUpPage(browser, '녹화자')
const ownerContext = owner.context()
const viewer = await anonPage(browser)
const title = `녹화 E2E ${Date.now()}`
let id
let recordings = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (page, path, init) =>
  page.evaluate(
    async ([p, i]) => {
      const res = await fetch(p, i)
      return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null }
    },
    [path, init],
  )

async function createBroadcast(page, t) {
  await page.goto(`${BASE}/broadcasts/new`)
  await page.getByLabel('제목').fill(t)
  await page.getByRole('button', { name: '만들기' }).click()
  await page.waitForURL(/\/broadcasts\/\d+$/)
  return Number(new URL(page.url()).pathname.split('/').pop())
}

/** 재생 중인 다시보기 영상의 상태 */
const videoState = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('[data-testid=replay-video]')
    if (!v) return null
    return {
      segment: Number(v.dataset.segment),
      currentTime: v.currentTime,
      duration: v.duration,
      width: v.videoWidth,
      // Chrome 전용: 디코드한 오디오 바이트. 0보다 크면 오디오 트랙이 실제로 재생된 것
      audioBytes: v.webkitAudioDecodedByteCount ?? -1,
      paused: v.paused,
    }
  })

await step('방송을 만들고 가짜 카메라로 송출한다', async () => {
  id = await createBroadcast(owner, title)
  await startCameraBroadcast(owner, id)
  await sleep(6_000)
  return `id=${id}`
})

await step('스튜디오 탭을 닫았다가 유예 시간 안에 다시 송출한다 (세그먼트가 하나 더 생긴다)', async () => {
  await owner.close()
  owner = await ownerContext.newPage()
  await startCameraBroadcast(owner, id)
  await sleep(6_000)
})

await step('시청자가 상세를 연 채로 소유자가 방송을 종료하면, 새로고침 없이 다시보기 플레이어가 나타난다', async () => {
  await viewer.goto(`${BASE}/broadcasts/${id}`)
  await viewer.getByTestId('status-line').getByText('LIVE').waitFor({ timeout: 10_000 })
  expectEqual((await api(owner, `/api/broadcasts/${id}/end`, { method: 'POST' })).status, 200, '종료')
  await viewer.getByTestId('status-line').getByText('방송 종료').waitFor({ timeout: 10_000 })
  // 마지막 세그먼트는 변환(오디오 AAC)이 끝난 뒤 등록된다. 그 사이에는 준비 중 안내가 보일 수 있다
  const preparing = await viewer.getByText('녹화 파일을 준비하고 있습니다').isVisible()
  await viewer.getByTestId('replay-video').waitFor({ timeout: 30_000 })
  return preparing ? '"준비 중" 안내 → 플레이어' : '바로 플레이어 (첫 구간이 이미 등록됨)'
})

await step('녹화 세그먼트가 2개 이상 등록된다 (재연결)', async () => {
  const deadline = Date.now() + 30_000
  for (;;) {
    const res = await api(viewer, `/api/broadcasts/${id}/recordings`)
    recordings = res.body.recordings
    if (recordings.length >= 2) break
    if (Date.now() > deadline) throw new Error(`세그먼트 ${recordings.length}개`)
    await sleep(1_000)
  }
  await viewer.getByTestId('segment-list').getByRole('button').nth(recordings.length - 1).waitFor({ timeout: 10_000 })
  return recordings.map((r) => `${r.url.split('/').pop()} ${(r.durationMs / 1000).toFixed(1)}s ${r.sizeBytes}B`).join(', ')
})

await step('홈의 다시보기 목록에 방송이 나타난다', async () => {
  const anon = await anonPage(browser)
  await anon.goto(`${BASE}/`)
  const section = anon.getByRole('region', { name: '다시보기' })
  await section.getByText(title).waitFor({ timeout: 10_000 })
  await section.getByText(title).click()
  await anon.waitForURL(new RegExp(`/broadcasts/${id}$`))
  await anon.getByTestId('replay-video').waitFor()
  await anon.close()
})

await step('상세에서 재생하면 시간이 흐르고 오디오 트랙도 재생된다', async () => {
  await viewer.reload()
  const video = viewer.getByTestId('replay-video')
  await video.waitFor()
  await viewer.evaluate(() => document.querySelector('[data-testid=replay-video]').play())
  await viewer.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid=replay-video]')
      return v && v.currentTime > 1.5 && v.videoWidth > 0
    },
    null,
    { timeout: 15_000 },
  )
  const s = await videoState(viewer)
  if (!(s.audioBytes > 0)) throw new Error(`오디오 디코드 바이트 ${s.audioBytes}`)
  return `구간 ${s.segment}, ${s.width}px, t=${s.currentTime.toFixed(1)}s/${s.duration.toFixed(1)}s, 오디오 ${s.audioBytes}B`
})

await step('첫 구간이 끝나면 다음 구간이 자동으로 이어서 재생된다', async () => {
  await viewer.evaluate(() => {
    const v = document.querySelector('[data-testid=replay-video]')
    v.currentTime = Math.max(0, v.duration - 0.5)
  })
  await viewer.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid=replay-video]')
      return v && v.dataset.segment === '2' && v.currentTime > 0.5 && !v.paused
    },
    null,
    { timeout: 15_000 },
  )
  const s = await videoState(viewer)
  return `구간 ${s.segment} 재생 중 t=${s.currentTime.toFixed(1)}s`
})

await step('파일은 Range 요청을 지원하고, moov가 앞에 있다(faststart)', async () => {
  const r = await viewer.evaluate(async (url) => {
    const res = await fetch(url, { headers: { Range: 'bytes=0-65535' } })
    const text = new TextDecoder('latin1').decode(await res.arrayBuffer())
    return { status: res.status, type: res.headers.get('content-type'), moov: text.indexOf('moov'), mdat: text.indexOf('mdat') }
  }, recordings[0].url)
  expectEqual(r.status, 206, 'Range 응답')
  if (r.moov < 0 || (r.mdat >= 0 && r.mdat < r.moov)) throw new Error(`moov=${r.moov} mdat=${r.mdat}`)
  return `${r.type}, moov@${r.moov}`
})

await step('ffprobe: 세그먼트 파일 코덱이 h264 + aac다', async () => {
  const notes = []
  for (const r of recordings) {
    // 주소 /recordings/live/... 가 mediamtx 컨테이너의 파일 경로와 같다
    const out = compose('exec', '-T', 'mediamtx', 'ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', r.url)
    const codecs = out.trim().split(/\r?\n/).map((l) => l.split(',')[0]).sort()
    // 변환 보장: 오디오는 모두 AAC(Opus가 남지 않음). 영상은 송출 측에서 첫 패킷이 늦으면 MediaMTX가 트랙을 버려
    // 오디오만 녹화되는 경우가 있다(recording 1 track (Opus), 송출 측 문제) — 그래도 변환·재생은 되어야 한다
    if (!codecs.includes('aac') || codecs.includes('opus')) throw new Error(`${r.url}: ${codecs.join('+')}`)
    notes.push(codecs.join('+'))
  }
  if (!notes.includes('aac+h264')) throw new Error(`영상+오디오 세그먼트가 없음: ${notes.join(', ')}`)
  // 변환 임시 파일이 남지 않았는지
  const ls = compose('exec', '-T', 'mediamtx', 'ls', '-a', `/recordings/live/${id}`)
  if (ls.includes('.tmp')) throw new Error(`임시 파일이 남음: ${ls}`)
  return notes.join(', ')
})

await step('등록되지 않은 파일·경로 조작은 받을 수 없다 (404)', async () => {
  const statuses = await viewer.evaluate(async (bid) => {
    const urls = [`/recordings/live/${bid}/nope.mp4`, `/recordings/live/${bid}/%2e%2e/${bid}/x.mp4`, '/recordings/']
    return Promise.all(urls.map((u) => fetch(u).then((r) => r.status)))
  }, id)
  for (const s of statuses) if (s !== 404) throw new Error(`상태 ${statuses.join(',')}`)
})

await step('api 컨테이너를 재시작해도 다시보기 목록·녹화 목록·파일이 그대로 조회된다', async () => {
  compose('restart', 'api')
  const deadline = Date.now() + 60_000
  while ((await api(viewer, '/api/health').catch(() => ({ status: 0 }))).status !== 200) {
    if (Date.now() > deadline) throw new Error('api가 다시 뜨지 않음')
    await sleep(1_000)
  }
  const after = await api(viewer, `/api/broadcasts/${id}/recordings`)
  expectEqual(after.body.recordings, recordings, '재시작 후 녹화 목록')
  const replays = await api(viewer, '/api/replays?limit=50')
  if (!replays.body.items.some((b) => b.id === id)) throw new Error('다시보기 목록에 없음')
  const file = await viewer.evaluate((u) => fetch(u, { headers: { Range: 'bytes=0-1' } }).then((r) => r.status), recordings[0].url)
  expectEqual(file, 206, '파일')
  await viewer.reload()
  await viewer.getByTestId('replay-video').waitFor({ timeout: 10_000 })
})

await step('훅이 유실된 세그먼트는 api 기동 시 복구 스캔이 등록한다 (일반 mp4·fragmented mp4 모두 길이 계산)', async () => {
  // 등록된 웹용 파일을 복사해 "훅이 오지 않은 세그먼트"를 만든다. 하나는 MediaMTX 원본처럼 fragmented로 바꾼다
  const dir = `/recordings/live/${id}`
  const src = recordings[0].url
  const plain = `${dir}/2026-01-01_00-00-00-000000_Z.mp4`
  const frag = `${dir}/2026-01-01_00-10-00-000000_Z.mp4`
  compose('exec', '-T', 'mediamtx', 'cp', src, plain)
  compose('exec', '-T', 'mediamtx', 'ffmpeg', '-v', 'error', '-y', '-i', src, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', frag)
  // 복구 스캔은 최근 2분 안에 바뀐 파일(녹화·변환 중일 수 있음)을 건너뛴다
  compose('exec', '-T', 'mediamtx', 'touch', '-d', '2026-01-01 00:00:00', plain, frag)
  compose('restart', 'api')
  const deadline = Date.now() + 60_000
  let added = []
  for (;;) {
    const res = await api(viewer, `/api/broadcasts/${id}/recordings`).catch(() => ({ status: 0 }))
    added = res.status === 200 ? res.body.recordings.filter((r) => r.url.includes('2026-01-01')) : []
    if (added.length === 2) break
    if (Date.now() > deadline) throw new Error(`복구 등록 ${added.length}개`)
    await sleep(1_000)
  }
  for (const r of added) {
    if (Math.abs(r.durationMs - recordings[0].durationMs) > 300) throw new Error(`길이 ${r.durationMs} vs ${recordings[0].durationMs}`)
  }
  // 이후 단계가 원래 목록을 기준으로 하므로 시작 시각이 가장 이른 두 구간이 추가됐음만 확인한다
  return added.map((r) => `${r.url.split('/').pop()} ${r.durationMs}ms`).join(', ')
})

await step('Cache-Control은 허용된 파일 응답에만 붙고, 거절(404)에는 붙지 않는다', async () => {
  const r = await viewer.evaluate(
    async ([ok, bid]) => {
      const a = await fetch(ok, { headers: { Range: 'bytes=0-1' } })
      const b = await fetch(`/recordings/live/${bid}/nope.mp4`)
      return [a.status, a.headers.get('cache-control'), b.status, b.headers.get('cache-control')]
    },
    [recordings[0].url, id],
  )
  expectEqual(r, [206, 'private, max-age=3600', 404, null])
})

await step('녹화가 하나뿐인 방송: 종료 직후 "준비 중" 안내가 보이고, 등록되면 새로고침 없이 플레이어로 바뀐다', async () => {
  const id2 = await createBroadcast(owner, `단일 구간 ${Date.now()}`)
  await startCameraBroadcast(owner, id2)
  await sleep(4_000)
  const watcher = await anonPage(browser)
  await watcher.goto(`${BASE}/broadcasts/${id2}`)
  await watcher.getByTestId('status-line').getByText('LIVE').waitFor({ timeout: 10_000 })
  // 종료 API를 직접 불러 종료 → 세그먼트 등록 사이의 짧은 틈을 놓치지 않게 한다
  const ended = api(owner, `/api/broadcasts/${id2}/end`, { method: 'POST' })
  const preparing = await watcher
    .getByText('녹화 파일을 준비하고 있습니다')
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  expectEqual((await ended).status, 200, '종료')
  await watcher.getByTestId('replay-video').waitFor({ timeout: 30_000 })
  expectEqual(await watcher.getByTestId('segment-list').count(), 0, '구간 목록(1개면 숨김)')
  await watcher.close()
  return preparing ? '"준비 중" 안내 확인 → SSE로 플레이어 전환' : '안내를 보기 전에 등록이 끝남'
})

await step('방송을 삭제하면 상세·녹화 목록·파일 모두 404가 된다', async () => {
  expectEqual((await api(owner, `/api/broadcasts/${id}`, { method: 'DELETE' })).status, 204)
  expectEqual((await api(viewer, `/api/broadcasts/${id}/recordings`)).status, 404, '녹화 목록')
  const file = await viewer.evaluate((u) => fetch(u, { cache: 'no-store' }).then((r) => r.status), recordings[0].url)
  expectEqual(file, 404, '파일')
})

await browser.close()
finish()
