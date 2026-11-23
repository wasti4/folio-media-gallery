import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { readJson, writeJson } from './media-storage.mjs'
import { extension } from '../shared/formats.mjs'

const derive = promisify(scrypt)
const format = Buffer.from('FOLIOPV1')
const saltLength = 16
const nonceLength = 12
const tagLength = 16
const overhead = nonceLength + tagLength
const headerLength = format.length + saltLength
const maxCatalog = 16 * 1024 * 1024
const maxPhoto = 64 * 1024 * 1024
const lockAfter = 5 * 60 * 1000
const catalogName = 'vault.dat'
const writeLockName = '.write-lock'
const photoId = /^[a-f0-9]{32}$/
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const pngPrefix = 'data:image/png;base64,'
const types = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon',
})
export const privatePhotoExtensions = Object.keys(types)

export class VaultError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

async function keyFor(password, salt, creating = false) {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024 ||
      (creating && Array.from(password).length < 12)) {
    throw new VaultError(creating ? 'PASSWORD_LENGTH' : 'UNLOCK_FAILED')
  }
  const secret = Buffer.from(password, 'utf8')
  try {
    return await derive(secret, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  } finally {
    secret.fill(0)
  }
}

function associatedData(salt, record) {
  return Buffer.concat([format, salt, Buffer.from(record, 'ascii')])
}

function seal(key, salt, record, data) {
  const nonce = randomBytes(nonceLength)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagLength })
  cipher.setAAD(associatedData(salt, record))
  const ciphertext = cipher.update(data)
  return Buffer.concat([nonce, ciphertext, cipher.final(), cipher.getAuthTag()])
}

function unseal(key, salt, record, data) {
  if (data.length < overhead) throw new Error('Truncated vault record')
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, nonceLength), { authTagLength: tagLength })
  cipher.setAAD(associatedData(salt, record))
  cipher.setAuthTag(data.subarray(-tagLength))
  const plaintext = cipher.update(data.subarray(nonceLength, -tagLength))
  try {
    cipher.final()
    return plaintext
  } catch (error) {
    plaintext.fill(0)
    throw error
  }
}

async function readLimited(file, limit) {
  const handle = await open(file, 'r')
  let data
  try {
    const details = await handle.stat()
    const { size } = details
    if (!details.isFile() || !size || size > limit) throw new Error('Invalid vault file size')
    data = Buffer.allocUnsafe(size)
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(data, offset, size - offset, offset)
      if (!bytesRead) throw new Error('Incomplete vault file')
      offset += bytesRead
    }
    return data
  } catch (error) {
    data?.fill(0)
    throw error
  } finally {
    await handle.close()
  }
}

const remove = file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
const revision = data => createHash('sha256').update(data).digest('hex')

async function writeNew(file, data) {
  const handle = await open(file, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await remove(file).catch(() => {})
    throw error
  }
}

function packCatalog({ key, salt }, items) {
  const data = Buffer.from(JSON.stringify(items))
  try {
    if (data.length > maxCatalog) throw new VaultError('CATALOG_FULL')
    return Buffer.concat([format, salt, seal(key, salt, 'catalog', data)])
  } finally {
    data.fill(0)
  }
}

function parseCatalog(data) {
  const items = JSON.parse(data.toString('utf8'))
  const seen = new Set()
  if (!Array.isArray(items)) throw new Error('Invalid vault catalog')
  for (const item of items) {
    if (typeof item?.id !== 'string' || !photoId.test(item.id) || seen.has(item.id) ||
        typeof item.name !== 'string' || !item.name || path.basename(item.name) !== item.name ||
        !Object.hasOwn(types, extension(item.name))) throw new Error('Invalid vault entry')
    seen.add(item.id)
  }
  return items
}

export class PrivateVault {
  static async open(pointer, onLocked) {
    const entry = await readJson(pointer).catch(() => ({}))
    const directory = typeof entry?.directory === 'string' && path.isAbsolute(entry.directory) ? entry.directory : null
    return new PrivateVault(pointer, directory, entry !== null, onLocked)
  }

  #session = null
  #timer
  #pending = null
  #readingThumbnail = false
  #epoch = 0

  constructor(pointer, directory, configured, onLocked) {
    this.pointer = pointer
    this.directory = directory
    this.configured = configured
    this.onLocked = onLocked
  }

