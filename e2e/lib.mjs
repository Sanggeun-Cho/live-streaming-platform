// 브라우저 E2E 공용 도구. 설치된 Chrome을 playwright-core로 구동한다 (브라우저 다운로드 없음).
//   E2E_BASE_URL: 기본 http://localhost:5173 (npm run dev:api + dev:web). Docker는 https://localhost
import { chromium } from 'playwright-core'

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173'

export async function launch() {
  return chromium.launch({
    channel: 'chrome',
    headless: process.env.E2E_HEADED !== '1',
    args: [
      // 송출 테스트용 가짜 카메라·마이크·화면 (권한 창 없이 허용)
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
}

let failed = 0
export async function step(name, fn) {
  try {
    const note = await fn()
    console.log(`✓ ${name}${note ? ` — ${note}` : ''}`)
  } catch (e) {
    failed++
    console.log(`✗ ${name}\n    ${String(e?.message ?? e).split('\n')[0]}`)
  }
}

export function finish() {
  console.log(failed === 0 ? '\n모든 시나리오 통과' : `\n실패 ${failed}건`)
  process.exitCode = failed === 0 ? 0 : 1
}

export const unique = (prefix) => `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`

/** 새 컨텍스트에서 회원가입하고 로그인된 페이지를 돌려준다 */
export async function signedUpPage(browser, name) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/signup`)
  await page.fill('input[type=email]', `${unique('user')}@example.com`)
  await page.fill('input[autocomplete=nickname]', name)
  await page.fill('input[type=password]', 'password123')
  await page.click('button[type=submit]')
  await page.getByRole('button', { name: '로그아웃' }).waitFor()
  return page
}

export function expectEqual(actual, expected, label = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} 기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`)
  }
}

/** 정규식 특수문자를 이스케이프한다 (제목으로 링크를 찾을 때) */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
