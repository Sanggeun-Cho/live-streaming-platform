// #10 실시간 댓글(채팅) 시나리오: 시청자 A / 비로그인 B / 다른 사용자 C / 방송자
import { anonPage, BASE, expectEqual, finish, launch, signedUpPage, step, unique } from './lib.mjs'

const browser = await launch()
const streamer = await signedUpPage(browser, '방송자')
const viewerA = await signedUpPage(browser, '시청자A')
const otherC = await signedUpPage(browser, '다른이C')
const anonB = await anonPage(browser)
// 화면이 통째로 사라지는 렌더 오류(예: 취소된 요청 결과를 쓰다 터짐)를 놓치지 않도록 모든 페이지의 오류를 모은다
const pageErrors = []
const watch = (page, name) => page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`))
for (const [page, name] of [[streamer, '방송자'], [viewerA, 'A'], [otherC, 'C'], [anonB, 'B']]) watch(page, name)

const id = await streamer.evaluate(async () => {
  const res = await fetch('/api/broadcasts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E 채팅 방송' }),
  })
  return (await res.json()).broadcast.id
})
const url = `${BASE}/broadcasts/${id}`
const chat = (page) => page.getByRole('complementary', { name: '채팅' })
const message = unique('안녕하세요 ')
let commentId

await step('비로그인 B: 빈 채팅 안내와 "로그인하고 채팅하기"가 보이고 입력창은 없다', async () => {
  await anonB.goto(url)
  await chat(anonB).getByText('아직 채팅이 없습니다').waitFor()
  await chat(anonB).getByRole('link', { name: '로그인하고 채팅하기' }).waitFor()
  expectEqual(await anonB.getByLabel('채팅 입력').count(), 0, '입력창')
})

await step('시청자 A: 공백만 입력하면 전송 버튼이 비활성이다', async () => {
  await viewerA.goto(url)
  await chat(viewerA).getByText('아직 채팅이 없습니다').waitFor()
  await viewerA.getByLabel('채팅 입력').fill('   ')
  expectEqual(await chat(viewerA).getByRole('button', { name: '전송' }).isDisabled(), true, '전송 비활성')
})

await step('시청자 A가 쓴 채팅이 B(비로그인) 화면에 새로고침 없이 나타난다', async () => {
  await viewerA.getByLabel('채팅 입력').fill(message)
  await viewerA.getByLabel('채팅 입력').press('Enter')
  await chat(viewerA).getByText(message).waitFor()
  expectEqual(await viewerA.getByLabel('채팅 입력').inputValue(), '', '전송 후 입력창 비움')
  await chat(anonB).getByText(message).waitFor({ timeout: 5000 })
  await chat(anonB).getByText('시청자A').waitFor()
})

await step('작성자 A에게만 수정·삭제 버튼이 보인다 (B·C에게는 없다)', async () => {
  await chat(viewerA).getByRole('button', { name: '댓글 수정' }).waitFor()
  await chat(viewerA).getByRole('button', { name: '댓글 삭제' }).waitFor()
  await otherC.goto(url)
  await chat(otherC).getByText(message).waitFor()
  expectEqual(await chat(otherC).getByRole('button', { name: '댓글 수정' }).count(), 0, 'C 수정 버튼')
  expectEqual(await chat(otherC).getByRole('button', { name: '댓글 삭제' }).count(), 0, 'C 삭제 버튼')
  expectEqual(await chat(anonB).getByRole('button', { name: '댓글 삭제' }).count(), 0, 'B 삭제 버튼')
})

await step('다른 사용자 C가 API로 A의 댓글을 직접 수정·삭제하면 403', async () => {
  const result = await otherC.evaluate(
    async ({ bid, text }) => {
      const list = await (await fetch(`/api/broadcasts/${bid}/comments`)).json()
      const target = list.items.find((c) => c.content === text)
      const p = await fetch(`/api/comments/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '탈취' }),
      })
      const d = await fetch(`/api/comments/${target.id}`, { method: 'DELETE' })
      return { id: target.id, statuses: [p.status, d.status], message: (await p.json()).message }
    },
    { bid: id, text: message },
  )
  commentId = result.id
  expectEqual(result.statuses, [403, 403])
  expectEqual(result.message, '본인이 작성한 댓글만 수정할 수 있습니다')
  await chat(anonB).getByText(message).waitFor()
})

