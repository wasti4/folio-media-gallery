import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findImportDuplicates, readPhotoMetadata } from '../desktop/photo-catalog.mjs'

async function fixtureDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'folio-photo-catalog-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function tiff({ endian = 'LE', date = '2024:02:29 18:04:05', offset = '+08:00' } = {}) {
  const bytes = Buffer.alloc(134)
  const u16 = (value, at) => bytes['writeUInt16' + endian](value, at)
  const u32 = (value, at) => bytes['writeUInt32' + endian](value, at)
  function tag(at, id, type, count, value) {
    u16(id, at)
    u16(type, at + 2)
    u32(count, at + 4)
    u32(value, at + 8)
  }
  bytes.write(endian === 'LE' ? 'II' : 'MM')
  u16(42, 2)
  u32(8, 4)
  u16(3, 8)
  tag(10, 0x0100, 4, 1, 1000)
  tag(22, 0x0101, 4, 1, 800)
  tag(34, 0x8769, 4, 1, 50)
  u16(offset ? 2 : 1, 50)
  tag(52, 0x9003, 2, 20, 90)
  if (offset) tag(64, 0x9011, 2, 7, 110)
  bytes.write(date, 90, 'ascii')
  bytes.write(offset, 110, 'ascii')
  return bytes
}

function jpegSegment(kind, contents) {
  const start = Buffer.from([0xff, kind, 0, 0])
  start.writeUInt16BE(contents.length + 2, 2)
  return Buffer.concat([start, contents])
}

function jpeg(exif) {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  frame.writeUInt16BE(2400, 1)
  frame.writeUInt16BE(3600, 3)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0')),
    jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), exif])),
    jpegSegment(0xc2, frame),
    Buffer.from([0xff, 0xd9]),
  ])
}

test('JPEG metadata reads both EXIF byte orders and the encoded frame dimensions', async t => {
  const directory = await fixtureDirectory(t)
  for (const endian of ['LE', 'BE']) {
    const file = path.join(directory, endian + '.jpg')
    await writeFile(file, jpeg(tiff({ endian })))
    assert.deepEqual(await readPhotoMetadata(file), {
      width: 3600,
      height: 2400,
      capturedAt: Date.parse('2024-02-29T18:04:05+08:00'),
    })
  }
})

test('JPEG handles camera-local dates and malformed metadata independently of frame dimensions', async t => {
  const directory = await fixtureDirectory(t)
  const file = path.join(directory, 'camera.jpg')
  await writeFile(file, jpeg(tiff({ offset: '' })))
  assert.equal((await readPhotoMetadata(file)).capturedAt, new Date(2024, 1, 29, 18, 4, 5).getTime())

  await writeFile(file, jpeg(tiff({ date: '2023:02:29 18:04:05' })))
  assert.deepEqual(await readPhotoMetadata(file), { width: 3600, height: 2400 })

  const malformed = tiff()
  malformed.writeUInt32LE(0xffffffff, 4)
  await writeFile(file, jpeg(malformed))
  assert.deepEqual(await readPhotoMetadata(file), { width: 3600, height: 2400 })

  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))
  assert.deepEqual(await readPhotoMetadata(file), {})
  assert.deepEqual(await readPhotoMetadata(path.join(directory, 'missing.jpg')), {})
})

function webpChunk(name, contents) {
  const header = Buffer.alloc(8)
  header.write(name)
  header.writeUInt32LE(contents.length, 4)
  return Buffer.concat([header, contents, Buffer.alloc(contents.length % 2)])
}

test('WebP skips large image data to read trailing EXIF without decoding', async t => {
  const directory = await fixtureDirectory(t)
  const file = path.join(directory, 'encoded.webp')
  const canvas = Buffer.alloc(10)
  canvas[0] = 8
  canvas.writeUIntLE(511, 4, 3)
  canvas.writeUIntLE(359, 7, 3)
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    webpChunk('VP8X', canvas),
    webpChunk('VP8L', Buffer.alloc(300001)),
    webpChunk('EXIF', tiff()),
  ])
  const header = Buffer.from('RIFF\0\0\0\0')
  header.writeUInt32LE(body.length, 4)
  await writeFile(file, Buffer.concat([header, body]))
  assert.deepEqual(await readPhotoMetadata(file), {
    width: 512,
    height: 360,
    capturedAt: Date.parse('2024-02-29T18:04:05+08:00'),
  })
})

test('standalone TIFF supplies dimensions and capture date', async t => {
  const directory = await fixtureDirectory(t)
  const file = path.join(directory, 'encoded.tif')
  await writeFile(file, tiff())
  assert.deepEqual(await readPhotoMetadata(file), {
    width: 1000,
    height: 800,
    capturedAt: Date.parse('2024-02-29T18:04:05+08:00'),
  })
})

test('exact duplicates compare bytes across nested folders and favor an existing library match', async t => {
  const directory = await fixtureDirectory(t)
  const catalog = path.join(directory, 'catalog')
  const source = path.join(directory, 'source', 'nested')
  await mkdir(catalog)
  await mkdir(source, { recursive: true })
  async function file(folder, id, contents) {
    const filename = path.join(folder, id + '.jpg')
    await writeFile(filename, contents)
    return { id, file: filename, size: Buffer.byteLength(contents) }
  }
  const original = await file(catalog, 'original', 'identical image')
  const copy = await file(source, 'copy', 'identical image')
  const differentBytes = await file(source, 'same-size', 'different image')
  const first = await file(directory, 'first', 'other image')
  const second = await file(source, 'second', 'other image')
  const unique = await file(source, 'unique', 'unique')
  const missing = { id: 'missing', file: path.join(source, 'missing.jpg'), size: copy.size }

  const result = await findImportDuplicates([copy, differentBytes, first, second, unique, missing], [original])
  assert.deepEqual(result.duplicates, [
    { id: copy.id, file: copy.file, match: { id: original.id, file: original.file, source: 'library' } },
    { id: second.id, file: second.file, match: { id: first.id, file: first.file, source: 'import' } },
  ])
  assert.equal(result.hashes.get(original.id), createHash('sha256').update('identical image').digest('hex'))
  assert.equal(result.hashes.get(copy.id), result.hashes.get(original.id))
  assert.notEqual(result.hashes.get(differentBytes.id), result.hashes.get(original.id))
  assert.equal(result.hashes.has(unique.id), false)
  assert.equal(result.hashes.has(missing.id), false)
})

test('duplicate lookup ignores a stale cached checksum', async t => {
  const directory = await fixtureDirectory(t)
  const original = path.join(directory, 'original.jpg')
  const incoming = path.join(directory, 'incoming.jpg')
  await Promise.all([writeFile(original, 'changed!'), writeFile(incoming, 'old data')])
  const { mtimeMs } = await stat(original)
  const savedHash = createHash('sha256').update('old data').digest('hex')
  const { duplicates, hashes } = await findImportDuplicates(
    [{ id: 'incoming', file: incoming, size: 8 }],
    [{ id: 'original', file: original, size: 8, sha256: savedHash, sha256Mtime: mtimeMs - 1000 }],
  )
  assert.deepEqual(duplicates, [])
  assert.equal(hashes.get('incoming'), savedHash)
  assert.equal(hashes.get('original'), createHash('sha256').update('changed!').digest('hex'))
})
