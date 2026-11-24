import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

// Folio only installs builds published on its own GitHub Releases page. GitHub publishes a SHA-256 digest
// for every release asset, so a download is trusted only after its bytes match that digest.
export const repository = 'wasti4/folio-media-gallery'
export const releaseFeed = 'https://api.github.com/repos/' + repository + '/releases/latest'
const downloadPrefix = 'https://github.com/' + repository + '/releases/download/'
const pagePrefix = 'https://github.com/' + repository + '/releases/'
export const checkInterval = 24 * 60 * 60 * 1000
const smallestInstaller = 1024 * 1024
const largestInstaller = 2 * 1024 ** 3
const checkTimeout = 20000

const checkFailed = 'Не удалось проверить обновления.'
const downloadFailed = 'Не удалось загрузить обновление.'
const corrupted = 'Загруженное обновление повреждено. Попробуйте ещё раз.'

export function parseVersion(value) {
  const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/.exec(typeof value === 'string' ? value.trim() : '')
  return match ? match.slice(1).map(Number) : null
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error('Invalid version')
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  return 0
}

export const installerName = version => 'Folio-' + version + '-Setup.exe'

export function normalizeUpdateSettings(value) {
  const checkedAt = Number(value?.checkedAt)
  return { automatic: value?.automatic !== false, checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : 0 }
}

function sameOrigin(url, feed) {
  try { return new URL(url).origin === new URL(feed).origin } catch { return false }
}

// Returns the newer release, or null. A release whose installer cannot be verified stays visible,
// so the update can still be downloaded from its page, but Folio will not install it by itself.
export function describeRelease(release, currentVersion, feed = releaseFeed) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null
  const parts = parseVersion(release.tag_name)
  if (!parts) return null
  const version = parts.join('.')
  if (compareVersions(version, currentVersion) <= 0) return null
  const official = feed === releaseFeed
  const trusted = (url, prefix) => typeof url === 'string' && (official ? url.startsWith(prefix) : sameOrigin(url, feed))
  const asset = Array.isArray(release.assets) ? release.assets.find(entry => entry?.name === installerName(version)) : null
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(typeof asset?.digest === 'string' ? asset.digest : '')?.[1].toLowerCase()
  const size = asset?.size
  const installer = asset && sha256 && trusted(asset.browser_download_url, downloadPrefix) && Number.isSafeInteger(size) &&
    size >= smallestInstaller && size <= largestInstaller ? { name: asset.name, url: asset.browser_download_url, size, sha256 } : null
  return { version, page: trusted(release.html_url, pagePrefix) ? release.html_url : null, installer }
}

export function installerArguments(language) {
  const name = { ru: 'russian', en: 'english', 'zh-CN': 'chinesesimplified' }[language] ?? 'english'
  // RELAUNCH tells the installer to start Folio again once the files are in place.
  return ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RELAUNCH=1', '/LANG=' + name]
}

async function fileDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifiedFile(file, installer) {
  const info = await stat(file).catch(() => null)
  return info?.isFile() && info.size === installer.size && await fileDigest(file) === installer.sha256
}

export async function downloadInstaller(update, directory, { fetch, signal, progress = () => {} }) {
  const { installer } = update
  if (!installer) throw new Error(downloadFailed)
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, installer.name)
  if (await verifiedFile(target, installer)) return target
  for (const entry of await readdir(directory).catch(() => [])) {
    await rm(path.join(directory, entry), { force: true, recursive: true }).catch(() => {})
  }
  const part = target + '.part'
  try {
    const response = await fetch(installer.url, { signal, headers: { Accept: 'application/octet-stream' } })
    if (!response.ok || !response.body) throw new Error(downloadFailed)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > 0 && declared !== installer.size) throw new Error(corrupted)
    const hash = createHash('sha256')
    const handle = await open(part, 'w')
    let received = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > installer.size) {
          await reader.cancel().catch(() => {})
          throw new Error(corrupted)
        }
        hash.update(value)
        await handle.write(value)
        progress(received / installer.size)
      }
    } finally {
      await handle.close()
    }
    if (received !== installer.size || hash.digest('hex') !== installer.sha256) throw new Error(corrupted)
    await rename(part, target)
    return target
  } catch (error) {
    await rm(part, { force: true }).catch(() => {})
    throw error
  }
}