await step('방송자의 채팅은 "방송자" 표시로 강조된다', async () => {
  await streamer.goto(url)
  await streamer.getByLabel('채팅 입력').fill('방송 시작합니다')
  await streamer.getByRole('button', { name: '전송' }).click()
  const item = chat(anonB).getByTestId('comment').filter({ hasText: '방송 시작합니다' })
  await item.getByText('방송자', { exact: true }).waitFor()
})

await step('A가 수정하면 B 화면에 "(수정됨)"과 함께 바뀐다', async () => {
  const item = chat(viewerA).getByTestId('comment').filter({ hasText: message })
  await item.getByRole('button', { name: '댓글 수정' }).click()
  await chat(viewerA).getByLabel('댓글 수정 내용').fill(`${message} 고침`)
  await chat(viewerA).getByRole('button', { name: '저장' }).click()
  await chat(anonB).getByText(`${message} 고침`).waitFor()
  await chat(anonB).getByText('(수정됨)').waitFor()
})

await step('A가 삭제하면 A·B 화면 모두 "삭제된 댓글입니다"로 바뀐다', async () => {
  viewerA.once('dialog', (d) => d.accept())
  await chat(viewerA).getByRole('button', { name: '댓글 삭제' }).click()
  await chat(viewerA).getByText('삭제된 댓글입니다').waitFor()
  await chat(anonB).getByText('삭제된 댓글입니다').waitFor()
  expectEqual(await chat(anonB).getByText(message).count(), 0, '원문 숨김')
  // 새로고침해도 자리는 남고 본문은 없다
  await anonB.reload()
  await chat(anonB).getByText('삭제된 댓글입니다').waitFor()
  expectEqual(await chat(anonB).getByText(message).count(), 0, '새로고침 후 원문 숨김')
  return `댓글 id=${commentId}`
})

await step('모바일(390px): 채팅이 영상 아래에 있고 가로 스크롤이 없다', async () => {
  await anonB.setViewportSize({ width: 390, height: 844 })
  await anonB.goto(url)
  await chat(anonB).getByText('방송 시작합니다').waitFor()
  const player = await anonB.getByTestId('player-placeholder').boundingBox()
  const panel = await chat(anonB).boundingBox()
  if (panel.y < player.y + player.height) throw new Error('채팅이 영상 아래에 있지 않다')
  const overflow = await anonB.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expectEqual(overflow, false, '가로 넘침')
})

await step('데스크톱: 채팅이 영상 옆에 있다', async () => {
  await viewerA.setViewportSize({ width: 1280, height: 800 })
  const player = await viewerA.getByTestId('player-placeholder').boundingBox()
  const panel = await chat(viewerA).boundingBox()
  if (panel.x < player.x + player.width) throw new Error('채팅이 영상 오른쪽에 있지 않다')
})

