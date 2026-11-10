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
    // E2E_VERBOSE=1이면 Playwright 호출 기록(어느 요소를 왜 못 눌렀는지)까지 보여준다
    const lines = String(e?.message ?? e).split('\n')
    console.log(`✗ ${name}\n    ${lines.slice(0, process.env.E2E_VERBOSE ? 15 : 1).join('\n    ')}`)
  }
}

export function finish() {
  console.log(failed === 0 ? '\n모든 시나리오 통과' : `\n실패 ${failed}건`)
  process.exitCode = failed === 0 ? 0 : 1
}

export const unique = (prefix) => `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`

/**
 * 컨텍스트에서 만들어지는 RTCPeerConnection을 window.__pcs에 모은다.
 * 재생 판정을 currentTime이 아니라 실제로 받은 RTP(디코딩된 영상 프레임·오디오 패킷)로 하기 위해서다.
 */
export async function trackPeerConnections(ctx) {
  await ctx.addInitScript(() => {
    const Native = window.RTCPeerConnection
    if (!Native || window.__pcs) return
    window.__pcs = []
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args)
        window.__pcs.push(this)
      }
    }
  })
  return ctx
}

/** 로컬 인증서를 허용하고 RTCPeerConnection을 추적하는 새 컨텍스트 */
export async function newContext(browser, options = {}) {
  return trackPeerConnections(await browser.newContext({ ignoreHTTPSErrors: true, ...options }))
}

/** 시청 화면이 지금까지 받은 미디어 누계 (닫히지 않은 수신 연결 합계) */
export const mediaCounters = (page, selector = '[data-testid=live-video]') =>
  page.evaluate(async (sel) => {
    const v = document.querySelector(sel)
    const out = {
      width: v?.videoWidth ?? 0,
      totalVideoFrames: v?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      framesDecoded: 0,
      audioPackets: 0,
      audioBytes: 0,
    }
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState === 'closed') continue
      const report = await pc.getStats()
      report.forEach((s) => {
        if (s.type !== 'inbound-rtp') return
        if (s.kind === 'video') out.framesDecoded += s.framesDecoded ?? 0
        if (s.kind === 'audio') {
          out.audioPackets += s.packetsReceived ?? 0
          out.audioBytes += s.bytesReceived ?? 0
        }
      })
    }
    return out
  }, selector)

/**
 * 영상과 소리가 실제로 흐르는지 확인한다: 1초 간격으로 잰 디코딩 영상 프레임(getStats framesDecoded),
 * 화면에 나간 프레임(getVideoPlaybackQuality), 수신 오디오 RTP 패킷이 모두 늘어나야 한다.
 */
export async function expectMediaFlowing(page, { timeout = 20_000, audio = true } = {}) {
  const deadline = Date.now() + timeout
  let prev = await mediaCounters(page)
  let cur = prev
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000)
    cur = await mediaCounters(page)
    const video = cur.width > 0 && cur.framesDecoded > prev.framesDecoded && cur.totalVideoFrames > prev.totalVideoFrames
    const sound = !audio || cur.audioPackets > prev.audioPackets
    if (video && sound) {
      return `영상 ${cur.width}px·디코딩 ${cur.framesDecoded}프레임, 오디오 ${cur.audioPackets}패킷(${cur.audioBytes}B)`
    }
    prev = cur
  }
  throw new Error(`미디어가 흐르지 않습니다: ${JSON.stringify(cur)}`)
}

/** 비로그인 사용자용 새 페이지 (로컬 인증서 허용) */
export async function anonPage(browser) {
  return (await newContext(browser)).newPage()
}

/** 새 컨텍스트에서 회원가입하고 로그인된 페이지를 돌려준다 */
export async function signedUpPage(browser, name) {
  const ctx = await newContext(browser)
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

/** 방송 스튜디오에서 카메라로 송출을 시작하고 LIVE가 될 때까지 기다린다 */
export async function startCameraBroadcast(page, broadcastId) {
  await page.goto(`${BASE}/broadcasts/${broadcastId}/studio`)
  await page.getByRole('button', { name: /카메라/ }).first().click()
  await page.getByRole('button', { name: '방송 시작' }).click()
  await page.getByTestId('studio-phase').getByText('LIVE').waitFor({ timeout: 20_000 })
  // 종료 후 장치가 꺼졌는지 확인할 수 있게 캡처 트랙을 보관한다
  await page.evaluate(() => {
    window.__studioTracks = document.querySelector('[data-testid=studio-preview]').srcObject.getTracks()
  })
}

/** startCameraBroadcast 이후 살아 있는 캡처 트랙 수 */
export const liveCaptureTracks = (page) =>
  page.evaluate(() => (window.__studioTracks ?? []).filter((t) => t.readyState === 'live').length)
