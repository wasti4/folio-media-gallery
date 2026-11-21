import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, screen, session, shell } from 'electron'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { audioExtensions, mediaExtensions, subtitleExtensions } from '../shared/formats.mjs'
import { introResizeDuration, normalizeTheme, productName, windowSurface } from '../shared/brand.mjs'
import { normalizeLanguage, translate } from '../shared/locale.mjs'
import { Library } from './library.mjs'
import { Playback } from './playback.mjs'
import { MediaEditor } from './editing.mjs'
import { localFileResponse } from './protocol.mjs'
import { backupSettings, createBackupSchedule } from './backup-schedule.mjs'
import { isWithin } from './media-storage.mjs'

const origin = 'luma://app'
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
let storageJob
let lastBackup
let automaticBackup
let automaticBackupTimer
let pendingPlaybackFlush
let playbackFlushToken = 0
let finalizing = false
let introPending
let showingIntro = false
const t = message => translate(library?.language, message)

app.setName(productName)
// Keep the existing library and Chromium preferences at the profile path used by Luma.
app.setPath('userData', process.env.LUMA_TEST_PROFILE ?? path.join(app.getPath('appData'), 'Luma'))
if (process.platform === 'win32') app.setAppUserModelId('local.folio.media')
protocol.registerSchemesAsPrivileged([{
  scheme: 'luma', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

function register(name, handler) {
  ipcMain.handle('luma:' + name, (event, ...args) => {
    if (!window || event.sender !== window.webContents ||
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
      window?.webContents.send('luma:storage-progress', { done, total })
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
  if (window && !window.isDestroyed()) window.webContents.send('luma:backup-status', automaticBackup.status())
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
  window.webContents.send('luma:prepare-playback-flush', token)
  return pendingPlaybackFlush.promise
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
    if (showingIntro && !introPending) introPending = enterGallery(window, animate === true)
    return introPending
  })
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
      if (window && !window.isDestroyed()) window.webContents.send('luma:edit-progress', progress)
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
  protocol.handle('luma', async request => {
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

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const candidates = [path.join(project, 'build', 'icon.ico'), path.join(process.resourcesPath, 'icon.ico')]
  showingIntro = !library.preferences.onboarded || app.commandLine.hasSwitch('intro')
  const minimum = showingIntro ? introSize : galleryMinimum
  nativeTheme.themeSource = library.theme
  const target = new URL(origin + '/')
  target.searchParams.set('theme', library.theme)
  target.searchParams.set('lang', library.language)
  if (showingIntro) target.searchParams.set('intro', '1')
  if (!useAcrylic) target.searchParams.set('scene', '1')
  window = new BrowserWindow({
    ...centeredBounds(workArea, showingIntro ? introSize : gallerySize),
    minWidth: Math.min(minimum.width, workArea.width), minHeight: Math.min(minimum.height, workArea.height),
    resizable: !showingIntro, maximizable: !showingIntro,
    frame: false, show: false, title: productName, icon: app.isPackaged ? candidates[1] : candidates[0],
    backgroundColor: showingIntro ? windowSurface[library.theme] : transparentBackground,
    ...(useAcrylic && { backgroundMaterial: showingIntro ? 'none' : 'acrylic' }),
    webPreferences: {
      preload: path.join(project, 'desktop', 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  })
  const current = window
  let allowClose = false
  window.on('close', event => {
    if (allowClose || finalizing) return
    event.preventDefault()
    requestPlaybackFlush().then(() => library.flushPlayback()).catch(error => console.error(error.message)).finally(() => {
      if (current.isDestroyed()) return
      allowClose = true
      current.close()
    })
  })
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== target.href) event.preventDefault()
  })
  window.webContents.on('did-fail-load', (_, code, reason, url, isMainFrame) => {
    if (isMainFrame) dialog.showErrorBox(t('Не удалось запустить Folio'), reason + ' (' + code + ')')
  })
  const emitState = () => window.webContents.send('luma:window-state', window.isMaximized())
  window.on('maximize', emitState)
  window.on('unmaximize', emitState)
  window.on('closed', () => {
    window = null
    playback.close()
    editor.close()
  })
  window.once('ready-to-show', () => window?.show())
  return window.loadURL(target.href)
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
    await createWindow()
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
    clearInterval(automaticBackupTimer)
    const completed = storageJob?.catch(error => console.error(error.message))
    Promise.all([requestPlaybackFlush(), completed]).then(() => Promise.all([library.flushRecent(), library.flushPlayback(), library.preferencesPending]))
      .catch(error => console.error(error.message)).finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())
}
