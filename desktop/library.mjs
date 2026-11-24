import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { convertiblePhotos, extension, mediaKind, trackKind } from '../shared/formats.mjs'
import { demoFolders, demoItems } from '../shared/demo.mjs'
import { normalizeTheme } from '../shared/brand.mjs'
import { normalizeLanguage, translate } from '../shared/locale.mjs'
import { normalizeTags } from '../shared/library-search.mjs'
import { describeSeriesEpisode } from '../shared/series.mjs'
import { backupManifest, portableMetadata, readBackup, writeBackup } from './library-backup.mjs'
import { assetFile, assetFolder, assetName, copyOriginal, fileChecksum, inBatches, isWithin, prepareAsset, readJson, writeJson } from './media-storage.mjs'
import { createSidecarSearch } from './sidecars.mjs'
import { readStorageInfo, relocateLibrary } from './library-location.mjs'
import { detachPhotos, recycleAssets, undoOrganization, unusedPhotoAssets } from './library-recovery.mjs'
import { normalizePlayback } from './playback-progress.mjs'
import { findImportDuplicates, readPhotoMetadata } from './photo-catalog.mjs'

const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32)
const idForPath = file => digest(pathKey(file))
const emptyState = () => ({
  version: 2, initialized: false, roots: [], loose: [], items: {}, folders: [], removed: {},
  favorites: {}, recent: {}, collections: [], tracks: {}, trash: {}, playback: {}, organizeUndo: null,
})
const demosById = new Map(demoItems.map(item => [item.id, item]))
const canceledImport = Symbol('canceled import')
const STAT_BATCH = 32
const fileStat = file => file ? stat(file).then(info => info.isFile() ? info : null, () => null) : Promise.resolve(null)

function record(file, details) {
  const kind = mediaKind(file)
  return {
    id: idForPath(file), file, filename: path.basename(file), name: path.parse(file).name,
    kind, ext: extension(file), folderId: 'folder-' + idForPath(path.dirname(file)),
    folderName: path.basename(path.dirname(file)) || path.dirname(file),
    modifiedAt: details.mtimeMs, size: details.size,
    series: kind === 'video' ? describeSeriesEpisode(path.basename(file), path.dirname(file), digest) ?? undefined : undefined,
  }
}

function rememberItem(draft, item) {
  const previous = draft.items[item.id]
  if (previous?.stored) {
    previous.file ??= item.file
  } else {
    draft.items[item.id] = {
      ...previous, ...item, folderId: previous?.folderId ?? item.folderId, folderName: previous?.folderName ?? item.folderName,
    }
  }
}

function selectedPhotos(items, ids) {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids)].flatMap(id => typeof id === 'string' && items[id]?.kind === 'photo' ? [items[id]] : [])
}

async function indexFolder(root, draft, storage, inventories, reimport = false) {
  const pending = [root.path]
  const ids = new Set()
  const inventory = { videos: [], tracks: [] }
  let skipped = 0
  while (pending.length) {
    const dir = pending.pop()
    if (isWithin(storage, dir)) continue
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) {
      skipped += 1
      const prefix = pathKey(dir.endsWith(path.sep) ? dir : dir + path.sep)
      for (const id of root.ids) {
        if (draft.items[id]?.file && pathKey(draft.items[id].file).startsWith(prefix)) ids.add(id)
      }
      continue
    }

    if (entries.some(entry => entry.name === backupManifest && entry.isFile())) continue
    const files = []
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) pending.push(file)
      if (entry.isFile()) {
        if (mediaKind(entry.name)) files.push(file)
        else if (trackKind(entry.name)) inventory.tracks.push(file)
      }
    }
    for (let start = 0; start < files.length; start += STAT_BATCH) {
      const batch = files.slice(start, start + STAT_BATCH)
      const stats = await Promise.all(batch.map(file => stat(file).catch(() => null)))
      for (const [index, info] of stats.entries()) {
        if (!info?.isFile()) continue
        const item = record(batch[index], info)
        if (draft.trash[item.id] || (!reimport && draft.removed[item.id])) continue
        ids.add(item.id)
        rememberItem(draft, item)
        if (item.kind === 'video') inventory.videos.push(item.file)
      }
    }
  }
  root.ids = [...ids]
  if (inventory.videos.length && inventory.tracks.length) inventories.set(root.path, inventory)
  return skipped
}

function prune(draft) {
  const retained = new Set([...draft.loose, ...draft.roots.flatMap(root => root.ids)])
  for (const id of Object.keys(draft.items)) {
    if (!draft.items[id].stored && !retained.has(id)) delete draft.items[id]
  }
}

