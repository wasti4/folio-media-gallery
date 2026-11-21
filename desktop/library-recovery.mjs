import { lstat, realpath, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { assetFile, inBatches, isWithin } from './media-storage.mjs'

export function detachPhotos(draft, ids, makeRecord) {
  const removed = new Map()
  for (const id of new Set(Array.isArray(ids) ? ids : [])) {
    if (typeof id !== 'string' || draft.items[id]?.kind !== 'photo') continue
    removed.set(id, makeRecord(draft.items[id], id))
    delete draft.items[id]
    delete draft.favorites[id]
    delete draft.recent[id]
    delete draft.tracks[id]
    draft.removed[id] = true
  }
  if (!removed.size) return removed
  draft.initialized = true
  draft.loose = draft.loose.filter(id => {
    const entry = removed.get(id)
    if (entry) entry.loose = true
    return !entry
  })
  for (const root of draft.roots) root.ids = root.ids.filter(id => {
    const entry = removed.get(id)
    if (entry?.roots) entry.roots.push(root.path)
    return !entry
  })
  for (const group of draft.collections) group.members = group.members.filter(id => {
    const entry = removed.get(id)
    if (entry?.collections) entry.collections.push(group.id)
    return !entry
  })
  return removed
}

export function unusedPhotoAssets(draft, photos, excludedTrash = new Set()) {
  const retained = new Set(Object.values(draft.items).map(item => item.stored))
  for (const [id, entry] of Object.entries(draft.trash)) {
    if (!excludedTrash.has(id)) retained.add(entry.item.stored)
  }
  return [...new Set(photos.map(item => item.stored).filter(stored => stored && !retained.has(stored)))]
}

export async function recycleAssets(mediaRoot, assets, recycle, progress) {
  const root = assets.length ? await realpath(mediaRoot).catch(() => null) : null
  const failed = new Set()
  await inBatches(assets, async stored => {
    try {
      const target = assetFile(mediaRoot, stored)
      const info = await lstat(target).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!info) return
      const file = await realpath(target)
      if (!root || !info.isFile() || !isWithin(root, file)) throw new Error('Папка файла находится за пределами хранилища.')
      await recycle(file)
      await rmdir(path.dirname(file)).catch(() => {})
    } catch {
      failed.add(stored)
    }
  }, progress)
  return failed
}

export function undoOrganization(draft) {
  const undo = draft.organizeUndo
  if (!undo) return 0
  draft.organizeUndo = null
  if (undo.type === 'collection') {
    const folder = draft.collections.find(group => group.id === undo.folderId)
    if (!folder) return 0
    const ids = new Set(undo.ids)
    const previous = folder.members.length
    folder.members = folder.members.filter(id => !ids.has(id))
    for (const id of ids) {
      const entry = draft.trash[id]
      if (entry) entry.collections = entry.collections.filter(folderId => folderId !== undo.folderId)
    }
    return previous - folder.members.length
  }
  let count = 0
  for (const { id, folderId, folderName } of undo.previous) {
    const item = draft.items[id] ?? draft.trash[id]?.item
    if (item?.folderId !== undo.folderId) continue
    item.folderId = folderId
    item.folderName = folderName
    count += 1
  }
  if (undo.created && !Object.values(draft.items).some(item => item.folderId === undo.folderId) &&
      !Object.values(draft.trash).some(entry => entry.item.folderId === undo.folderId)) {
    draft.folders = draft.folders.filter(folder => folder.id !== undo.folderId)
  }
  return count
}