  get generation() { return this.#epoch }

  status() {
    return {
      configured: this.configured, unlocked: Boolean(this.#session),
      items: this.#session?.items.map(({ id, name }) => ({ id, name })) ?? [],
      ...(this.#session && { generation: this.#epoch }),
    }
  }

  lock() {
    this.#epoch++
    clearTimeout(this.#timer)
    this.#session?.key.fill(0)
    this.#session = null
    this.onLocked?.()
  }

  #assertEpoch(epoch) {
    if (epoch !== this.#epoch) throw new VaultError('LOCKED')
  }

  #touch() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.lock(), lockAfter).unref()
  }

  #require() {
    if (!this.#session) throw new VaultError('LOCKED')
    this.#touch()
    return this.#session
  }

  async #exclusive(action) {
    if (this.#pending) throw new VaultError('BUSY')
    const epoch = this.#epoch
    this.#pending = Promise.resolve().then(() => action(epoch))
    try {
      return await this.#pending
    } finally {
      this.#pending = null
    }
  }

  settle() { return this.#pending?.catch(() => {}) }

  async #setDirectory(directory) {
    await writeJson(this.pointer, { directory })
    this.directory = directory
    this.configured = true
  }

  #activate(session, epoch) {
    this.#assertEpoch(epoch)
    this.#session?.key.fill(0)
    this.#session = session
    this.#touch()
    return this.status()
  }

  async create(parent, password) {
    return this.#exclusive(async epoch => {
      if (this.configured) throw new VaultError('EXISTS')
      const salt = randomBytes(saltLength)
      const key = await keyFor(password, salt, true)
      const session = { key, salt, items: [] }
      let directory
      try {
        const target = path.join(await realpath(parent), 'Folio Private')
        this.#assertEpoch(epoch)
        await mkdir(target, { mode: 0o700 }).catch(error => {
          if (error.code === 'EEXIST') throw new VaultError('EXISTS')
          throw error
        })
        directory = target
        const encrypted = packCatalog(session, [])
        await writeNew(path.join(directory, catalogName), encrypted)
        session.revision = revision(encrypted)
        this.#assertEpoch(epoch)
        await this.#setDirectory(directory)
        return this.#activate(session, epoch)
      } finally {
        if (this.#session !== session) {
          key.fill(0)
          if (directory && this.directory !== directory) {
            await remove(path.join(directory, catalogName)).catch(() => {})
            await rmdir(directory).catch(() => {})
          }
        }
      }
    })
  }