export class Library {
  static async open(defaultIndex, demoPath = '', legacyIndex, defaultTheme = 'dark') {
    const stable = path.dirname(defaultIndex)
    const settingsFile = path.join(stable, 'appearance.json')
    const locationFile = path.join(stable, 'location.json')
    const [location, settings] = await Promise.all([readJson(locationFile), readJson(settingsFile)])
    if (location && (typeof location.directory !== 'string' || !path.isAbsolute(location.directory))) {
      throw new Error('Папка медиатеки недоступна. Подключите диск и запустите Folio снова.')
    }
    const indexFile = location ? path.join(location.directory, 'library.json') : defaultIndex
    const saved = await readJson(indexFile)
    if (location && !saved) throw new Error('Папка медиатеки недоступна. Подключите диск и запустите Folio снова.')
    const state = saved ?? await readJson(legacyIndex)
    const library = new Library(indexFile, demoPath, { ...emptyState(), ...state, version: 2 }, settingsFile, locationFile, {
      theme: normalizeTheme(settings?.theme ?? state?.theme ?? defaultTheme),
      language: normalizeLanguage(settings?.language),
      onboarded: settings?.onboarded === true,
      automaticBackup: settings?.automaticBackup,
      updates: settings?.updates,
      watchedFolders: settings?.watchedFolders,
    })
    await mkdir(library.mediaRoot, { recursive: true })
    return library
  }

  constructor(indexFile, demoPath, state, settingsFile, locationFile, preferences) {
    this.indexFile = indexFile
    this.demoPath = demoPath
    this.mediaRoot = path.join(path.dirname(indexFile), 'Media')
    this.state = state
    this.settingsFile = settingsFile
    this.locationFile = locationFile
    this.preferences = preferences
    this.preferencesPending = Promise.resolve()
    this.pending = Promise.resolve()
    this.recent = new Map()
    this.recentTimer = null
    this.recentWrite = null
    this.lastOpened = 0
    this.playbackPending = new Map()
    this.playbackTimer = null
  }

  enqueue(task) {
    const operation = this.pending.then(task)
    this.pending = operation.catch(() => {})
    return operation
  }

  async update(mutator, afterCommit) {
    return this.enqueue(async () => {
      const draft = structuredClone(this.state)
      const created = []
      let result
      try {
        result = await mutator(draft, created)
        await writeJson(this.indexFile, draft)
      } catch (error) {
        for (const file of created) await rm(file, { force: true }).catch(() => {})
        throw error
      }
      this.state = draft
      return afterCommit ? afterCommit(result) : result
    })
  }

  async moveTo(directory, progress) {
    await Promise.all([this.flushRecent(), this.flushPlayback()])
    return this.enqueue(() => relocateLibrary(this, directory, progress))
  }

  storageInfo(cache) { return readStorageInfo(this, cache) }

  file(id, includeDeleted = false) {
    if (typeof id !== 'string') return null
    const item = this.state.items[id] ?? (includeDeleted ? this.state.trash[id]?.item : undefined)
    if (item?.stored) return { ...item, file: assetFile(this.mediaRoot, item.stored) }
    if (item?.file) return item
    const sample = demosById.get(id)
    return sample ? { ...sample, file: path.join(this.demoPath, sample.filename) } : null
  }

  get theme() { return this.preferences.theme }
  get language() { return this.preferences.language }

  setPreferences(fields) {
    const next = { ...this.preferences, ...fields }
    this.preferences = next
    this.preferencesPending = this.preferencesPending.catch(() => {}).then(() => writeJson(this.settingsFile, next))
    return this.preferencesPending
  }

