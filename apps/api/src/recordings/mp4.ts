// mp4 파일의 재생 길이를 박스(atom) 헤더만 읽어 구한다 (#12 녹화 복구 스캔용).
// api 이미지에는 ffprobe가 없고, 1GB 서버에서 파일 전체를 읽을 수도 없어서 필요한 박스만 읽는다.
//
// - 일반 mp4(웹용 변환본, +faststart): moov/mvhd의 duration / timescale
// - fragmented mp4(MediaMTX 원본): mvhd duration이 0이므로 트랙별로
//   (마지막 moof의 tfdt + trun 샘플 길이 합) − (첫 moof의 tfdt) 를 mdhd timescale로 나눈다
// 박스 구조: ISO/IEC 14496-12 (ISO BMFF). 필드 오프셋은 각 박스의 version 0/1 구분을 따른다.

import { open } from 'node:fs/promises'

type Range = { type: string; start: number; end: number }

// moov·moof 하나가 이보다 크면 비정상 파일로 본다 (보통 수 KB~수백 KB)
const MAX_META_BOX = 16 * 1024 * 1024
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'mvex', 'moof', 'traf'])

/** buf[start, end) 안의 자식 박스들 (내용 범위) */
function* children(buf: Buffer, start: number, end: number): Generator<Range> {
  let pos = start
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let header = 8
    if (size === 1) {
      if (pos + 16 > end) return
      size = Number(buf.readBigUInt64BE(pos + 8))
      header = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < header || pos + size > end) return
    yield { type, start: pos + header, end: pos + size }
    pos += size
  }
}

const readU64 = (buf: Buffer, at: number) => Number(buf.readBigUInt64BE(at))

type TrackSpan = { start: number; end: number }

export type Mp4Info = {
  movie: { timescale: number; duration: number } | null
  timescales: Map<number, number>
  defaultDurations: Map<number, number>
  spans: Map<number, TrackSpan>
}

function parseMeta(buf: Buffer, start: number, end: number, info: Mp4Info, trackId: number | null = null) {
  for (const box of children(buf, start, end)) {
    const { type, start: s, end: e } = box
    if (type === 'trak') {
      // tkhd가 mdia보다 앞에 있으므로 먼저 track_ID를 찾아 넘긴다
      let id: number | null = null
      for (const c of children(buf, s, e)) {
        if (c.type === 'tkhd') id = buf[c.start] === 1 ? buf.readUInt32BE(c.start + 20) : buf.readUInt32BE(c.start + 12)
      }
      parseMeta(buf, s, e, info, id)
    } else if (type === 'traf') {
      parseTraf(buf, s, e, info)
    } else if (CONTAINERS.has(type)) {
      parseMeta(buf, s, e, info, trackId)
    } else if (type === 'mvhd') {
      const v1 = buf[s] === 1
      info.movie = v1
        ? { timescale: buf.readUInt32BE(s + 20), duration: readU64(buf, s + 24) }
        : { timescale: buf.readUInt32BE(s + 12), duration: buf.readUInt32BE(s + 16) }
    } else if (type === 'mdhd' && trackId !== null) {
      info.timescales.set(trackId, buf[s] === 1 ? buf.readUInt32BE(s + 20) : buf.readUInt32BE(s + 12))
    } else if (type === 'trex') {
      info.defaultDurations.set(buf.readUInt32BE(s + 4), buf.readUInt32BE(s + 12))
    }
  }
}

function parseTraf(buf: Buffer, start: number, end: number, info: Mp4Info) {
  let trackId: number | null = null
  let defaultDuration: number | undefined
  let base: number | null = null
  let total = 0
  for (const { type, start: s } of children(buf, start, end)) {
    if (type === 'tfhd') {
      const flags = buf.readUIntBE(s + 1, 3)
      trackId = buf.readUInt32BE(s + 4)
      let pos = s + 8
      if (flags & 0x1) pos += 8 // base_data_offset
      if (flags & 0x2) pos += 4 // sample_description_index
      defaultDuration = flags & 0x8 ? buf.readUInt32BE(pos) : info.defaultDurations.get(trackId)
    } else if (type === 'tfdt') {
      base = buf[s] === 1 ? readU64(buf, s + 4) : buf.readUInt32BE(s + 4)
    } else if (type === 'trun') {
      const flags = buf.readUIntBE(s + 1, 3)
      const count = buf.readUInt32BE(s + 4)
      let pos = s + 8
      if (flags & 0x1) pos += 4 // data_offset
      if (flags & 0x4) pos += 4 // first_sample_flags
      if (!(flags & 0x100)) {
        total += count * (defaultDuration ?? 0)
        continue
      }
      const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length
      for (let i = 0; i < count; i++) total += buf.readUInt32BE(pos + i * stride)
    }
  }
  if (trackId === null || base === null) return
  const span = info.spans.get(trackId)
  if (span) {
    span.start = Math.min(span.start, base)
    span.end = Math.max(span.end, base + total)
  } else {
    info.spans.set(trackId, { start: base, end: base + total })
  }
}

/** 박스 정보에서 길이(ms)를 구한다. 구할 수 없으면 null */
export function durationFromInfo(info: Mp4Info): number | null {
  if (info.movie && info.movie.timescale > 0 && info.movie.duration > 0) {
    return Math.round((info.movie.duration / info.movie.timescale) * 1000)
  }
  let best = 0
  for (const [id, span] of info.spans) {
    const ts = info.timescales.get(id)
    if (ts) best = Math.max(best, ((span.end - span.start) / ts) * 1000)
  }
  return best > 0 ? Math.round(best) : null
}

/** mp4 파일의 길이(ms). mp4가 아니거나 길이를 알 수 없으면 null */
export async function mp4DurationMs(file: string): Promise<number | null> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const info: Mp4Info = { movie: null, timescales: new Map(), defaultDurations: new Map(), spans: new Map() }
    const header = Buffer.alloc(16)
    let pos = 0
    while (pos + 8 <= size) {
      await fh.read(header, 0, 16, pos)
      let boxSize = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      let headerSize = 8
      if (boxSize === 1) {
        boxSize = Number(header.readBigUInt64BE(8))
        headerSize = 16
      } else if (boxSize === 0) {
        boxSize = size - pos
      }
      if (boxSize < headerSize || pos + boxSize > size) break
      if (type === 'moov' || type === 'moof') {
        if (boxSize > MAX_META_BOX) return null
        const buf = Buffer.alloc(boxSize)
        await fh.read(buf, 0, boxSize, pos)
        parseMeta(buf, 0, boxSize, info)
      }
      pos += boxSize
    }
    return durationFromInfo(info)
  } catch {
    return null
  } finally {
    await fh.close()
  }
}
