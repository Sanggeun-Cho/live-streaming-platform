// API 호출 공통 래퍼. 같은 출처라 쿠키가 자동으로 실린다.
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type Options = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

export async function api<T>(path: string, { method = 'GET', body, signal }: Options = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'NETWORK_ERROR', '서버에 연결할 수 없습니다')
  }

  if (res.status === 204) return undefined as T

  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (data ?? {}) as { code?: string; message?: string }
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? `요청에 실패했습니다 (HTTP ${res.status})`)
  }
  return data as T
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : '알 수 없는 오류가 발생했습니다')
