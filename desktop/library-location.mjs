import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { assetFile, copyOriginal, fileChecksum, inBatches, isWithin, writeJson } from './media-storage.mjs'

function managedAssets(state) {
  const assets = new Set()
  for (const { stored } of [...Object.values(state.items), ...Object.values(state.trash).map(entry => entry.item)]) {
    if (stored) assets.add(stored)
  }
  for (const tracks of Object.values(state.tracks)) {
    for (const track of tracks) if (track?.stored) assets.add(track.stored)
  }
  return assets
}

async function removeStage(directory, parent) {
  const actual = await realpath(directory).catch(() => null)
  if (actual === directory && path.dirname(actual) === parent) {
    await rm(actual, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
  }
}

const exists = file => lstat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})

export async function relocateLibrary(library, destination, progress) {
  const directory = await realpath(destination)
  if (!(await stat(directory)).isDirectory()) throw new Error('Выберите папку для медиатеки.')
  const oldDirectory = await realpath(path.dirname(library.indexFile))
  if (directory === oldDirectory) return { directory, retained: 0 }
  const oldMedia = await realpath(library.mediaRoot)
  const nextMedia = path.join(directory, 'Media')
  const nextIndex = path.join(directory, 'library.json')
  if (isWithin(oldMedia, directory) || isWithin(nextMedia, oldDirectory) ||
      await exists(nextMedia) || await exists(nextIndex)) {
    throw new Error('Выберите папку с доступным местом и без другой медиатеки.')
  }

  const stage = await mkdtemp(path.join(directory, '.folio-move-'))
  const stagedMedia = path.join(stage, 'Media')
  const stagedIndex = path.join(stage, 'library.json')
  const oldFiles = new Map()
  let publishedMedia = false
  let publishedIndex = false
  let switched = false
  const oldIndex = library.indexFile
  try {
    await mkdir(stagedMedia)
    await inBatches([...managedAssets(library.state)], async stored => {
      const source = assetFile(oldMedia, stored)
      const details = await lstat(source)
      if (!details.isFile() || !isWithin(oldMedia, await realpath(source))) {
        throw new Error('Перенос прерван. Один из файлов медиатеки недоступен.')
      }
      const sha256 = await fileChecksum(source, details.size)
      const copy = await copyOriginal(source, stagedMedia, stored, { size: details.size, sha256 })
      if (copy.mtimeMs !== details.mtimeMs) throw new Error('Перенос прерван. Исходный файл изменился.')
      oldFiles.set(source, details)
    }, progress)
    await writeJson(stagedIndex, library.state)
    if (await realpath(stagedMedia) !== stagedMedia || await exists(nextMedia)) {
      throw new Error('Выберите папку с доступным местом и без другой медиатеки.')
    }
    await rename(stagedMedia, nextMedia)
    publishedMedia = true
    await copyFile(stagedIndex, nextIndex, constants.COPYFILE_EXCL)
    publishedIndex = true
    await writeJson(library.locationFile, { directory })
    library.indexFile = nextIndex
    library.mediaRoot = nextMedia
    switched = true
  } finally {
    if (!switched && publishedIndex) await rm(nextIndex, { force: true }).catch(() => {})
    if (!switched && publishedMedia) await removeStage(nextMedia, directory)
    await removeStage(stage, directory)
  }

  let retained = 0
  const assetFolders = new Set()
  await inBatches([...oldFiles], async ([file, previous]) => {
    const safe = await lstat(file).then(async current => current.isFile() &&
      current.size === previous.size && current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs &&
      isWithin(oldMedia, await realpath(file)), () => false).catch(() => false)
    if (!safe) {
      retained += 1
      return
    }
    try {
      await rm(file)
      const parent = path.dirname(file)
      await rmdir(parent).catch(() => {})
      assetFolders.add(path.dirname(parent))
    } catch {
      retained += 1
    }
  })
  for (const folder of assetFolders) await rmdir(folder).catch(() => {})
  await rmdir(oldMedia).catch(() => {})
  if (!retained) await rm(oldIndex, { force: true }).catch(() => {})
  return { directory, retained }
}

async function bytesIn(directory) {
  if (!directory) return 0
  let total = 0
  const queue = [directory]
  while (queue.length) {
    const folder = queue.pop()
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const files = []
    for (const entry of entries) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) queue.push(file)
      else if (entry.isFile()) files.push(file)
    }
    await inBatches(files, async file => { total += (await stat(file).catch(() => null))?.size ?? 0 })
  }
  return total
}

export async function readStorageInfo(library, cache) {
  const directory = path.dirname(library.indexFile)
  const [mediaBytes, cacheBytes, stats] = await Promise.all([
    bytesIn(library.mediaRoot), bytesIn(cache), statfs(directory).catch(() => null),
  ])
  return { directory, mediaBytes, cacheBytes, availableBytes: stats ? stats.bavail * stats.bsize : null }
}
