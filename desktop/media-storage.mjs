import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const badCharacters = /[<>:"/\\|?*\u0000-\u001f\u007f]/
const reservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

function portableSegment(value) {
  return value.length > 0 && value.length <= 120 && !badCharacters.test(value) &&
    !/[ .]$/.test(value) && !reservedName.test(value)
}

function cleanSegment(value, limit) {
  const clean = value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim()
  const shortened = Array.from(clean).slice(0, limit).join('').replace(/[ .]+$/, '') || 'Медиа'
  return reservedName.test(shortened) ? '_' + shortened : shortened
}

export function assetName(folder, filename) {
  const suffix = path.extname(filename)
  const name = cleanSegment(path.basename(filename, suffix), 45) + suffix.toLowerCase()
  return folder + '/' + randomUUID().replaceAll('-', '') + '/' + name
}

export function assetFolder(name, id) {
  return cleanSegment(name, 27) + '-' + id.slice(-8)
}

export function isAssetName(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length === 3 && /^[a-f0-9]{32}$/.test(parts[1]) && parts.every(portableSegment)
}

export function assetFile(root, name) {
  if (!isAssetName(name)) throw new Error('Недопустимый путь к файлу в медиатеке.')
  return path.join(root, ...name.split('/'))
}

export function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

export async function readJson(file) {
  if (!file) return null
  const data = await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return data === null ? null : JSON.parse(data)
}

export async function writeJson(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp'
  await mkdir(path.dirname(file), { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function inBatches(entries, task, progress = () => {}) {
  progress(0, entries.length)
  let next = 0
  let done = 0
  let failure
  async function work() {
    while (!failure && next < entries.length) {
      try {
        await task(entries[next++])
        progress(++done, entries.length)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  // Let in-flight writes finish before the caller rolls back a failed operation.
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, work))
  if (failure) throw failure.error
}

export async function fileChecksum(file, size) {
  const hash = createHash('sha256')
  if (size <= 64 * 1024) hash.update(await readFile(file))
  else for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function copyOriginal(source, root, relative, { created, size, sha256, verify = false, reuse = false, optional = false,
  integrityError = 'Файл в резервной копии повреждён.' } = {}) {
  const before = await stat(source).catch(() => null)
  if (!before?.isFile() && optional) return null
  if (!before?.isFile()) throw new Error('Недоступен файл «' + path.basename(source) + '». Подключите диск и повторите.')
  const invalid = () => new Error(integrityError)
  if (size !== undefined && size !== before.size) throw invalid()
  const target = await prepareAsset(root, relative)

  const existing = await lstat(target).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    const collision = () => new Error('В хранилище уже есть другой файл с этим именем.')
    if (!reuse || !existing.isFile() || before.size !== existing.size) throw collision()
    const [sourceHash, targetHash] = await Promise.all([fileChecksum(source, before.size), fileChecksum(target, existing.size)])
    if (sha256 && sourceHash !== sha256) throw invalid()
    if (sourceHash !== targetHash) throw collision()
    return before
  }

  const temporary = path.join(path.dirname(target), randomUUID() + '.part')
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    const [after, copy] = await Promise.all([stat(source), stat(temporary)])
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || copy.size !== before.size) {
      throw new Error('Файл «' + path.basename(source) + '» изменился во время копирования. Повторите операцию.')
    }
    const digest = verify || sha256 ? await fileChecksum(temporary, copy.size) : undefined
    if (sha256 && digest !== sha256) throw invalid()
    await rename(temporary, target)
    created?.push(target)
    return { size: before.size, mtimeMs: before.mtimeMs, sha256: digest }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function prepareAsset(root, relative) {
  const target = assetFile(root, relative)
  const parent = path.dirname(target)
  await mkdir(parent, { recursive: true })
  const [resolvedRoot, resolvedParent] = await Promise.all([realpath(root), realpath(parent)])
  if (!isWithin(resolvedRoot, resolvedParent)) throw new Error('Папка файла находится за пределами хранилища.')
  return target
}
