// #8 모바일 송출 + 시청 시나리오 (docker compose 전체 구성 필요: E2E_BASE_URL=https://localhost)
// 휴대폰 화면 크기·터치·모바일 UA를 흉내 낸다. 실제 기기 확인은 #9에서 한다.
import { BASE, expectEqual, expectMediaFlowing, finish, launch, newContext, step, unique } from './lib.mjs'

const browser = await launch()
const iphone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
}
const phoneCtx = await newContext(browser, iphone)
// 모바일 브라우저처럼 화면 공유 API를 없앤다
await phoneCtx.addInitScript(() => {
  delete MediaDevices.prototype.getDisplayMedia
})
const phone = await phoneCtx.newPage()
const pc = await (await newContext(browser)).newPage()
const mobileViewer = await (await newContext(browser, iphone)).newPage()
let id

const phase = (page) => page.getByTestId('studio-phase')
const noHorizontalScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
/** 휴대폰이 실제로 영상 프레임을 인코딩해 보내고 있는지 (송출 쪽 RTP 누계) */
const sentVideoFrames = (page) =>
  page.evaluate(async () => {
    let frames = 0
    for (const c of window.__pcs ?? []) {
      if (c.connectionState === 'closed') continue
      const report = await c.getStats()
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') frames += s.framesEncoded ?? 0
      })
    }
    return frames
  })

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
  // 카메라를 열지 못하면 화면이 오류를 안내하고 사용자가 다시 누른다. 부하가 큰 환경에서는 Chrome 가짜 카메라가
  // 잠깐 열리지 않기도 하므로(#30) 그 경우에만 사용자처럼 한 번 더 누르고, 몇 번 다시 눌렀는지 결과에 남긴다
  const errors = []
  for (let attempt = 1; ; attempt++) {
    const preview = phase(phone).getByText('미리보기')
    const error = phone.locator('p.error[role=alert]')
    await phone.getByRole('button', { name: /카메라/ }).first().tap()
    // 이전 시도의 오류 문구가 사라진 뒤(요청 시작) 결과를 기다린다
    if (attempt > 1) await error.waitFor({ state: 'hidden', timeout: 5_000 })
    await preview.or(error).first().waitFor({ timeout: 30_000 })
    if (await preview.isVisible()) break
    errors.push(await error.innerText())
    if (attempt >= 3) throw new Error(`카메라를 열지 못함: ${errors.join(' / ')}`)
  }
  expectEqual(await noHorizontalScroll(phone), true, '가로 스크롤 없음')
  return errors.length > 0 ? `카메라 다시 누름 ${errors.length}회 (${errors[0]})` : undefined
})

await step('카메라와 마이크가 함께 송출되고, PC 시청 화면에 영상 프레임과 오디오 RTP가 계속 들어온다', async () => {
  await phone.getByRole('button', { name: '방송 시작' }).tap()
  await phase(phone).getByText('LIVE').waitFor({ timeout: 20_000 })
  await pc.goto(`${BASE}/broadcasts/${id}`)
  await pc.getByTestId('live-video').waitFor({ timeout: 20_000 })
  return await expectMediaFlowing(pc)
})

await step('방송 중 전면/후면 카메라를 바꿔도 송출이 끊기지 않는다', async () => {
  await phone.getByRole('button', { name: /전면\/후면/ }).tap()
  await phase(phone).getByText('LIVE').waitFor({ timeout: 15_000 })
  return await expectMediaFlowing(pc, { timeout: 15_000 })
})

await step('카메라 영상 트랙이 예기치 않게 끝나도(다른 앱·OS가 가져감) 카메라를 다시 열어 송출이 이어진다', async () => {
  // OS가 카메라를 끊은 것처럼: 트랙을 멈추고 ended 이벤트를 보낸다 (stop()만으로는 ended가 발생하지 않는다)
  const before = await phone.evaluate(() => {
    const track = document.querySelector('[data-testid=studio-preview]').srcObject.getVideoTracks()[0]
    track.stop()
    track.dispatchEvent(new Event('ended'))
    return track.id
  })
  await phone.waitForFunction(
    (old) => {
      const t = document.querySelector('[data-testid=studio-preview]')?.srcObject?.getVideoTracks()[0]
      return t && t.id !== old && t.readyState === 'live'
    },
    before,
    { timeout: 15_000 },
  )
  await phase(phone).getByText('LIVE').waitFor({ timeout: 15_000 })
  const sent0 = await sentVideoFrames(phone)
  const flowing = await expectMediaFlowing(pc, { timeout: 15_000 })
  const sent1 = await sentVideoFrames(phone)
  if (!(sent1 > sent0)) throw new Error(`휴대폰 영상 송출이 멈춤 ${sent0} → ${sent1}`)
  return flowing
})

await step('휴대폰으로 시청: 음소거로 시작하고 "소리 켜기"와 전체 화면 버튼이 있다', async () => {
  await mobileViewer.goto(`${BASE}/broadcasts/${id}`)
  await mobileViewer.getByTestId('live-video').waitFor({ timeout: 20_000 })
  // 음소거여도 오디오 RTP는 받고 있어야 한다 (소리 켜기를 누르면 바로 들린다)
  await expectMediaFlowing(mobileViewer)
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
