import { lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { mediaKind, trackKind } from '../shared/formats.mjs'
import { normalizeTags } from '../shared/library-search.mjs'
import { assetFile, copyOriginal, inBatches, isAssetName, isWithin, readJson, writeJson } from './media-storage.mjs'
import { normalizePlayback } from './playback-progress.mjs'

export const backupManifest = 'folio-library.json'
const format = 'folio-library'
const invalid = () => new Error('Эта папка не содержит целой резервной копии Folio.')
const itemId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const folderId = value => typeof value === 'string' && /^folder-[a-f0-9]{32}$/.test(value)
const collectionId = value => typeof value === 'string' && /^collection-[a-f0-9-]{36}$/.test(value)
const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0')
const validTime = value => Number.isFinite(value) && Math.abs(value) <= 8.64e15

export function portableMetadata(item) {
  const series = item.series
  const dimensions = value => Number.isSafeInteger(value) && value > 0 && value <= 2 ** 24 ? value : undefined
  return {
    capturedAt: validTime(item.capturedAt) ? item.capturedAt : undefined,
    width: dimensions(item.width),
    height: dimensions(item.height),
    tags: item.tags ? normalizeTags(item.tags) : undefined,
    series: series && itemId(series.key) && validText(series.title, 255) &&
      Number.isFinite(series.season) && Number.isFinite(series.episode) ? {
        key: series.key, title: series.title, season: series.season, episode: series.episode,
        special: series.special === true || undefined,
      } : undefined,
  }
}

export async function writeBackup(parent, records, collections, folders, progress, deleted = []) {
  const date = new Date().toLocaleDateString('sv-SE')
  const directory = await mkdtemp(path.join(parent, 'Folio-' + date + '-'))
  const root = path.join(directory, 'Media')
  try {
    const assets = new Map()
    for (const { item, tracks } of [...records, ...deleted]) {
      assets.set(item.stored, item.file)
      for (const track of tracks) assets.set(track.stored, track.file)
    }
    const metadata = new Map()
    await inBatches([...assets], async ([stored, source]) => {
      const { size, sha256 } = await copyOriginal(source, root, stored, { verify: true })
      metadata.set(stored, { size, sha256 })
    }, progress)

    const ids = new Set(records.map(({ item }) => item.id))
    function savedRecord({ item, tracks }) {
      return {
        id: item.id,
        filename: item.filename,
        folderId: item.folderId,
        folderName: item.folderName,
        modifiedAt: item.modifiedAt,
        stored: item.stored,
        ...metadata.get(item.stored),
        favorite: item.favorite,
        openedAt: item.openedAt,
        ...portableMetadata(item),
        playback: item.playback ? normalizePlayback(item.playback) : undefined,
        tracks: tracks.map(({ stored, label }) => ({ stored, label, ...metadata.get(stored) })),
      }
    }
    await writeJson(path.join(directory, backupManifest), {
      format,
      version: 2,
      items: records.map(savedRecord),
      deleted: deleted.map(record => ({ ...savedRecord(record), deletedAt: record.deletedAt, collections: record.collections })),
      collections: collections.map(({ id, name, members }) => ({ id, name, members: members.filter(id => ids.has(id)) })),
      folders: folders.map(({ id, name }) => ({ id, name })),
    })
    return { directory, count: records.length + deleted.length }
  } catch (error) {
    const resolved = await realpath(directory).catch(() => null)
    if (resolved === directory && path.dirname(resolved) === parent) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
    throw error
  }
}

export async function readBackup(folder) {
  const directory = await realpath(folder)
  const index = path.join(directory, backupManifest)
  if (!(await lstat(index).catch(() => null))?.isFile()) throw invalid()
  const manifest = await readJson(index).catch(() => { throw invalid() })
  if (manifest?.format !== format || ![1, 2].includes(manifest.version) ||
      !Array.isArray(manifest.items) || !Array.isArray(manifest.collections) ||
      (manifest.deleted !== undefined && !Array.isArray(manifest.deleted))) throw invalid()

  const ids = new Set()
  const media = new Set()
  const assets = new Map()

  function addAsset(entry) {
    if (!isAssetName(entry?.stored) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw invalid()
    const sha256 = manifest.version === 2 ? entry.sha256 : undefined
    const previous = assets.get(entry.stored)
    if (manifest.version === 2 && !checksum(sha256)) throw invalid()
    if (previous && (previous.size !== entry.size || previous.sha256 !== sha256)) throw invalid()
    assets.set(entry.stored, { size: entry.size, sha256 })
  }

  function readRecord(item) {
    addAsset(item)
    const kind = mediaKind(typeof item.filename === 'string' ? item.filename : '')
    if (!itemId(item.id) || ids.has(item.id) || media.has(item.stored) ||
      !validText(item.filename, 255) || /[/\\]/.test(item.filename) || !kind || kind !== mediaKind(item.stored) ||
      !folderId(item.folderId) ||
      !validText(item.folderName, 255) || !validTime(item.modifiedAt) || !validTime(item.openedAt) ||
      typeof item.favorite !== 'boolean' || !Array.isArray(item.tracks)) throw invalid()
    ids.add(item.id)
    media.add(item.stored)
    for (const track of item.tracks) {
      addAsset(track)
      if (!trackKind(track.stored) || (track.label !== undefined && !validText(track.label, 255))) throw invalid()
    }
  }
  for (const item of manifest.items) readRecord(item)
  const activeIds = new Set(ids)
  for (const item of manifest.deleted ?? []) {
    readRecord(item)
    if (mediaKind(item.filename) !== 'photo' || !validTime(item.deletedAt) ||
        !Array.isArray(item.collections) || !item.collections.every(collectionId)) throw invalid()
  }

  const collectionIds = new Set()
  for (const collection of manifest.collections) {
    if (!collectionId(collection?.id) ||
      collectionIds.has(collection.id) || !validText(collection.name, 70) ||
      !Array.isArray(collection.members) || !collection.members.every(id => activeIds.has(id))) throw invalid()
    collectionIds.add(collection.id)
  }

  if (manifest.folders !== undefined) {
    if (!Array.isArray(manifest.folders)) throw invalid()
    const unique = new Set()
    for (const folder of manifest.folders) {
      if (!folderId(folder?.id) || unique.has(folder.id) || !validText(folder.name, 255)) throw invalid()
      unique.add(folder.id)
    }
  }

  const root = path.join(directory, 'Media')
  await inBatches([...assets], async ([stored, asset]) => {
    const file = await realpath(assetFile(root, stored)).catch(() => { throw invalid() })
    const info = await stat(file).catch(() => null)
    if (!isWithin(root, file) || !info?.isFile() || info.size !== asset.size) throw invalid()
    asset.file = file
  })
  return { ...manifest, assets }
}
