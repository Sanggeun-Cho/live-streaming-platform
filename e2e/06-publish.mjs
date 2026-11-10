// #6 송출 제어 시나리오 (docker compose 전체 구성 필요: E2E_BASE_URL=https://localhost)
// 가짜 카메라로 WHIP 송출 → 시청자 화면 실시간 상태 변경 → 끊김·재연결 → 종료 → 재송출 거절 → 유예 만료
import {
  anonPage,
  BASE,
  expectEqual,
  expectMediaFlowing,
  finish,
  launch,
  liveCaptureTracks,
  signedUpPage,
  startCameraBroadcast,
  step,
} from './lib.mjs'

const browser = await launch()
const owner = await signedUpPage(browser, '송출자')
const viewer = await anonPage(browser)
let id
let ownerContext
let ownerPage // 송출 탭을 닫았다가 다시 연 소유자 화면

async function createBroadcast(page, title) {
  await page.goto(`${BASE}/broadcasts/new`)
  await page.getByLabel('제목').fill(title)
  await page.getByRole('button', { name: '만들기' }).click()
  await page.waitForURL(/\/broadcasts\/\d+$/)
  return Number(new URL(page.url()).pathname.split('/').pop())
}

// 영상 프레임이 디코딩되고 오디오 RTP가 실제로 들어오는지로 판정한다 (currentTime은 멈춘 화면에서도 흐를 수 있다)
const videoPlaying = (page) =>
  expectMediaFlowing(page).catch(async (e) => {
    const err = await page.locator('.player-error').allTextContents()
    throw new Error(`${e.message.split('\n')[0]} / 플레이어 오류: ${err.join(' ') || '없음'}`)
  })

const statusLine = (page) => page.getByTestId('status-line')

await step('소유자가 방송을 만들고, 비로그인 시청자가 상세 화면을 연다 (방송 준비)', async () => {
  id = await createBroadcast(owner, `송출 E2E ${Date.now()}`)
  await viewer.goto(`${BASE}/broadcasts/${id}`)
  await statusLine(viewer).getByText('방송 준비').waitFor()
  return `id=${id}`
})

await step('토큰 없이 WHIP로 송출을 시도하면 MediaMTX가 거절한다 (401)', async () => {
  const status = await viewer.evaluate(async (bid) => {
    const pc = new RTCPeerConnection()
    pc.addTransceiver('video', { direction: 'sendonly' })
    await pc.setLocalDescription(await pc.createOffer())
    const res = await fetch(`/live/${bid}/whip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    })
    pc.close()
    return res.status
  }, id)
  expectEqual(status, 401)
})

await step('소유자가 카메라로 방송을 시작하면 시청자 화면이 새로고침 없이 LIVE로 바뀌고 영상이 재생된다', async () => {
  await startCameraBroadcast(owner, id)
  await statusLine(viewer).getByText('LIVE').waitFor({ timeout: 15_000 })
  return await videoPlaying(viewer)
})

await step('시청자 수가 실시간으로 표시된다', async () => {
  await statusLine(viewer).getByText(/시청자 \d+명/).waitFor({ timeout: 5_000 })
  return await statusLine(viewer).innerText()
})

await step('방송 중에는 소유자의 방송 화면에서 삭제 버튼이 비활성화된다', async () => {
  const detail = await owner.context().newPage()
  await detail.goto(`${BASE}/broadcasts/${id}`)
  expectEqual(await detail.getByRole('button', { name: '삭제' }).isDisabled(), true)
  await detail.close()
})

await step('송출 탭이 닫히면 시청자 화면에 "연결이 끊겼습니다(재연결 대기)"가 표시된다', async () => {
  ownerContext = owner.context()
  const cookies = await ownerContext.cookies()
  await owner.close()
  await viewer.getByText('다시 연결되기를 기다리는 중').waitFor({ timeout: 15_000 })
  ownerPage = await ownerContext.newPage()
  await ownerPage.goto(`${BASE}/broadcasts/${id}`)
  return `쿠키 ${cookies.length}개 유지`
})

await step('유예 시간 안에 다시 송출하면 같은 방송이 LIVE로 돌아오고 시청자 영상이 다시 재생된다', async () => {
  const page = ownerPage
  await startCameraBroadcast(page, id)
  await viewer.getByTestId('live-video').waitFor({ timeout: 15_000 })
  return await videoPlaying(viewer)
})

await step('소유자가 방송을 종료하면 시청자 화면이 "방송 종료"로 바뀐다', async () => {
  const page = ownerPage
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: '방송 종료' }).click()
  await statusLine(viewer).getByText('방송 종료').waitFor({ timeout: 10_000 })
  expectEqual(await viewer.getByTestId('live-video').count(), 0, '플레이어')
})

await step('종료된 방송은 publish 토큰을 다시 받을 수 없다 (409, 기존 토큰 재송출 403은 API 테스트)', async () => {
  const page = ownerPage
  const result = await page.evaluate(async (bid) => {
    const tokenRes = await fetch(`/api/broadcasts/${bid}/publish-token`, { method: 'POST' })
    return tokenRes.status
  }, id)
  expectEqual(result, 409)
})

await step('송출이 끊긴 채 유예 시간(45초)이 지나면 자동으로 방송 종료가 확정된다', async () => {
  const page = ownerPage
  const id2 = await createBroadcast(page, `유예 E2E ${Date.now()}`)
  await startCameraBroadcast(page, id2)
  await viewer.goto(`${BASE}/broadcasts/${id2}`)
  await statusLine(viewer).getByText('LIVE').waitFor({ timeout: 10_000 })
  const before = Date.now()
  page.once('dialog', (d) => d.accept()) // 방송 중 이탈 경고(beforeunload)
  await page.goto(`${BASE}/`) // 송출 화면을 떠난다
  await viewer.getByText('다시 연결되기를 기다리는 중').waitFor({ timeout: 15_000 })
  await statusLine(viewer).getByText('방송 종료').waitFor({ timeout: 70_000 })
  return `끊김 후 ${Math.round((Date.now() - before) / 1000)}초 만에 종료`
})

await step('다른 탭에서 방송을 종료하면 송출 중이던 탭도 카메라·마이크를 끄고 종료를 안내한다', async () => {
  const page = ownerPage
  const id3 = await createBroadcast(page, `다른 탭 종료 ${Date.now()}`)
  await startCameraBroadcast(page, id3)
  const other = await ownerContext.newPage()
  await other.goto(`${BASE}/broadcasts/${id3}`)
  expectEqual(await other.evaluate((bid) => fetch(`/api/broadcasts/${bid}/end`, { method: 'POST' }).then((r) => r.status), id3), 200)
  await page.getByRole('heading', { name: '방송이 종료되었습니다' }).waitFor({ timeout: 10_000 })
  expectEqual(await liveCaptureTracks(page), 0, '살아 있는 캡처 트랙')
})

await browser.close()
finish()
