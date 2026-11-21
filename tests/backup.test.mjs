import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Library } from '../desktop/library.mjs'

async function setup(t) {
  const temp = await mkdtemp(path.join(tmpdir(), 'folio-backup-'))
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4 }))
  const album = path.join(temp, 'Семейный альбом')
  const output = path.join(temp, 'Экспорт')
  await Promise.all([mkdir(album), mkdir(output)])
  const photo = path.join(album, 'У моря.jpg')
  const video = path.join(album, 'Прогулка.mkv')
  const track = path.join(temp, 'Отдельный звук.flac')
  await Promise.all([[photo, 'original photo'], [video, 'original movie'], [track, 'original sound']].map(([file, bytes]) => writeFile(file, bytes)))
  const library = await Library.open(path.join(temp, 'profile', 'library.json'))
  return { temp, album, output, photo, video, track, library }
}

test('a relocated backup restores originals, attached sound and gallery metadata without duplicating items', async t => {
  const { temp, library, output, album, photo, video, track } = await setup(t)
  await library.importPaths([album, photo])
  const before = library.snapshot()
  const picture = before.items.find(item => item.kind === 'photo')
  const movie = before.items.find(item => item.kind === 'video')
  const captions = path.join(temp, 'Субтитры.srt')
  await writeFile(captions, '1\n00:00:00,000 --> 00:00:01,000\nHello\n')
  await library.rememberTracks(movie.id, [track, captions])
  const { id: collectionId } = await library.createCollection('На память')
  await library.toggleCollection(collectionId, picture.id)
  await library.toggleFavorite(picture.id)
  const viewed = library.markOpened(picture.id)
  await Promise.all([rm(photo), rm(video), rm(track), rm(captions)])

  const backup = await library.exportBackup(output)
  assert.equal(backup.count, 2)
  const moved = path.join(temp, 'С другого диска')
  await rename(backup.directory, moved)
  const manifest = await readFile(path.join(moved, 'folio-library.json'), 'utf8')
  assert.ok(!manifest.includes('original photo'))
  assert.ok(!manifest.includes(JSON.stringify(temp).slice(1, -1)))

  const restored = await Library.open(path.join(temp, 'another-profile', 'library.json'))
  assert.equal((await restored.restoreBackup(moved)).added, 2)
  const restoredPhoto = restored.snapshot().items.find(item => item.kind === 'photo')
  assert.equal(restoredPhoto.favorite, true)
  assert.equal(restoredPhoto.openedAt, viewed)
  assert.equal(restoredPhoto.folderName, 'Семейный альбом')
  assert.deepEqual(restored.snapshot().folders.find(folder => folder.id === collectionId).members, [restoredPhoto.id])
  assert.equal(await readFile(restored.file(picture.id).file, 'utf8'), 'original photo')
  assert.equal(await readFile(restored.externalTracks(movie.id)[0], 'utf8'), 'original sound')
  assert.match(await readFile(restored.externalTracks(movie.id)[1], 'utf8'), /Hello/)
  const secondItem = path.join(temp, 'Отдельный кадр.jpg')
  await writeFile(secondItem, 'other photo')
  await restored.importPaths([secondItem])
  assert.equal((await restored.restoreBackup(moved)).added, 0)
  assert.equal(restored.snapshot().items.length, 3)
  assert.equal(restored.snapshot().folders.filter(folder => folder.id === collectionId).length, 1)
})

test('migrating a linked index retains identifiers, and retries an unavailable original', async t => {
  const { library, output, temp, photo, video, album } = await setup(t)
  const id = 'a'.repeat(32)
  const missing = 'b'.repeat(32)
  const folderId = 'folder-' + 'c'.repeat(32)
  const legacy = path.join(temp, 'old-library.json')
  const metadata = await stat(photo)
  await writeFile(legacy, JSON.stringify({
    version: 1, theme: 'light',
    loose: [id, missing],
    items: {
      [id]: { id, file: photo, filename: 'У моря.jpg', name: 'У моря', ext: 'jpg', kind: 'photo', folderId, folderName: path.basename(album), size: metadata.size, modifiedAt: metadata.mtimeMs },
      [missing]: { id: missing, file: video, filename: 'Прогулка.mkv', name: 'Прогулка', ext: 'mkv', kind: 'video', folderId, folderName: path.basename(album), size: 14, modifiedAt: metadata.mtimeMs },
    },
    favorites: { [id]: true },
  }))
  await rename(video, video + '.offline')
  const upgraded = await Library.open(library.indexFile, '', legacy)
  assert.equal(upgraded.theme, 'light')
  assert.equal(upgraded.snapshot().linked, 2)
  assert.deepEqual(await upgraded.migrate(), { copied: 1, skipped: 1 })
  assert.equal(upgraded.snapshot().items.find(item => item.id === id).favorite, true)
  assert.equal(upgraded.snapshot().linked, 1)
  await assert.rejects(upgraded.exportBackup(output), /недоступ|подключ/i)
  assert.deepEqual(await readdir(output), [])
  await rename(video + '.offline', video)
  assert.equal((await upgraded.migrate()).copied, 1)
  await rm(photo)
  assert.equal(await readFile(upgraded.file(id).file, 'utf8'), 'original photo')
  assert.equal(upgraded.snapshot().linked, 0)
})