// Installers of the running version or older are leftovers of a finished update.
export async function removeFinishedDownloads(directory, currentVersion) {
  for (const entry of await readdir(directory).catch(() => [])) {
    const version = /^Folio-(\d+\.\d+\.\d+)-Setup\.exe(\.part)?$/.exec(entry)?.[1]
    if (!version || compareVersions(version, currentVersion) <= 0) {
      await rm(path.join(directory, entry), { force: true, recursive: true }).catch(() => {})
    }
  }
}

export class Updater {
  constructor({ version, fetch, directory, read, save, installable, feed = releaseFeed, now = Date.now, publish = () => {} }) {
    Object.assign(this, { version, fetch, directory, read, save, installable, feed, now, publish })
    this.state = 'idle'
    this.update = null
    this.progress = 0
    this.error = ''
    this.file = null
    this.checking = null
    this.downloading = null
    this.controller = null
    this.lastProgress = 0
  }

  get settings() { return normalizeUpdateSettings(this.read()) }

  status() {
    const { automatic, checkedAt } = this.settings
    const { update } = this
    return {
      current: this.version, automatic, checkedAt, installable: this.installable, state: this.state,
      progress: this.progress, error: this.error,
      available: update && { version: update.version, page: update.page, downloadable: Boolean(update.installer) && this.installable },
    }
  }

  emit() { this.publish(this.status()) }

  due() {
    const { automatic, checkedAt } = this.settings
    const now = this.now()
    return automatic && (now - checkedAt >= checkInterval || checkedAt > now)
  }

  async tick() {
    if (!this.due() || ['checking', 'downloading', 'ready'].includes(this.state)) return this.status()
    return this.check()
  }

  check() {
    if (this.checking) return this.checking
    if (this.state === 'downloading' || this.state === 'ready') return Promise.resolve(this.status())
    this.state = 'checking'
    this.error = ''
    this.emit()
    this.checking = (async () => {
      try {
        const response = await this.fetch(this.feed, {
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          signal: AbortSignal.timeout(checkTimeout),
        })
        // A repository without published releases answers 404, which simply means there is nothing newer.
        const release = response.status === 404 ? null : response.ok ? await response.json() : undefined
        if (release === undefined) throw new Error(checkFailed)
        this.update = describeRelease(release, this.version, this.feed)
        this.state = this.update ? 'available' : 'current'
        await this.save({ ...this.settings, checkedAt: this.now() })
      } catch {
        this.state = 'error'
        this.error = checkFailed
      } finally {
        this.checking = null
        this.emit()
      }
      return this.status()
    })()
    return this.checking
  }

  download() {
    if (this.state === 'ready') return Promise.resolve(this.status())
    if (this.downloading) return this.downloading
    if (!this.installable || !this.update?.installer) return Promise.reject(new Error('Это обновление можно скачать только со страницы выпуска.'))
    const controller = new AbortController()
    this.controller = controller
    this.state = 'downloading'
    this.progress = 0
    this.error = ''
    this.emit()
    const progress = fraction => {
      this.progress = fraction
      const now = Date.now()
      if (now - this.lastProgress >= 150) {
        this.lastProgress = now
        this.emit()
      }
    }
    this.downloading = downloadInstaller(this.update, this.directory, { fetch: this.fetch, signal: controller.signal, progress })
      .then(file => {
        this.file = file
        this.state = 'ready'
        this.progress = 1
      }, error => {
        this.state = 'available'
        this.progress = 0
        if (!controller.signal.aborted) this.error = error.message === corrupted ? corrupted : downloadFailed
      })
      .finally(() => {
        this.downloading = null
        this.controller = null
        this.emit()
      })
      .then(() => this.status())
    return this.downloading
  }

  cancel() {
    this.controller?.abort()
  }

  // The verified installer to run on quit, or null.
  readyInstaller() {
    return this.state === 'ready' ? this.file : null
  }

  async setAutomatic(value) {
    await this.save({ ...this.settings, automatic: value === true })
    this.emit()
    return this.status()
  }
}
