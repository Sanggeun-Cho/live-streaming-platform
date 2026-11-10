// 녹화·다시보기 (#12, DESIGN.md §7)
//
// 흐름: MediaMTX가 live/{id}를 fMP4로 녹화 → 세그먼트가 닫히면 hooks/segment.sh가 오디오만 AAC로 바꾼 웹용 mp4를
// 같은 경로에 만든 뒤 api에 segment 이벤트를 보낸다 → 여기서 recordings 테이블에 등록한다.
// 파일은 Caddy가 /recordings/*로 서빙하되, 요청마다 api에 "등록된 파일이고 방송이 삭제되지 않았는지"를 묻는다(forward_auth).
//
// 세그먼트 훅은 offline과 같은 시점이나 그 뒤에 도착한다(#2 스파이크). 그래서 방송 상태(LIVE/ENDED)와 상관없이 등록한다.
// 훅이 유실되면(wget 실패, 변환 중 mediamtx 재시작) api가 기동 시와 5분마다 녹화 디렉터리를 스캔해 메운다(scan).

import { and, asc, desc, eq, isNull, lt, or, type SQL, sql } from 'drizzle-orm'
import { readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Db } from '../db/client.js'
import { broadcasts, channels, recordings, users } from '../db/schema.js'
import { broadcastColumns, broadcastNotFound, type BroadcastView } from '../broadcasts/service.js'
import { parseMediaPath } from '../broadcasts/lifecycle.js'
import { mp4DurationMs } from './mp4.js'

/** 브라우저가 파일을 받는 주소의 접두사 (Caddy가 recordings 볼륨을 이 경로로 서빙한다) */
export const RECORDINGS_URL_PREFIX = '/recordings/'

export type RecordingView = {
  id: number
  /** 같은 출처 기준 재생 주소 (예: /recordings/live/12/2026-11-09_12-00-00-000000_+0000.mp4) */
  url: string
  startedAt: Date
  durationMs: number
  sizeBytes: number | null
}

export type ReplayView = BroadcastView & { recordingCount: number; totalDurationMs: number }

export type SegmentEvent = {
  path: string
  segmentPath?: string
  segmentDuration?: string
  segmentSize?: string
}

export type RegisterResult =
  | { status: 'registered'; broadcastId: number; recording: RecordingView }
  /** 복구 스캔이 먼저 등록한 원본을 훅(웹용 변환 완료)이 최종 크기·길이로 고쳤다 */
  | { status: 'updated'; broadcastId: number; recording: RecordingView }
  | { status: 'duplicate' }
  | { status: 'unknown-broadcast' }
  | { status: 'invalid'; reason: string }

// 상대 경로 형식: live/{방송 ID}/{파일 이름}.mp4. 파일 이름에 슬래시가 없고 점으로 시작하지 않으므로 상위 디렉터리로 빠져나갈 수 없다
const RELATIVE_PATH = /^live\/([1-9][0-9]{0,15})\/[A-Za-z0-9_+-][A-Za-z0-9_.+-]{0,127}\.mp4$/

/**
 * 녹화 디렉터리 밖이거나 형식이 다른 경로는 null. 반환값은 녹화 디렉터리 기준 상대 경로.
 * normalize 결과가 원래 문자열과 같아야 통과하므로 `..`, `//`, `./` 같은 우회 표현을 모두 거절한다.
 */
export function toRelativePath(recordingsDir: string, absolute: string): { relative: string; broadcastId: number } | null {
  const root = recordingsDir.endsWith('/') ? recordingsDir : `${recordingsDir}/`
  if (posix.normalize(absolute) !== absolute || !absolute.startsWith(root)) return null
  const relative = absolute.slice(root.length)
  const m = RELATIVE_PATH.exec(relative)
  return m ? { relative, broadcastId: Number(m[1]) } : null
}

/**
 * MTX_SEGMENT_DURATION을 밀리초로. MediaMTX 버전에 따라 초 단위 숫자("23.18") 또는
 * Go duration 문자열("23.18s", "1m2.5s")로 오므로 둘 다 받는다.
 */
