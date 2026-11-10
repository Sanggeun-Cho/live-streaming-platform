// #14 심사자용 테스트 계정 바로 로그인 (docker compose: SEED_TEST_ACCOUNTS 기본 true)
import { anonPage, BASE, expectEqual, finish, launch, step } from './lib.mjs'

const browser = await launch()
const page = await anonPage(browser)

await step('로그인 화면에 "방송자 A / 시청자 B" 바로 로그인 버튼이 있다', async () => {
  await page.goto(`${BASE}/login`)
  await page.getByRole('button', { name: '방송자 A' }).waitFor()
  await page.getByRole('button', { name: '시청자 B' }).waitFor()
})

await step('방송자 A를 누르면 입력 없이 로그인되고 원래 가려던 화면(새 방송)으로 간다', async () => {
  await page.goto(`${BASE}/broadcasts/new`)
  await page.waitForURL((u) => u.pathname === '/login')
  await page.getByRole('button', { name: '방송자 A' }).click()
  await page.waitForURL((u) => u.pathname === '/broadcasts/new')
  await page.getByRole('link', { name: /방송자A 내 채널/ }).waitFor()
})

await step('로그아웃 후 시청자 B로 바꿔 로그인할 수 있다', async () => {
  await page.getByRole('button', { name: '로그아웃' }).click()
  await page.goto(`${BASE}/login`)
  await page.getByRole('button', { name: '시청자 B' }).click()
  await page.waitForURL((u) => u.pathname === '/')
  await page.getByRole('link', { name: /시청자B 내 채널/ }).waitFor()
  const me = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.json()))
  expectEqual(me.user.email, 'viewer@test.com')
})

await browser.close()
finish()
