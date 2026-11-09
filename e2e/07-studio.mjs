// #7 PC 송출(방송 스튜디오) 시나리오 (docker compose 전체 구성 필요: E2E_BASE_URL=https://localhost)
// Chrome 가짜 화면 공유(--auto-select-desktop-capture-source)와 가짜 카메라·마이크를 쓴다.
import { execSync } from 'node:child_process'
import { anonPage, BASE, expectEqual, finish, launch, liveCaptureTracks, signedUpPage, step } from './lib.mjs'

const browser = await launch()
const owner = await signedUpPage(browser, '스튜디오')
const viewer = await anonPage(browser)
let id

const phase = (page) => page.getByTestId('studio-phase')
const videoInfo = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('[data-testid=live-video]')
    return v ? { w: v.videoWidth, t: v.currentTime } : null
  })
const waitPlaying = (page) =>
  page.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid=live-video]')
      return v && v.videoWidth > 0 && v.currentTime > 0.3
    },
    null,
    { timeout: 20_000 },
  )

await step('소유자: 방송 상세의 "방송 시작하기"로 스튜디오에 들어간다', async () => {
  await owner.goto(`${BASE}/broadcasts/new`)
  await owner.getByLabel('제목').fill(`스튜디오 E2E ${Date.now()}`)
  await owner.getByRole('button', { name: '만들기' }).click()
  await owner.waitForURL(/\/broadcasts\/\d+$/)
  id = Number(new URL(owner.url()).pathname.split('/').pop())
  await owner.getByRole('link', { name: '방송 시작하기' }).click()
  await owner.waitForURL(`**/broadcasts/${id}/studio`)
  await phase(owner).getByText('송출 준비').waitFor()
})

await step('다른 사용자는 스튜디오에서 송출할 수 없다', async () => {
  const other = await signedUpPage(browser, '남의스튜디오')
  await other.goto(`${BASE}/broadcasts/${id}/studio`)
  await other.getByText('본인 방송만 송출할 수 있습니다').waitFor()
  await other.context().close()
})

await step('화면 공유를 선택하면 미리보기와 화면 소리·마이크 상태가 보인다', async () => {
  await owner.getByRole('button', { name: /화면 공유/ }).click()
  await phase(owner).getByText('미리보기').waitFor({ timeout: 15_000 })
  const tracks = await owner.evaluate(() =>
    document
      .querySelector('[data-testid=studio-preview]')
      .srcObject.getTracks()
      .map((t) => t.kind)
      .sort(),
  )
  expectEqual(tracks, ['audio', 'video'], '송출 트랙(영상 1 + 섞인 오디오 1)')
  const audio = await owner.locator('.audio-status').innerText()
  return audio.replace(/\s+/g, ' ')
})

await step('방송을 시작하면 LIVE가 되고, 시청자 화면에서 재생되며 송출 품질이 표시된다', async () => {
  await owner.getByRole('button', { name: '방송 시작' }).click()
  await phase(owner).getByText('LIVE').waitFor({ timeout: 20_000 })
  await viewer.goto(`${BASE}/broadcasts/${id}`)
  await waitPlaying(viewer)
  await owner.getByTestId('studio-stats').waitFor({ timeout: 10_000 })
  return `${await owner.getByTestId('studio-stats').innerText()} / 시청 ${(await videoInfo(viewer)).w}px`
})

await step('마이크 끄기·켜기를 누르면 상태가 바뀐다', async () => {
  await owner.getByRole('button', { name: /마이크 끄기/ }).click()
  await owner.getByRole('button', { name: /마이크 켜기/ }).click()
  await owner.getByRole('button', { name: /마이크 끄기/ }).waitFor()
})

await step('방송 중 카메라로 소스를 바꾸면 연결을 유지한 채 시청자 화면이 바뀐다', async () => {
  const before = (await videoInfo(viewer)).w
  await owner.getByRole('button', { name: /카메라/ }).first().click()
  await phase(owner).getByText('LIVE').waitFor({ timeout: 15_000 })
  await viewer.waitForFunction((w) => document.querySelector('[data-testid=live-video]')?.videoWidth !== w, before, {
    timeout: 15_000,
  })
  return `${before}px → ${(await videoInfo(viewer)).w}px`
})

