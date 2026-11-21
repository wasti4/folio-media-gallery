import { open, stat } from 'node:fs/promises'
import { fileChecksum, inBatches } from './media-storage.mjs'

const HEADER_BYTES = 4096
const MAX_METADATA_BYTES = 256 * 1024
const MAX_SECTIONS = 256
const MAX_IFD_ENTRIES = 1024
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const exifSignature = Buffer.from('Exif\0\0')
const tiffTags = new Map([
  [0x0100, 'width'], [0x0101, 'height'], [0x8769, 'exifDirectory'],
  [0x9003, 'taken'], [0x9011, 'takenOffset'], [0xa002, 'pixelWidth'], [0xa003, 'pixelHeight'],
])

function dimensions(width, height) {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 ? { width, height } : {}
}

function exifTimestamp(taken, offset) {
  if (typeof taken !== 'string') return undefined
  const fields = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(taken)
  if (!fields || fields[1] === '0000') return undefined
  const [, year, month, day, time] = fields
  const iso = `${year}-${month}-${day}T${time}`
  const checked = new Date(iso + 'Z')
  if (!Number.isFinite(checked.getTime()) || !checked.toISOString().startsWith(iso)) return undefined
  const zone = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(offset) ? offset : ''
  const value = Date.parse(iso + zone)
  return Number.isFinite(value) ? value : undefined
}

async function tiffMetadata(read, start, length) {
  const at = (offset, count) => Number.isSafeInteger(offset) && offset >= 0 && offset + count <= length
    ? read(start + offset, count) : null
  const header = await at(0, 8)
  const byteOrder = header?.toString('ascii', 0, 2)
  if (byteOrder !== 'II' && byteOrder !== 'MM') return {}
  const endian = byteOrder === 'II' ? 'LE' : 'BE'
  const u16 = (buffer, offset = 0) => buffer['readUInt16' + endian](offset)
  const u32 = (buffer, offset = 0) => buffer['readUInt32' + endian](offset)
  if (u16(header, 2) !== 42) return {}

  async function directory(offset) {
    const fields = {}
    if (!Number.isInteger(offset) || offset < 8) return fields
    const countBytes = await at(offset, 2)
    const count = countBytes && u16(countBytes)
    if (!count || count > MAX_IFD_ENTRIES) return fields
    const entries = await at(offset + 2, count * 12)
    if (!entries) return fields
    for (let entry = 0; entry < entries.length; entry += 12) {
      const field = tiffTags.get(u16(entries, entry))
      if (!field) continue
      const type = u16(entries, entry + 2)
      const count = u32(entries, entry + 4)
      const value = entry + 8
      if (count === 1 && type === 3) fields[field] = u16(entries, value)
      if (count === 1 && type === 4) fields[field] = u32(entries, value)
      if (type === 2 && count > 0 && count <= 32) {
        const text = count <= 4 ? entries.subarray(value, value + count) : await at(u32(entries, value), count)
        if (text) fields[field] = text.toString('ascii').split('\0', 1)[0].trim()
      }
    }
    return fields
  }

  const image = await directory(u32(header, 4))
  const exif = await directory(image.exifDirectory)
  const capturedAt = exifTimestamp(exif.taken, exif.takenOffset ?? image.takenOffset)
    ?? exifTimestamp(image.taken, image.takenOffset)
  return {
    ...dimensions(image.width ?? exif.pixelWidth, image.height ?? exif.pixelHeight),
    ...(capturedAt === undefined ? {} : { capturedAt }),
  }
}

async function jpegMetadata(read, size) {
  let exif = {}
  let frame = {}
  let offset = 2
  for (let sections = 0; sections < MAX_SECTIONS; sections++) {
    const marker = await read(offset, 2)
    if (!marker || marker[0] !== 0xff) break
    const kind = marker[1]
    offset += kind === 0xff ? 1 : 2
    if (kind === 0xff || kind === 0x01 || (kind >= 0xd0 && kind <= 0xd7)) continue
    if (kind === 0xd9 || kind === 0xda) break
    const lengthBytes = await read(offset, 2)
    const length = lengthBytes && lengthBytes.readUInt16BE()
    if (!length || length < 2 || offset + length > size) break
    const data = offset + 2
    if (kind === 0xe1 && length >= 16 && exif.capturedAt === undefined) {
      const signature = await read(data, 6)
      if (signature?.equals(exifSignature)) exif = { ...exif, ...await tiffMetadata(read, data + 6, length - 8) }
    }
    if (!frame.width && kind >= 0xc0 && kind <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(kind) && length >= 8) {
      const header = await read(data, 5)
      if (header) frame = dimensions(header.readUInt16BE(3), header.readUInt16BE(1))
    }
    if (frame.width && exif.capturedAt !== undefined) break
    offset += length
  }
  return { ...exif, ...frame }
}

async function pngMetadata(read, size) {
  let frame = {}
  let offset = 8
  for (let sections = 0; sections < MAX_SECTIONS; sections++) {
    const section = await read(offset, 8)
    if (!section) break
    const length = section.readUInt32BE()
    const kind = section.toString('ascii', 4)
    const data = offset + 8
    const end = data + length + 4
    if (end > size || kind === 'IEND') break
    if (offset === 8 && kind === 'IHDR' && length === 13) {
      const header = await read(data, 8)
      if (header) frame = dimensions(header.readUInt32BE(0), header.readUInt32BE(4))
    }
    if (kind === 'eXIf') return { ...await tiffMetadata(read, data, length), ...frame }
    offset = end
  }
  return frame
}