test('a backup with changed bytes is rejected even when the file has the expected size', async t => {
  const { temp, library, album, output, photo } = await setup(t)
  await library.importPaths([album])
  const { directory } = await library.exportBackup(output)
  const manifest = JSON.parse(await readFile(path.join(directory, 'folio-library.json'), 'utf8'))
  const damaged = path.join(directory, 'Media', ...manifest.items.at(-1).stored.split('/'))
  const bytes = await readFile(damaged)
  bytes[0] ^= 0xff
  await writeFile(damaged, bytes)
  const destination = await Library.open(path.join(temp, 'empty', 'library.json'))
  await destination.importPaths([photo])
  const previous = destination.snapshot()
  await assert.rejects(destination.restoreBackup(directory))
  assert.deepEqual(destination.snapshot(), previous)
  await writeFile(damaged, 'x')
  await assert.rejects(destination.restoreBackup(directory))
  assert.deepEqual(destination.snapshot(), previous)
})

test('legacy backups still restore, but a same-size collision with a local file fails', async t => {
  const { temp, library, album, output } = await setup(t)
  await library.importPaths([album])
  const { directory } = await library.exportBackup(output)
  const index = path.join(directory, 'folio-library.json')
  const manifest = JSON.parse(await readFile(index, 'utf8'))
  manifest.version = 1
  for (const item of manifest.items) delete item.sha256
  await writeFile(index, JSON.stringify(manifest))

  const destination = await Library.open(path.join(temp, 'legacy-restore', 'library.json'))
  assert.equal((await destination.restoreBackup(directory)).added, 2)
  const file = destination.file(manifest.items[0].id).file
  const original = await readFile(file)
  const different = Buffer.from(original)
  different[0] ^= 0xff
  await writeFile(file, different)
  await assert.rejects(destination.restoreBackup(directory))
  assert.deepEqual(await readFile(file), different)
  assert.equal(destination.snapshot().items.length, 2)
})

test('deleting a library photo preserves the source and an earlier backup restores the photo and its metadata', async t => {
  const { library, album, photo, video, output, temp } = await setup(t)
  await rm(video)
  await library.importPaths([album, photo])
  const { id } = library.snapshot().items[0]
  const { id: collection } = await library.createCollection('Фото')
  await library.toggleCollection(collection, id)
  await library.toggleFavorite(id)
  library.markOpened(id)
  const { directory: backup } = await library.exportBackup(output)
  library.markOpened(id)
  const recycled = path.join(temp, 'recycled.jpg')
  const managed = library.file(id).file
  assert.equal((await library.removePhoto(id, file => rename(file, recycled))).removed, true)
  assert.equal(await readFile(recycled, 'utf8'), 'original photo')
  assert.equal(await readFile(photo, 'utf8'), 'original photo')
  await assert.rejects(stat(managed), { code: 'ENOENT' })
  await library.flushRecent()
  await library.refresh()
  const reopened = await Library.open(library.indexFile)
  assert.equal(reopened.snapshot().demo, false)
  assert.deepEqual(reopened.snapshot().items, [])
  assert.deepEqual(reopened.snapshot().folders.find(folder => folder.id === collection).members, [])
  assert.equal(reopened.state.recent[id], undefined)
  assert.equal(reopened.state.favorites[id], undefined)

  assert.equal((await reopened.restoreBackup(backup)).added, 1)
  assert.equal(reopened.snapshot().items[0].favorite, true)
  assert.deepEqual(reopened.snapshot().folders.find(folder => folder.id === collection).members, [id])
  assert.equal(await readFile(reopened.file(id).file, 'utf8'), 'original photo')
  assert.equal((await reopened.restoreBackup(backup)).added, 0)
  assert.equal((await reopened.removePhoto(id, file => rename(file, path.join(temp, 'second-recycled.jpg')))).removed, true)
  await reopened.refresh()
  assert.equal(reopened.snapshot().items.length, 0)
  assert.equal((await reopened.importPaths([album])).added, 1)
})

test('restoring a photo while its previous copy is being recycled leaves a readable file', async t => {
  const { library, photo, output, temp } = await setup(t)
  await library.importPaths([photo])
  const { id } = library.snapshot().items[0]
  const { directory } = await library.exportBackup(output)
  const trashStarted = Promise.withResolvers()
  const trashReady = Promise.withResolvers()
  const removal = library.removePhoto(id, async file => {
    trashStarted.resolve()
    await trashReady.promise
    await rename(file, path.join(temp, 'recycled.jpg'))
  })
  await trashStarted.promise
  const restore = library.restoreBackup(directory)
  try {
    await Promise.race([restore, new Promise(resolve => setTimeout(resolve, 100))])
  } finally {
    trashReady.resolve()
  }
  await removal
  await restore
  assert.equal(await readFile(library.file(id).file, 'utf8'), 'original photo')
})