await step('화면 공유를 브라우저에서 중지하면 안내가 뜨고, 다시 선택하면 송출이 이어진다', async () => {
  await owner.getByRole('button', { name: /화면 공유/ }).click()
  // 이미 LIVE였으므로 LIVE 표시만으로는 전환이 끝났는지 알 수 없다. 버튼 문구로 화면 공유가 실제 소스가 된 것을 기다린다
  await owner.getByRole('button', { name: /화면 공유 다시 선택/ }).waitFor({ timeout: 15_000 })
  await phase(owner).getByText('LIVE').waitFor({ timeout: 15_000 })
  // 브라우저의 "공유 중지" 버튼은 트랙에 ended 이벤트를 보낸다
  await owner.evaluate(() => {
    const t = document.querySelector('[data-testid=studio-preview]').srcObject.getVideoTracks()[0]
    t.stop()
    t.dispatchEvent(new Event('ended'))
  })
  await owner.getByText('화면 공유가 중지되어 송출을 멈췄습니다').waitFor({ timeout: 5_000 })
  // 영상이 멈춘 채 마이크만 나가지 않는다: 송출이 끊겨 시청자에게 재연결 대기가 보인다
  await viewer.getByText('다시 연결되기를 기다리는 중').waitFor({ timeout: 15_000 })
  await owner.getByRole('button', { name: '화면 다시 선택' }).click()
  await phase(owner).getByText('LIVE').waitFor({ timeout: 20_000 })
  await waitPlaying(viewer)
})

await step('같은 방송을 다른 탭에서 송출하면 이전 탭은 "다른 곳에서 송출 중"으로 바뀌고, 다시 가져올 수 있다', async () => {
  const second = await owner.context().newPage()
  await second.goto(`${BASE}/broadcasts/${id}/studio`)
  await second.getByRole('button', { name: /카메라/ }).first().click()
  await second.getByRole('button', { name: '방송 시작' }).click()
  await phase(second).getByText('LIVE').waitFor({ timeout: 20_000 })
  await phase(owner).getByText('다른 곳에서 송출 중').waitFor({ timeout: 10_000 })
  await owner.getByRole('button', { name: '여기서 다시 송출' }).click()
  await phase(owner).getByText('LIVE').waitFor({ timeout: 20_000 })
  await phase(second).getByText('다른 곳에서 송출 중').waitFor({ timeout: 10_000 })
  await waitPlaying(viewer)
  second.once('dialog', (d) => d.accept())
  await second.close({ runBeforeUnload: true })
})

await step('서버에서 송출 연결이 끊기면(네트워크 끊김) 스튜디오가 "재연결 중"을 거쳐 자동으로 LIVE로 돌아온다', async () => {
  // MediaMTX Control API로 송출 세션을 강제로 끊는다 (컨테이너 내부에서만 접근 가능)
  const sh = (cmd) => execSync(`docker compose exec -T mediamtx sh -c "${cmd}"`, { encoding: 'utf8' })
  const path = JSON.parse(sh(`wget -qO- http://localhost:9997/v3/paths/get/live/${id}`))
  sh(`wget -qO- --post-data= http://localhost:9997/v3/webrtcsessions/kick/${path.source.id}`)
  await phase(owner).getByText('재연결 중').waitFor({ timeout: 20_000 })
  await phase(owner).getByText('LIVE').waitFor({ timeout: 30_000 })
  await waitPlaying(viewer)
})

await step('방송을 종료하면 종료 화면으로 바뀌고 화면 공유·마이크가 모두 꺼진다', async () => {
  await owner.evaluate(() => {
    window.__studioTracks = document.querySelector('[data-testid=studio-preview]').srcObject.getTracks()
  })
  owner.once('dialog', (d) => d.accept())
  await owner.getByRole('button', { name: '방송 종료' }).click()
  await owner.getByRole('heading', { name: '방송이 종료되었습니다' }).waitFor({ timeout: 10_000 })
  expectEqual(await liveCaptureTracks(owner), 0, '살아 있는 캡처 트랙')
  await viewer.getByTestId('status-line').getByText('방송 종료').waitFor({ timeout: 10_000 })
})

await step('화면 공유를 중지하고 그대로 두면 유예 시간 뒤 방송이 자동으로 종료된다', async () => {
  await owner.goto(`${BASE}/broadcasts/new`)
  await owner.getByLabel('제목').fill(`공유 중지 방치 ${Date.now()}`)
  await owner.getByRole('button', { name: '만들기' }).click()
  await owner.waitForURL(/\/broadcasts\/\d+$/)
  const id2 = Number(new URL(owner.url()).pathname.split('/').pop())
  await owner.goto(`${BASE}/broadcasts/${id2}/studio`)
  await owner.getByRole('button', { name: /화면 공유/ }).click()
  await owner.getByRole('button', { name: '방송 시작' }).click()
  await phase(owner).getByText('LIVE').waitFor({ timeout: 20_000 })
  const started = Date.now()
  await owner.evaluate(() => {
    const t = document.querySelector('[data-testid=studio-preview]').srcObject.getVideoTracks()[0]
    t.stop()
    t.dispatchEvent(new Event('ended'))
  })
  await owner.getByRole('heading', { name: '방송이 종료되었습니다' }).waitFor({ timeout: 70_000 })
  return `${Math.round((Date.now() - started) / 1000)}초 뒤 종료`
})

await step('종료된 방송의 스튜디오에 다시 들어가면 새 방송을 만들라고 안내한다', async () => {
  await owner.goto(`${BASE}/broadcasts/${id}/studio`)
  await owner.getByText('이미 종료된 방송입니다').waitFor()
})

await browser.close()
finish()
