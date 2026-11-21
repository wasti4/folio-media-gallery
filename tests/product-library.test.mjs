import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Library } from '../desktop/library.mjs'

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(path.join(base, 'folio-product-'))
  t.after(async () => {
    if (path.dirname(root) === base && await realpath(root).catch(() => null) === root) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
    }
  })
  const source = path.join(root, 'source')
  const destination = path.join(root, 'new library')
  const backups = path.join(root, 'backups')
  await Promise.all([source, destination, backups].map(folder => mkdir(folder)))
  const photo = path.join(source, 'Кадр.jpg')
  const video = path.join(source, 'Море.mp4')
  const audio = path.join(source, 'Море.ru.flac')
  await Promise.all([[photo, 'first image'], [video, 'video bytes'], [audio, 'external sound']].map(([file, contents]) => writeFile(file, contents)))
  const profile = path.join(root, 'profile', 'library.json')
  const library = await Library.open(profile)
  await library.importPaths([source])
  return { root, source, destination, backups, photo, video, profile, library,
    photoId: library.snapshot().items.find(item => item.kind === 'photo').id,
    videoId: library.snapshot().items.find(item => item.kind === 'video').id }
}

test('relocation verifies and moves active, deleted and attached media across the stable profile pointer', async t => {
  const { library, photoId, videoId, destination, profile, photo, root } = await fixture(t)
  const old = library.file(photoId).file
  await library.setPreferences({ language: 'zh-CN' })
  await library.softDeletePhotos([photoId])
  const progress = []
  assert.equal((await library.moveTo(destination, (done, total) => progress.push([done, total]))).directory, destination)
  assert.deepEqual(progress.at(-1), [3, 3])
  assert.equal(await readFile(photo, 'utf8'), 'first image')
  await assert.rejects(readFile(old), { code: 'ENOENT' })
  const reopened = await Library.open(profile)
  assert.equal(reopened.language, 'zh-CN')
  assert.equal(path.dirname(reopened.indexFile), destination)
  assert.equal(await readFile(reopened.externalTracks(videoId)[0], 'utf8'), 'external sound')
  assert.equal(reopened.snapshot().deleted.length, 1)
  await reopened.restoreDeletedPhotos([photoId])
  assert.equal(await readFile(reopened.file(photoId).file, 'utf8'), 'first image')
  assert.ok(reopened.file(photoId).file.startsWith(destination + path.sep))
  const previews = path.join(root, 'preview cache')
  await mkdir(previews)
  await writeFile(path.join(previews, 'thumbnail.jpg'), 'thumb')
  const info = await reopened.storageInfo(previews)
  assert.equal(info.directory, destination)
  assert.equal(info.cacheBytes, 5)
  assert.ok(info.mediaBytes >= 30)
})

test('a missing managed original makes relocation fail without redirecting the active index', async t => {
  const { library, photoId, videoId, destination, profile } = await fixture(t)
  const oldVideo = library.file(videoId).file
  await rm(library.file(photoId).file)
  await assert.rejects(library.moveTo(destination))
  await assert.rejects(readFile(path.join(destination, 'library.json')), { code: 'ENOENT' })
  const reopened = await Library.open(profile)
  assert.equal(reopened.indexFile, profile)
  assert.equal(reopened.file(videoId).file, oldVideo)
  assert.equal(await readFile(oldVideo, 'utf8'), 'video bytes')
})

test('a move can be undone after restart and leaves unrelated library changes in place', async t => {
  const { library, photoId, profile } = await fixture(t)
  const originalFolder = library.file(photoId).folderId
  const moved = await library.organizePhotos([photoId], { name: 'Из поездки' })
  assert.equal(library.file(photoId).folderId, moved.folder.id)
  assert.equal(library.snapshot().canUndo, true)
  await library.toggleFavorite(photoId)
  const reopened = await Library.open(profile)
  assert.equal((await reopened.undoOrganize()).count, 1)
  assert.equal(reopened.file(photoId).folderId, originalFolder)
  assert.equal(reopened.snapshot().items.find(item => item.id === photoId).favorite, true)
  assert.equal(reopened.snapshot().canUndo, false)
  assert.ok(!reopened.snapshot().folders.some(folder => folder.id === moved.folder.id))
})

