import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Library } from '../desktop/library.mjs'
import { FolderWatcher, normalizeWatchedFolders, relevantChange, watchLimit } from '../desktop/watch-folders.mjs'

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(path.join(base, 'folio-watch-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }))
  const source = path.join(root, 'Screenshots')
  await mkdir(path.join(source, 'Trips'), { recursive: true })
  const library = await Library.open(path.join(root, 'profile', 'Library', 'library.json'))
  return { root, source, library }
}

const names = (library, kind) => library.snapshot().items.filter(item => !kind || item.kind === kind).map(item => item.filename).sort()

test('a watched folder brings in new media only, once, and respects deletions and duplicates', async t => {
  const { source, library } = await fixture(t)
  await writeFile(path.join(source, 'Alpha.jpg'), 'alpha')
  await writeFile(path.join(source, 'Trips', 'Sea.mp4'), 'sea video')
  await writeFile(path.join(source, 'notes.txt'), 'not media')

  assert.deepEqual((await library.newFiles(source)).map(file => path.basename(file)).sort(), ['Alpha.jpg', 'Sea.mp4'])
  assert.deepEqual(await library.syncFolder(source), { added: 2, skipped: 0 })
  assert.deepEqual(names(library), ['Alpha.jpg', 'Sea.mp4'])
  assert.deepEqual(await library.newFiles(source), [])
  assert.ok(library.snapshot().folders.some(folder => folder.id === library.folderIdFor(source) && folder.name === 'Screenshots'))

  await writeFile(path.join(source, 'Bravo.jpg'), 'bravo')
  await writeFile(path.join(source, 'Charlie.jpg'), 'charlie, still being written')
  const ready = [path.join(source, 'Bravo.jpg')]
  assert.deepEqual(await library.syncFolder(source, undefined, ready), { added: 1, skipped: 0 })
  assert.deepEqual((await library.newFiles(source)).map(file => path.basename(file)), ['Charlie.jpg'], 'an unfinished file waits')
  assert.deepEqual(await library.syncFolder(source), { added: 1, skipped: 0 })

  const alpha = library.snapshot().items.find(item => item.filename === 'Alpha.jpg')
  await library.softDeletePhotos([alpha.id])
  assert.deepEqual(await library.newFiles(source), [], 'a photo in Recently deleted is not brought back')
  await library.recycleDeletedPhotos([alpha.id], async () => {})
  assert.deepEqual(await library.newFiles(source), [], 'nor after it was deleted for good')
  assert.equal((await library.syncFolder(source)).added, 0)

  await copyFile(path.join(source, 'Bravo.jpg'), path.join(source, 'Bravo copy.jpg'))
  assert.deepEqual(await library.syncFolder(source), { added: 0, skipped: 0, skippedDuplicates: 1 })
  assert.deepEqual(await library.newFiles(source), [], 'a skipped duplicate is not offered again')
  assert.deepEqual(names(library), ['Bravo.jpg', 'Charlie.jpg', 'Sea.mp4'])
})

test('a manually imported folder keeps its deleted photos out once it is watched', async t => {
  const { source, library } = await fixture(t)
  await writeFile(path.join(source, 'Keep.jpg'), 'keep')
  await writeFile(path.join(source, 'Drop.jpg'), 'drop')
  await library.importPaths([source])
  const drop = library.snapshot().items.find(item => item.filename === 'Drop.jpg')
  await library.softDeletePhotos([drop.id])
  await writeFile(path.join(source, 'New.jpg'), 'new')
  assert.deepEqual(await library.syncFolder(source), { added: 1, skipped: 0 })
  assert.deepEqual(names(library), ['Keep.jpg', 'New.jpg'])
  assert.equal(library.state.roots.length, 1, 'the existing root is reused')
})

test('watched folders are normalized and capped', () => {
  const folders = normalizeWatchedFolders([
    { path: 'C:\\Pictures', addedAt: 5 }, 'C:\\Pictures', { path: 'relative' }, { path: 'D:\\Shots', addedAt: 'x' }, null,
    ...Array.from({ length: 20 }, (_, index) => 'E:\\Folder ' + index),
  ].map(entry => typeof entry === 'string' && process.platform !== 'win32' ? entry.replaceAll('\\', '/').replace(/^[A-Z]:/, '') : entry))
  assert.equal(folders.length, watchLimit)
  assert.equal(folders[0].addedAt, 5)
  assert.equal(folders.filter(folder => folder.path.endsWith('Pictures')).length, 1)
  assert.deepEqual(normalizeWatchedFolders('nope'), [])
})

test('changes to downloads in progress and other files are ignored', () => {
  assert.equal(relevantChange('Screenshot 1.png'), true)
  assert.equal(relevantChange('Trips\\clip.MKV'), true)
  assert.equal(relevantChange('New folder'), true, 'a folder moved in as a whole')
  assert.equal(relevantChange(null), true)
  assert.equal(relevantChange('photo.jpg.crdownload'), false)
  assert.equal(relevantChange('desktop.ini'), false)
  assert.equal(relevantChange('video.part'), false)
})

function harness(library, { available = () => true } = {}) {
  let saved = []
  const watchers = []
  const notes = []
  const activity = []
  const syncs = []
  const watcher = new FolderWatcher({
    read: () => saved, save: async value => { saved = value },
    scan: folder => library.newFiles(folder),
    sync: async (folder, ready) => {
      syncs.push(ready.map(file => path.basename(file)).sort())
      return library.syncFolder(folder, undefined, ready)
    },
    available, notify: change => notes.push(change), activity: (folder, running) => activity.push(running),
    watch: (folder, listener) => {
      const emitter = Object.assign(new EventEmitter(), { folder, listener, closed: false, close() { this.closed = true } })
      watchers.push(emitter)
      return emitter
    },
    settle: 10 ** 9, rescan: 10 ** 9, retry: 10 ** 9, busyRetry: 10 ** 9,
  })
  return { watcher, watchers, notes, activity, syncs, saved: () => saved }
}

async function settleInitialRun(watcher, folder) {
  await new Promise(resolve => setTimeout(resolve, 30))
  await watcher.entry(folder).running
}

test('a file is imported only after it stops changing', async t => {
  const { source, library } = await fixture(t)
  const { watcher, watchers, notes, activity, syncs, saved } = harness(library)
  t.after(() => watcher.stop())
  await writeFile(path.join(source, 'Existing.jpg'), 'existing')
  await watcher.add(source)
  assert.deepEqual(saved().map(folder => folder.path), [source])
  watcher.stop()
  watcher.start()
  await settleInitialRun(watcher, source)
  assert.equal(notes.length, 0, 'the first look only records the file')
  await watcher.run(source)
  assert.deepEqual(syncs, [['Existing.jpg']])
  assert.equal(notes[0].added, 1)
  assert.equal(notes[0].name, 'Screenshots')
  assert.deepEqual(activity, [true, false])

  const growing = path.join(source, 'Recording.mp4')
  await writeFile(growing, 'part one')
  await watcher.run(source)
  await appendFile(growing, ' and part two')
  await watcher.run(source)
  assert.equal(syncs.length, 1, 'a file that changed between looks waits')
  await watcher.run(source)
  assert.deepEqual(syncs.at(-1), ['Recording.mp4'])
  assert.deepEqual(names(library), ['Existing.jpg', 'Recording.mp4'])

  let scheduled = 0
  const schedule = watcher.schedule.bind(watcher)
  watcher.schedule = (...args) => { scheduled += 1; return schedule(...args) }
  const live = watchers.at(-1)
  live.listener('rename', 'download.jpg.crdownload')
  assert.equal(scheduled, 0)
  live.listener('rename', 'download.jpg')
  assert.equal(scheduled, 1)
})

test('a busy library postpones the pass and a lost folder is watched again when it returns', async t => {
  const { source, library } = await fixture(t)
  let free = false
  const { watcher, watchers } = harness(library, { available: () => free })
  t.after(() => watcher.stop())
  let scans = 0
  const scan = watcher.scan
  watcher.scan = folder => { scans += 1; return scan(folder) }
  await watcher.add(source)
  watcher.stop()
  watcher.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(scans, 0, 'nothing is read while another storage operation runs')
  free = true

  watchers.at(-1).emit('error', new Error('gone'))
  assert.equal(watcher.status()[0].error, 'unavailable')
  assert.equal(watcher.status()[0].watching, false)
  assert.equal(watchers.at(-1).closed, true)
  watcher.reopen()
  assert.equal(watcher.status()[0].watching, true)
  assert.equal(watcher.status()[0].error, '')

  await watcher.remove(source)
  assert.deepEqual(watcher.status(), [])
  assert.equal(watchers.at(-1).closed, true)
})

test('no more than the limit of folders can be watched', async t => {
  const { root, library } = await fixture(t)
  const { watcher } = harness(library)
  t.after(() => watcher.stop())
  for (let index = 0; index < watchLimit; index++) await watcher.add(path.join(root, 'Folder ' + index))
  await assert.rejects(watcher.add(path.join(root, 'One more')), /12/)
  await watcher.add(path.join(root, 'Folder 3'))
  assert.equal(watcher.status().length, watchLimit, 'adding a watched folder again changes nothing')
})