  snapshot() {
    const { items: localItems, favorites, recent, collections, roots } = this.state
    const local = Object.values(localItems)
    const demo = !this.state.initialized && local.length === 0
    const byFolder = new Map(this.state.folders.map(folder => [folder.id, { ...folder, kind: 'physical' }]))
    let linked = 0
    for (const item of local) {
      if (this.needsCopy(item)) linked += 1
      if (!byFolder.has(item.folderId)) byFolder.set(item.folderId, {
        id: item.folderId, name: item.folderName, kind: 'physical',
        location: item.stored ? path.join(this.mediaRoot, item.stored.split('/')[0]) : path.dirname(item.file),
      })
    }
    const folders = demo ? demoFolders : [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    const items = (demo ? demoItems : local).map(({ file, stored, photoIndexed, ...item }) => ({
      ...item,
      series: item.series ?? (item.kind === 'video' && file ? describeSeriesEpisode(item.filename, path.dirname(file), digest) : undefined),
      favorite: Boolean(favorites[item.id]),
      openedAt: this.recent.get(item.id) ?? recent[item.id] ?? 0,
      url: '/~file/' + item.id,
      viewUrl: (convertiblePhotos.has(item.ext) ? '/~view/' : '/~file/') + item.id + '?v=' + item.modifiedAt,
      preview: '/~preview/' + item.id + '?v=' + item.modifiedAt,
    }))
    const deleted = Object.values(this.state.trash).map(({ item, deletedAt }) => ({
      id: item.id, name: item.name, filename: item.filename, folderName: item.folderName, deletedAt,
      preview: '/~preview/' + item.id + '?v=' + item.modifiedAt,
    })).sort((a, b) => b.deletedAt - a.deletedAt)
    return { demo, items, folders: [...folders, ...collections], sources: roots.length, linked, deleted,
      unindexedPhotos: local.filter(item => item.kind === 'photo' && item.stored && !item.photoIndexed).length,
      canUndo: Boolean(this.state.organizeUndo), playback: { ...this.state.playback, ...Object.fromEntries(this.playbackPending) } }
  }

  needsCopy(item) {
    return !item.stored || this.state.tracks[item.id]?.some(track => typeof track === 'string')
  }

  async copyItems(draft, ids, created, progress, discover = false, inventories, hashes) {
    let copied = 0
    let skipped = 0
    const sidecars = createSidecarSearch(await realpath(this.mediaRoot), inventories)
    await inBatches(ids, async id => {
      const item = draft.items[id]
      const fresh = !item.stored
      if (fresh) {
        const stored = assetName(assetFolder(item.folderName, item.folderId), item.filename)
        const info = await copyOriginal(item.file, this.mediaRoot, stored, { created, optional: true, sha256: hashes?.get(id),
          integrityError: 'Файл изменился после проверки дубликатов. Повторите импорт.' })
        if (!info) {
          skipped += 1
          return
        }
        draft.items[id] = { ...item, stored, size: info.size, modifiedAt: info.mtimeMs }
        if (item.kind === 'photo') Object.assign(draft.items[id], await readPhotoMetadata(assetFile(this.mediaRoot, stored)), { photoIndexed: true })
        copied += 1
      }
      if (item.kind !== 'video') return
      const candidates = item.file && (fresh || discover) ? await sidecars(item.file) : []
      const tracks = await this.copyTracks(draft, id, candidates, created)
      skipped += tracks.skipped
    }, progress)
    return { copied, skipped }
  }

  migrate(progress) {
    if (!Object.values(this.state.items).some(item => this.needsCopy(item))) return Promise.resolve({ copied: 0, skipped: 0 })
    return this.update((draft, created) => this.copyItems(
      draft, Object.values(draft.items).filter(item => !item.stored || draft.tracks[item.id]?.some(track => typeof track === 'string')).map(item => item.id),
      created, progress,
    ))
  }

  importPaths(paths, progress, chooseDuplicates) {
    return this.update(async (draft, created) => {
      const before = new Set(Object.keys(draft.items))
      const touched = new Set()
      const loose = new Set(draft.loose)
      const storage = await realpath(this.mediaRoot)
      const inventories = new Map()
      let skipped = 0
      for (const entry of new Set(paths)) {
        if (typeof entry !== 'string' || !path.isAbsolute(entry)) continue
        const file = await realpath(entry).catch(() => null)
        const info = file && await stat(file).catch(() => null)
        if (!info) {
          skipped += 1
          continue
        }
        if (isWithin(storage, file)) continue
        if (info.isDirectory()) {
          let root = draft.roots.find(item => pathKey(item.path) === pathKey(file))
          if (!root) {
            root = { path: file, ids: [] }
            draft.roots.push(root)
          }
          skipped += await indexFolder(root, draft, storage, inventories, true)
          for (const id of root.ids) touched.add(id)
        } else if (info.isFile() && mediaKind(file)) {
          const item = record(file, info)
          if (draft.trash[item.id]) continue
          rememberItem(draft, item)
          touched.add(item.id)
          loose.add(item.id)
        }
      }
      draft.loose = [...loose]
      prune(draft)
      let skippedDuplicates = 0
      let hashes
      if (chooseDuplicates) {
        const incoming = [...touched].filter(id => !before.has(id)).map(id => draft.items[id])
        const known = Object.values(this.state.items).map(item => ({ ...item, file: item.stored ? assetFile(this.mediaRoot, item.stored) : item.file }))
        const result = await findImportDuplicates(incoming, known)
        hashes = result.hashes
        if (result.duplicates.length) {
          const choice = await chooseDuplicates(result.duplicates)
          if (choice === 'cancel') throw canceledImport
          if (choice === 'skip') {
            for (const { id } of result.duplicates) {
              draft.removed[id] = true
              delete draft.items[id]
              touched.delete(id)
            }
            skippedDuplicates = result.duplicates.length
          }
        }
      }
      const work = await this.copyItems(draft, [...touched], created, progress, true, inventories, hashes)
      for (const id of touched) {
        if (!before.has(id) && !draft.items[id]?.stored) delete draft.items[id]
        if (draft.items[id]?.stored) delete draft.removed[id]
      }
      draft.loose = draft.loose.filter(id => draft.items[id])
      for (const root of draft.roots) root.ids = root.ids.filter(id => draft.items[id])
      skipped += work.skipped
      const added = Object.keys(draft.items).filter(id => !before.has(id)).length
      if (added) draft.initialized = true
      return { added, skipped, ...(skippedDuplicates ? { skippedDuplicates } : {}) }
    }).catch(error => {
      if (error === canceledImport) return { canceled: true }
      throw error
    })
  }

  folderIdFor(directory) { return 'folder-' + idForPath(directory) }

  knows(file) {
    const id = idForPath(file)
    return Boolean(this.state.items[id] || this.state.removed[id] || this.state.trash[id])
  }

  // Media under a folder that Folio has neither imported nor been told to forget. Reads only, so a watched
  // folder can be checked often without rewriting the library index.
  async newFiles(folder) {
    const storage = await realpath(this.mediaRoot)
    const found = []
    const pending = [folder]
    while (pending.length) {
      const dir = pending.pop()
      if (isWithin(storage, dir)) continue
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
      if (!entries || entries.some(entry => entry.name === backupManifest && entry.isFile())) continue
      for (const entry of entries) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) pending.push(file)
        else if (entry.isFile() && mediaKind(entry.name) && !this.knows(file)) found.push(file)
      }
    }
    return found
  }

  // Imports what was added to a watched folder. Unlike a manual import it keeps media the user deleted from
  // Folio out, skips exact copies of files already in the library without asking, and takes only `ready`
  // files when given, so a file that is still being written waits for the next pass.
  syncFolder(folder, progress, ready) {
    const allowed = ready && new Set([...ready].map(pathKey))
    return this.update(async (draft, created) => {
      const storage = await realpath(this.mediaRoot)
      let root = draft.roots.find(item => pathKey(item.path) === pathKey(folder))
      if (!root) {
        root = { path: folder, ids: [] }
        draft.roots.push(root)
      }
      const before = new Set(Object.keys(draft.items))
      const inventories = new Map()
      const skipped = await indexFolder(root, draft, storage, inventories)
      const waiting = new Set(allowed ? root.ids.filter(id => !before.has(id) && !allowed.has(pathKey(draft.items[id].file))) : [])
      for (const id of waiting) delete draft.items[id]
      root.ids = root.ids.filter(id => !waiting.has(id))
      prune(draft)
      const incoming = root.ids.filter(id => !before.has(id))
      const known = Object.values(this.state.items).map(item => ({ ...item, file: item.stored ? assetFile(this.mediaRoot, item.stored) : item.file }))
      const { duplicates, hashes } = await findImportDuplicates(incoming.map(id => draft.items[id]), known)
      for (const { id } of duplicates) {
        draft.removed[id] = true
        delete draft.items[id]
      }
      const fresh = incoming.filter(id => draft.items[id])
      const work = await this.copyItems(draft, fresh, created, progress, true, inventories, hashes)
      for (const id of fresh) if (!draft.items[id]?.stored) delete draft.items[id]
      root.ids = root.ids.filter(id => draft.items[id])
      const added = fresh.filter(id => draft.items[id]).length
      if (added) draft.initialized = true
      return { added, skipped: skipped + work.skipped, ...(duplicates.length ? { skippedDuplicates: duplicates.length } : {}) }
    })
  }

  indexPhotos(progress) {
    return this.update(async draft => {
      const items = Object.values(draft.items).filter(item => item.kind === 'photo' && item.stored && !item.photoIndexed)
      await inBatches(items, async item => {
        const file = assetFile(this.mediaRoot, item.stored)
        if (await fileStat(file)) Object.assign(item, await readPhotoMetadata(file), { photoIndexed: true })
      }, progress)
      return { count: items.length }
    })
  }

  async removePhoto(id, trash) {
    const result = await this.removePhotos([id], trash)
    return result.removedIds.length ? { removed: true, trashFailed: Boolean(result.trashFailed) } : { removed: false }
  }

  async removePhotos(ids, trash, progress) {
    if (!selectedPhotos(this.state.items, ids).length) return { removedIds: [], trashFailed: 0 }
    return this.update(draft => {
      const removed = detachPhotos(draft, ids, item => ({ item }))
      const stored = unusedPhotoAssets(draft, [...removed.values()].map(entry => entry.item))
      return { removedIds: [...removed.keys()], stored }
    }, async ({ removedIds, stored }) => {
      for (const id of removedIds) this.recent.delete(id)
      const failed = await recycleAssets(this.mediaRoot, stored, trash, progress)
      return { removedIds, trashFailed: failed.size }
    })
  }

  trashPhotos(draft, ids) {
    const deletedAt = Date.now()
    const removed = detachPhotos(draft, ids, (item, id) => ({
      item, deletedAt, favorite: Boolean(draft.favorites[id]),
      openedAt: this.recent.get(id) ?? draft.recent[id] ?? 0, collections: [], roots: [],
    }))
    for (const [id, entry] of removed) draft.trash[id] = entry
    return [...removed.keys()]
  }

  forgetRecent(result) {
    for (const id of result.removedIds) this.recent.delete(id)
    return result
  }

  softDeletePhotos(ids) {
    return this.update(draft => ({ removedIds: this.trashPhotos(draft, ids) }), result => this.forgetRecent(result))
  }

  restoreDeletedPhotos(ids) {
    return this.update(async draft => {
      const candidates = [...new Set(Array.isArray(ids) ? ids : [])].filter(id => draft.trash[id]?.item)
      const restored = new Set()
      await inBatches(candidates, async id => {
        const { item } = draft.trash[id]
        if (item.stored && !await fileStat(assetFile(this.mediaRoot, item.stored))) return
        restored.add(id)
      })
      const memberships = new Map()
      const roots = new Map()
      const loose = new Set(draft.loose)
      for (const id of restored) {
        const entry = draft.trash[id]
        draft.items[id] = entry.item
        if (entry.favorite) draft.favorites[id] = true
        if (entry.openedAt) draft.recent[id] = entry.openedAt
        if (entry.loose) loose.add(id)
        for (const key of entry.collections) {
          if (!memberships.has(key)) memberships.set(key, [])
          memberships.get(key).push(id)
        }
        for (const key of entry.roots ?? []) {
          if (!roots.has(key)) roots.set(key, [])
          roots.get(key).push(id)
        }
        delete draft.removed[id]
        delete draft.trash[id]
      }
      draft.loose = [...loose]
      for (const group of draft.collections) if (memberships.has(group.id)) group.members = [...new Set([...group.members, ...memberships.get(group.id)])]
      for (const root of draft.roots) if (roots.has(root.path)) root.ids = [...new Set([...root.ids, ...roots.get(root.path)])]
      return { count: restored.size, skipped: candidates.length - restored.size }
    })
  }

  recycleDeletedPhotos(ids, recycle, progress) {
    return this.update(async draft => {
      const selected = new Set(Array.isArray(ids) ? ids.filter(id => draft.trash[id]?.item) : [])
      const assets = unusedPhotoAssets(draft, [...selected].map(id => draft.trash[id].item), selected)
      const failed = await recycleAssets(this.mediaRoot, assets, recycle, progress)
      let count = 0
      for (const id of selected) {
        if (failed.has(draft.trash[id].item.stored)) continue
        delete draft.trash[id]
        count += 1
      }
      return { count, skipped: selected.size - count }
    })
  }

  organizePhotos(ids, destination) {
    return this.update(draft => {
      const photos = selectedPhotos(draft.items, ids)
      const changedIds = []
      if (!photos.length) return { changedIds, folder: null }
      const folderId = destination?.folderId
      const collection = folderId && draft.collections.find(group => group.id === folderId)
      if (collection) {
        const members = new Set(collection.members)
        for (const photo of photos) {
          if (members.has(photo.id)) continue
          collection.members.push(photo.id)
          changedIds.push(photo.id)
        }
        if (changedIds.length) draft.organizeUndo = { type: 'collection', folderId, ids: changedIds }
        return { changedIds, folder: { id: collection.id, name: collection.name, kind: 'collection' } }
      }

      const folders = new Map(draft.folders.map(folder => [folder.id, folder]))
      let folder
      if (folderId) {
        const original = Object.values(draft.items).find(item => item.folderId === folderId)
        folder = folders.get(folderId) ?? (original && { id: original.folderId, name: original.folderName })
        if (!folder) throw new Error('Папка отсутствует в медиатеке.')
      } else {
        const name = typeof destination?.name === 'string' ? destination.name.trim().slice(0, 70) : ''
        if (!name || /[\u0000-\u001f]/.test(name)) throw new Error('Укажите название папки.')
        folder = { id: 'folder-' + randomUUID().replaceAll('-', ''), name }
      }
      folders.set(folder.id, folder)
      const previous = []
      for (const photo of photos) {
        if (photo.folderId === folder.id) continue
        previous.push({ id: photo.id, folderId: photo.folderId, folderName: photo.folderName })
        if (!folders.has(photo.folderId)) folders.set(photo.folderId, { id: photo.folderId, name: photo.folderName })
        photo.folderId = folder.id
        photo.folderName = folder.name
        changedIds.push(photo.id)
      }
      if (changedIds.length) {
        draft.folders = [...folders.values()]
        draft.organizeUndo = { type: 'move', folderId: folder.id, created: !folderId, previous }
      }
      return { changedIds, folder: { ...folder, kind: 'physical' } }
    })
  }

  undoOrganize() {
    return this.update(draft => ({ count: undoOrganization(draft) }))
  }

  setTags(id, value) {
    return this.update(draft => {
      if (draft.items[id]?.kind !== 'photo') return
      draft.items[id].tags = normalizeTags(value)
    })
  }

  rememberPlayback(id, patch) {
    if (this.file(id)?.kind !== 'video') return null
    const previous = this.playbackPending.get(id) ?? this.state.playback[id]
    const record = { ...previous, ...normalizePlayback(patch) }
    if (!Object.keys(record).length || Object.keys(record).every(key => record[key] === previous?.[key])) return previous ?? null
    this.playbackPending.set(id, record)
    if (!this.playbackTimer) this.playbackTimer = setTimeout(() => {
      this.flushPlayback().catch(error => console.error('Could not save playback progress:', error.message))
    }, 1800)
    return record
  }

  flushPlayback() {
    clearTimeout(this.playbackTimer)
    this.playbackTimer = null
    if (!this.playbackPending.size) return this.pending
    const pending = new Map(this.playbackPending)
    return this.update(draft => {
      for (const [id, record] of pending) {
        if (draft.items[id]?.kind === 'video' || demosById.get(id)?.kind === 'video') draft.playback[id] = record
      }
    }).then(() => {
      for (const [id, record] of pending) if (this.playbackPending.get(id) === record) this.playbackPending.delete(id)
    })
  }

  async keepEdit(source, ext, render, signal, suffix = '(правка)') {
    const temporary = await mkdtemp(path.join(path.dirname(this.indexFile), '.edit-'))
    const part = path.join(temporary, 'copy.' + ext)
    try {
      await render(part)
      const details = await stat(part)
      if (!details.size) throw new Error('Не удалось сохранить копию.')
      return await this.update(async (draft, created) => {
        signal?.throwIfAborted()
        const folderName = source.folderName
        const folderId = source.demo ? 'folder-' + digest('demo:' + source.folderId) : source.folderId
        const stem = source.name.slice(0, 93) + ' ' + translate(this.language, suffix)
        const names = new Set(Object.values(draft.items).filter(item => item.folderId === folderId).map(item => pathKey(item.filename)))
        let filename = stem + '.' + ext
        for (let number = 2; names.has(pathKey(filename)); number++) filename = stem + ' ' + number + '.' + ext

        const stored = assetName(assetFolder(folderName, folderId), filename)
        const target = await prepareAsset(this.mediaRoot, stored)
        signal?.throwIfAborted()
        await rename(part, target)
        created.push(target)
        const id = stored.split('/')[1]
        draft.items[id] = {
          id, stored, filename, name: path.parse(filename).name, folderId, folderName,
          kind: mediaKind(filename), ext, size: details.size, modifiedAt: details.mtimeMs,
          ...(mediaKind(filename) === 'photo' ? { ...await readPhotoMetadata(target), photoIndexed: true } : {}),
        }
        draft.initialized = true
        return id
      })
    } finally {
      await rm(part, { force: true }).catch(() => {})
      await rmdir(temporary).catch(() => {})
    }
  }

  refresh(progress) {
    return this.update(async (draft, created) => {
      let skipped = 0
      const storage = await realpath(this.mediaRoot)
      const inventories = new Map()
      for (const root of draft.roots) skipped += await indexFolder(root, draft, storage, inventories)
      const retained = []
      for (const id of draft.loose) {
        const file = draft.items[id]?.file
        if (!file) continue
        if (draft.items[id].stored) {
          retained.push(id)
          continue
        }
        try {
          const info = await stat(file)
          if (!info.isFile()) continue
          rememberItem(draft, { ...record(file, info), id })
        } catch (error) {
          const missing = error.code === 'ENOENT' && await stat(path.dirname(file)).then(info => info.isDirectory(), () => false)
          if (missing) continue
          skipped += 1
        }
        retained.push(id)
      }
      draft.loose = retained
      prune(draft)
      const work = await this.copyItems(draft, Object.keys(draft.items), created, progress, true, inventories)
      skipped += work.skipped
      return { skipped }
    })
  }

  toggleFavorite(id) {
    if (!this.file(id)) return
    return this.update(draft => {
      if (!draft.items[id] && !demosById.has(id)) return
      if (draft.favorites[id]) delete draft.favorites[id]
      else draft.favorites[id] = true
    })
  }

  markOpened(id) {
    if (!this.file(id)) return 0
    const time = Math.max(Date.now(), this.lastOpened + 1)
    this.lastOpened = time
    this.recent.set(id, time)
    if (!this.recentTimer) this.recentTimer = setTimeout(() => {
      this.flushRecent().catch(error => console.error('Could not save playback history:', error.message))
    }, 230)
    return time
  }

  flushRecent() {
    clearTimeout(this.recentTimer)
    this.recentTimer = null
    if (this.recentWrite) return this.recentWrite.then(() => this.flushRecent())
    if (!this.recent.size) return this.pending
    const entries = new Map(this.recent)
    this.recentWrite = this.update(draft => {
      for (const [id, time] of entries) {
        if (draft.items[id] || demosById.has(id)) draft.recent[id] = Math.max(draft.recent[id] ?? 0, time)
      }
    }).then(() => {
      for (const [id, time] of entries) {
        if (this.recent.get(id) === time) this.recent.delete(id)
      }
    }).finally(() => { this.recentWrite = null })
    return this.recentWrite
  }

  createCollection(value) {
    const name = typeof value === 'string' ? value.trim().slice(0, 70) : ''
    if (!name) throw new Error('Укажите название подборки.')
    return this.update(draft => {
      const id = 'collection-' + randomUUID()
      draft.collections.push({ id, name, kind: 'collection', members: [] })
      return { id }
    })
  }

  toggleCollection(collection, id) {
    if (!this.file(id)) return
    return this.update(draft => {
      if (!draft.items[id] && !demosById.has(id)) return
      const folder = draft.collections.find(item => item.id === collection)
      if (!folder) return
      folder.members = folder.members.includes(id) ? folder.members.filter(member => member !== id) : [...folder.members, id]
    })
  }

  removeCollection(id) {
    return this.update(draft => { draft.collections = draft.collections.filter(folder => folder.id !== id) })
  }

  // Photos in the folder move to Recently deleted, like any other photo deletion, so they stay recoverable.
  // Videos and GIFs have no deletion flow yet, so a folder that still holds them stays in the list.
  // Restoring a photo from Recently deleted recreates its folder.
  removeFolder(id) {
    return this.update(draft => {
      const known = draft.folders.some(folder => folder.id === id) ||
        Object.values(draft.items).some(item => item.folderId === id)
      if (typeof id !== 'string' || !known) throw new Error('Папка отсутствует в медиатеке.')
      const photos = Object.values(draft.items).filter(item => item.folderId === id && item.kind === 'photo' && !item.demo)
      const removedIds = this.trashPhotos(draft, photos.map(item => item.id))
      const remaining = Object.values(draft.items).filter(item => item.folderId === id).length
      if (!remaining) {
        draft.folders = draft.folders.filter(folder => folder.id !== id)
        if (draft.organizeUndo?.folderId === id) draft.organizeUndo = null
      }
      return { removedIds, remaining, folderRemoved: !remaining }
    }, result => this.forgetRecent(result))
  }

  externalTracks(id) {
    return this.externalTrackOptions(id).map(track => track.file)
  }

  externalTrackOptions(id) {
    return (this.state.tracks[id] || []).map(track => {
      if (typeof track === 'string') return { file: track, label: path.basename(track) }
      const file = assetFile(this.mediaRoot, track.stored)
      return { file, label: track.label ?? path.basename(track.source || file) }
    })
  }

  rememberTracks(id, tracks) {
    if (!this.file(id)) throw new Error('Видео отсутствует в медиатеке.')
    return this.update(async (draft, created) => {
      const { files } = await this.copyTracks(draft, id, tracks.map(file => ({ file })), created)
      const result = tracks.map(source => files.get(pathKey(source)))
      if (result.some(file => !file)) throw new Error('Не удалось скопировать внешнюю дорожку.')
      return result
    })
  }

  async copyTracks(draft, id, candidates, created) {
    const previous = draft.tracks[id] || []
    const saved = previous.filter(track => typeof track !== 'string')
    const linked = new Set(previous.filter(track => typeof track === 'string'))
    const requested = new Map([...linked].map(file => [pathKey(file), { file }]))
    for (const candidate of candidates) requested.set(pathKey(candidate.file), candidate)
    const files = new Map()
    const restored = new Map()
    for (const track of saved) {
      const file = assetFile(this.mediaRoot, track.stored)
      files.set(pathKey(file), file)
      if (track.source) {
        const key = pathKey(track.source)
        files.set(key, file)
        const label = requested.get(key)?.label
        if (label) track.label = label
      } else {
        const label = track.label ?? path.basename(file)
        if (!restored.has(label)) restored.set(label, [])
        restored.get(label).push({ track, file })
      }
    }
    let skipped = 0
    const unresolved = []
    for (const { file: source, label = path.basename(source) } of requested.values()) {
      const key = pathKey(source)
      if (!path.isAbsolute(source) || !trackKind(source) || files.has(key)) continue
      const details = await fileStat(source)
      if (!details) {
        if (linked.has(source)) unresolved.push(source)
        skipped += 1
        continue
      }
      // A portable backup drops source paths. Reuse a restored copy only after comparing its bytes.
      let hash
      for (const { track, file } of restored.get(label) ?? []) {
        if (track.source || extension(file) !== extension(source) || (await fileStat(file))?.size !== details.size) continue
        hash ??= await fileChecksum(source, details.size)
        if (hash !== await fileChecksum(file, details.size)) continue
        track.source = source
        files.set(key, file)
        break
      }
      if (files.has(key)) continue
      const stored = assetName('Tracks', path.basename(source))
      await copyOriginal(source, this.mediaRoot, stored, { created })
      saved.push({ stored, source, label })
      files.set(key, assetFile(this.mediaRoot, stored))
    }
    if (saved.length || unresolved.length) draft.tracks[id] = [...saved, ...unresolved]
    return { files, skipped }
  }

  async exportBackup(folder, progress) {
    const parent = await realpath(folder)
    if (isWithin(await realpath(this.mediaRoot), parent)) throw new Error('Выберите место для копии за пределами папки с оригиналами Folio.')
    await this.migrate()
    await Promise.all([this.flushRecent(), this.flushPlayback()])
    const { items, collections, folders, favorites, recent, tracks, trash, playback } = this.state
    const makeRecord = (item, favorite, openedAt, attachments) => {
      if (!item.stored || attachments.some(track => typeof track === 'string')) {
        throw new Error('Часть оригиналов или дорожек недоступна. Подключите их папки и повторите создание копии.')
      }
      return {
        item: { ...item, file: assetFile(this.mediaRoot, item.stored), favorite, openedAt, playback: playback[item.id],
          series: item.series ?? (item.kind === 'video' && item.file ? describeSeriesEpisode(item.filename, path.dirname(item.file), digest) : undefined) },
        tracks: attachments.map(({ stored, label }) => ({ stored, label, file: assetFile(this.mediaRoot, stored) })),
      }
    }
    const records = Object.values(items).map(item => makeRecord(item, Boolean(favorites[item.id]), recent[item.id] ?? 0, tracks[item.id] ?? []))
    const deleted = Object.values(trash).map(({ item, favorite, openedAt, deletedAt, collections: memberships }) => ({
      ...makeRecord(item, favorite, openedAt, []), deletedAt, collections: memberships,
    }))
    if (!records.length && !deleted.length) throw new Error('Добавьте файлы, чтобы создать резервную копию.')
    return writeBackup(parent, records, collections, folders, progress, deleted)
  }

  async restoreBackup(folder, progress) {
    const backup = await readBackup(folder)
    return this.update(async (draft, created) => {
      await inBatches([...backup.assets], ([stored, asset]) =>
        copyOriginal(asset.file, this.mediaRoot, stored, { created, size: asset.size, sha256: asset.sha256, reuse: true }), progress)
      const byStorage = new Map(Object.values(draft.items).filter(item => item.stored).map(item => [item.stored, item.id]))
      const deletedByStorage = new Map(Object.values(draft.trash).map(({ item }) => [item.stored, item.id]))
      const ids = new Map()
      const allocate = id => draft.items[id] || draft.trash[id] ? randomUUID().replaceAll('-', '') : id
      const fromBackup = (record, id) => {
        const { stored, filename, folderId, folderName, modifiedAt, size } = record
        return { id, stored, filename, name: path.parse(filename).name, folderId, folderName,
          kind: mediaKind(filename), ext: extension(filename), modifiedAt, size, ...portableMetadata(record),
          photoIndexed: Boolean(record.width && record.height) }
      }
      let added = 0
      for (const record of backup.items) {
        const { id, stored, favorite, openedAt, tracks, playback } = record
        let local = byStorage.get(stored)
        if (!local) {
          const previouslyDeleted = deletedByStorage.get(stored)
          local = previouslyDeleted ?? allocate(id)
          const previousFile = previouslyDeleted ? draft.trash[previouslyDeleted].item.file : undefined
          draft.items[local] = { ...fromBackup(record, local), file: previousFile }
          if (previouslyDeleted) delete draft.trash[previouslyDeleted]
          byStorage.set(stored, local)
          added += 1
        } else {
          const item = draft.items[local]
          const metadata = portableMetadata(record)
          for (const [key, value] of Object.entries(metadata)) if (item[key] === undefined && value !== undefined) item[key] = value
        }
        ids.set(id, local)
        delete draft.removed[local]
        if (favorite) draft.favorites[local] = true
        if (openedAt) draft.recent[local] = Math.max(draft.recent[local] ?? 0, openedAt)
        if (playback && draft.items[local].kind === 'video' && !draft.playback[local]) draft.playback[local] = normalizePlayback(playback)
        if (tracks.length) {
          const saved = draft.tracks[local] || []
          const known = new Map(saved.filter(track => typeof track !== 'string').map(track => [track.stored, track]))
          for (const { stored, label } of tracks) {
            if (!known.has(stored)) {
              const track = { stored, label }
              known.set(stored, track)
              saved.push(track)
            } else if (label && !known.get(stored).label) known.get(stored).label = label
          }
          draft.tracks[local] = saved
        }
      }
      let deletedAdded = 0
      for (const record of backup.deleted ?? []) {
        if (byStorage.has(record.stored) || deletedByStorage.has(record.stored)) continue
        const local = allocate(record.id)
        draft.trash[local] = { item: fromBackup(record, local), deletedAt: record.deletedAt,
          favorite: record.favorite, openedAt: record.openedAt, collections: record.collections }
        draft.removed[local] = true
        deletedAdded += 1
      }
      const collections = new Map(draft.collections.map(group => [group.id, group]))
      for (const group of backup.collections) {
        const members = group.members.map(id => ids.get(id))
        const existing = collections.get(group.id)
        if (existing) existing.members = [...new Set([...existing.members, ...members])]
        else draft.collections.push({ id: group.id, name: group.name, kind: 'collection', members: [...new Set(members)] })
      }
      const folders = new Set(draft.folders.map(folder => folder.id))
      for (const { id, name } of backup.folders ?? []) {
        if (!folders.has(id)) draft.folders.push({ id, name })
      }
      if (backup.items.length || deletedAdded) draft.initialized = true
      return { added, skipped: 0, ...(deletedAdded ? { deletedAdded } : {}) }
    })
  }
}
