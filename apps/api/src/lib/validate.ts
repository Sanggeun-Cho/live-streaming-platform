import { z } from 'zod'
import { validationError } from '../errors.js'

/** zod 스키마로 검증하고, 실패하면 공통 형식의 400 VALIDATION_ERROR를 던진다 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {})
  if (!result.success) throw validationError(result.error)
  return result.data
}

/** URL 경로의 숫자 ID (`/:id`) */
export const positiveId = (label = 'ID') => {
  const error = `${label}가 올바르지 않습니다`
  return z.coerce.number({ error }).int({ error }).positive({ error })
}

export const idParams = z.object({ id: positiveId() })

/** 목록 페이지 크기 (`?limit=`). 1~50, 기본 20 */
export const pageLimit = () => {
  const error = '개수는 1~50 사이의 숫자여야 합니다'
  return z.coerce.number({ error }).int({ error }).min(1, { error }).max(50, { error }).default(20)
}