export function parseDurationMs(raw: string | undefined): number | null {
  if (!raw) return null
  const value = raw.trim()
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  const unitMs: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, µs: 0.001, ns: 0.000001 }
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/gy
  let total = 0
  let consumed = 0
  for (let m = re.exec(value); m; m = re.exec(value)) {
    total += Number(m[1]) * unitMs[m[2]!]!
    consumed = re.lastIndex
  }
  return consumed === value.length && consumed > 0 ? Math.round(total) : null
}

/**
 * recordPath의 `%Y-%m-%d_%H-%M-%S-%f_%z` 파일 이름에서 녹화 시작 시각을 읽는다.
 * 훅 도착 순서는 믿을 수 없으므로(변환 시간이 세그먼트마다 다르다) 재생 순서는 이 값으로 정한다.
 */
export function parseSegmentStart(relative: string): Date | null {
  const name = posix.basename(relative)
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})(?:_(Z|[+-]\d{2}:?\d{2}))?/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, us, tz] = m
  const offset = !tz || tz === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.slice(-2)}`
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${us!.slice(0, 3)}${offset}`)
  return Number.isNaN(date.getTime()) ? null : date
}

// 복구 스캔: mtime이 이보다 최근인 파일은 아직 녹화 중이거나 훅(변환·등록)이 처리 중일 수 있어 건너뛴다.
// MediaMTX는 녹화 중인 fMP4에 1초 간격으로 덧붙이므로 2분이면 충분히 구분된다
const SCAN_SETTLE_MS = 2 * 60_000
// 변환 임시 파일이 이 시간 안에 바뀌었으면 변환 중으로 본다 (segment.sh의 ffmpeg timeout 30분 + 여유)
const CONVERTING_MS = 35 * 60_000

/** segment.sh가 쓰는 변환 임시 파일 이름 */
export const tempNameOf = (fileName: string) => `.${fileName.replace(/\.mp4$/, '')}.web.tmp.mp4`

export type ScanResult = { registered: Extract<RegisterResult, { status: 'registered' }>[]; skipped: number }