/** 도배 제한(429)에 걸리면 잠시 기다렸다가 이어서 n개를 쓴다 */
const postMany = (page, prefix, n) =>
  page.evaluate(
    async ({ bid, prefix, n }) => {
      for (let i = 0; i < n; ) {
        const res = await fetch(`/api/broadcasts/${bid}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `${prefix}${i}` }),
        })
        if (res.status === 429) await new Promise((r) => setTimeout(r, 1000))
        else if (!res.ok) throw new Error(`작성 실패 ${res.status}`)
        else i++
      }
    },
    { bid: id, prefix, n },
  )

// 열린 SSE 연결은 Playwright의 오프라인 전환으로 끊기지 않는다. 그래서 EventSource를 감싸
// 테스트가 연결을 끊었다가(브라우저의 error 이벤트) 다시 붙이는(open 이벤트) 자동 재연결 흐름을 흉내 낸다
function wrapEventSource() {
  const Real = window.EventSource
  const names = ['status', 'viewers', 'updated', 'deleted', 'comment']
  window.EventSource = class extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      this.onopen = null
      this.onerror = null
      window.__sse = this
      this.connect()
    }
    connect() {
      const es = new Real(this.url)
      this.es = es
      es.onopen = (e) => this.onopen?.(e)
      es.onerror = (e) => this.onerror?.(e)
      for (const n of names) es.addEventListener(n, (e) => this.dispatchEvent(new MessageEvent(n, { data: e.data })))
    }
    drop() {
      this.es.close()
      this.onerror?.(new Event('error'))
    }
    close() {
      this.es.close()
    }
  }
}

await step('연결이 끊긴 동안 쌓인 채팅(한 페이지 50개 초과)은 재연결 후 빈 구간 없이 이어진다', async () => {
  const ctx = (await anonPage(browser)).context()
  await ctx.addInitScript(wrapEventSource)
  const page = await ctx.newPage()
  watch(page, '재연결')
  await page.goto(url)
  await chat(page).getByText('방송 시작합니다').waitFor()
  const items = chat(page).getByTestId('comment')
  const gapItems = items.filter({ hasText: '끊긴동안' })
  await page.evaluate(() => window.__sse.drop())
  await Promise.all([postMany(viewerA, '끊긴동안A', 20), postMany(otherC, '끊긴동안C', 20), postMany(streamer, '끊긴동안S', 15)])
  // 끊겨 있으므로 실시간으로는 오지 않는다 (같은 시각 연결된 B에는 온다)
  await chat(anonB).getByTestId('comment').filter({ hasText: '끊긴동안' }).nth(54).waitFor()
  expectEqual(await gapItems.count(), 0, '끊긴 동안 표시')
  await page.evaluate(() => window.__sse.connect())
  // 재연결 후 최신 50개로 목록을 바꾼다: 이전 대화는 빈 구간 너머라 숨기고 "이전 채팅 보기"로 잇는다
  await gapItems.nth(49).waitFor({ timeout: 10000 })
  expectEqual(await items.count(), 50, '재연결 후 표시 개수')
  expectEqual(await chat(page).getByText('방송 시작합니다').count(), 0, '빈 구간 너머 이전 대화')
  await chat(page).getByRole('button', { name: '이전 채팅 보기' }).click()
  await chat(page).getByText('방송 시작합니다').waitFor()
  expectEqual(await gapItems.count(), 55, '끊긴 동안 쓴 채팅 전부')
  const ids = await items.evaluateAll((els) => els.map((e) => Number(e.dataset.commentId)))
  expectEqual(new Set(ids).size, ids.length, '중복 없음')
  expectEqual([...ids].sort((a, b) => a - b), ids, 'id 순서')
})

await step('비로그인(390px): "로그인하고 채팅하기" → 가입 → 같은 방송으로 돌아와 바로 채팅한다', async () => {
  const page = await anonPage(browser)
  watch(page, '새시청자')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(url)
  await chat(page).getByRole('link', { name: '로그인하고 채팅하기' }).click()
  await page.waitForURL((u) => u.pathname === '/login')
  expectEqual(new URL(page.url()).searchParams.get('next'), `/broadcasts/${id}`)
  await page.locator('.auth-card').getByRole('link', { name: '회원가입' }).click()
  await page.fill('input[type=email]', `${unique('chat')}@example.com`)
  await page.fill('input[autocomplete=nickname]', '새시청자')
  await page.fill('input[type=password]', 'password123')
  await page.click('button[type=submit]')
  await page.waitForURL((u) => u.pathname === `/broadcasts/${id}`)
  await page.getByLabel('채팅 입력').fill('가입하고 왔어요')
  await page.getByRole('button', { name: '전송' }).click()
  await chat(viewerA).getByText('가입하고 왔어요').waitFor()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expectEqual(overflow, false, '가로 넘침')
})

await step('세션이 만료된 뒤 전송하면 로그인 화면으로 보내고 돌아올 주소를 유지한다', async () => {
  await otherC.context().clearCookies()
  await otherC.getByLabel('채팅 입력').fill('만료 후 전송')
  await otherC.getByRole('button', { name: '전송' }).click()
  await otherC.waitForURL((u) => u.pathname === '/login')
  expectEqual(new URL(otherC.url()).searchParams.get('next'), `/broadcasts/${id}`)
})

await step('응답을 기다리지 않고 연달아 보내도 이어서 입력한 채팅이 지워지지 않는다', async () => {
  const burst = ['연달아 하나', '연달아 둘', '연달아 셋'].map((m) => `${m} ${Date.now()}`)
  for (const m of burst) {
    await viewerA.getByLabel('채팅 입력').fill(m)
    await viewerA.getByLabel('채팅 입력').press('Enter')
  }
  for (const m of burst) await chat(anonB).getByText(m).waitFor({ timeout: 5000 })
})

await step('어느 화면에서도 처리되지 않은 오류가 없다', async () => {
  expectEqual(pageErrors, [], '페이지 오류')
})

await browser.close()
finish()
