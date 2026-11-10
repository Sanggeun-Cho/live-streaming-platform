import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeTossClient, createTossClient, TossApiError, withFakeIdempotency } from '../src/payments/toss.js'

// 토스 API 대신 응답을 정해 주는 로컬 서버
async function stub(status: number, body: string) {
  const requests: Array<{ url?: string; headers: IncomingMessage['headers']; body: string }> = []
  const server: Server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: data })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return { server, requests, baseUrl: `http://127.0.0.1:${port}` }
}

describe('토스 API 클라이언트', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  const confirmWith = async (status: number, body: string) => {
    const s = await stub(status, body)
    server = s.server
    const client = createTossClient('test_gsk_unit', { baseUrl: s.baseUrl })
    const result = await client.confirm({ paymentKey: 'pk', orderId: 'don_abcdef', amount: 1000, idempotencyKey: 'confirm-don_abcdef-0' }).catch((e: unknown) => e)
    return { result, requests: s.requests }
  }

  it('Basic 인증(시크릿 키 + 콜론)과 받은 멱등키를 붙여 승인을 요청한다', async () => {
    const payment = { paymentKey: 'pk', orderId: 'don_abcdef', status: 'DONE', totalAmount: 1000, currency: 'KRW' }
    const { result, requests } = await confirmWith(200, JSON.stringify({ ...payment, mId: 'x' }))
    expect(result).toEqual(payment)
    expect(requests[0]).toMatchObject({
      url: '/v1/payments/confirm',
      headers: {
        authorization: `Basic ${Buffer.from('test_gsk_unit:').toString('base64')}`,
        'idempotency-key': 'confirm-don_abcdef-0',
      },
    })
    expect(JSON.parse(requests[0]!.body)).toEqual({ paymentKey: 'pk', orderId: 'don_abcdef', amount: 1000 })
  })

  it.each([
    ['빈 본문', ''],
    ['필드 누락', JSON.stringify({ status: 'DONE' })],
    ['금액이 문자열', JSON.stringify({ paymentKey: 'pk', orderId: 'don_abcdef', status: 'DONE', totalAmount: '1000' })],
  ])('성공 응답의 형식이 다르면(%s) 일시 오류로 본다', async (_label, body) => {
    const { result } = await confirmWith(200, body)
    expect(result).toBeInstanceOf(TossApiError)
    expect((result as TossApiError).code).toBe('INVALID_RESPONSE')
    expect((result as TossApiError).transient).toBe(true)
  })

  it('오류 응답은 코드를 읽고, 429·5xx는 일시 오류, 4xx 거절은 아니다', async () => {
    const rejected = (await confirmWith(400, JSON.stringify({ code: 'REJECT_CARD_COMPANY', message: 'x' }))).result
    expect(rejected).toMatchObject({ code: 'REJECT_CARD_COMPANY', transient: false })
    server?.close()
    expect((await confirmWith(429, '')).result).toMatchObject({ status: 429, transient: true })
    server?.close()
    expect((await confirmWith(500, 'oops')).result).toMatchObject({ code: 'UNKNOWN', transient: true })
  })

  it.each([
    [409, 'IDEMPOTENT_REQUEST_PROCESSING'],
    [400, 'PROVIDER_ERROR'],
    [400, 'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING'],
  ])('토스가 재시도하라고 하는 오류(%s %s)는 4xx여도 일시 오류다', async (status, code) => {
    const { result } = await confirmWith(status, JSON.stringify({ code, message: 'x' }))
    expect(result).toMatchObject({ code, transient: true })
  })
})

describe('가짜 토스 멱등키', () => {
  const input = { paymentKey: 'pk', orderId: 'don_abcdef', amount: 1000, idempotencyKey: 'k1' }

  it('같은 키는 첫 응답을 오류까지 그대로 돌려주고, 처리 중이면 409, 다른 키는 새로 처리한다', async () => {
    let calls = 0
    let release!: () => void
    const confirm = withFakeIdempotency(async () => {
      calls++
      await new Promise<void>((r) => (release = r))
      throw new TossApiError(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', 'x')
    })
    const first = confirm(input).catch((e: unknown) => e)
    await expect(confirm(input)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENT_REQUEST_PROCESSING' })
    release()
    expect(await first).toMatchObject({ code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' })
    await expect(confirm(input)).rejects.toMatchObject({ code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' })
    expect(calls).toBe(1)
    const other = confirm({ ...input, idempotencyKey: 'k2' }).catch((e: unknown) => e)
    release()
    await other
    expect(calls).toBe(2)
  })

  it('E2E용 가짜 결제: 같은 키 재요청은 같은 승인, 다른 키로 같은 결제를 다시 승인하면 ALREADY_PROCESSED_PAYMENT', async () => {
    const client = createFakeTossClient()
    const payment = await client.confirm(input)
    expect(payment).toMatchObject({ status: 'DONE', totalAmount: 1000 })
    expect(await client.confirm(input)).toEqual(payment)
    await expect(client.confirm({ ...input, idempotencyKey: 'k2' })).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED_PAYMENT',
    })
    expect(await client.getPayment('pk')).toEqual(payment)
  })
})