test('recently deleted photos survive verification and restoration from a backup with their memberships', async t => {
  const { library, photoId, backups, profile, root, source } = await fixture(t)
  const group = await library.createCollection('Воспоминания')
  await library.toggleCollection(group.id, photoId)
  await library.toggleFavorite(photoId)
  const actual = library.file(photoId).file
  assert.deepEqual((await library.softDeletePhotos([photoId])).removedIds, [photoId])
  assert.equal(library.file(photoId), null)
  assert.equal(await readFile(actual, 'utf8'), 'first image')
  await library.refresh()
  await library.importPaths([source])
  assert.equal(library.file(photoId), null)
  const backup = await library.exportBackup(backups)
  const portable = await Library.open(path.join(root, 'portable', 'library.json'))
  await portable.restoreBackup(backup.directory)
  assert.equal(portable.snapshot().deleted[0].id, photoId)
  assert.equal((await portable.restoreDeletedPhotos([photoId])).count, 1)
  assert.equal(portable.snapshot().items.find(item => item.id === photoId).favorite, true)
  assert.deepEqual(portable.snapshot().folders.find(folder => folder.id === group.id).members, [photoId])
  assert.equal(await readFile(portable.file(photoId).file, 'utf8'), 'first image')
  const reopened = await Library.open(profile)
  const winBin = path.join(root, 'recycled.jpg')
  assert.equal((await reopened.recycleDeletedPhotos([photoId], file => rename(file, winBin))).count, 1)
  assert.equal(await readFile(winBin, 'utf8'), 'first image')
  assert.equal(reopened.snapshot().deleted.length, 0)
})

test('viewer progress and tags are durable and travel with a verified backup', async t => {
  const { library, photoId, videoId, backups, profile, root } = await fixture(t)
  await library.setTags(photoId, ['Море', 'Поездка'])
  library.rememberPlayback(videoId, { position: 23.4, duration: 100, audioId: 'external-a', subtitleId: 'subtitle-3' })
  library.rememberPlayback(videoId, { watched: true })
  await library.flushPlayback()
  const reopened = await Library.open(profile)
  assert.deepEqual(reopened.snapshot().playback[videoId], {
    position: 23.4, duration: 100, audioId: 'external-a', subtitleId: 'subtitle-3', watched: true,
  })
  const backup = await reopened.exportBackup(backups)
  const portable = await Library.open(path.join(root, 'portable', 'library.json'))
  await portable.restoreBackup(backup.directory)
  assert.deepEqual(portable.file(photoId).tags, ['Море', 'Поездка'])
  assert.deepEqual(portable.snapshot().playback[videoId], reopened.snapshot().playback[videoId])
})

test('duplicate choices can cancel without side effects, skip across refresh, and allow explicit reimport', async t => {
  const { library, root, photo } = await fixture(t)
  const directory = path.join(root, 'duplicate source')
  await mkdir(directory)
  const duplicate = path.join(directory, 'Another photo.jpg')
  await writeFile(duplicate, await readFile(photo))
  const initialRoots = library.snapshot().sources
  const choose = choice => duplicates => {
    assert.equal(duplicates.length, 1)
    assert.equal(duplicates[0].file, duplicate)
    assert.equal(duplicates[0].match.source, 'library')
    return choice
  }
  assert.deepEqual(await library.importPaths([directory], undefined, choose('cancel')), { canceled: true })
  assert.equal(library.snapshot().sources, initialRoots)
  assert.equal((await library.importPaths([directory], undefined, choose('skip'))).skippedDuplicates, 1)
  await library.refresh()
  assert.equal(library.snapshot().items.length, 2)
  assert.equal((await library.importPaths([directory], undefined, choose('all'))).added, 1)
})
