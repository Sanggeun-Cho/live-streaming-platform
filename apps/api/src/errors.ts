import type { ZodError } from 'zod'

// 공통 에러 응답 { code, message }로 변환되는 애플리케이션 에러
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
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
