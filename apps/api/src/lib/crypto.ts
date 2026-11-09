import { timingSafeEqual } from 'node:crypto'

/** 응답 시간으로 내용이 드러나지 않게 비교한다 (시크릿·서명 비교용) */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
