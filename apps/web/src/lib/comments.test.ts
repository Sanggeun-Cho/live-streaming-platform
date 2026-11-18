// 채팅 전송의 도배 제한 재시도·시각 표시 단위 테스트
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { formatChatTime, retryRateLimited } from './comments'

const limited = () => new ApiError(429, 'TOO_MANY_REQUESTS', '요청이 너무 많습니다')
const noSleep = () => Promise.resolve()

describe('retryRateLimited', () => {
  it('429면 기다렸다 다시 보내고, 성공하면 결과를 돌려준다', async () => {
    const send = vi.fn().mockRejectedValueOnce(limited()).mockResolvedValueOnce('ok')
    const onWait = vi.fn()
    await expect(retryRateLimited(send, onWait, [10, 20], noSleep)).resolves.toBe('ok')
    expect(send).toHaveBeenCalledTimes(2)
    expect(onWait).toHaveBeenCalledTimes(1)
  })

  it('계속 429면 다시 보낼 기회를 다 쓴 뒤 오류를 던진다', async () => {
    const send = vi.fn().mockRejectedValue(limited())
    await expect(retryRateLimited(send, undefined, [10, 20], noSleep)).rejects.toMatchObject({ status: 429 })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('429가 아닌 오류는 다시 보내지 않는다', async () => {
    const send = vi.fn().mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', '잘못된 요청'))
    await expect(retryRateLimited(send, undefined, [10], noSleep)).rejects.toMatchObject({ status: 400 })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('formatChatTime', () => {
  const now = new Date(2026, 10, 18, 21, 0)
  it('오늘이면 시:분만, 아니면 날짜도 붙인다', () => {
    expect(formatChatTime(new Date(2026, 10, 18, 9, 5).toISOString(), now)).toBe('09:05')
    expect(formatChatTime(new Date(2026, 10, 17, 23, 30).toISOString(), now)).toBe('11/17 23:30')
  })
})