async function webpMetadata(read, size, header) {
  const end = header.readUInt32LE(4) + 8
  if (end > size || end < 12) return {}
  let frame = {}
  let offset = 12
  for (let sections = 0; sections < MAX_SECTIONS && offset + 8 <= end; sections++) {
    const chunk = await read(offset, 8)
    if (!chunk) break
    const kind = chunk.toString('ascii', 0, 4)
    const length = chunk.readUInt32LE(4)
    const data = offset + 8
    offset = data + length + (length % 2)
    if (offset > end) break

    if (kind === 'VP8X' && length >= 10) {
      const canvas = await read(data, 10)
      if (canvas) {
        frame = dimensions(1 + canvas.readUIntLE(4, 3), 1 + canvas.readUIntLE(7, 3))
        if (!(canvas[0] & 8)) break
      }
    }
    if (!frame.width && kind === 'VP8 ' && length >= 10) {
      const lossy = await read(data, 10)
      if (lossy && lossy[3] === 0x9d && lossy[4] === 1 && lossy[5] === 0x2a) {
        frame = dimensions(lossy.readUInt16LE(6) & 0x3fff, lossy.readUInt16LE(8) & 0x3fff)
      }
    }
    if (!frame.width && kind === 'VP8L' && length >= 5) {
      const lossless = await read(data, 5)
      if (lossless?.[0] === 0x2f) {
        const packed = lossless.readUInt32LE(1)
        frame = dimensions(1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff))
      }
    }
    if (kind === 'EXIF' && length >= 8) {
      const prefix = await read(data, 6)
      const skip = prefix?.equals(exifSignature) ? 6 : 0
      return { ...await tiffMetadata(read, data + skip, length - skip), ...frame }
    }
  }
  return frame
}

function bmpMetadata(header) {
  if (header.length < 22) return {}
  const dib = header.readUInt32LE(14)
  if (dib === 12) return dimensions(header.readUInt16LE(18), header.readUInt16LE(20))
  if (dib >= 40 && header.length >= 26) return dimensions(header.readInt32LE(18), Math.abs(header.readInt32LE(22)))
  return {}
}

function icoMetadata(header) {
  const count = Math.min(header.readUInt16LE(4), Math.floor((header.length - 6) / 16))
  let size = 0
  let largest = {}
  for (let index = 0; index < count; index++) {
    const width = header[6 + index * 16] || 256
    const height = header[7 + index * 16] || 256
    if (width * height <= size) continue
    size = width * height
    largest = { width, height }
  }
  return largest
}

export async function readPhotoMetadata(file) {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    let header = Buffer.alloc(0)
    let budget = MAX_METADATA_BYTES
    let reads = MAX_SECTIONS * 2
    async function read(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || length <= 0 || offset + length > size) return null
      if (offset + length <= header.length) return header.subarray(offset, offset + length)
      if (length > budget || reads <= 0) return null
      const bytes = Buffer.alloc(length)
      budget -= length
      let completed = 0
      while (completed < length && reads-- > 0) {
        const { bytesRead } = await handle.read(bytes, completed, length - completed, offset + completed)
        if (!bytesRead) return null
        completed += bytesRead
      }
      return completed === length ? bytes : null
    }

    header = await read(0, Math.min(size, HEADER_BYTES))
    if (!header) return {}
    const signature = header.toString('ascii', 0, 2)
    if (header[0] === 0xff && header[1] === 0xd8) return await jpegMetadata(read, size)
    if (header.subarray(0, 8).equals(pngSignature)) return await pngMetadata(read, size)
    if (header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') {
      return await webpMetadata(read, size, header)
    }
    if (signature === 'II' || signature === 'MM') return await tiffMetadata(read, 0, size)
    if (signature === 'BM') return bmpMetadata(header)
    if (header.length >= 6 && header.readUInt32LE() === 0x00010000) return icoMetadata(header)
    return {}
  } catch {
    return {}
  } finally {
    await handle?.close().catch(() => {})
  }
}

const validLength = item => Number.isSafeInteger(item.size) && item.size >= 0

async function currentChecksum(item) {
  try {
    const before = await stat(item.file)
    if (!before.isFile() || before.size !== item.size) return null
    if (item.sha256Mtime === before.mtimeMs && /^[a-f0-9]{64}$/i.test(item.sha256 ?? '')) return item.sha256.toLowerCase()
    const hash = await fileChecksum(item.file, item.size)
    const after = await stat(item.file)
    return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino
      ? hash : null
  } catch {
    return null
  }
}

export async function findImportDuplicates(incoming, known) {
  const sizeCount = new Map()
  for (const item of incoming) {
    if (validLength(item)) sizeCount.set(item.size, (sizeCount.get(item.size) ?? 0) + 1)
  }
  const existing = known.filter(item => sizeCount.has(item.size))
  const existingSizes = new Set(existing.map(item => item.size))
  const entries = [
    ...existing.map(item => ({ item, source: 'library' })),
    ...incoming.filter(item => existingSizes.has(item.size) || sizeCount.get(item.size) > 1)
      .map(item => ({ item, source: 'import' })),
  ]
  await inBatches(entries, async entry => { entry.hash = await currentChecksum(entry.item) })

  const hashes = new Map()
  const duplicates = []
  const seen = new Map()
  for (const { item: { id, file, size }, source, hash } of entries) {
    if (!hash) continue
    hashes.set(id, hash)
    const key = size + ':' + hash
    const previous = seen.get(key)
    if (!previous) seen.set(key, { id, file, source })
    else if (source === 'import' && previous.id !== id) duplicates.push({ id, file, match: previous })
  }
  return { duplicates, hashes }
}
