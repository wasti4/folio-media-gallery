const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = name => (...args) => ipcRenderer.invoke('folio:' + name, ...args)
const playbackFlushListeners = new Set()
ipcRenderer.on('folio:prepare-playback-flush', (_, token) => {
  Promise.allSettled([...playbackFlushListeners].map(listener => Promise.resolve().then(listener)))
    .then(() => invoke('playback-flushed')(token)).catch(() => {})
})

contextBridge.exposeInMainWorld('folio', {
  state: invoke('state'),
  vault: {
    state: invoke('vault-state'),
    create: invoke('vault-create'),
    connect: invoke('vault-connect'),
    unlock: invoke('vault-unlock'),
    lock: invoke('vault-lock'),
    import: invoke('vault-import'),
    image: invoke('vault-image'),
    thumbnail: invoke('vault-thumbnail'),
    saveCopy: invoke('vault-save-copy'),
    remove: invoke('vault-remove'),
    observeLock: callback => {
      const listener = (_, status) => callback(status)
      ipcRenderer.on('folio:vault-locked', listener)
      return () => ipcRenderer.removeListener('folio:vault-locked', listener)
    },
  },
  import: invoke('import'),
  drop: files => invoke('drop')(Array.from(files, file => webUtils.getPathForFile(file)).filter(Boolean)),
  refresh: invoke('refresh'),
  migrate: invoke('migrate'),
  indexPhotos: invoke('index-photos'),
  backup: invoke('backup'),
  restore: invoke('restore'),
  openStorage: invoke('open-storage'),
  librarySettings: invoke('library-settings'),
  moveLibrary: invoke('move-library'),
  automaticBackupFolder: invoke('automatic-backup-folder'),
  automaticBackupFrequency: invoke('automatic-backup-frequency'),
  observeBackupStatus: callback => {
    const listener = (_, status) => callback(status)
    ipcRenderer.on('folio:backup-status', listener)
    return () => ipcRenderer.removeListener('folio:backup-status', listener)
  },
  observeStorage: callback => {
    const listener = (_, progress) => callback(progress)
    ipcRenderer.on('folio:storage-progress', listener)
    return () => ipcRenderer.removeListener('folio:storage-progress', listener)
  },
  favorite: invoke('favorite'),
  opened: invoke('opened'),
  createCollection: invoke('create-collection'),
  toggleCollection: invoke('toggle-collection'),
  removeCollection: invoke('remove-collection'),
  removeFolder: invoke('remove-folder'),
  removePhoto: invoke('remove-photo'),
  organizePhotos: invoke('organize-photos'),
  undoOrganize: invoke('undo-organize'),
  setPhotoTags: invoke('set-photo-tags'),
  removePhotos: invoke('remove-photos'),
  restoreDeleted: invoke('restore-deleted'),
  recycleDeleted: invoke('recycle-deleted'),
  reveal: invoke('reveal'),
  inspect: invoke('inspect'),
  play: invoke('play'),
  playbackProgress: invoke('playback-progress'),
  observePlaybackFlush: callback => {
    playbackFlushListeners.add(callback)
    return () => playbackFlushListeners.delete(callback)
  },
  saveVideoFrame: invoke('save-video-frame'),
  release: invoke('release'),
  editInfo: invoke('edit-info'),
  editFrame: invoke('edit-frame'),
  editClip: invoke('edit-clip'),
  stopEditPreview: invoke('stop-edit-preview'),
  saveEdit: invoke('save-edit'),
  cancelEditSave: invoke('cancel-edit-save'),
  observeEdit: callback => {
    const listener = (_, fraction) => callback(fraction)
    ipcRenderer.on('folio:edit-progress', listener)
    return () => ipcRenderer.removeListener('folio:edit-progress', listener)
  },
  wallpaper: process.platform === 'win32' ? invoke('wallpaper') : undefined,
  attach: invoke('attach'),
  window: invoke('window'),
  theme: invoke('theme'),
  language: invoke('language'),
  finishIntro: invoke('finish-intro'),
  warmIntroGallery: invoke('warm-intro-gallery'),
  finishIntroMotion: invoke('intro-motion-finished'),
  revealIntroGallery: callback => {
    const listener = (_, animate) => callback(animate)
    ipcRenderer.on('folio:reveal-intro-gallery', listener)
    return () => ipcRenderer.removeListener('folio:reveal-intro-gallery', listener)
  },
  observeWindow: callback => {
    const listener = (_, maximized) => callback(maximized)
    ipcRenderer.on('folio:window-state', listener)
    return () => ipcRenderer.removeListener('folio:window-state', listener)
  },
})
