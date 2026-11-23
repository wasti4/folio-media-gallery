import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, protocol, screen, session, shell } from 'electron'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { audioExtensions, contentType, mediaExtensions, subtitleExtensions } from '../shared/formats.mjs'
import { introResizeDuration, normalizeTheme, productName, windowSurface } from '../shared/brand.mjs'
import { normalizeLanguage, translate } from '../shared/locale.mjs'
import { Library } from './library.mjs'
import { Playback } from './playback.mjs'
import { MediaEditor } from './editing.mjs'
import { localFileResponse } from './protocol.mjs'
import { backupSettings, createBackupSchedule } from './backup-schedule.mjs'
import { isWithin } from './media-storage.mjs'
import { PrivateVault, VaultError, privatePhotoExtensions } from './private-vault.mjs'
import { profileDirectory } from './profile.mjs'

const origin = 'folio://app'
const project = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const renderer = path.join(project, 'dist')
const introSize = { width: 760, height: 530 }
const gallerySize = { width: 1312, height: 850 }
const galleryMinimum = { width: 860, height: 590 }
const useAcrylic = process.platform === 'win32' && Number(process.getSystemVersion().split('.')[2]) >= 22621
const transparentBackground = '#00000000'
let window
let library
let playback
let editor
let vault
let storageJob
let lastBackup
let automaticBackup
let automaticBackupTimer
let pendingPlaybackFlush
let playbackFlushToken = 0
let finalizing = false
let introPending
let galleryLanding
let motionFinished
let showingIntro = false
const t = message => translate(library?.language, message)

