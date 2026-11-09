// #5 방송 CRUD 화면 시나리오: 소유자 / 다른 사용자 / 비로그인
import { BASE, escapeRe, expectEqual, finish, launch, signedUpPage, step } from './lib.mjs'

const browser = await launch()
const owner = await signedUpPage(browser, '방송자')
const other = await signedUpPage(browser, '다른이')
const anon = await (await browser.newContext()).newPage()
const title = `E2E 방송 ${Date.now()}`
let id

await step('비로그인이 새 방송 화면에 가면 로그인 화면으로 보내고, 돌아올 주소(next)를 유지한다', async () => {
  await anon.goto(`${BASE}/broadcasts/new`)
  await anon.waitForURL((u) => u.pathname === '/login')
  expectEqual(new URL(anon.url()).searchParams.get('next'), '/broadcasts/new')
})

await step('소유자: 빈 제목은 화면에서 막는다', async () => {
  await owner.getByRole('link', { name: '방송하기' }).click()
  await owner.getByRole('button', { name: '만들기' }).click()
  await owner.getByRole('alert').getByText('제목을 입력하세요').waitFor()
})

await step('소유자: 방송을 만들면 상세 화면으로 이동하고 "방송 준비" 상태다', async () => {
  await owner.getByLabel('제목').fill(title)
  await owner.getByLabel('설명 (선택)').fill('첫 줄\n둘째 줄')
  await owner.getByRole('button', { name: '만들기' }).click()
  await owner.waitForURL(/\/broadcasts\/\d+$/)
  id = Number(new URL(owner.url()).pathname.split('/').pop())
  await owner.getByRole('heading', { name: title }).waitFor()
  await owner.getByText('방송 준비').first().waitFor()
  return `id=${id}`
})

await step('비로그인: 목록에 보이고 상세를 볼 수 있지만 수정·삭제 버튼은 없다', async () => {
  await anon.goto(`${BASE}/`)
  await anon.getByRole('link', { name: new RegExp(escapeRe(title)) }).first().click()
  await anon.getByRole('heading', { name: title }).waitFor()
  expectEqual(await anon.getByRole('link', { name: '정보 수정' }).count(), 0, '수정 버튼')
  expectEqual(await anon.getByRole('button', { name: '삭제' }).count(), 0, '삭제 버튼')
})

await step('다른 사용자: 상세에 수정·삭제 버튼이 없고, 수정 주소로 직접 가도 막힌다', async () => {
  await other.goto(`${BASE}/broadcasts/${id}`)
  await other.getByRole('heading', { name: title }).waitFor()
  expectEqual(await other.getByRole('button', { name: '삭제' }).count(), 0, '삭제 버튼')
  await other.goto(`${BASE}/broadcasts/${id}/edit`)
  await other.getByText('본인 방송만 수정할 수 있습니다').waitFor()
})

await step('다른 사용자: API로 직접 수정·삭제하면 서버가 403으로 거절한다', async () => {
  const res = await other.evaluate(async (bid) => {
    const p = await fetch(`/api/broadcasts/${bid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '탈취' }),
    })
    const d = await fetch(`/api/broadcasts/${bid}`, { method: 'DELETE' })
    return [p.status, d.status]
  }, id)
  expectEqual(res, [403, 403])
})

await step('소유자: 정보를 수정하면 상세에 반영된다', async () => {
  await owner.getByRole('link', { name: '정보 수정' }).click()
  await owner.getByLabel('제목').fill(`${title} (수정)`)
  await owner.getByRole('button', { name: '저장' }).click()
  await owner.waitForURL((u) => u.pathname === `/broadcasts/${id}`)
  await owner.getByRole('heading', { name: `${title} (수정)` }).waitFor()
})

await step('소유자: 내 채널에서 내 방송이 보인다', async () => {
  await owner.getByRole('link', { name: '내 채널' }).click()
  await owner.getByRole('heading', { name: '내 채널' }).waitFor()
  await owner.getByRole('link', { name: new RegExp(escapeRe(`${title} (수정)`)) }).waitFor()
})

await step('소유자: 삭제하면 내 채널로 이동하고, 상세는 "찾을 수 없음"이 된다', async () => {
  await owner.goto(`${BASE}/broadcasts/${id}`)
  owner.once('dialog', (d) => d.accept())
  await owner.getByRole('button', { name: '삭제' }).click()
  await owner.waitForURL(/\/channels\/\d+$/)
  await owner.getByText('아직 만든 방송이 없습니다').waitFor()
  await anon.goto(`${BASE}/broadcasts/${id}`)
  await anon.getByText('방송을 찾을 수 없습니다').waitFor()
})

await step('모바일 폭(390px)에서 목록이 가로 스크롤 없이 보인다', async () => {
  await anon.setViewportSize({ width: 390, height: 844 })
  await anon.goto(`${BASE}/`)
  await anon.getByRole('heading', { name: '전체 방송' }).waitFor()
  const overflow = await anon.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expectEqual(overflow, false, '가로 넘침')
})

await browser.close()
finish()
