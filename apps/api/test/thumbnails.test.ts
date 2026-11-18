import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THUMBNAIL_MAX_BYTES } from '../src/broadcasts/thumbnails.js'
import { makeApp, signupAs, type TestApp, type TestUser } from './helpers.js'

const SECRET = 'test-internal-secret-0123456789'

/** SOI(FF D8 FF)로 시작해 EOI(FF D9)로 끝나는 최소 JPEG 모양의 바이트 */
const jpeg = (fill = 0x11, size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill), Buffer.from([0xff, 0xd9])])

describe('방송 썸네일', () => {
  let app: TestApp
  let dir: string
  let owner: TestUser
  let other: TestUser
  let id: number

  const as = (u: TestUser | null) => (u ? { cookies: { sid: u.sid } } : {})
  const put = (body: Buffer | string, u: TestUser | null = owner, type = 'image/jpeg', bid = id) =>
    app.inject({ method: 'PUT', url: `/api/broadcasts/${bid}/thumbnail`, headers: { 'content-type': type }, payload: body, ...as(u) })
  const get = (bid = id) => app.inject({ method: 'GET', url: `/api/broadcasts/${bid}/thumbnail` })
  const goLive = (bid = id) =>
    app.inject({
      method: 'POST',
      url: '/internal/media/events',
      headers: { 'x-internal-secret': SECRET },
      payload: { type: 'online', path: `live/${bid}` },
    })
  const create = async () =>
    (await app.inject({ method: 'POST', url: '/api/broadcasts', payload: { title: '썸네일 방송' }, ...as(owner) })).json()
      .broadcast.id as number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'thumbnails-test-'))
    ;({ app } = await makeApp(':memory:', { INTERNAL_SECRET: SECRET, THUMBNAILS_DIR: dir }))
    owner = await signupAs(app, 'owner')
    other = await signupAs(app, 'other')
    id = await create()
    await goLive()
  })

  afterEach(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('소유자가 방송 중에 올리면 파일로 저장하고, 목록·상세에 썸네일 주소가 붙고, 누구나 조회한다', async () => {
    const before = await app.inject({ method: 'GET', url: `/api/broadcasts/${id}` })
    expect(before.json().broadcast.thumbnailUrl).toBeNull()

    const res = await put(jpeg())
    expect(res.statusCode).toBe(200)
    const { thumbnailUrl } = res.json()
    expect(thumbnailUrl).toMatch(new RegExp(`^/api/broadcasts/${id}/thumbnail\\?v=\\d+$`))
    expect(readFileSync(join(dir, `${id}.jpg`))).toEqual(jpeg())

    const detail = await app.inject({ method: 'GET', url: `/api/broadcasts/${id}` })
    expect(detail.json().broadcast.thumbnailUrl).toBe(thumbnailUrl)
    const list = await app.inject({ method: 'GET', url: '/api/broadcasts?status=LIVE' })
    expect(list.json().items[0]).toMatchObject({ id, thumbnailUrl })

    const image = await app.inject({ method: 'GET', url: thumbnailUrl })
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/jpeg')
    expect(image.headers['cache-control']).toBe('public, max-age=60')
    expect(image.rawPayload).toEqual(jpeg())
  })

  it('다시 올리면 파일을 덮어쓰고 주소(v)가 바뀐다. 종료 후에도 마지막 썸네일이 다시보기에 남는다', async () => {
    const first = (await put(jpeg(0x11))).json().thumbnailUrl
    await new Promise((r) => setTimeout(r, 5))
    const second = (await put(jpeg(0x22))).json().thumbnailUrl
    expect(second).not.toBe(first)
    expect((await get()).rawPayload).toEqual(jpeg(0x22))

    await app.inject({ method: 'POST', url: `/api/broadcasts/${id}/end`, ...as(owner) })
    const ended = await app.inject({ method: 'GET', url: `/api/broadcasts/${id}` })
    expect(ended.json().broadcast).toMatchObject({ status: 'ENDED', thumbnailUrl: second })
    expect((await get()).statusCode).toBe(200)
  })

  it('권한: 비로그인 401, 다른 사용자 403, 없는 방송 404 (파일은 만들지 않는다)', async () => {
    const anon = await put(jpeg(), null)
    expect([anon.statusCode, anon.json().code]).toEqual([401, 'UNAUTHORIZED'])
    const forbidden = await put(jpeg(), other)
    expect([forbidden.statusCode, forbidden.json().code]).toEqual([403, 'FORBIDDEN'])
    const missing = await put(jpeg(), owner, 'image/jpeg', 999999)
    expect([missing.statusCode, missing.json().code]).toEqual([404, 'BROADCAST_NOT_FOUND'])
    expect(existsSync(join(dir, `${id}.jpg`))).toBe(false)
  })

  it('상태: 방송 전(READY)·종료 후(ENDED)에는 409로 거절한다', async () => {
    const ready = await create()
    const res = await put(jpeg(), owner, 'image/jpeg', ready)
    expect([res.statusCode, res.json().code]).toEqual([409, 'BROADCAST_NOT_LIVE'])

    await app.inject({ method: 'POST', url: `/api/broadcasts/${id}/end`, ...as(owner) })
    const ended = await put(jpeg())
    expect([ended.statusCode, ended.json().code]).toEqual([409, 'BROADCAST_NOT_LIVE'])
  })

  it('형식: JPEG가 아닌 본문은 400, 다른 Content-Type은 415, 상한을 넘으면 413', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
    const notJpeg = await put(png)
    expect([notJpeg.statusCode, notJpeg.json().code]).toEqual([400, 'INVALID_IMAGE'])
    const wrongType = await put(png, owner, 'image/png')
    expect([wrongType.statusCode, wrongType.json().code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE'])
    const json = await put('{"a":1}', owner, 'application/json')
    expect(json.statusCode).toBe(415)
    const empty = await put(Buffer.alloc(0))
    expect(empty.statusCode).toBe(400)

    expect((await put(jpeg(0x33, THUMBNAIL_MAX_BYTES - 6))).statusCode).toBe(200)
    const tooLarge = await put(jpeg(0x33, THUMBNAIL_MAX_BYTES))
    expect([tooLarge.statusCode, tooLarge.json().code]).toEqual([413, 'PAYLOAD_TOO_LARGE'])
  })

  it('조회: 올린 적 없으면 404, 삭제된 방송은 404', async () => {
    const none = await get()
    expect([none.statusCode, none.json().code]).toEqual([404, 'THUMBNAIL_NOT_FOUND'])

    await put(jpeg())
    await app.inject({ method: 'POST', url: `/api/broadcasts/${id}/end`, ...as(owner) })
    await app.inject({ method: 'DELETE', url: `/api/broadcasts/${id}`, ...as(owner) })
    const deleted = await get()
    expect([deleted.statusCode, deleted.json().code]).toEqual([404, 'BROADCAST_NOT_FOUND'])
  })
})
