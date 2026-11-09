import type { ZodError } from 'zod'

// 공통 에러 응답 { code, message }로 변환되는 애플리케이션 에러
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /**
     * 5xx여도 message를 사용자에게 그대로 보낸다 (외부 결제 API 장애처럼 사용자가 다음에 할 일을 알아야 하는 경우).
     * 기본값 false: 예상하지 못한 5xx는 내부 정보를 숨긴다. 4xx는 항상 보낸다
     */
    readonly expose = false,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function validationError(error: ZodError): AppError {
  const first = error.issues[0]
  return new AppError(400, 'VALIDATION_ERROR', first?.message ?? '요청 형식이 올바르지 않습니다')
}

export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', '로그인이 필요합니다')

export const forbidden = (message = '권한이 없습니다') => new AppError(403, 'FORBIDDEN', message)
