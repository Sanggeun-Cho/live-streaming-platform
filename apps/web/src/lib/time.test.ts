// 시간 표기 규칙 단위 테스트
import { describe, expect, it } from 'vitest'
import { formatDurationText, timeAgoOf } from './time'

describe('formatDurationText', () => {
  it('요약 길이를 말로 쓴다 (0인 단위는 뺀다)', () => {
    expect(formatDurationText(0)).toBe('0초')
    expect(formatDurationText(48_000)).toBe('48초')
    expect(formatDurationText(12 * 60_000)).toBe('12분')
    expect(formatDurationText(12 * 60_000 + 30_000)).toBe('12분 30초')
    expect(formatDurationText(3_600_000 + 5 * 60_000 + 59_000)).toBe('1시간 5분')
    expect(formatDurationText(2 * 3_600_000)).toBe('2시간')
  })
})

describe('timeAgoOf', () => {
  it('"12분 전 시작"처럼 쓰고, 1분 안이면 "방금 시작"으로 쓴다', () => {
    const now = Date.parse('2026-11-18T10:00:00Z')
    expect(timeAgoOf('2026-11-18T09:59:30Z', '시작', now)).toBe('방금 시작')
    expect(timeAgoOf('2026-11-18T09:48:00Z', '시작', now)).toBe('12분 전 시작')
    expect(timeAgoOf('2026-11-18T08:00:00Z', '종료', now)).toBe('2시간 전 종료')
  })
})
