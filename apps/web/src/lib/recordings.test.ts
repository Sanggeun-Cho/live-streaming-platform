// 다시보기 구간 이어 재생 규칙 단위 테스트
import { describe, expect, it } from 'vitest'
import { formatDuration, nextSegment, type Recording, segmentPosition } from './recordings'

const rec = (id: number, startedAt: string): Recording => ({ id, url: `/recordings/live/1/${id}.mp4`, startedAt, durationMs: 60_000, sizeBytes: null })
const a = rec(10, '2026-11-10T10:00:00Z')
const b = rec(11, '2026-11-10T10:05:00Z')
const c = rec(12, '2026-11-10T10:10:00Z')

describe('다시보기 구간', () => {
  it('지금 구간이 끝나면 시작 시각 순서상 다음 구간을, 마지막이면 null을 돌려준다', () => {
    expect(nextSegment([a, b, c], a.id)).toBe(b)
    expect(nextSegment([a, b, c], b.id)).toBe(c)
    expect(nextSegment([a, b, c], c.id)).toBeNull()
    expect(nextSegment([a], a.id)).toBeNull()
  })

  it('보던 구간은 id로 찾는다: 앞쪽 구간이 늦게 끼어들어도 같은 구간을 이어 간다', () => {
    const early = rec(9, '2026-11-10T09:55:00Z')
    expect(segmentPosition([a, b], b.id)).toBe(1)
    expect(segmentPosition([early, a, b], b.id)).toBe(2)
    expect(nextSegment([early, a, b], a.id)).toBe(b)
  })

  it('보던 구간이 목록에서 사라지면 첫 구간으로 돌아간다', () => {
    expect(segmentPosition([a, c], b.id)).toBe(0)
    expect(nextSegment([a, c], b.id)).toBe(c)
  })
})

describe('formatDuration', () => {
  it('1시간 미만은 m:ss, 이상은 h:mm:ss', () => {
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_723_000)).toBe('1:02:03')
    expect(formatDuration(-5)).toBe('0:00')
  })
})