  async #openCatalog(directory, password, epoch) {
    let key
    try {
      if (!directory) throw new Error('Vault unavailable')
      const data = await readLimited(path.join(directory, catalogName), headerLength + overhead + maxCatalog)
      if (!data.subarray(0, format.length).equals(format) || data.length <= headerLength + overhead) {
        throw new Error('Unknown vault format')
      }
      const salt = data.subarray(format.length, headerLength)
      key = await keyFor(password, salt)
      this.#assertEpoch(epoch)
      const plaintext = unseal(key, salt, 'catalog', data.subarray(headerLength))
      try {
        return { key, salt, items: parseCatalog(plaintext), revision: revision(data) }
      } finally {
        plaintext.fill(0)
      }
    } catch (error) {
      key?.fill(0)
      if (error.code === 'LOCKED') throw error
      throw new VaultError('UNLOCK_FAILED')
    }
  }

  async connect(parent, password) {
    return this.#exclusive(async epoch => {
      if (this.#session) throw new VaultError('BUSY')
      const directory = await realpath(parent)
      const session = await this.#openCatalog(directory, password, epoch)
      try {
        this.#assertEpoch(epoch)
        await this.#setDirectory(directory)
        return this.#activate(session, epoch)
      } finally {
        if (this.#session !== session) session.key.fill(0)
      }
    })
  }

  async unlock(password) {
    return this.#exclusive(async epoch => {
      if (this.#session) return this.status()
      const session = await this.#openCatalog(this.directory, password, epoch)
      try {
        return this.#activate(session, epoch)
      } finally {
        if (this.#session !== session) session.key.fill(0)
      }
    })
  }

  async #commit(session, items, epoch) {
    const file = path.join(this.directory, catalogName)
    const temporary = file + '.' + randomUUID() + '.tmp'
    const lockFile = path.join(this.directory, writeLockName)
    const lock = await open(lockFile, 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') throw new VaultError('IN_USE')
      throw error
    })
    try {
      const current = await readLimited(file, headerLength + overhead + maxCatalog)
      if (revision(current) !== session.revision) throw new VaultError('CHANGED')
      this.#assertEpoch(epoch)
      const encrypted = packCatalog(session, items)
      await writeNew(temporary, encrypted)
      this.#assertEpoch(epoch)
      await rename(temporary, file)
      session.items = items
      session.revision = revision(encrypted)
    } finally {
      await remove(temporary).catch(() => {})
      await lock.close().catch(() => {})
      await remove(lockFile).catch(() => {})
    }
  }

  async #writePhoto(session, name, data) {
    const id = randomUUID().replaceAll('-', '')
    await writeNew(path.join(this.directory, id + '.bin'), seal(session.key, session.salt, 'photo:' + id, data))
    return { id, name }
  }

  async addFiles(files) {
    return this.#exclusive(async epoch => {
      const session = this.#require()
      const created = []
      const items = []
      let skipped = 0
      try {
        for (const file of files) {
          this.#assertEpoch(epoch)
          const name = path.basename(file)
          const data = Object.hasOwn(types, extension(name)) ? await readLimited(file, maxPhoto).catch(() => null) : null
          if (!data) {
            skipped++
            continue
          }
          try {
            this.#assertEpoch(epoch)
            const item = await this.#writePhoto(session, name, data)
            items.push(item)
            created.push(path.join(this.directory, item.id + '.bin'))
          } finally {
            data.fill(0)
          }
        }
        this.#assertEpoch(epoch)
        if (items.length) await this.#commit(session, [...session.items, ...items], epoch)
      } catch (error) {
        for (const file of created) await remove(file).catch(() => {})
        throw error
      }
      if (this.#session === session) this.#touch()
      return { ...this.status(), added: items.length, skipped }
    })
  }

  async readImage(id) {
    return this.#exclusive(epoch => this.#readPhoto(id, epoch, maxPhoto, (bytes, item) =>
      'data:' + types[extension(item.name)] + ';base64,' + bytes.toString('base64')))
  }

  async readThumbnail(id, preview) {
    if (this.#readingThumbnail) return ''
    this.#readingThumbnail = true
    try {
      return await this.#readPhoto(id, this.#epoch, 16 * 1024 * 1024, preview)
    } finally {
      this.#readingThumbnail = false
    }
  }

  async #readPhoto(id, epoch, limit, render) {
    const session = this.#require()
    const item = session.items.find(entry => entry.id === id)
    if (!item) throw new VaultError('MISSING_PHOTO')
    let plaintext
    try {
      const record = await readLimited(path.join(this.directory, item.id + '.bin'), limit + overhead)
      this.#assertEpoch(epoch)
      plaintext = unseal(session.key, session.salt, 'photo:' + item.id, record)
      return render(plaintext, item)
    } catch (error) {
      if (error.code === 'LOCKED') throw error
      throw new VaultError('PHOTO_DAMAGED')
    } finally {
      plaintext?.fill(0)
    }
  }

  async saveCopy(id, source, generation) {
    return this.#exclusive(async epoch => {
      this.#assertEpoch(generation)
      const session = this.#require()
      const original = session.items.find(entry => entry.id === id)
      if (!original) throw new VaultError('MISSING_PHOTO')
      if (typeof source !== 'string' || !source.startsWith(pngPrefix) ||
          source.length > pngPrefix.length + Math.ceil(maxPhoto / 3) * 4) throw new VaultError('EDIT_LIMIT')
      const bytes = Buffer.from(source.slice(pngPrefix.length), 'base64')
      let copy
      try {
        if (!bytes.subarray(0, pngHeader.length).equals(pngHeader) || bytes.length > maxPhoto) throw new VaultError('EDIT_LIMIT')
        const name = path.parse(original.name).name + ' (edit).png'
        copy = await this.#writePhoto(session, name, bytes)
        await this.#commit(session, [...session.items, copy], epoch)
      } catch (error) {
        if (copy) await remove(path.join(this.directory, copy.id + '.bin')).catch(() => {})
        throw error
      } finally {
        bytes.fill(0)
      }
      return { ...this.status(), id: copy.id }
    })
  }

  async remove(id) {
    return this.#exclusive(async epoch => {
      const session = this.#require()
      if (!session.items.some(item => item.id === id)) throw new VaultError('MISSING_PHOTO')
      await this.#commit(session, session.items.filter(item => item.id !== id), epoch)
      const cleanupFailed = await remove(path.join(this.directory, id + '.bin')).then(() => false, () => true)
      return { ...this.status(), cleanupFailed }
    })
  }
}
