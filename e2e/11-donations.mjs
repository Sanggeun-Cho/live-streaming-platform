// #11 도네이션 화면 시나리오. 개발 서버(api + vite)에서 실행한다.
//   E2E_API_URL: api 직접 주소 (기본 http://localhost:3000). 방송을 LIVE로 만드는 내부 훅을 여기로 보낸다
//   E2E_INTERNAL_SECRET: 내부 훅 시크릿 (기본 개발용 값)
//
// api 설정에 따라 두 가지로 돈다.
//   TOSS_FAKE_PAYMENTS=true: 결제창 없이 승인되는 가짜 결제로 주문 → 성공 화면 → confirm → 적립 → 실시간 알림 전체 흐름
//   TOSS_CLIENT_KEY/SECRET_KEY(토스 테스트 키): 실제 토스 결제창이 열리고 닫히는지, 실제 승인 API가 가짜 결제 키를 거절하는지
//     (카드사 인증 화면은 카드사 앱·ISP 인증이라 자동화할 수 없다)
import { anonPage, BASE, expectEqual, finish, launch, signedUpPage, step } from './lib.mjs'

const API = process.env.E2E_API_URL ?? 'http://localhost:3000'
const SECRET = process.env.E2E_INTERNAL_SECRET ?? 'dev-internal-secret-change-me'

const browser = await launch()
const streamer = await signedUpPage(browser, '방송자')
const viewer = await signedUpPage(browser, '후원자')
const watcher = await signedUpPage(browser, '구경꾼')
const anon = await anonPage(browser)
const config = await (await fetch(`${BASE}/api/donations/config`)).json()
console.log(`결제 모드: ${config.fake ? '가짜 결제' : config.enabled ? '토스 테스트 키' : '꺼짐'}`)

