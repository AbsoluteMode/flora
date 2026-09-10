import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { validateRelativePath } from './safe-path'

/**
 * A small zip writer and reader — enough for a workflow bundle, nothing more.
 *
 * Zip rather than a bespoke format because a bundle travels through chats and
 * mail, and the person on the other end may want to look inside before they
 * trust it: every desktop opens a zip. Names are UTF-8 (flag 0x800), entries
 * are deflated when that saves bytes and stored otherwise, and every entry's
 * CRC is checked on the way back in. No zip64: a bundle is small by design.
 */
export interface ZipEntry {
  name: string
  data: Buffer
  mtime?: Date
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const UTF8 = 0x0800
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024

export function writeZip(entries: ZipEntry[]): Buffer {
  if (entries.length > 4096 || entries.some((e) => e.data.length > 32 * 1024 * 1024) || entries.reduce((sum, e) => sum + e.data.length, 0) > MAX_ARCHIVE_BYTES) throw new Error('zip exceeds the size or entry count limit')
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.data)
    const method = deflated.length < entry.data.length ? 8 : 0
    const body = method === 8 ? deflated : entry.data
    const checksum = crc32(entry.data)
    const [time, date] = dosTime(entry.mtime ?? new Date())

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, end])
}

export interface ZipLimits { maxEntryBytes?: number; maxTotalBytes?: number; maxEntries?: number }

export function readZip(archive: Buffer, limits: ZipLimits = {}): ZipEntry[] {
  const maxEntry = limits.maxEntryBytes ?? 32 * 1024 * 1024
  const maxTotal = limits.maxTotalBytes ?? MAX_ARCHIVE_BYTES
  const maxEntries = limits.maxEntries ?? 4096
  if (archive.length > maxTotal) throw new Error('zip exceeds the archive size limit')
  const bounds = (at: number, bytes: number): void => {
    if (at < 0 || bytes < 0 || at + bytes > archive.length) throw new Error('corrupt zip: truncated entry')
  }
  // The end record sits in the last 64 KiB (a comment may follow it).
  let endAt = -1
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65_557); i--) {
    if (archive.readUInt32LE(i) === END) {
      endAt = i
      break
    }
  }
  if (endAt < 0) throw new Error('not a zip file (no end-of-central-directory record)')
  const count = archive.readUInt16LE(endAt + 10)
  if (count > maxEntries) throw new Error('zip exceeds the entry count limit')
  let at = archive.readUInt32LE(endAt + 16)
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let total = 0
  for (let n = 0; n < count; n++) {
    bounds(at, 46)
    if (archive.readUInt32LE(at) !== CENTRAL) throw new Error('corrupt zip: bad central directory entry')
    const method = archive.readUInt16LE(at + 10)
    const time = archive.readUInt16LE(at + 12)
    const date = archive.readUInt16LE(at + 14)
    const checksum = archive.readUInt32LE(at + 16)
    const compressed = archive.readUInt32LE(at + 20)
    const size = archive.readUInt32LE(at + 24)
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    const localAt = archive.readUInt32LE(at + 42)
    bounds(at + 46, nameLength + extraLength + commentLength)
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    validateRelativePath(name)
    const key = name.normalize('NFC').toLowerCase()
    if (names.has(key)) throw new Error(`duplicate zip path: ${name}`)
    names.add(key)
    if (size > maxEntry || size > maxTotal - total) throw new Error('zip exceeds the decompressed size limit')
    total += size
    at += 46 + nameLength + extraLength + commentLength

    bounds(localAt, 30)
    if (archive.readUInt32LE(localAt) !== LOCAL) throw new Error(`corrupt zip: bad local header for ${name}`)
    const dataAt = localAt + 30 + archive.readUInt16LE(localAt + 26) + archive.readUInt16LE(localAt + 28)
    bounds(dataAt, compressed)
    const body = archive.subarray(dataAt, dataAt + compressed)
    let data: Buffer
    if (method === 0) data = Buffer.from(body)
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: Math.max(1, size) })
    else throw new Error(`unsupported zip compression method ${method} for ${name}`)
    if (data.length !== size || crc32(data) !== checksum) throw new Error(`corrupt zip: ${name} does not match its checksum`)
    entries.push({ name, data, mtime: fromDosTime(time, date) })
  }
  return entries
}

function dosTime(d: Date): [number, number] {
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return [time, date]
}

function fromDosTime(time: number, date: number): Date {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2)
}
