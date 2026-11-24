import { watch as watchTree } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { extension, mediaKind } from '../shared/formats.mjs'

const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file
export const watchLimit = 12

export function normalizeWatchedFolders(value) {
  const seen = new Set()
  const folders = []
  for (const entry of Array.isArray(value) ? value : []) {
    const folder = typeof entry === 'string' ? entry : entry?.path
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || seen.has(pathKey(folder))) continue
    seen.add(pathKey(folder))
    const addedAt = Number(entry?.addedAt)
    folders.push({ path: folder, addedAt: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : 0 })
    if (folders.length === watchLimit) break
  }
  return folders
}

// Events name the changed entry. A name without an extension may be a folder moved in as a whole,
// so only names with a non-media extension, such as browser downloads in progress, are ignored.
export function relevantChange(name) {
  if (typeof name !== 'string' || !name) return true
  return !extension(name) || Boolean(mediaKind(name))
}

// A file counts as written once its size and modification time match the previous look and another
// program no longer holds it open exclusively.
async function fingerprint(file) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return null
  const handle = await open(file, 'r').catch(error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code) ? false : null)
  if (handle === false) return 'busy'
  await handle?.close().catch(() => {})
  return info.size + ':' + info.mtimeMs
}

function defaultWatch(folder, listener) {
  return watchTree(folder, { recursive: true }, listener)
}

export class FolderWatcher {
  constructor({ read, save, scan, sync, available, publish = () => {}, notify = () => {}, activity = () => {},
    watch = defaultWatch, settle = 2500, rescan = 15 * 60_000, retry = 60_000, busyRetry = 3000, now = Date.now }) {
    Object.assign(this, { read, save, scan, sync, available, publish, notify, activity, watch, settle, rescan, retry, busyRetry, now })
    this.entries = new Map()
    this.stopped = true
    this.rescanTimer = null
    this.retryTimer = null
  }

  folders() { return normalizeWatchedFolders(this.read()) }

  entry(folder) {
    const key = pathKey(folder)
    if (!this.entries.has(key)) {
      this.entries.set(key, { path: folder, watcher: null, timer: null, running: null, again: false, error: '', seen: new Map(), lastAdded: 0 })
    }
    return this.entries.get(key)
  }

  status() {
    return this.folders().map(({ path: folder }) => {
      const entry = this.entries.get(pathKey(folder))
      return { path: folder, name: path.basename(folder) || folder, watching: Boolean(entry?.watcher), error: entry?.error ?? '',
        lastAdded: entry?.lastAdded ?? 0 }
    })
  }

  emit() { this.publish(this.status()) }

  start() {
    if (!this.stopped) return
    this.stopped = false
    for (const { path: folder } of this.folders()) {
      this.open(folder)
      this.schedule(folder, 0)
    }
    this.rescanTimer = setInterval(() => {
      for (const { path: folder } of this.folders()) this.schedule(folder, 0)
    }, this.rescan)
    this.retryTimer = setInterval(() => this.reopen(), this.retry)
    this.emit()
  }

  stop() {
    this.stopped = true
    clearInterval(this.rescanTimer)
    clearInterval(this.retryTimer)
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer)
      entry.timer = null
      this.close(entry)
    }
  }

  open(folder) {
    const entry = this.entry(folder)
    if (entry.watcher || this.stopped) return
    try {
      const watcher = this.watch(folder, (type, name) => {
        if (relevantChange(name)) this.schedule(folder, this.settle)
      })
      watcher.on?.('error', () => {
        if (entry.watcher !== watcher) return
        this.close(entry)
        entry.error = 'unavailable'
        this.emit()
      })
      entry.watcher = watcher
      entry.error = ''
    } catch {
      entry.error = 'unavailable'
    }
  }

  close(entry) {
    const { watcher } = entry
    entry.watcher = null
    try { watcher?.close() } catch { /* Already closed. */ }
  }

  // A folder on a disconnected drive comes back once it can be watched again.
  reopen() {
    let changed = false
    for (const { path: folder } of this.folders()) {
      const entry = this.entry(folder)
      if (entry.watcher) continue
      this.open(folder)
      if (entry.watcher) {
        changed = true
        this.schedule(folder, 0)
      }
    }
    if (changed) this.emit()
  }

  schedule(folder, delay) {
    if (this.stopped) return
    const entry = this.entry(folder)
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.run(folder).catch(() => {})
    }, delay)
  }

  async run(folder) {
    const entry = this.entry(folder)
    if (this.stopped || !this.folders().some(item => pathKey(item.path) === pathKey(folder))) return
    if (entry.running) {
      entry.again = true
      return
    }
    if (!this.available()) {
      this.schedule(folder, this.busyRetry)
      return
    }
    const done = Promise.withResolvers()
    entry.running = done.promise
    let settledAgain = false
    try {
      const files = await this.scan(folder)
      const seen = new Map()
      const ready = []
      for (const file of files) {
        const mark = await fingerprint(file)
        if (!mark) continue
        seen.set(pathKey(file), mark)
        if (mark !== 'busy' && entry.seen.get(pathKey(file)) === mark) ready.push(file)
        else settledAgain = true
      }
      entry.seen = seen
      if (!ready.length || this.stopped) return
      if (!this.available()) {
        settledAgain = true
        return
      }
      this.activity(folder, true)
      let result
      try {
        result = await this.sync(folder, ready)
      } finally {
        this.activity(folder, false)
      }
      for (const file of ready) entry.seen.delete(pathKey(file))
      if (entry.error === 'failed') entry.error = ''
      if (result?.added) {
        entry.lastAdded = this.now()
        this.notify({ folder, name: path.basename(folder) || folder, ...result })
      }
    } catch (error) {
      if (!entry.watcher) entry.error = 'unavailable'
      else entry.error = 'failed'
      console.error('Could not import from a watched folder:', error.message)
      this.schedule(folder, this.retry)
    } finally {
      entry.running = null
      done.resolve()
      if (entry.again) {
        entry.again = false
        this.schedule(folder, this.settle)
      } else if (settledAgain) this.schedule(folder, this.settle)
      this.emit()
    }
  }

  async add(folder) {
    const folders = this.folders()
    if (!folders.some(entry => pathKey(entry.path) === pathKey(folder))) {
      if (folders.length >= watchLimit) throw new Error('Folio может следить не больше чем за 12 папками.')
      await this.save([...folders, { path: folder, addedAt: this.now() }])
    }
    this.open(folder)
    this.emit()
    return this.status()
  }

  async remove(folder) {
    if (typeof folder !== 'string') return this.status()
    const key = pathKey(folder)
    const folders = this.folders()
    const remaining = folders.filter(entry => pathKey(entry.path) !== key)
    const entry = this.entries.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      this.close(entry)
      await entry.running
      this.entries.delete(key)
    }
    if (remaining.length !== folders.length) await this.save(remaining)
    this.emit()
    return this.status()
  }
}
