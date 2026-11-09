// #8 모바일 송출 + 시청 시나리오 (docker compose 전체 구성 필요: E2E_BASE_URL=https://localhost)
// 휴대폰 화면 크기·터치·모바일 UA를 흉내 낸다. 실제 기기 확인은 #9에서 한다.
import { BASE, expectEqual, finish, launch, step, unique } from './lib.mjs'

const browser = await launch()
const iphone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ignoreHTTPSErrors: true,
}
const phoneCtx = await browser.newContext(iphone)
// 모바일 브라우저처럼 화면 공유 API를 없앤다
await phoneCtx.addInitScript(() => {
  delete MediaDevices.prototype.getDisplayMedia
})
const phone = await phoneCtx.newPage()
const pc = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage()
const mobileViewer = await (await browser.newContext(iphone)).newPage()
let id

const phase = (page) => page.getByTestId('studio-phase')
const noHorizontalScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

await step('휴대폰에서 가입하고 방송을 만든다 (390px)', async () => {
  await phone.goto(`${BASE}/signup`)
  await phone.fill('input[type=email]', `${unique('phone')}@example.com`)
  await phone.fill('input[autocomplete=nickname]', '폰방송자')
  await phone.fill('input[type=password]', 'password123')
  await phone.click('button[type=submit]')
  await phone.getByRole('button', { name: '로그아웃' }).waitFor()
  await phone.goto(`${BASE}/broadcasts/new`)
  await phone.getByLabel('제목').fill(`모바일 E2E ${Date.now()}`)
  await phone.getByRole('button', { name: '만들기' }).click()
  await phone.waitForURL(/\/broadcasts\/\d+$/)
  id = Number(new URL(phone.url()).pathname.split('/').pop())
  expectEqual(await noHorizontalScroll(phone), true, '가로 스크롤 없음')
})

await step('스튜디오: 화면 공유 버튼 대신 안내가 보이고 카메라로 송출한다', async () => {
  await phone.goto(`${BASE}/broadcasts/${id}/studio`)
  expectEqual(await phone.getByRole('button', { name: /화면 공유/ }).count(), 0, '화면 공유 버튼')
  await phone.getByText('화면 공유를 지원하지 않아 카메라로 송출합니다').waitFor()
  await phone.getByRole('button', { name: /카메라/ }).first().tap()
  await phase(phone).getByText('미리보기').waitFor({ timeout: 15_000 })
  expectEqual(await noHorizontalScroll(phone), true, '가로 스크롤 없음')
})

await step('카메라와 마이크가 함께 송출되고, PC에서 시청하면 영상과 소리 트랙이 재생된다', async () => {
  await phone.getByRole('button', { name: '방송 시작' }).tap()
  await phase(phone).getByText('LIVE').waitFor({ timeout: 20_000 })
  await pc.goto(`${BASE}/broadcasts/${id}`)
  await pc.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid=live-video]')
      return v && v.videoWidth > 0 && v.currentTime > 0.3 && v.srcObject.getAudioTracks().length === 1
    },
    null,
    { timeout: 20_000 },
  )
})

await step('방송 중 전면/후면 카메라를 바꿔도 송출이 끊기지 않는다', async () => {
  await phone.getByRole('button', { name: /전면\/후면/ }).tap()
  await phase(phone).getByText('LIVE').waitFor({ timeout: 15_000 })
  const t0 = await pc.evaluate(() => document.querySelector('[data-testid=live-video]').currentTime)
  await pc.waitForTimeout(2000)
  const t1 = await pc.evaluate(() => document.querySelector('[data-testid=live-video]').currentTime)
  if (!(t1 > t0)) throw new Error(`재생이 멈춤 ${t0} → ${t1}`)
})

await step('휴대폰으로 시청: 음소거로 시작하고 "소리 켜기"와 전체 화면 버튼이 있다', async () => {
  await mobileViewer.goto(`${BASE}/broadcasts/${id}`)
  await mobileViewer.waitForFunction(() => document.querySelector('[data-testid=live-video]')?.videoWidth > 0, null, {
    timeout: 20_000,
  })
  expectEqual(await mobileViewer.evaluate(() => document.querySelector('[data-testid=live-video]').muted), true, '음소거 시작')
  await mobileViewer.getByRole('button', { name: /소리 켜기/ }).tap()
  expectEqual(await mobileViewer.evaluate(() => document.querySelector('[data-testid=live-video]').muted), false, '소리 켜짐')
  await mobileViewer.getByRole('button', { name: /전체 화면/ }).waitFor()
  expectEqual(await noHorizontalScroll(mobileViewer), true, '가로 스크롤 없음')
})

await step('휴대폰에서 방송을 종료하면 시청자 화면이 "방송 종료"로 바뀐다', async () => {
  phone.once('dialog', (d) => d.accept())
  await phone.getByRole('button', { name: '방송 종료' }).tap()
  await phone.getByRole('heading', { name: '방송이 종료되었습니다' }).waitFor({ timeout: 10_000 })
  await pc.getByTestId('status-line').getByText('방송 종료').waitFor({ timeout: 10_000 })
  await mobileViewer.getByTestId('status-line').getByText('방송 종료').waitFor({ timeout: 10_000 })
})

await browser.close()
finish()
