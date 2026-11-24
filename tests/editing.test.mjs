import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { MediaEditor } from '../desktop/editing.mjs'
import { Library } from '../desktop/library.mjs'
import { Playback } from '../desktop/playback.mjs'

const exec = promisify(execFile)

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'folio-edit-test-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }))
  const library = await Library.open(path.join(root, 'Library', 'library.json'))
  const playback = new Playback(library, path.join(root, 'cache'))
  return { root, library, playback, editor: new MediaEditor(library, playback, root) }
}

test('an edited photo is a cropped, rotated copy with alpha and the original remains byte-for-byte intact', async t => {
  const { root, library, playback, editor } = await setup(t)
  const source = path.join(root, 'Photo.png')
  await exec(playback.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=gray@0.5:s=80x48,format=rgba',
    '-frames:v', '1', '-update', '1', source])
  await library.importPaths([source])
  const [original] = library.snapshot().items
  const before = await readFile(library.file(original.id).file)
  const id = await editor.save(original.id, {
    crop: { x: 0.25, y: 0, width: 0.5, height: 0.5 }, rotation: 1, brightness: 30, sharpness: 35,
  })
  const edited = library.file(id)
  assert.notEqual(id, original.id)
  assert.equal(edited.folderId, original.folderId)
  const meta = await playback.metadata(edited)
  assert.deepEqual([meta.streams[0].width, meta.streams[0].height, meta.streams[0].pix_fmt], [24, 40, 'rgba'])
  const { stdout } = await exec(playback.ffmpeg, ['-v', 'error', '-i', edited.file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer' })
  assert.ok(stdout[0] > 148 && stdout[3] >= 125 && stdout[3] <= 130)
  assert.deepEqual(await readFile(library.file(original.id).file), before)
  assert.equal((await Library.open(library.indexFile)).snapshot().items.length, 2)
})

test('a trimmed and cropped video exports H.264 with its embedded audio and the requested duration', async t => {
  const { root, library, playback, editor } = await setup(t)
  const source = path.join(root, 'Sequence.mp4')
  await copyFile('public/demo/dolomites.mp4', source)
  await library.importPaths([source])
  const [original] = library.snapshot().items
  const edited = library.file(await editor.save(original.id, {
    start: 2, end: 4.5, crop: { x: 0, y: 0, width: 0.5, height: 0.5 }, contrast: 12, saturation: -21,
  }))
  const meta = await playback.metadata(edited)
  const sourceMeta = await playback.metadata(library.file(original.id))
  assert.equal(meta.streams[0].codec_name, 'h264')
  assert.equal(meta.streams[0].width, Math.ceil(Math.floor(sourceMeta.streams[0].width / 2) / 2) * 2)
  assert.ok(Math.abs(Number(meta.format.duration) - 2.5) < 0.16)
  assert.ok(meta.streams.some(stream => stream.codec_type === 'audio'))
})

test('wallpaper preparation keeps a Windows-compatible image in the user profile without writing system settings', async t => {
  const { root, library, playback, editor } = await setup(t)
  const source = path.join(root, 'Coast.jpg')
  await copyFile('public/demo/shore.jpg', source)
  await library.importPaths([source])
  const [photo] = library.snapshot().items
  const wallpaper = await editor.prepareWallpaper(photo.id)
  assert.equal(path.dirname(wallpaper), path.join(root, 'Wallpapers'))
  assert.equal((await readFile(wallpaper)).subarray(0, 2).toString(), 'BM')
  const meta = await playback.metadata({ file: wallpaper })
  assert.equal(meta.streams[0].codec_name, 'bmp')
  assert.equal(library.snapshot().items.length, 1)
})

test('photo export mirrors the source before applying the crop and includes the new color controls', async t => {
  const { root, library, playback, editor } = await setup(t)
  const source = path.join(root, 'Swatches.png')
  await exec(playback.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
    'color=c=0xAA3322:s=32x16,format=rgba,drawbox=x=16:y=0:w=16:h=16:color=0x4C6688:t=fill',
    '-frames:v', '1', '-update', '1', source])
  await library.importPaths([source])
  const [photo] = library.snapshot().items
  const variant = async input => {
    const id = await editor.save(photo.id, { ...input, crop: { x: 0, y: 0, width: .5, height: 1 } })
    const { stdout } = await exec(playback.ffmpeg, ['-v', 'error', '-i', library.file(id).file, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer' })
    return stdout
  }
  const neutral = await variant({ flipX: true })
  assert.equal(neutral.length, 16 * 16 * 4)
  assert.ok(neutral[2] > neutral[0] + 45, 'the left crop of the mirrored photo should be the original blue right half')
  const tone = { flipX: true, exposure: 20, shadows: 15, highlights: -9 }
  const unheated = await variant(tone)
  const adjusted = await variant({ ...tone, warmth: 35 })
  assert.ok(adjusted[0] > neutral[0] + 20)
  assert.ok(adjusted[0] > unheated[0] + 3 && adjusted[2] < unheated[2] - 3)
  assert.equal(adjusted[3], 255)
})

test('a batch edit saves a rotated, toned copy of every selected photo and leaves framing alone', async t => {
  const { root, library, playback, editor } = await setup(t)
  for (const [name, size] of [['Wide.png', '40x20'], ['Tall.png', '20x30']]) {
    await exec(playback.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x806040:s=' + size + ',format=rgba',
      '-frames:v', '1', '-update', '1', path.join(root, name)])
  }
  await copyFile('public/demo/dolomites.mp4', path.join(root, 'Clip.mp4'))
  await library.importPaths([path.join(root, 'Wide.png'), path.join(root, 'Tall.png'), path.join(root, 'Clip.mp4')])
  const items = library.snapshot().items
  const originals = new Map(await Promise.all(items.map(async item => [item.id, await readFile(library.file(item.id).file)])))
  const steps = []
  const result = await editor.saveMany(items.map(item => item.id), {
    rotation: 1, saturation: -100, crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  }, (done, total) => steps.push([done, total]))
  assert.equal(result.total, 2, 'videos are not part of a photo batch')
  assert.equal(result.saved.length, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.canceled, false)
  assert.deepEqual(steps, [[0, 2], [1, 2], [2, 2]])
  const sizes = await Promise.all(result.saved.map(async id => {
    const meta = await playback.metadata(library.file(id))
    return meta.streams[0].width + 'x' + meta.streams[0].height
  }))
  assert.deepEqual(sizes.sort(), ['20x40', '30x20'], 'each copy is rotated as a whole, without the crop')
  const { stdout } = await exec(playback.ffmpeg, ['-v', 'error', '-i', library.file(result.saved[0]).file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer' })
  assert.ok(Math.abs(stdout[0] - stdout[2]) <= 2, 'the copy is desaturated')
  for (const [id, bytes] of originals) assert.deepEqual(await readFile(library.file(id).file), bytes)
  await assert.rejects(editor.saveMany(items.map(item => item.id), { crop: { x: 0.2, y: 0, width: 0.5, height: 1 } }), /Нет правок/)
  await assert.rejects(editor.saveMany([items.find(item => item.kind === 'video').id], { contrast: 10 }), /Выберите фотографии/)
})

test('canceling a batch edit stops after the photo being saved', async t => {
  const { root, library, playback, editor } = await setup(t)
  const files = ['One.png', 'Two.png', 'Three.png'].map(name => path.join(root, name))
  for (const file of files) {
    await exec(playback.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x336699:s=16x16', '-frames:v', '1', '-update', '1', file])
  }
  await library.importPaths(files)
  const ids = library.snapshot().items.map(item => item.id)
  const result = await editor.saveMany(ids, { contrast: 20 }, done => { if (done === 1) editor.cancelSave() })
  assert.equal(result.canceled, true)
  assert.equal(result.saved.length, 1)
  assert.equal(library.snapshot().items.length, 4)
  assert.equal(editor.batch, null)
})
