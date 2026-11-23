import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Library } from '../desktop/library.mjs'

async function fixture(t) {
  const temp = await mkdtemp(path.join(tmpdir(), 'folio-library-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const source = path.join(temp, 'Медиа')
  const album = path.join(source, 'Аниме')
  await mkdir(album, { recursive: true })
  const files = ['Фото.JPG', 'Аниме/Серия 01.mkv', 'Аниме/Анимация.gif', 'Аниме/Серия 01.ru.ass']
  for (const file of files) await writeFile(path.join(source, file), 'test')
  const index = path.join(temp, 'index.json')
  return { source, album, temp, index, library: await Library.open(index) }
}

test('nested media are indexed once and attached tracks stay out of the gallery', async t => {
  const { library, source, album } = await fixture(t)
  const { added } = await library.importPaths([source, album, path.join(source, 'Фото.JPG')])
  assert.equal(added, 3)
  const state = library.snapshot()
  assert.equal(state.items.length, 3)
  assert.equal(state.folders.length, 2)
  assert.deepEqual(state.items.map(item => item.kind).sort(), ['gif', 'photo', 'video'])
  assert.equal(state.items.find(item => item.kind === 'video').folderName, 'Аниме')
})

test('collections, history and favorites survive reopening the index', async t => {
  const { library, source, index } = await fixture(t)
  await library.importPaths([source])
  const id = library.snapshot().items[0].id
  const { id: collection } = await library.createCollection('В поездку')
  await Promise.all([library.toggleFavorite(id), library.markOpened(id), library.toggleCollection(collection, id)])
  await library.flushRecent()
  const reopened = (await Library.open(index)).snapshot()
  assert.equal(reopened.items.find(item => item.id === id).favorite, true)
  assert.ok(reopened.items.find(item => item.id === id).openedAt > 0)
  assert.deepEqual(reopened.folders.find(folder => folder.id === collection).members, [id])
})

test('refresh retains files from a temporarily unavailable source', async t => {
  const { library, source, temp } = await fixture(t)
  await library.importPaths([source])
  await rename(source, path.join(temp, 'Другой диск'))
  const result = await library.refresh()
  assert.equal(result.skipped, 1)
  assert.equal(library.snapshot().items.length, 3)
})

test('imported photos and detected tracks remain readable after the originals disappear', async t => {
  const { library, source, album, index } = await fixture(t)
  const file = path.join(source, 'Фото.JPG')
  await library.importPaths([file, album])
  const snapshot = library.snapshot()
  const photo = snapshot.items.find(item => item.kind === 'photo')
  const video = snapshot.items.find(item => item.kind === 'video')
  assert.notEqual(library.file(photo.id).file, file)
  assert.equal(path.basename(library.externalTracks(video.id)[0]), 'Серия 01.ru.ass')
  await rm(file)
  await rm(path.join(album, 'Серия 01.ru.ass'))
  await library.refresh()
  const reopened = await Library.open(index)
  assert.equal(reopened.snapshot().items.length, 3)
  assert.equal(await readFile(reopened.file(photo.id).file, 'utf8'), 'test')
  assert.equal(await readFile(reopened.externalTracks(video.id)[0], 'utf8'), 'test')
})

test('history is immediately visible and a queued batch survives reopening', async t => {
  const { library, source, index } = await fixture(t)
  await library.importPaths([source])
  const ids = library.snapshot().items.slice(0, 2).map(item => item.id)
  const first = library.markOpened(ids[0])
  const second = library.markOpened(ids[1])
  assert.ok(first > 0 && second >= first)
  assert.equal(library.snapshot().items.find(item => item.id === ids[1]).openedAt, second)
  await library.flushRecent()
  const reopened = (await Library.open(index)).snapshot()
  assert.equal(reopened.items.find(item => item.id === ids[0]).openedAt, first)
  assert.equal(reopened.items.find(item => item.id === ids[1]).openedAt, second)
})

test('a batch can be organized into new and existing library folders and collections', async t => {
  const { temp, library, source, album, index } = await fixture(t)
  await writeFile(path.join(album, 'Первый кадр.png'), 'first')
  await writeFile(path.join(album, 'Второй кадр.png'), 'second')
  await library.importPaths([source])
  const photos = library.snapshot().items.filter(item => item.kind === 'photo')
  const destination = photos.find(item => item.filename === 'Фото.JPG').folderId
  const selected = photos.filter(item => item.folderId !== destination)
  const ids = selected.map(item => item.id)
  const paths = ids.map(id => library.file(id).file)
  await library.toggleFavorite(ids[0])
  const creation = await library.organizePhotos([...ids, ids[0], 'demo-dolomites'], { name: 'Кадры' })
  assert.deepEqual(creation.changedIds.sort(), [...ids].sort())
  const newFolder = creation.folder.id
  assert.ok(library.snapshot().folders.some(folder => folder.id === newFolder && folder.name === 'Кадры'))
  await library.refresh()
  assert.ok(ids.every(id => library.file(id).folderId === newFolder))
  assert.deepEqual(ids.map(id => library.file(id).file), paths)
  assert.equal((await readFile(path.join(album, 'Первый кадр.png'), 'utf8')), 'first')
  assert.equal(library.snapshot().items.find(item => item.id === ids[0]).favorite, true)

  const { id: group } = await library.createCollection('Избранные кадры')
  assert.equal((await library.organizePhotos(ids, { folderId: group })).changedIds.length, 2)
  assert.equal((await library.organizePhotos(ids, { folderId: group })).changedIds.length, 0)
  assert.ok(ids.every(id => library.file(id).folderId === newFolder))
  assert.equal((await library.organizePhotos(ids, { folderId: destination })).changedIds.length, 2)
  await assert.rejects(library.organizePhotos(ids, { folderId: 'unavailable' }))
  const reopened = await Library.open(index)
  assert.ok(ids.every(id => reopened.file(id).folderId === destination))
  assert.ok(reopened.snapshot().folders.some(folder => folder.id === newFolder))
  const backup = await reopened.exportBackup(temp)
  const restored = await Library.open(path.join(temp, 'restored', 'library.json'))
  await restored.restoreBackup(backup.directory)
  assert.ok(ids.every(id => restored.file(id).folderId === destination))
  assert.ok(restored.snapshot().folders.some(folder => folder.id === newFolder))
  assert.deepEqual(restored.snapshot().folders.find(folder => folder.id === group).members.sort(), [...ids].sort())
  // An emptied folder simply disappears.
  const empty = await reopened.removeFolder(newFolder)
  assert.deepEqual(empty.removedIds, [])
  assert.ok(!reopened.snapshot().folders.some(folder => folder.id === newFolder))
  // A folder with photos sends them to Recently deleted, and restoring them brings the folder back.
  const inFolder = reopened.snapshot().items.filter(item => item.folderId === destination)
  const removal = await reopened.removeFolder(destination)
  assert.equal(removal.folderRemoved, inFolder.every(item => item.kind === 'photo'))
  assert.deepEqual(removal.removedIds.sort(), inFolder.filter(item => item.kind === 'photo').map(item => item.id).sort())
  assert.ok(removal.removedIds.every(id => !reopened.file(id) && reopened.snapshot().deleted.some(entry => entry.id === id)))
  await reopened.restoreDeletedPhotos(removal.removedIds)
  assert.ok(removal.removedIds.every(id => reopened.file(id).folderId === destination))
  assert.ok(reopened.snapshot().folders.some(folder => folder.id === destination))
  assert.ok(!(await Library.open(index)).snapshot().folders.some(folder => folder.id === newFolder))
})

test('group deletion prunes references once and reports recycling failures for managed photos', async t => {
  const { temp, source, album, library } = await fixture(t)
  await writeFile(path.join(album, 'Второй кадр.png'), 'second')
  await library.importPaths([source, path.join(source, 'Фото.JPG')])
  const items = library.snapshot().items
  const ids = items.filter(item => item.kind === 'photo').map(item => item.id)
  const video = items.find(item => item.kind === 'video')
  const { id: group } = await library.createCollection('Фото')
  const recycled = []
  for (const id of ids) {
    await library.toggleCollection(group, id)
    await library.toggleFavorite(id)
    library.markOpened(id)
  }
  const result = await library.removePhotos([...ids, ids[0], video.id], async file => {
    if (path.basename(file).endsWith('.png')) throw new Error('Trash unavailable')
    await rename(file, path.join(temp, 'recycled.jpg'))
    recycled.push(file)
  })
  assert.deepEqual(result.removedIds.sort(), [...ids].sort())
  assert.equal(result.trashFailed, 1)
  assert.equal(recycled.length, 1)
  await library.flushRecent()
  await library.refresh()
  assert.deepEqual(library.snapshot().items.map(item => item.kind).sort(), ['gif', 'video'])
  assert.deepEqual(library.snapshot().folders.find(folder => folder.id === group).members, [])
  assert.ok(ids.every(id => !library.state.recent[id] && !library.state.favorites[id]))
  assert.equal(await readFile(path.join(source, 'Фото.JPG'), 'utf8'), 'test')
  assert.equal(await readFile(path.join(album, 'Второй кадр.png'), 'utf8'), 'second')
})

test('an anime folder matches episodes across video, subtitle and dub folders and preserves track names in a backup', async t => {
  const { temp, library } = await fixture(t)
  const series = path.join(temp, 'Anime pack')
  const files = {
    'Видео/Season 1/[Release] Moon Story - 01 [1080p].mkv': 's1e1',
    'Видео/Season 1/[Release] Moon Story - 10 [1080p].mkv': 's1e10',
    'Видео/Season 2/Moon.Story.S02E01.mkv': 's2e1',
    'Субтитры/Season 1/01.ru.ass': 's1 subtitles',
    'Субтитры/Moon Story S02E01.en.srt': 's2 subtitles',
    'Субтитры/01.ass': 'ambiguous without a season',
    'Аудиодорожки/Studio A/Season 1/01.mka': 'studio A',
    'Аудиодорожки/Studio B/Season 1/01.mka': 'studio B',
    'Аудиодорожки/Studio A/Season 1/10.mka': 'tenth episode',
    'Аудиодорожки/Studio A/Season 2/Серия 01.flac': 'second season',
  }
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(series, name)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
  assert.deepEqual(await library.importPaths([series]), { added: 3, skipped: 0 })
  const snapshot = library.snapshot()
  const [first, tenth, secondSeason] = Object.keys(files).slice(0, 3).map(name =>
    snapshot.items.find(item => item.filename === path.basename(name)))
  async function contents(subject, id) {
    return (await Promise.all(subject.externalTracks(id).map(file => readFile(file, 'utf8')))).sort()
  }
  assert.deepEqual(await contents(library, first.id), ['s1 subtitles', 'studio A', 'studio B'])
  assert.deepEqual(await contents(library, tenth.id), ['tenth episode'])
  assert.deepEqual(await contents(library, secondSeason.id), ['s2 subtitles', 'second season'])
  assert.deepEqual(library.externalTrackOptions(first.id).map(track => track.label).sort(),
    ['01.ru.ass', 'Studio A · 01.mka', 'Studio B · 01.mka'])

  const relocated = path.join(temp, 'Moved anime')
  await rename(series, relocated)
  const { directory } = await library.exportBackup(temp)
  const restored = await Library.open(path.join(temp, 'portable', 'library.json'))
  assert.equal((await restored.restoreBackup(directory)).added, 3)
  assert.deepEqual(await contents(restored, first.id), ['s1 subtitles', 'studio A', 'studio B'])
  assert.deepEqual(restored.externalTrackOptions(first.id).map(track => track.label).sort(),
    ['01.ru.ass', 'Studio A · 01.mka', 'Studio B · 01.mka'])
  await rename(relocated, series)
  assert.equal((await restored.importPaths([series])).added, 0)
  assert.deepEqual(await contents(restored, first.id), ['s1 subtitles', 'studio A', 'studio B'])
})

test('separate media import and refresh find sibling folders without crossing into other anime', async t => {
  const { temp, library } = await fixture(t)
  const series = path.join(temp, 'Package')
  const video = path.join(series, '1 Videos', '[Pack] Signal - 02 [1080p].mkv')
  const audio = path.join(series, '2 External Audio', 'Dub', '02.flac')
  const captions = path.join(series, '3 Subs', 'Signal - 02.ass')
  const unrelated = path.join(temp, 'Другой сериал', 'Subs', '02.ass')
  for (const file of [video, audio, unrelated]) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, path.basename(file))
  }
  await library.importPaths([video])
  const id = library.snapshot().items[0].id
  assert.equal(library.externalTracks(id).length, 1)
  assert.deepEqual(library.externalTrackOptions(id).map(track => track.label), ['Dub · 02.flac'])
  await mkdir(path.dirname(captions))
  await writeFile(captions, 'new captions')
  await library.refresh()
  assert.deepEqual(library.externalTrackOptions(id).map(track => track.label).sort(), ['Dub · 02.flac', 'Signal - 02.ass'])
  await library.refresh()
  assert.equal(library.externalTracks(id).length, 2)
})
