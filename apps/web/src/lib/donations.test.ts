// 후원 금액 입력·검증 규칙과 시간 표시 단위 테스트
import { describe, expect, it } from 'vitest'
import { amountError, formatAmountInput, parseAmountInput } from './donations'
import { timeAgo } from './time'

const limits = { min: 1_000, max: 1_000_000, unit: 1_000, messageMax: 100 }

describe('후원 금액', () => {
  it('쉼표·단위가 섞인 입력에서 숫자만 읽고, 비면 null', () => {
    expect(parseAmountInput('12,000')).toBe(12_000)
    expect(parseAmountInput('12000원')).toBe(12_000)
    expect(parseAmountInput('')).toBeNull()
    expect(parseAmountInput('원')).toBeNull()
    expect(formatAmountInput(1_234_000)).toBe('1,234,000')
    expect(formatAmountInput(null)).toBe('')
  })

  it('상황마다 다른 안내를 돌려주고, 규칙에 맞으면 null', () => {
    expect(amountError(null, limits)).toBe('후원 금액을 입력해 주세요')
    expect(amountError(500, limits)).toBe('최소 1,000원부터 후원할 수 있습니다')
    expect(amountError(2_000_000, limits)).toBe('최대 1,000,000원까지 후원할 수 있습니다')
    expect(amountError(1_500, limits)).toBe('1,000원 단위로 입력해 주세요')
    expect(amountError(12_000, limits)).toBeNull()
  })
})

describe('상대 시간', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('1분 미만은 방금 전, 이후 분·시간·일 단위', () => {
    expect(timeAgo(ago(10_000), now)).toBe('방금 전')
    expect(timeAgo(ago(-5_000), now)).toBe('방금 전')
    expect(timeAgo(ago(3 * 60_000), now)).toBe('3분 전')
    expect(timeAgo(ago(2 * 3_600_000), now)).toBe('2시간 전')
    expect(timeAgo(ago(4 * 86_400_000), now)).toBe('4일 전')
  })
})