const apiFetch = (page, path, init = {}) =>
  page.evaluate(
    async ({ path, init }) => {
      const res = await fetch(`/api${path}`, {
        ...init,
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    },
    { path, init },
  )

const { body: created } = await apiFetch(streamer, '/broadcasts', { method: 'POST', body: { title: `후원 E2E ${Date.now()}` } })
const id = created.broadcast.id
const url = `${BASE}/broadcasts/${id}`
const reason = (page) => page.getByTestId('donation-reason')

async function goLive() {
  const res = await fetch(`${API}/internal/media/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
    body: JSON.stringify({ type: 'online', path: `live/${id}` }),
  })
  if (!res.ok) throw new Error(`online 훅 실패 ${res.status}`)
}

await step('방송 전(READY): 후원 버튼이 비활성이고 이유를 안내한다', async () => {
  await viewer.goto(url)
  await reason(viewer).getByText('방송이 시작되면 후원할 수 있습니다').waitFor()
  expectEqual(await viewer.getByRole('button', { name: '후원하기' }).isDisabled(), true, '버튼 비활성')
  await viewer.getByText('아직 후원이 없습니다').waitFor()
})

await step('방송이 시작되면 새로고침 없이 후원 버튼이 켜진다', async () => {
  await goLive()
  await viewer.getByRole('button', { name: '후원하기' }).and(viewer.locator(':enabled')).waitFor()
})

await step('비로그인: 로그인 안내 링크를 누르면 로그인 화면으로 가고 돌아올 주소를 유지한다', async () => {
  await anon.goto(url)
  await anon.getByRole('link', { name: '로그인하고 후원하기' }).click()
  await anon.waitForURL((u) => u.pathname === '/login')
  expectEqual(new URL(anon.url()).searchParams.get('next'), `/broadcasts/${id}`)
})

await step('방송자 본인: 후원 버튼이 비활성이고 "본인 방송에는 후원할 수 없습니다"', async () => {
  await streamer.goto(url)
  await reason(streamer).getByText('본인 방송에는 후원할 수 없습니다').waitFor()
  const res = await apiFetch(streamer, `/broadcasts/${id}/donation-orders`, { method: 'POST', body: { amount: 1000 } })
  expectEqual(res.status, 403, '본인 방송 주문 API')
})

await step('금액 규칙: 1,000원 단위가 아니면 안내하고 제출 버튼을 막는다', async () => {
  await viewer.getByRole('button', { name: '후원하기' }).click()
  await viewer.getByLabel('직접 입력 (원)').fill('1500')
  await viewer.getByText('1,000원 단위로 입력하세요').waitFor()
  expectEqual(await viewer.locator('form button[type=submit]').isDisabled(), true, '제출 비활성')
  await viewer.getByRole('button', { name: '5,000원', exact: true }).click()
  await viewer.getByRole('button', { name: '5,000원 후원하기' }).waitFor()
})

if (config.fake) {
  await watcher.goto(url)
  await watcher.getByRole('button', { name: '후원하기' }).and(watcher.locator(':enabled')).waitFor()
  let successUrl

  await step('후원 → 성공 화면에서 승인 확인 → 방송 화면으로 돌아와 합계·내역에 보인다', async () => {
    await viewer.getByLabel('메시지 (선택)').fill('E2E 응원합니다')
    await viewer.getByRole('button', { name: '5,000원 후원하기' }).click()
    await viewer.waitForURL(/\/donation\/success\?/)
    successUrl = viewer.url()
    await viewer.getByTestId('donation-done').getByText('5,000원을 후원했습니다').waitFor()
    await viewer.waitForURL((u) => u.pathname === `/broadcasts/${id}`, { timeout: 10_000 })
    await viewer.getByTestId('donation-total').getByText('5,000원').waitFor()
    await viewer.getByTestId('donation-list').getByText('E2E 응원합니다').waitFor()
  })

  await step('다른 시청자 화면: 새로고침 없이 후원 알림(닉네임·금액·메시지)과 합계가 갱신된다', async () => {
    const alert = watcher.getByTestId('donation-alert')
    await alert.waitFor()
    const text = await alert.innerText()
    for (const s of ['후원자', '5,000원', 'E2E 응원합니다']) if (!text.includes(s)) throw new Error(`알림에 ${s} 없음: ${text}`)
    await watcher.getByTestId('donation-total').getByText('5,000원').waitFor()
  })

  await step('같은 성공 주소를 다시 열어도(중복 승인 통지) 1번만 적립된다', async () => {
    await viewer.goto(successUrl)
    await viewer.getByTestId('donation-done').waitFor()
    const again = await apiFetch(viewer, '/donations/confirm', {
      method: 'POST',
      body: Object.fromEntries(['orderId', 'paymentKey', 'amount'].map((k) => [k, new URL(successUrl).searchParams.get(k)])),
    })
    expectEqual(again.body.alreadyConfirmed, true, '재요청 결과')
    const { body } = await apiFetch(viewer, `/broadcasts/${id}/donations`)
    expectEqual(body.total, { amount: 5000, count: 1 }, '합계')
  })

  await step('결제창에서 돌아온 금액이 주문과 다르면 적립하지 않고 안내한다', async () => {
    const { body } = await apiFetch(viewer, `/broadcasts/${id}/donation-orders`, { method: 'POST', body: { amount: 10000 } })
    const qs = new URLSearchParams({ orderId: body.order.orderId, paymentKey: 'fake_tampered', amount: '1000' })
    await viewer.goto(`${url}/donation/success?${qs}`)
    await viewer.getByRole('alert').getByText('결제 금액이 주문 금액과 다릅니다').waitFor()
    const list = await apiFetch(viewer, `/broadcasts/${id}/donations`)
    expectEqual(list.body.total, { amount: 5000, count: 1 }, '합계 그대로')
  })

  await step('결제 취소로 돌아오면 취소 안내와 방송으로 돌아가는 링크를 보여준다', async () => {
    await viewer.goto(`${url}/donation/fail?code=PAY_PROCESS_CANCELED&message=${encodeURIComponent('취소')}`)
    await viewer.getByRole('heading', { name: '결제를 취소했습니다' }).waitFor()
    await viewer.getByRole('link', { name: '방송 화면으로 돌아가기' }).click()
    await viewer.waitForURL((u) => u.pathname === `/broadcasts/${id}`)
  })

  await step('모바일(390px)에서 후원 영역이 가로로 넘치지 않는다', async () => {
    await viewer.setViewportSize({ width: 390, height: 844 })
    await viewer.getByRole('button', { name: '후원하기' }).click()
    const overflow = await viewer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (process.env.E2E_SCREENSHOT) await viewer.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true })
    if (overflow > 0) throw new Error(`가로 넘침 ${overflow}px`)
  })
} else if (config.enabled) {
  await step('토스 테스트 키: 후원하면 실제 토스 결제창이 주문 금액으로 열리고, 닫으면 취소를 안내한다', async () => {
    await viewer.getByRole('button', { name: '5,000원 후원하기' }).click()
    const frame = viewer.frameLocator('iframe[src*="tosspayments.com"]').first()
    await frame.getByText('5,000원').first().waitFor({ timeout: 20_000 })
    await frame.getByText('결제하기', { exact: true }).waitFor()
    // 결제창 오른쪽 위 닫기(X)
    await frame.locator('button[aria-label*="닫기"], button:has(svg)').first().click()
    await viewer.getByText('결제를 취소했습니다').waitFor()
  })

  await step('토스 테스트 키: 결제창 인증 없이 만든 결제 키는 실제 승인 API가 거절하고, 주문은 실패로 남는다', async () => {
    const { body } = await apiFetch(viewer, `/broadcasts/${id}/donation-orders`, { method: 'POST', body: { amount: 1000 } })
    const res = await apiFetch(viewer, '/donations/confirm', {
      method: 'POST',
      body: { orderId: body.order.orderId, paymentKey: 'tgen_not_authenticated', amount: 1000 },
    })
    expectEqual([res.status, res.body.code], [400, 'PAYMENT_REJECTED'])
    return res.body.message
  })
}

await step('방송이 끝나면 후원 버튼이 꺼지고 내역은 그대로 보인다', async () => {
  await viewer.goto(url)
  await apiFetch(streamer, `/broadcasts/${id}/end`, { method: 'POST' })
  await reason(viewer).getByText('종료된 방송에는 후원할 수 없습니다').waitFor()
  if (config.fake) await viewer.getByTestId('donation-list').getByText('E2E 응원합니다').waitFor()
})

await browser.close()
finish()
