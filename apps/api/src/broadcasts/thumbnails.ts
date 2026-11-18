import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import type { AuthUser } from '../auth/service.js'
import type { Db } from '../db/client.js'
import { broadcasts } from '../db/schema.js'
import { AppError } from '../errors.js'
import { broadcastNotFound, getOwned } from './service.js'

/** 썸네일 본문 상한. 640px 폭 JPEG(품질 0.7)는 보통 30~80KB라 여유를 둔다 */
export const THUMBNAIL_MAX_BYTES = 300 * 1024

const thumbnailNotFound = () => new AppError(404, 'THUMBNAIL_NOT_FOUND', '썸네일이 없습니다')

// JPEG는 SOI(FF D8)로 시작해 EOI(FF D9)로 끝난다. Content-Type만 믿으면 다른 파일을 이미지로 내보내게 된다
const isJpeg = (b: Buffer) =>
  b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9

/** 방송 중 화면(썸네일). 파일은 dir/<방송 ID>.jpg 하나를 덮어쓰고, DB에는 올린 시각만 둔다 */
export function createThumbnailService(db: Db, { dir }: { dir: string }) {
  const { orm } = db
  const fileOf = (id: number) => join(dir, `${id}.jpg`)

  /** 올리기 전 확인: 본인 방송이고 방송 중이어야 한다 (본문을 받기 전에도 부르려고 따로 둔다) */
  function assertUploadable(id: number, user: AuthUser) {
    getOwned(db, id, user)
    const row = orm.select({ status: broadcasts.status }).from(broadcasts).where(eq(broadcasts.id, id)).get()
    if (row?.status !== 'LIVE') {
      throw new AppError(409, 'BROADCAST_NOT_LIVE', '방송 중일 때만 썸네일을 올릴 수 있습니다')
    }
  }

  return {
    assertUploadable,

    async save(id: number, user: AuthUser, jpeg: Buffer): Promise<{ thumbnailUrl: string }> {
      // 본문을 받는 사이 방송이 끝났을 수 있어 한 번 더 확인한다
      assertUploadable(id, user)
      if (!isJpeg(jpeg)) throw new AppError(400, 'INVALID_IMAGE', 'JPEG 이미지가 아닙니다')
      await mkdir(dir, { recursive: true })
      // 임시 파일에 쓰고 바꿔 끼워, 읽는 쪽이 반쯤 쓰인 파일을 받지 않게 한다
      const tmp = `${fileOf(id)}.${randomUUID()}.tmp`
      await writeFile(tmp, jpeg)
      await rename(tmp, fileOf(id))
      const now = new Date()
      orm.update(broadcasts).set({ thumbnailUpdatedAt: now }).where(eq(broadcasts.id, id)).run()
      return { thumbnailUrl: `/api/broadcasts/${id}/thumbnail?v=${now.getTime()}` }
    },

    /** 공개 조회. 삭제된 방송·올린 적 없는 방송은 404 */
    async read(id: number): Promise<Buffer> {
      const row = orm
        .select({ thumbnailUpdatedAt: broadcasts.thumbnailUpdatedAt })
        .from(broadcasts)
        .where(and(eq(broadcasts.id, id), isNull(broadcasts.deletedAt)))
        .get()
      if (!row) throw broadcastNotFound()
      if (!row.thumbnailUpdatedAt) throw thumbnailNotFound()
      try {
        return await readFile(fileOf(id))
      } catch (e) {
        // 볼륨을 비우는 등 DB와 파일이 어긋나도 500 대신 "없음"으로 응답한다
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw thumbnailNotFound()
        throw e
      }
    },
  }
}

export type ThumbnailService = ReturnType<typeof createThumbnailService>