app.setName(productName)
app.setPath('userData', profileDirectory(app.getPath('appData'), productName, process.env.FOLIO_TEST_PROFILE))
if (process.platform === 'win32') app.setAppUserModelId('local.folio.media')
protocol.registerSchemesAsPrivileged([{
  scheme: 'folio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

function register(name, handler) {
  ipcMain.handle('folio:' + name, (event, ...args) => {
    const fromWindow = event.sender === window?.webContents
    const landingState = name === 'state' && event.sender === galleryLanding?.current.webContents
    if ((!fromWindow && !landingState) ||
      !event.senderFrame?.url.startsWith(origin + '/') || event.senderFrame.parent) {
      throw new Error('Действие недоступно.')
    }
    return handler(...args)
  })
}

async function importPaths(paths) {
  if (!Array.isArray(paths)) return { state: library.snapshot(), added: 0, skipped: 0 }
  return changeLibrary(progress => library.importPaths(paths, progress, async duplicates => {
    const detail = duplicates.slice(0, 6).map(({ file }) => path.basename(file)).join('\n') + (duplicates.length > 6 ? '\n…' : '')
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', title: t('Точные дубликаты'),
      message: translate(library.language, 'Найдено {count} совпадений по содержимому.', { count: duplicates.length }),
      detail, buttons: [t('Пропустить дубликаты'), t('Импортировать все'), t('Отмена')], defaultId: 0, cancelId: 2, noLink: true,
    })
    return ['skip', 'all', 'cancel'][response] ?? 'cancel'
  }))
}

async function storageOperation(action) {
  if (storageJob) throw new Error('Дождитесь завершения текущей операции с медиатекой.')
  let last = 0
  const progress = (done, total) => {
    const now = Date.now()
    if (done === 0 || done === total || now - last >= 100) {
      last = now
      window?.webContents.send('folio:storage-progress', { done, total })
    }
  }
  const operation = Promise.resolve().then(() => action(progress))
  storageJob = operation
  try {
    return await operation
  } finally {
    storageJob = null
  }
}

async function changeLibrary(action) {
  const result = await storageOperation(action)
  return { ...result, state: library.snapshot() }
}

async function chooseFolder(title) {
  const result = await dialog.showOpenDialog(window, { title, properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
}

function publishBackupStatus() {
  if (window && !window.isDestroyed()) window.webContents.send('folio:backup-status', automaticBackup.status())
}

function requestPlaybackFlush() {
  if (pendingPlaybackFlush) return pendingPlaybackFlush.promise
  if (!window || window.isDestroyed() || !window.webContents.getURL().startsWith(origin + '/')) return Promise.resolve()
  const token = ++playbackFlushToken
  const { promise, resolve } = Promise.withResolvers()
  const timer = setTimeout(() => resolve(), 500)
  pendingPlaybackFlush = { token, promise: promise.finally(() => {
    clearTimeout(timer)
    pendingPlaybackFlush = null
  }), resolve }
  window.webContents.send('folio:prepare-playback-flush', token)
  return pendingPlaybackFlush.promise
}

function lockVault() {
  vault?.lock()
}

function registerVaultActions() {
  const action = (name, handler) => register('vault-' + name, async (...args) => {
    if (finalizing) return { error: 'LOCKED' }
    try {
      return { value: await handler(...args) }
    } catch (error) {
      return { error: error instanceof VaultError ? error.code : 'FAILED' }
    }
  })
  const pick = async (title, options) => {
    const generation = vault.generation
    const result = await dialog.showOpenDialog(window, { title: t(title), ...options })
    if (generation !== vault.generation) throw new VaultError('LOCKED')
    return result.canceled ? null : result.filePaths
  }
  const directory = ['openDirectory', 'dontAddToRecent']
  action('state', () => vault.status())
  action('create', async password => {
    const selected = await pick('Выберите место для приватной папки', { properties: directory })
    return selected?.length ? vault.create(selected[0], password) : null
  })
  action('connect', async password => {
    const selected = await pick('Выберите существующую приватную папку', { properties: directory })
    return selected?.length ? vault.connect(selected[0], password) : null
  })
  action('unlock', password => vault.unlock(password))
  action('lock', () => { lockVault(); return vault.status() })
  action('import', async () => {
    if (!vault.status().unlocked) throw new VaultError('LOCKED')
    const selected = await pick('Выберите фото для приватной папки', {
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [{ name: t('Фотографии'), extensions: privatePhotoExtensions }],
    })
    return selected?.length ? vault.addFiles(selected) : null
  })
  action('image', id => vault.readImage(id))
  action('thumbnail', id => vault.readThumbnail(id, (bytes, item) => {
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return { source: 'data:' + contentType(item.name) + ';base64,' + bytes.toString('base64') }
    const { width, height } = image.getSize()
    const scale = Math.min(1, 320 / Math.max(width, height))
    return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toDataURL()
  }))
  action('save-copy', (id, image, generation) => vault.saveCopy(id, image, generation))
  action('remove', id => vault.remove(id))
}

function registerActions() {
  register('state', () => library.snapshot())
  register('theme', theme => {
    const next = normalizeTheme(theme)
    nativeTheme.themeSource = next
    return library.setPreferences({ theme: next })
  })
  register('language', value => library.setPreferences({ language: normalizeLanguage(value) }))
  register('finish-intro', animate => {
    if (showingIntro && !introPending) {
      introPending = useAcrylic ? landIntroMotion(window, animate === true) : enterGallery(window, animate === true)
    }
    return introPending
  })
  register('warm-intro-gallery', () => {
    if (showingIntro && useAcrylic && !introPending) prepareIntroLanding(window)
  })
  register('intro-motion-finished', () => { motionFinished?.() })
  register('import', async kind => {
    const folder = kind === 'folder'
    const result = await dialog.showOpenDialog(window, {
      title: t(folder ? 'Скопировать папку в Folio' : 'Скопировать медиафайлы в Folio'),
      properties: [folder ? 'openDirectory' : 'openFile', 'multiSelections'],
      filters: folder ? undefined : [{ name: t('Фото, видео и GIF'), extensions: mediaExtensions }],
    })
    return result.canceled ? null : importPaths(result.filePaths)
  })
  register('drop', importPaths)
  register('refresh', () => changeLibrary(progress => library.refresh(progress)))
  register('migrate', () => changeLibrary(progress => library.migrate(progress)))
  register('index-photos', () => changeLibrary(progress => library.indexPhotos(progress)))
  register('library-settings', async () => ({ ...await library.storageInfo(playback.cache), backup: automaticBackup.status() }))
  register('move-library', async () => {
    const folder = await chooseFolder(t('Выберите папку для медиатеки.'))
    return folder ? changeLibrary(progress => library.moveTo(folder, progress)) : null
  })
  register('automatic-backup-folder', async () => {
    const folder = await chooseFolder(t('Выберите папку для автоматических копий'))
    if (!folder) return automaticBackup.status()
    const directory = await realpath(folder)
    if (isWithin(await realpath(library.mediaRoot), directory)) throw new Error('Выберите место для копии за пределами папки с оригиналами Folio.')
    const current = backupSettings(library.preferences.automaticBackup)
    if (directory !== current.directory) {
      await library.setPreferences({ automaticBackup: backupSettings({ directory, frequency: current.frequency }) })
    }
    return automaticBackup.status()
  })
  register('automatic-backup-frequency', async frequency => {
    const current = backupSettings(library.preferences.automaticBackup)
    if (!['off', 'daily', 'weekly'].includes(frequency) || (frequency !== 'off' && !current.directory)) {
      throw new Error('Сначала выберите папку для резервных копий.')
    }
    if (current.frequency !== frequency) {
      await library.setPreferences({ automaticBackup: { ...current, frequency, since: Date.now(), lastAttemptAt: null, lastFailure: '' } })
    }
    return automaticBackup.status()
  })
  register('backup', async () => {
    const folder = await chooseFolder(t('Выберите, куда сохранить резервную копию Folio'))
    if (!folder) return null
    const result = await storageOperation(progress => library.exportBackup(folder, progress))
    lastBackup = result.directory
    return { ...result, state: library.snapshot() }
  })
  register('restore', async () => {
    const folder = await chooseFolder(t('Выберите папку резервной копии Folio'))
    return folder ? changeLibrary(progress => library.restoreBackup(folder, progress)) : null
  })
  register('open-storage', async kind => {
    const folder = kind === 'backup' ? lastBackup : library.mediaRoot
    if (folder && await shell.openPath(folder)) throw new Error('Не удалось открыть папку.')
  })
  register('favorite', async id => {
    await library.toggleFavorite(id)
    return library.snapshot()
  })
  register('opened', id => library.markOpened(id))
  register('create-collection', async name => {
    const result = await library.createCollection(name)
    return { ...result, state: library.snapshot() }
  })
  register('toggle-collection', async (folderId, id) => {
    await library.toggleCollection(folderId, id)
    return library.snapshot()
  })
  register('remove-collection', async id => {
    await library.removeCollection(id)
    return library.snapshot()
  })
  register('remove-folder', id => changeLibrary(() => library.removeFolder(id)))
  register('remove-photo', id => changeLibrary(async () => {
    const result = await library.softDeletePhotos([id])
    return { ...result, removed: result.removedIds.length > 0 }
  }))
  register('organize-photos', (ids, destination) => changeLibrary(() => library.organizePhotos(ids, destination)))
  register('undo-organize', () => changeLibrary(() => library.undoOrganize()))
  register('set-photo-tags', async (id, tags) => {
    await library.setTags(id, tags)
    return library.snapshot()
  })
  register('remove-photos', ids => changeLibrary(() => library.softDeletePhotos(ids)))
  register('restore-deleted', ids => changeLibrary(() => library.restoreDeletedPhotos(ids)))
  register('recycle-deleted', ids => changeLibrary(async progress => {
    const previews = new Map()
    for (const id of Array.isArray(ids) ? ids : []) {
      const item = library.file(id, true)
      if (item?.kind === 'photo' && !item.demo) previews.set(id, item)
    }
    const result = await library.recycleDeletedPhotos(ids, file => shell.trashItem(file), progress)
    for (const [id, item] of previews) if (!library.file(id, true)) playback.forgetPreview(item)
    return result
  }))
  register('reveal', id => {
    const item = library.file(id)
    if (item && !item.demo) shell.showItemInFolder(item.file)
  })
  register('inspect', id => playback.inspect(id))
  register('play', (id, options) => playback.open(id, options))
  register('playback-progress', (id, patch) => library.rememberPlayback(id, patch))
  register('playback-flushed', token => { if (pendingPlaybackFlush?.token === token) pendingPlaybackFlush.resolve() })
  register('save-video-frame', (id, data) => changeLibrary(async () => {
    const source = playback.video(id)
    if (!(data instanceof Uint8Array) || data.byteLength < 33 || data.byteLength > 100 * 1024 ** 2) throw new Error('Не удалось сохранить кадр.')
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (bytes.readBigUInt64BE(0) !== 0x89504e470d0a1a0an || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) > 16384 || bytes.readUInt32BE(20) > 16384) {
      throw new Error('Не удалось сохранить кадр.')
    }
    const saved = await library.keepEdit(source, 'png', file => writeFile(file, bytes, { flag: 'wx' }), undefined, '(кадр)')
    return { id: saved }
  }))
  register('release', token => playback.release(token))
  register('edit-info', id => editor.inspect(id))
  register('edit-frame', (id, options) => editor.frame(id, options))
  register('edit-clip', (id, settings) => editor.clip(id, settings))
  register('stop-edit-preview', () => editor.stopPreview())
  register('cancel-edit-save', () => editor.cancelSave())
  register('save-edit', async (id, settings) => {
    const edited = await storageOperation(() => editor.save(id, settings, progress => {
      if (window && !window.isDestroyed()) window.webContents.send('folio:edit-progress', progress)
    }))
    return edited ? { id: edited, state: library.snapshot() } : null
  })
  register('wallpaper', id => editor.setWallpaper(id))
  register('attach', async (id, kind) => {
    if (!['audio', 'subtitle'].includes(kind)) return null
    playback.video(id)
    const audio = kind === 'audio'
    const result = await dialog.showOpenDialog(window, {
      title: t(audio ? 'Добавить аудиодорожку' : 'Добавить субтитры'),
      properties: ['openFile'],
      filters: [{ name: t(audio ? 'Аудиодорожки' : 'Текстовые субтитры'), extensions: audio ? audioExtensions : subtitleExtensions }],
    })
    if (result.canceled) return null
    return playback.attach(id, await realpath(result.filePaths[0]), kind)
  })
  register('window', action => {
    const current = window
    if (action === 'minimize') current.minimize()
    if (action === 'maximize') {
      if (current.isMaximized()) current.unmaximize()
      else current.maximize()
    }
    if (action === 'close') current.close()
    return !current.isDestroyed() && current.isMaximized()
  })
}

function serveApp() {
  protocol.handle('folio', async request => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
      const url = new URL(request.url)
      if (url.hostname !== 'app') return new Response(null, { status: 404 })
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.startsWith('/~')) {
        const [, action, id, extra] = pathname.split('/')
        if (!id || extra) return new Response(null, { status: 404 })
        if (action === '~stream') return playback.stream(id, request)
        if (action === '~edit-frame') return editor.renderFrame(id, request)
        const item = library.file(id, action === '~preview')
        if (!item) return new Response(null, { status: 404 })
        if (action === '~file') return localFileResponse(item.file, request)
        if (action === '~preview' || action === '~view') {
          return localFileResponse(await playback.preview(item, action === '~view'), request)
        }
        return new Response(null, { status: 404 })
      }
      const file = path.resolve(renderer, pathname === '/' ? 'index.html' : '.' + pathname)
      if (!file.startsWith(renderer + path.sep)) return new Response(null, { status: 403 })
      return localFileResponse(file, request)
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

function canFullscreen(contents, permission, source, mainFrame) {
  return permission === 'fullscreen' && mainFrame && contents === window?.webContents &&
    typeof source === 'string' && (source === origin || source.startsWith(origin + '/'))
}

function centeredBounds(area, size, anchor = area) {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  const x = Math.max(area.x, Math.min(area.x + area.width - width, Math.round(anchor.x + (anchor.width - width) / 2)))
  const y = Math.max(area.y, Math.min(area.y + area.height - height, Math.round(anchor.y + (anchor.height - height) / 2)))
  return { x, y, width, height }
}

async function enterGallery(current, animate) {
  const saving = library.setPreferences({ onboarded: true }).then(() => null, error => error)
  const start = current.getBounds()
  const { workArea } = screen.getDisplayMatching(start)
  const end = centeredBounds(workArea, gallerySize, start)
  if (animate && !current.isMinimized() && (start.width !== end.width || start.height !== end.height)) {
    const began = performance.now()
    let elapsed = performance.now() - began
    while (elapsed < introResizeDuration && !current.isDestroyed() && !current.isMinimized()) {
      const mix = (1 - Math.cos(elapsed / introResizeDuration * Math.PI)) / 2
      const size = {
        width: Math.round(start.width + (end.width - start.width) * mix),
        height: Math.round(start.height + (end.height - start.height) * mix),
      }
      current.setBounds(centeredBounds(workArea, size, start))
      const spent = performance.now() - began - elapsed
      await delay(Math.max(1, 1000 / 60 - spent))
      elapsed = performance.now() - began
    }
  }
  if (!current.isDestroyed()) {
    current.setBounds(end)
    current.setMinimumSize(Math.min(galleryMinimum.width, workArea.width), Math.min(galleryMinimum.height, workArea.height))
    current.setResizable(true)
    current.setMaximizable(true)
  }
  // Keep the opaque backing during native resizes and let Chromium paint the final bounds before restoring Acrylic.
  if (animate && !current.isDestroyed() && !current.isMinimized()) await delay(32)
  if (!current.isDestroyed()) {
    if (useAcrylic) current.setBackgroundMaterial('acrylic')
    current.setBackgroundColor(transparentBackground)
  }
  showingIntro = false
  const error = await saving
  if (error) throw error
}

async function galleryPaintReady() {
  const tick = () => new Promise(resolve => setTimeout(resolve, 16))
  const deadline = performance.now() + 540
  while (!document.querySelector('[data-intro-gallery]') && performance.now() < deadline) await tick()
  const images = [...document.querySelectorAll('.app-shell img')].filter(image => {
    const box = image.getBoundingClientRect()
    return box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.left < innerWidth
  }).slice(0, 16)
  for (const image of images) image.loading = 'eager'
  await Promise.race([
    Promise.allSettled([document.fonts.ready, ...images.map(image => image.decode())]),
    new Promise(resolve => setTimeout(resolve, 210)),
  ])
}

function prepareIntroLanding(current) {
  const bounds = current.getBounds()
  const { theme, language } = library
  if (galleryLanding && !galleryLanding.current.isDestroyed() && galleryLanding.theme === theme &&
    galleryLanding.language === language && Object.keys(bounds).every(key => bounds[key] === galleryLanding.bounds[key])) {
    return galleryLanding
  }
  if (galleryLanding && !galleryLanding.current.isDestroyed()) galleryLanding.current.destroy()
  const { workArea } = screen.getDisplayMatching(bounds)
  const landing = createWindow({ workArea, bounds, landing: true })
  const painted = Promise.all([landing.loaded, landing.ready]).then(() =>
    landing.current.webContents.executeJavaScript('(' + galleryPaintReady.toString() + ')()'))
  painted.catch(() => {})
  galleryLanding = { ...landing, bounds, theme, language, painted }
  return galleryLanding
}

async function landIntroMotion(current, animate) {
  const saved = library.setPreferences({ onboarded: true }).then(() => null, error => error)
  const motion = Promise.withResolvers()
  motionFinished = motion.resolve
  if (animate) current.setShape([])
  let landing
  try {
    if (animate) await Promise.race([motion.promise, delay(1250)])
    if (current.isDestroyed()) return
    landing = prepareIntroLanding(current)
    const deadline = new AbortController()
    try {
      await Promise.race([landing.painted, delay(2200, undefined, { signal: deadline.signal }).then(() => {
        throw new Error(t('Не удалось запустить Folio'))
      })])
    } finally {
      deadline.abort()
    }
    if (current.isDestroyed()) return

    const next = landing.current
    const focused = current.isFocused()
    if (animate) {
      // Keep the finished transition over the gallery while Windows presents its first real frame.
      current.setAlwaysOnTop(true)
      next.showInactive()
      current.moveTop()
      await delay(45)
      if (current.isDestroyed()) return
      if (next.isDestroyed()) throw new Error(t('Не удалось запустить Folio'))
    }
    next.setBackgroundMaterial('acrylic')
    next.setBackgroundColor(transparentBackground)
    if (animate) await delay(85)
    if (current.isDestroyed()) return
    if (next.isDestroyed()) throw new Error(t('Не удалось запустить Folio'))
    window = next
    galleryLanding = null
    showingIntro = false
    if (!animate) next.showInactive()
    current.destroy()
    if (focused) next.focus()
    next.webContents.setBackgroundThrottling(true)
    next.webContents.send('folio:reveal-intro-gallery', animate)
    const error = await saved
    if (error) console.error(error.message)
  } catch (error) {
    if (!current.isDestroyed()) {
      current.setAlwaysOnTop(false)
      current.setShape([])
      await enterGallery(current, false)
    }
    throw error
  } finally {
    motionFinished = null
    if (landing && galleryLanding === landing) {
      galleryLanding = null
      if (!landing.current.isDestroyed()) landing.current.destroy()
    }
  }
}

function createWindow({ workArea = screen.getPrimaryDisplay().workArea, bounds, landing = false } = {}) {
  const candidates = [path.join(project, 'build', 'icon.ico'), path.join(process.resourcesPath, 'icon.ico')]
  const intro = !landing && (!library.preferences.onboarded || app.commandLine.hasSwitch('intro'))
  if (!landing) showingIntro = intro
  const animatedIntro = intro && useAcrylic
  const compact = intro && !animatedIntro
  const minimum = intro ? introSize : galleryMinimum
  nativeTheme.themeSource = library.theme
  const target = new URL(origin + '/')
  target.searchParams.set('theme', library.theme)
  target.searchParams.set('lang', library.language)
  if (intro) {
    target.searchParams.set('intro', '1')
    if (animatedIntro) target.searchParams.set('intro-motion', '1')
  }
  if (landing) target.searchParams.set('intro-landing', '1')
  if (!useAcrylic) target.searchParams.set('scene', '1')
  const current = new BrowserWindow({
    ...(bounds ?? centeredBounds(workArea, compact ? introSize : gallerySize)),
    minWidth: Math.min(minimum.width, workArea.width), minHeight: Math.min(minimum.height, workArea.height),
    resizable: !intro, maximizable: !intro,
    frame: false, show: false, title: productName, icon: app.isPackaged ? candidates[1] : candidates[0],
    backgroundColor: compact || landing ? windowSurface[library.theme] : transparentBackground,
    ...(animatedIntro && { transparent: true, hasShadow: false, thickFrame: false }),
    ...(useAcrylic && { backgroundMaterial: intro || landing ? 'none' : 'acrylic' }),
    webPreferences: {
      preload: path.join(project, 'desktop', 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      ...(landing && { backgroundThrottling: false }),
    },
  })
  if (!landing) window = current
  let allowClose = false
  current.on('close', event => {
    if (allowClose || finalizing || current !== window) return
    event.preventDefault()
    requestPlaybackFlush().then(() => library.flushPlayback()).catch(error => console.error(error.message)).finally(() => {
      if (current.isDestroyed()) return
      allowClose = true
      current.close()
    })
  })
  current.setMenu(null)
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  current.webContents.on('will-navigate', (event, url) => {
    if (url !== target.href) event.preventDefault()
  })
  current.webContents.on('did-fail-load', (_, code, reason, url, isMainFrame) => {
    if (!landing && isMainFrame) dialog.showErrorBox(t('Не удалось запустить Folio'), reason + ' (' + code + ')')
  })
  const emitState = () => current.webContents.send('folio:window-state', current.isMaximized())
  current.on('maximize', emitState)
  current.on('unmaximize', emitState)
  current.on('minimize', () => { if (current === window) lockVault() })
  current.webContents.on('render-process-gone', () => { if (current === window) lockVault() })
  current.on('closed', () => {
    if (current !== window) return
    if (galleryLanding && !galleryLanding.current.isDestroyed()) galleryLanding.current.destroy()
    galleryLanding = null
    window = null
    lockVault()
    playback.close()
    editor.close()
  })
  const ready = new Promise(resolve => current.once('ready-to-show', () => {
    if (animatedIntro) {
      const { width, height } = current.getContentBounds()
      const visible = centeredBounds({ x: 0, y: 0, width, height }, introSize)
      current.setShape([visible])
    }
    if (!landing) current.show()
    resolve()
  }))
  return { current, ready, loaded: current.loadURL(target.href) }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.whenReady().then(async () => {
    const data = app.getPath('userData')
    const cache = path.join(data, 'media-cache')
    await mkdir(cache, { recursive: true })
    const systemTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    library = await Library.open(
      path.join(data, 'Library', 'library.json'), path.join(renderer, 'demo'), path.join(data, 'library.json'), systemTheme,
    )
    playback = new Playback(library, cache, process.resourcesPath)
    editor = new MediaEditor(library, playback, data)
    vault = await PrivateVault.open(path.join(data, 'private-vault.json'), () => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('folio:vault-locked', vault.status())
      }
    })
    powerMonitor.on('lock-screen', lockVault)
    powerMonitor.on('suspend', lockVault)
    automaticBackup = createBackupSchedule({
      read: () => library.preferences.automaticBackup,
      save: settings => library.setPreferences({ automaticBackup: settings }),
      available: () => !storageJob && !finalizing && Boolean(window) &&
        (Object.keys(library.state.items).length > 0 || Object.keys(library.state.trash).length > 0),
      backup: directory => storageOperation(progress => library.exportBackup(directory, progress)),
    })
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(canFullscreen(contents, permission, details.requestingUrl, details.isMainFrame))
    })
    session.defaultSession.setPermissionCheckHandler((contents, permission, source, details) => {
      return canFullscreen(contents, permission, source, details.isMainFrame)
    })
    serveApp()
    registerActions()
    registerVaultActions()
    await createWindow().loaded
    const checkBackup = () => {
      const checking = automaticBackup.tick()
      if (automaticBackup.status().running) {
        publishBackupStatus()
        checking.catch(error => console.error(error.message)).finally(publishBackupStatus)
      }
    }
    automaticBackupTimer = setInterval(checkBackup, 60_000)
    checkBackup()
  }).catch(error => {
    dialog.showErrorBox(t('Не удалось запустить Folio'), error.message)
    app.quit()
  })
  app.on('before-quit', event => {
    if (!library || finalizing) return
    event.preventDefault()
    finalizing = true
    lockVault()
    clearInterval(automaticBackupTimer)
    const completed = storageJob?.catch(error => console.error(error.message))
    Promise.all([requestPlaybackFlush(), completed, vault?.settle()]).then(() => Promise.all([library.flushRecent(), library.flushPlayback(), library.preferencesPending]))
      .catch(error => console.error(error.message)).finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())
}