export function createRecordingService(db: Db, { recordingsDir }: { recordingsDir: string }) {
  const { orm } = db

  const toView = (row: { id: number; filePath: string; startedAt: Date; durationMs: number; sizeBytes: number | null }): RecordingView => ({
    id: row.id,
    url: `${RECORDINGS_URL_PREFIX}${row.filePath}`,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes,
  })

  const recordingColumns = {
    id: recordings.id,
    filePath: recordings.filePath,
    startedAt: recordings.startedAt,
    durationMs: recordings.durationMs,
    sizeBytes: recordings.sizeBytes,
  }

  /** 방송 행이 있는가. activeOnly면 삭제되지 않은 방송만 */
  const broadcastExists = (id: number, { activeOnly }: { activeOnly: boolean }) =>
    orm
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(activeOnly ? and(eq(broadcasts.id, id), isNull(broadcasts.deletedAt)) : eq(broadcasts.id, id))
      .get() !== undefined

  /**
   * 훅과 복구 스캔이 함께 쓰는 등록. 같은 파일은 한 번만 들어간다 (file_path 유니크).
   * fromHook이면 이미 있는 행의 크기·길이를 훅 값으로 고친다: segment.sh가 변환 차례(flock)를 기다리는 동안
   * 복구 스캔이 변환 전 원본(Opus)을 먼저 등록할 수 있다. 훅은 변환이 끝난 최종 파일 기준이라 훅 값이 맞다.
   */
  function insert(
    broadcastId: number,
    relative: string,
    durationMs: number,
    sizeBytes: number | null,
    now: Date,
    { fromHook }: { fromHook: boolean },
  ): RegisterResult {
    // 종료 → 삭제 뒤에 늦게 도착한 세그먼트도 등록해 둔다 (조회·서빙은 삭제 기준으로 막힌다)
    if (!broadcastExists(broadcastId, { activeOnly: false })) return { status: 'unknown-broadcast' }
    // 파일 이름을 못 읽으면 "지금 - 길이"로 추정한다 (훅은 세그먼트가 닫힌 직후 실행된다)
    const startedAt = parseSegmentStart(relative) ?? new Date(now.getTime() - durationMs)
    const row = orm
      .insert(recordings)
      .values({ broadcastId, filePath: relative, startedAt, durationMs, sizeBytes })
      .onConflictDoNothing({ target: recordings.filePath })
      .returning(recordingColumns)
      .get()
    if (row) return { status: 'registered', broadcastId, recording: toView(row) }
    if (!fromHook) return { status: 'duplicate' }

    const existing = orm.select(recordingColumns).from(recordings).where(eq(recordings.filePath, relative)).get()
    // 훅이 크기를 못 읽었으면(stat 실패) 있던 값을 지우지 않는다
    const nextSize = sizeBytes ?? existing?.sizeBytes ?? null
    if (!existing || (existing.durationMs === durationMs && existing.sizeBytes === nextSize)) return { status: 'duplicate' }
    const updated = orm
      .update(recordings)
      .set({ durationMs, sizeBytes: nextSize })
      .where(eq(recordings.id, existing.id))
      .returning(recordingColumns)
      .get()
    return { status: 'updated', broadcastId, recording: toView(updated!) }
  }

  return {
    /** MediaMTX segment 훅. 같은 파일은 한 번만 등록한다 (멱등) */
    register(event: SegmentEvent, now = new Date()): RegisterResult {
      const pathId = parseMediaPath(event.path)
      if (pathId === null) return { status: 'invalid', reason: 'path가 live/{id} 형식이 아닙니다' }
      const parsed = event.segmentPath ? toRelativePath(recordingsDir, event.segmentPath) : null
      if (!parsed) return { status: 'invalid', reason: '녹화 디렉터리 밖이거나 형식이 다른 segmentPath' }
      if (parsed.broadcastId !== pathId) return { status: 'invalid', reason: 'path와 segmentPath의 방송이 다릅니다' }
      const durationMs = parseDurationMs(event.segmentDuration)
      if (durationMs === null) return { status: 'invalid', reason: 'segmentDuration 형식 오류' }
      const size = event.segmentSize ? Number(event.segmentSize) : NaN
      const sizeBytes = Number.isSafeInteger(size) && size >= 0 ? size : null
      return insert(pathId, parsed.relative, durationMs, sizeBytes, now, { fromHook: true })
    },

    /**
     * 복구 스캔: 녹화 디렉터리에서 등록되지 않은 세그먼트를 찾아 등록한다.
     * 훅 유실(wget 실패, api 다운)이나 변환 도중 mediamtx 재시작으로 빠진 세그먼트를 메운다.
     * 변환되지 않은 원본(Opus)이면 원본 그대로 등록한다 (Chrome·Android에서는 재생된다).
     * 녹화 디렉터리가 없으면(개발 모드) 아무것도 하지 않는다.
     */
    async scan(now = Date.now()): Promise<ScanResult> {
      const result: ScanResult = { registered: [], skipped: 0 }
      const liveDir = join(recordingsDir, 'live')
      let dirs: string[]
      try {
        dirs = await readdir(liveDir)
      } catch {
        return result
      }
      for (const dir of dirs) {
        const broadcastId = parseMediaPath(`live/${dir}`)
        if (broadcastId === null) continue
        let names: string[]
        try {
          names = await readdir(join(liveDir, dir))
        } catch {
          continue
        }
        const known = new Set(
          orm
            .select({ filePath: recordings.filePath })
            .from(recordings)
            .where(eq(recordings.broadcastId, broadcastId))
            .all()
            .map((r) => r.filePath),
        )
        const present = new Set(names)
        for (const name of names) {
          const relative = `live/${dir}/${name}`
          // 점으로 시작하는 변환 임시 파일은 RELATIVE_PATH에서 걸러진다
          if (known.has(relative) || !RELATIVE_PATH.test(relative)) continue
          try {
            const file = join(liveDir, dir, name)
            const info = await stat(file)
            const temp = tempNameOf(name)
            const converting =
              present.has(temp) && now - (await stat(join(liveDir, dir, temp))).mtimeMs < CONVERTING_MS
            const durationMs = now - info.mtimeMs < SCAN_SETTLE_MS || converting ? null : await mp4DurationMs(file)
            if (durationMs === null) {
              result.skipped++
              continue
            }
            const r = insert(broadcastId, relative, durationMs, info.size, new Date(now), { fromHook: false })
            if (r.status === 'registered') result.registered.push(r)
          } catch {
            result.skipped++
          }
        }
      }
      return result
    },

    /** 방송의 녹화 세그먼트를 재생 순서대로. 없거나 삭제된 방송은 404 */
    listForBroadcast(broadcastId: number): RecordingView[] {
      if (!broadcastExists(broadcastId, { activeOnly: true })) throw broadcastNotFound()
      return orm
        .select(recordingColumns)
        .from(recordings)
        .where(eq(recordings.broadcastId, broadcastId))
        .orderBy(asc(recordings.startedAt), asc(recordings.id))
        .all()
        .map(toView)
    },

    /** 다시보기 목록: 녹화가 하나 이상 있는 종료된 방송, 종료 시각 최신순 */
    listReplays({ cursor, limit }: { cursor?: number; limit: number }): { items: ReplayView[]; nextCursor: number | null } {
      const conditions: SQL[] = [isNull(broadcasts.deletedAt), eq(broadcasts.status, 'ENDED')]
      if (cursor) {
        // 종료 시각 최신순. 커서는 이전 페이지 마지막 방송의 ID이고, 그 방송의 종료 시각 기준으로 이어 읽는다
        const at = orm.select({ endedAt: broadcasts.endedAt }).from(broadcasts).where(eq(broadcasts.id, cursor)).get()?.endedAt
        if (!at) return { items: [], nextCursor: null }
        conditions.push(or(lt(broadcasts.endedAt, at), and(eq(broadcasts.endedAt, at), lt(broadcasts.id, cursor)))!)
      }
      const rows = orm
        .select({
          ...broadcastColumns,
          recordingCount: sql<number>`count(${recordings.id})`.mapWith(Number),
          totalDurationMs: sql<number>`sum(${recordings.durationMs})`.mapWith(Number),
        })
        .from(broadcasts)
        .innerJoin(channels, eq(channels.id, broadcasts.channelId))
        .innerJoin(users, eq(users.id, channels.userId))
        .innerJoin(recordings, eq(recordings.broadcastId, broadcasts.id))
        .where(and(...conditions))
        .groupBy(broadcasts.id)
        .orderBy(desc(broadcasts.endedAt), desc(broadcasts.id))
        .limit(limit + 1)
        .all()
      const items = rows.slice(0, limit)
      return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null }
    },

    /**
     * Caddy forward_auth: 이 주소의 파일을 내보내도 되는가.
     * 등록된 세그먼트이고 방송이 삭제되지 않았을 때만 true. 변환 중인 임시 파일·미등록 파일·삭제된 방송의 영상은 막는다.
     */
    canServe(uri: string): boolean {
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(uri, 'http://x').pathname)
      } catch {
        return false
      }
      if (!pathname.startsWith(RECORDINGS_URL_PREFIX)) return false
      const relative = pathname.slice(RECORDINGS_URL_PREFIX.length)
      // 디코딩 뒤 `..%2F` 같은 우회는 RELATIVE_PATH(파일 이름에 슬래시·선행 점 금지)가 막는다.
      // normalize 비교는 RELATIVE_PATH가 느슨해질 때를 대비한 이중 방어라 지금은 단독으로 걸리는 입력이 없다
      if (!RELATIVE_PATH.test(relative) || posix.normalize(relative) !== relative) return false
      const row = orm
        .select({ id: recordings.id })
        .from(recordings)
        .innerJoin(broadcasts, eq(broadcasts.id, recordings.broadcastId))
        .where(and(eq(recordings.filePath, relative), isNull(broadcasts.deletedAt)))
        .get()
      return row !== undefined
    },
  }
}

export type RecordingService = ReturnType<typeof createRecordingService>
