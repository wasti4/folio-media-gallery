const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = name => (...args) => ipcRenderer.invoke('luma:' + name, ...args)
const playbackFlushListeners = new Set()
ipcRenderer.on('luma:prepare-playback-flush', (_, token) => {
  Promise.allSettled([...playbackFlushListeners].map(listener => Promise.resolve().then(listener)))
    .then(() => invoke('playback-flushed')(token)).catch(() => {})
})

contextBridge.exposeInMainWorld('luma', {
  state: invoke('state'),
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
    ipcRenderer.on('luma:backup-status', listener)
    return () => ipcRenderer.removeListener('luma:backup-status', listener)
  },
  observeStorage: callback => {
    const listener = (_, progress) => callback(progress)
    ipcRenderer.on('luma:storage-progress', listener)
    return () => ipcRenderer.removeListener('luma:storage-progress', listener)
  },
  favorite: invoke('favorite'),
  opened: invoke('opened'),
  createCollection: invoke('create-collection'),
  toggleCollection: invoke('toggle-collection'),
  removeCollection: invoke('remove-collection'),
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
    ipcRenderer.on('luma:edit-progress', listener)
    return () => ipcRenderer.removeListener('luma:edit-progress', listener)
  },
  wallpaper: process.platform === 'win32' ? invoke('wallpaper') : undefined,
  attach: invoke('attach'),
  window: invoke('window'),
  theme: invoke('theme'),
  language: invoke('language'),
  finishIntro: invoke('finish-intro'),
  observeWindow: callback => {
    const listener = (_, maximized) => callback(maximized)
    ipcRenderer.on('luma:window-state', listener)
    return () => ipcRenderer.removeListener('luma:window-state', listener)
  },
})
