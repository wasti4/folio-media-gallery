import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
  Check, ChevronLeft, CircleAlert, Folder, FolderOpen, FolderPlus, HardDriveDownload, HardDriveUpload,
  Heart, Images, LoaderCircle, Monitor, Plus, RefreshCw, SlidersHorizontal, Tags, Trash2, Upload, X,
} from 'lucide-react'
import '@fontsource-variable/manrope'
import { isDesktop, mediaApi, saveSetting, setting } from './media-api.mjs'
import { EmptyGallery, Feature, GalleryGrid, GalleryToolbar, Sidebar, Titlebar, sortOptions } from './gallery.jsx'
import { Dialog, IconButton, Menu, MenuItem, quantity } from './ui.jsx'
import { PhotoFolderMenu, SelectionDock } from './photo-selection.jsx'
import { animatePhotoAction, capturePhotoAction } from './gallery-motion.mjs'
import { Viewer } from './viewer.jsx'
import { SeriesView } from './series.jsx'
import { LibraryFilters, PhotoTagsField } from './library-search.jsx'
import { DeletedPhotos, LibrarySettings } from './library-settings.jsx'
import { BatchEditor } from './batch-editor.jsx'
import { PrivateGallery } from './private-gallery.jsx'
import { Intro } from './intro.jsx'
import { Localization } from './localization.jsx'
import './style.css'
import './photo-selection.css'
import './intro-motion.css'
import { introResizeDuration, normalizeTheme, windowSurface } from '../shared/brand.mjs'
import { languages, normalizeLanguage, translate, translateError } from '../shared/locale.mjs'
import { emptyLibraryFilters, hasLibraryFilters, matchesLibrarySearch } from '../shared/library-search.mjs'

const fileForms = ['файл', 'файла', 'файлов']
const folderForms = ['папка', 'папки', 'папок']
const photoForms = ['фотография', 'фотографии', 'фотографий']
const duplicateForms = ['дубликат', 'дубликата', 'дубликатов']
const emptySelection = new Set()
const scopes = { all: 'Медиатека', favorites: 'Избранное', recent: 'Недавние', series: 'Сериалы', deleted: 'Недавно удалённые', vault: 'Приватная папка' }
const canRemovePhoto = item => isDesktop && item.kind === 'photo' && !item.demo
const jobLabels = {
  import: 'Копируем в Folio', refresh: 'Обновляем медиатеку', migrate: 'Копируем прежние оригиналы',
  backup: 'Создаём резервную копию', restore: 'Восстанавливаем медиатеку',
  'remove-photos': 'Удаляем фотографии',
  'index-photos': 'Проверяем даты съёмки',
}
const launchOptions = new URLSearchParams(location.search)
const introMotion = isDesktop && launchOptions.has('intro-motion')
const introLanding = isDesktop && launchOptions.has('intro-landing')
const appearance = normalizeTheme(isDesktop ? launchOptions.get('theme') : setting(
  'theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
))
const initialLanguage = normalizeLanguage(isDesktop ? launchOptions.get('lang') : setting('language', 'ru'))
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.setProperty('--window-surface', windowSurface[theme])
}
applyTheme(appearance)
document.documentElement.style.setProperty('--intro-resize-duration', introResizeDuration + 'ms')
document.documentElement.lang = initialLanguage

function sortItems(a, b, by, scope, collator) {
  if (by === 'name') return collator.compare(a.name, b.name)
  if (by === 'kind') return collator.compare(a.ext, b.ext) || collator.compare(a.name, b.name)
  if (by === 'oldest') return a.modifiedAt - b.modifiedAt || collator.compare(a.name, b.name)
  if (by === 'capture') return (b.capturedAt ?? b.modifiedAt) - (a.capturedAt ?? a.modifiedAt) || collator.compare(a.name, b.name)
  if (scope === 'recent') return b.openedAt - a.openedAt
  return b.modifiedAt - a.modifiedAt || collator.compare(a.name, b.name)
}

function App() {
  const [libraryState, setState] = useState({ items: [], folders: [], demo: false, sources: 0 })
  const [loaded, setLoaded] = useState(false)
  const [scope, setScope] = useState('all')
  const [filter, setFilter] = useState('all')
  const [libraryFilters, setLibraryFilters] = useState(emptyLibraryFilters)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState(() => setting('sort', 'newest'))
  const [view, setView] = useState(() => setting('view', 'grid'))
  const [expanded, setExpanded] = useState(() => setting('sidebar', false))
  const [language, setLanguage] = useState(initialLanguage)
  const [intro, setIntro] = useState(() => {
    if (introLanding) return 'prepared'
    const firstRun = isDesktop ? launchOptions.get('intro') === '1' : !setting('onboarded', false)
    return firstRun ? 'tour' : ''
  })
  const [popup, setPopup] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [privateViewing, setPrivateViewing] = useState(false)
  const [picked, setPicked] = useState(null)
  const [photoOperation, setPhotoOperation] = useState(null)
  const [busy, setBusy] = useState(null)
  const [storageProgress, setStorageProgress] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState(null)
  const [batch, setBatch] = useState(null)
  const [update, setUpdate] = useState(null)
  const [watchJob, setWatchJob] = useState(null)
  const announcedUpdate = useRef('')
  const latest = useRef(null)
  const dragDepth = useRef(0)
  const toastTimer = useRef(null)
  const focusReturn = useRef(null)
  const selection = useRef(null)
  const pickAnchor = useRef(null)
  const mutatingPhotos = useRef(false)
  const opened = useRef(new Map())
  const importing = useRef(false)
  const triedMigration = useRef(false)
  const triedIndex = useRef(false)
  const searchRef = useRef(null)
  const scrollRef = useRef(null)
  const body = useRef(null)
  const sidebarMotion = useRef(null)
  const introFinishing = useRef(false)
  const wallpaperPending = useRef(false)

  const t = useCallback((message, values) => translate(language, message, values), [language])
  const errorText = useCallback(error => translateError(language, error), [language])
  const collator = useMemo(() => new Intl.Collator(language, { numeric: true, sensitivity: 'base' }), [language])
  const state = useMemo(() => libraryState.demo ? {
    ...libraryState,
    items: libraryState.items.map(item => ({ ...item, name: t(item.name), folderName: t(item.folderName) })),
    folders: libraryState.folders.map(folder => folder.kind === 'demo' ? { ...folder, name: t(folder.name) } : folder),
  } : isDesktop ? libraryState : {
    ...libraryState,
    items: libraryState.items.map(item => item.folderId === 'web-folder-' ? { ...item, folderName: t('Импортированные файлы') } : item),
    folders: libraryState.folders.map(folder => folder.id === 'web-folder-' ? { ...folder, name: t('Импортированные файлы') } : folder),
  }, [libraryState, t])

  const itemById = useMemo(() => new Map(state.items.map(item => [item.id, item])), [state.items])
  const folder = state.folders.find(item => item.id === scope)
  const privateScope = scope === 'vault'
  const galleryScope = scope !== 'series' && scope !== 'deleted' && !privateScope
  const query = search.trim().toLocaleLowerCase(language)
  const deferredQuery = useDeferredValue(query)
  const current = useMemo(() => {
    if (!galleryScope) return []
    const members = folder?.kind === 'collection' ? new Set(folder.members) : null
    return state.items.filter(item => {
      if (scope === 'favorites' && !item.favorite) return false
      if (scope === 'recent' && !item.openedAt) return false
      if (folder && (members ? !members.has(item.id) : item.folderId !== folder.id)) return false
      if (filter !== 'all' && item.kind !== filter) return false
      return matchesLibrarySearch(item, { query: deferredQuery, filters: libraryFilters, language })
    }).sort((a, b) => sortItems(a, b, sort, scope, collator))
  }, [state.items, folder, scope, filter, libraryFilters, deferredQuery, sort, language, collator, galleryScope])
  const selectable = useMemo(() => current.filter(canRemovePhoto).map(item => item.id), [current])
  const selecting = picked !== null
  const feature = state.demo && scope === 'all' && filter === 'all' && !query && !hasLibraryFilters(libraryFilters) ? itemById.get('demo-dolomites') : null
  const viewerItem = viewer ? itemById.get(viewer.ids[viewer.index]) : null

  const notify = useCallback((text, error = false, openFolder) => {
    clearTimeout(toastTimer.current)
    setToast({ text, error, openFolder })
    toastTimer.current = setTimeout(() => setToast(null), error || openFolder ? 5300 : 2900)
  }, [])
  latest.current = { t, language }

  function changeTheme(value) {
    applyTheme(value)
    if (isDesktop) mediaApi.theme(value).catch(error => notify(errorText(error), true))
    else saveSetting('theme', value)
  }

  function changeLanguage(value) {
    const next = normalizeLanguage(value)
    document.documentElement.lang = next
    setLanguage(next)
    setPopup(null)
    if (isDesktop) mediaApi.language(next).catch(error => notify(translateError(next, error), true))
    else saveSetting('language', next)
  }

  useEffect(() => {
    if (introLanding) return mediaApi.revealIntroGallery(animate => setIntro(animate ? 'settling' : ''))
  }, [])

  async function finishIntro() {
    if (introFinishing.current) return
    introFinishing.current = true
    const animate = !matchMedia('(prefers-reduced-motion: reduce)').matches
    if (introMotion) {
      setIntro(animate ? 'moving' : 'switching')
      const motion = async () => {
        await new Promise(resolve => requestAnimationFrame(resolve))
        const stage = body.current?.closest('.window-stage')
        const animations = stage?.getAnimations({ subtree: true }).filter(animation =>
          animation.animationName?.startsWith('folio-motion-')) ?? []
        await Promise.allSettled(animations.map(animation => animation.finished))
        await mediaApi.finishIntroMotion()
      }
      try {
        await Promise.all([mediaApi.finishIntro(animate), animate && motion()])
      } catch (error) {
        notify(errorText(error), true)
      }
      setIntro('')
      return
    }
    setIntro('opening')
    try {
      if (isDesktop) await mediaApi.finishIntro(animate)
      else {
        if (animate) await new Promise(resolve => setTimeout(resolve, introResizeDuration))
        saveSetting('onboarded', true)
      }
    } catch (error) {
      notify(errorText(error), true)
    }
    setIntro(animate ? 'arrival' : '')
  }

  function resizeSidebar(value) {
    const content = body.current
    const animate = content && !matchMedia('(prefers-reduced-motion: reduce)').matches
    const before = animate ? content.getBoundingClientRect() : null
    sidebarMotion.current?.cancel()
    flushSync(() => setExpanded(value))
    if (before) {
      const after = content.getBoundingClientRect()
      if (before.width && after.width && Math.abs(before.left - after.left) > 1) {
        sidebarMotion.current = content.animate([
          { transform: 'translateX(' + (before.left - after.left) + 'px) scaleX(' + before.width / after.width + ')' },
          { transform: 'none' },
        ], { duration: 370, easing: 'cubic-bezier(.22, .88, .28, 1)' })
      }
    }
    saveSetting('sidebar', value)
  }

  useEffect(() => { document.title = t('Folio — Медиагалерея') }, [t])
  useEffect(() => {
    Promise.resolve(mediaApi.state()).then(setState).catch(error => notify(translateError(initialLanguage, error), true)).finally(() => setLoaded(true))
    return () => clearTimeout(toastTimer.current)
  }, [notify])
  useEffect(() => mediaApi.observeStorage?.(setStorageProgress), [])
  useEffect(() => mediaApi.observeWatchActivity?.(activity => {
    setWatchJob(activity)
    if (!activity) setStorageProgress(null)
  }), [])
  // A watched folder changes the library in the background. The state is read again once no other
  // operation is about to apply its own, older snapshot.
  useEffect(() => mediaApi.observeLibrary?.(change => {
    const apply = () => {
      if (importing.current || mutatingPhotos.current) {
        setTimeout(apply, 400)
        return
      }
      Promise.resolve(mediaApi.state()).then(setState).catch(() => {})
    }
    apply()
    if (!change.added) return
    const { t, language } = latest.current
    notify(t('Из «{name}» добавлено {count}', { name: change.name, count: quantity(change.added, fileForms, language) }), false, change.folderId)
  }), [notify])
  useEffect(() => {
    if (!mediaApi.updates) return
    let active = true
    mediaApi.updates.status().then(status => { if (active && status) setUpdate(status) }).catch(() => {})
    const stop = mediaApi.updates.observe(setUpdate)
    return () => { active = false; stop() }
  }, [])
  useEffect(() => {
    const version = update?.available?.version
    if (!version || update.state !== 'available' || announcedUpdate.current === version) return
    announcedUpdate.current = version
    if (dialog?.kind !== 'settings') notify(t('Вышла новая версия Folio — {version}', { version }), false, { settings: true })
  }, [update?.available?.version, update?.state])

  const closePopup = useCallback(() => setPopup(null), [])
  const reflectHistory = useCallback(() => {
    const entries = opened.current
    if (!entries.size) return
    opened.current = new Map()
    setState(state => ({ ...state, items: state.items.map(item => {
      const time = entries.get(item.id)
      return time > item.openedAt ? { ...item, openedAt: time } : item
    }) }))
  }, [])

  const closeViewer = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    selection.current = null
    setViewer(null)
    reflectHistory()
    requestAnimationFrame(() => {
      const trigger = focusReturn.current?.isConnected ? focusReturn.current : searchRef.current
      trigger?.focus({ preventScroll: true })
    })
  }, [reflectHistory])

  function recordView(id) {
    Promise.resolve(mediaApi.opened(id)).then(time => {
      if (!time) return
      opened.current.set(id, Math.max(opened.current.get(id) ?? 0, time))
      if (!selection.current) reflectHistory()
    }).catch(error => notify(errorText(error), true))
  }

  function navigate(next) {
    setScope(next)
    setFilter('all')
    setSearch('')
    setLibraryFilters(emptyLibraryFilters)
    closePopup()
    if (!mutatingPhotos.current) clearSelection()
    scrollRef.current?.scrollTo({ top: 0 })
  }

  async function importItems(action, job = 'import') {
    if (importing.current || mutatingPhotos.current) return
    importing.current = true
    closePopup()
    setStorageProgress(null)
    setBusy(job)
    try {
      const result = await action()
      if (!result || result.canceled) return
      setState(result.state)
      if (job === 'index-photos') return
      if (job === 'backup') {
        setDialog({ kind: 'backup', path: result.directory, count: result.count })
      } else if (job === 'restore') {
        navigate('all')
        const count = result.added + (result.deletedAdded || 0)
        notify(count ? t('Восстановлено {count}', { count: quantity(count, fileForms, language) }) : t('Резервная копия объединена с медиатекой'))
      } else if (job === 'migrate') {
        if (result.skipped) notify(t('Часть прежних оригиналов или дорожек недоступна. Подключите исходные папки и повторите копирование.'), true)
        else if (result.copied) notify(t('Прежние оригиналы сохранены в Folio'))
      } else if (result.added) {
        navigate('all')
        notify(t('Добавлено {count}', { count: quantity(result.added, fileForms, language) }) +
          (result.skipped ? ' · ' + t('пропущено {count}', { count: result.skipped }) : '') +
          (result.skippedDuplicates ? ' · ' + t('Пропущено {count}', { count: quantity(result.skippedDuplicates, duplicateForms, language) }) : ''), Boolean(result.skipped))
      } else if (result.skippedDuplicates) {
        notify(t('Пропущено {count}', { count: quantity(result.skippedDuplicates, duplicateForms, language) }))
      } else if (result.skipped) {
        notify(t('Некоторые папки сейчас недоступны.'), true)
      } else {
        notify(t(job === 'refresh' ? 'Медиатека обновлена' : 'Новых медиафайлов не найдено'))
      }
    } catch (error) {
      notify(errorText(error), true)
    } finally {
      importing.current = false
      setBusy(null)
      setStorageProgress(null)
    }
  }

  useEffect(() => {
    if (!isDesktop || !loaded || busy || intro || dialog || viewer || photoOperation) return
    if (!triedMigration.current) {
      triedMigration.current = true
      if (state.linked) {
        importItems(() => mediaApi.migrate(), 'migrate')
        return
      }
    }
    if (!triedIndex.current && state.unindexedPhotos) {
      triedIndex.current = true
      importItems(() => mediaApi.indexPhotos(), 'index-photos')
    }
  }, [loaded, state.linked, state.unindexedPhotos, busy, intro, dialog, viewer, photoOperation])

  async function openStorage(kind) {
    closePopup()
    try { await mediaApi.openStorage(kind) } catch (error) { notify(errorText(error), true) }
  }

  useEffect(() => {
    function shortcut(event) {
      if (viewer || batch || dialog || intro || privateScope || event.defaultPrevented) return
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      const textInput = event.target.closest?.('input, textarea, [contenteditable]')
      if (selecting && !textInput && !popup && !mutatingPhotos.current) {
        if (modifier && ['a', 'ф'].includes(key)) {
          event.preventDefault()
          setPicked(new Set(selectable))
        } else if (event.key === 'Escape') {
          event.preventDefault()
          clearSelection(true)
        } else if (event.key === 'Delete' && !event.repeat && picked.size) {
          event.preventDefault()
          confirmPhotoDeletion([...picked])
        }
      }
      if (modifier && ['z', 'я'].includes(key) && !textInput && !busy && state.canUndo) {
        event.preventDefault()
        undoMove()
      }
      if (modifier && ['k', 'f', 'л', 'а'].includes(key)) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
      if (modifier && ['o', 'щ'].includes(key)) {
        event.preventDefault()
        importItems(() => mediaApi.import('file'))
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [viewer, batch, dialog, intro, language, popup, picked, selectable, busy, state.canUndo, folder, scope, privateScope])

  function clearSelection(restoreFocus = false) {
    pickAnchor.current = null
    setPicked(null)
    if (restoreFocus) requestAnimationFrame(() => {
      const trigger = scrollRef.current?.querySelector('.gallery-select:not(:disabled)') || searchRef.current
      trigger?.focus({ preventScroll: true })
    })
  }

  function toggleSelection() {
    closePopup()
    if (selecting) clearSelection()
    else setPicked(new Set())
  }

  function choosePhoto(id, range) {
    const anchor = pickAnchor.current
    if (!range || !anchor) pickAnchor.current = id
    setPicked(previous => {
      if (!previous) return previous
      const next = new Set(previous)
      if (range && anchor) {
        const from = selectable.indexOf(anchor)
        const to = selectable.indexOf(id)
        if (from >= 0 && to >= 0) {
          for (const item of selectable.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(item)
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function openMedia(item, editing = false, entries = current) {
    focusReturn.current = document.activeElement
    const ids = entries.map(media => media.id)
    if (!ids.includes(item.id)) ids.unshift(item.id)
    selection.current = { ids, index: ids.indexOf(item.id), editing }
    setViewer(selection.current)
    recordView(item.id)
  }

  function openEditedCopy(result) {
    setState(result.state)
    const available = new Set(result.state.items.map(item => item.id))
    const active = selection.current
    const ids = (active?.ids || []).filter(id => available.has(id))
    const index = ids.indexOf(active?.ids[active.index]) + 1
    ids.splice(index, 0, result.id)
    selection.current = { ids, index }
    setViewer(selection.current)
    recordView(result.id)
    notify(t('Копия сохранена в медиатеке'))
  }

  const updatePlayback = useCallback(async (id, values) => {
    if (!mediaApi.playbackProgress) return
    try {
      const record = await mediaApi.playbackProgress(id, values)
      if (record) setState(state => ({ ...state, playback: { ...state.playback, [id]: record } }))
    } catch (error) {
      notify(errorText(error), true)
    }
  }, [errorText, notify])

  function openBatch() {
    if (importing.current || mutatingPhotos.current || !picked?.size) return
    closePopup()
    focusReturn.current = document.activeElement
    setStorageProgress(null)
    setBatch(selectable.filter(id => picked.has(id)))
  }

  function closeBatch() {
    setBatch(null)
    setStorageProgress(null)
    requestAnimationFrame(() => { if (focusReturn.current?.isConnected) focusReturn.current.focus({ preventScroll: true }) })
  }

  function batchSaved(result) {
    setState(result.state)
    setBatch(null)
    setStorageProgress(null)
    clearSelection(true)
    const count = result.saved.length
    const text = result.canceled ? t('Сохранение остановлено. Сохранено копий: {count}', { count })
      : t('Сохранено копий: {count}', { count }) + (result.failed ? ' · ' + t('не удалось: {count}', { count: result.failed }) : '')
    notify(text, Boolean(result.failed))
  }

  function savedFrame(result) {
    setState(result.state)
    notify(t('Кадр сохранён в медиатеке'), false, { photo: result.id })
  }

  async function undoMove() {
    if (!state.canUndo || importing.current || mutatingPhotos.current) return
    mutatingPhotos.current = true
    try {
      const result = await mediaApi.undoOrganize()
      setState(result.state)
      if (folder && !result.state.folders.some(entry => entry.id === scope)) navigate('all')
      clearSelection()
      if (result.count) notify(t('Перемещение отменено'))
    } catch (error) { notify(errorText(error), true) } finally { mutatingPhotos.current = false }
  }

  async function saveTags(event) {
    event.preventDefault()
    const pending = dialog
    setDialog({ ...pending, waiting: true })
    try {
      setState(await mediaApi.setPhotoTags(pending.item.id, pending.tags))
      setDialog(null)
      notify(t('Теги сохранены'))
    } catch (error) {
      setDialog({ ...pending, waiting: false })
      notify(errorText(error), true)
    }
  }

  async function changeDeleted(ids, recycle = false) {
    if (importing.current || mutatingPhotos.current) return
    mutatingPhotos.current = true
    setPhotoOperation({ action: recycle ? 'remove' : 'restore', saving: true })
    if (recycle) setDialog({ ...dialog, waiting: true })
    try {
      const result = await (recycle ? mediaApi.recycleDeleted(ids) : mediaApi.restoreDeleted(ids))
      setState(result.state)
      setDialog(null)
      if (result.skipped) notify(t(recycle ? 'Не удалось переместить все копии в корзину Windows.' : 'Часть удалённых файлов недоступна.'), true)
      else notify(t(!recycle ? 'Восстановлено {count}' : ids.length > 1 ? 'В корзину Windows перемещено {count}' : 'Копия перемещена в корзину Windows',
        { count: quantity(result.count ?? ids.length, photoForms, language) }))
    } catch (error) {
      if (recycle) setDialog({ ...dialog, waiting: false })
      notify(errorText(error), true)
    } finally {
      mutatingPhotos.current = false
      setPhotoOperation(null)
      setStorageProgress(null)
    }
  }

  async function setWallpaper(item) {
    closePopup()
    if (wallpaperPending.current) return
    wallpaperPending.current = true
    try {
      await mediaApi.wallpaper(item.id)
      notify(t('Обои рабочего стола обновлены'))
    } catch (error) {
      notify(errorText(error), true)
    } finally {
      wallpaperPending.current = false
    }
  }

  function stepMedia(direction) {
    const active = selection.current
    if (!active) return
    const index = active.index + direction
    if (index < 0 || index >= active.ids.length) return
    selection.current = { ...active, index, direction }
    setViewer(selection.current)
    recordView(active.ids[index])
  }

  async function toggleFavorite(id) {
    closePopup()
    try { setState(await mediaApi.favorite(id)) } catch (error) { notify(errorText(error), true) }
  }

  const showPopup = (event, kind, item) => {
    const anchor = event.currentTarget
    setPopup(previous => previous?.anchor === anchor && previous.kind === kind ? null : { kind, anchor, item })
  }
  const showImport = event => showPopup(event, 'import')

  async function toggleMembership(folderId, itemId) {
    closePopup()
    try {
      const next = await mediaApi.toggleCollection(folderId, itemId)
      setState(next)
      const collection = next.folders.find(item => item.id === folderId)
      notify(t(collection.members.includes(itemId) ? 'Файл добавлен в подборку' : 'Файл убран из подборки'))
    } catch (error) { notify(errorText(error), true) }
  }

  async function saveCollection(event) {
    event.preventDefault()
    const name = new FormData(event.currentTarget).get('name').trim()
    if (!name) return
    const member = dialog.item
    setDialog({ ...dialog, waiting: true })
    try {
      const result = await mediaApi.createCollection(name)
      setState(member ? await mediaApi.toggleCollection(result.id, member.id) : result.state)
      setDialog(null)
      if (!member) navigate(result.id)
      notify(t(member ? 'Файл добавлен в подборку' : 'Подборка создана'))
    } catch (error) {
      setDialog({ ...dialog, waiting: false })
      notify(errorText(error), true)
    }
  }

  async function deleteCollection() {
    const collection = dialog.folder.kind === 'collection'
    if (dialog.waiting) return
    setDialog({ ...dialog, waiting: true })
    try {
      if (collection) {
        setState(await mediaApi.removeCollection(dialog.folder.id))
        setDialog(null)
        navigate('all')
        notify(t('Подборка удалена'))
        return
      }
      const result = await mediaApi.removeFolder(dialog.folder.id)
      setState(result.state)
      setDialog(null)
      afterPhotoDeletion(result)
      if (result.folderRemoved) navigate('all')
      notify(result.removedIds.length
        ? t('Удалено {count}', { count: quantity(result.removedIds.length, photoForms, language) })
        : t('Папка удалена'))
    } catch (error) {
      setDialog(current => current && { ...current, waiting: false })
      notify(errorText(error), true)
    }
  }

  async function confirmPhotoDeletion(ids, item = itemById.get(ids[0])) {
    if (importing.current || mutatingPhotos.current || !ids.length) return
    const trigger = popup?.anchor || document.activeElement
    closePopup()
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    setDialog({ kind: 'remove-photo', ids, item, trigger })
  }

  function cancelPhotoDialog() {
    if (dialog.waiting) return
    const trigger = dialog.trigger
    setDialog(null)
    requestAnimationFrame(() => trigger?.focus({ preventScroll: true }))
  }

  function createPhotoFolder(event) {
    event.preventDefault()
    const name = new FormData(event.currentTarget).get('name').trim()
    if (name) runPhotoAction(dialog.ids, { name })
  }

  function afterPhotoDeletion(result) {
    const removed = new Set(result.removedIds)
    for (const id of removed) opened.current.delete(id)
    if (folder?.kind === 'physical' && !result.state.folders.some(item => item.id === scope)) navigate('all')
    const active = selection.current
    if (!active || !removed.has(active.ids[active.index])) return
    const ids = active.ids.filter(id => !removed.has(id))
    if (!ids.length) {
      closeViewer()
      return
    }
    const index = Math.min(active.index, ids.length - 1)
    selection.current = { ids, index }
    setViewer(selection.current)
    recordView(ids[index])
  }

  function photoMotionTarget(action, destination, viewerNode) {
    if (action === 'remove' && viewerNode) return viewerNode.querySelector('.photo-delete')
    if (destination && expanded) {
      const row = document.querySelector('[data-folder-id="' + CSS.escape(destination.id) + '"]')
      if (row) {
        const box = row.getBoundingClientRect()
        const bounds = row.closest('.sidebar-scroll').getBoundingClientRect()
        if (box.top >= bounds.top && box.bottom <= bounds.bottom) return row.querySelector('.folder-icon')
      }
    }
    const role = action === 'move' ? 'folder' : 'trash'
    const dock = document.querySelector('.selection-dock [data-photo-target="' + role + '"] > svg')
    if (dock || action !== 'remove') return dock
    // Without the selection dock, deleted photos fly into the sidebar's Deleted section instead of a floating bin over the toolbar.
    return document.querySelector('.sidebar [data-destination="deleted"] .side-icon')
  }

  async function runPhotoAction(ids, destination) {
    if (importing.current || mutatingPhotos.current || !ids.length) return
    const action = destination ? 'move' : 'remove'
    const viewerNode = viewerItem && document.querySelector('.viewer')
    let capture
    try { capture = capturePhotoAction(scrollRef.current, ids, viewerNode) } catch { /* The operation can continue without thumbnails. */ }
    const icon = document.querySelector('.photo-delete-confirm svg')?.cloneNode(true)
    const modal = dialog
    mutatingPhotos.current = true
    closePopup()
    setToast(null)
    setStorageProgress(null)
    setPhotoOperation({ action, name: destination?.name, saving: true })
    if (modal) setDialog({ ...modal, waiting: true })
    try {
      const result = destination ? await mediaApi.organizePhotos(ids, destination) : await mediaApi.removePhotos(ids)
      const changed = destination ? result.changedIds : result.removedIds
      flushSync(() => {
        setDialog(null)
        setPhotoOperation({ action, name: result.folder?.name })
      })
      if (!changed.length) {
        setState(result.state)
        if (result.folder) notify(t('Выбранные фото уже в «{name}»', { name: result.folder.name }), false, result.folder.id)
        return
      }
      const leavingFolder = destination && folder?.kind === 'physical' && result.folder.kind === 'physical'
        && result.folder.id !== scope
      let applied = false
      const commit = () => {
        if (applied) return
        applied = true
        flushSync(() => {
          setState(result.state)
          if (!destination) afterPhotoDeletion(result)
        })
      }
      await animatePhotoAction(capture, { action, ids: changed, departing: !destination || leavingFolder ? changed : [],
        target: photoMotionTarget(action, result.folder, viewerNode), icon, commit }).catch(() => {})
      commit()
      clearSelection(!viewerNode)
      if (destination) {
        const message = result.folder.kind === 'collection' ? 'Добавлено {count} в «{name}»' : 'Перемещено {count} в «{name}»'
        notify(t(message, { count: quantity(changed.length, photoForms, language), name: result.folder.name }), false, result.folder.id)
      } else notify(ids.length === 1 ? t('Фото удалено из медиатеки') : t('Удалено {count}', { count: quantity(changed.length, photoForms, language) }))
    } catch (error) {
      if (modal) setDialog({ ...modal, waiting: false })
      notify(errorText(error), true)
    } finally {
      mutatingPhotos.current = false
      setPhotoOperation(null)
      setStorageProgress(null)
    }
  }

  const collections = state.folders.filter(item => item.kind === 'collection')
  const progressJob = busy || (photoOperation?.saving && photoOperation.action === 'remove' && storageProgress?.total > 1 ? 'remove-photos' : null)
  const singleRemoval = dialog?.kind === 'remove-photo' && dialog.ids.length === 1 && dialog.item
  const deleted = scope === 'deleted' ? (state.deleted ?? []).filter(item => !query ||
    [item.name, item.folderName, item.filename].some(value => value?.toLocaleLowerCase(language).includes(query))) : []
  const activePopupItem = popup?.item ? itemById.get(popup.item.id) || popup.item : null
  const dragContainsFiles = event => event.dataTransfer.types.includes('Files')

  const scene = !isDesktop || launchOptions.has('scene')
  const prepared = intro === 'prepared' || intro === 'settling'
  return <Localization.Provider value={{ language, t, changeLanguage }}>
    <div className={'window-stage' + (!isDesktop ? ' web-preview' : '') + (scene ? ' has-scene' : '')}
      data-onboarding={intro || undefined} data-intro-motion={introMotion ? '' : undefined} data-intro-gallery={prepared && loaded ? '' : undefined}
      onAnimationEnd={event => {
        if (event.target === event.currentTarget && event.animationName === 'intro-motion-settle') setIntro('')
      }}><div
    className={'app-root' + (expanded ? ' sidebar-expanded' : '')}
    onDragEnter={event => {
      if (!dragContainsFiles(event) || privateScope || viewer || batch || intro || dialog || mutatingPhotos.current) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }}
    onDragOver={event => {
      if (dragContainsFiles(event)) {
        event.preventDefault()
        event.dataTransfer.dropEffect = privateScope || viewer || batch || intro || dialog || mutatingPhotos.current ? 'none' : 'copy'
      }
    }}
    onDragLeave={event => {
      if (!dragContainsFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    }}
    onDrop={event => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (!privateScope && !viewer && !batch && !intro && !dialog && !mutatingPhotos.current && event.dataTransfer.files.length) {
        const files = [...event.dataTransfer.files]
        importItems(() => mediaApi.drop(files))
      }
    }}>
    <div className="glass-grain" aria-hidden="true" />
    <div className="app-shell" inert={Boolean(viewerItem || batch || privateViewing || dialog || intro || photoOperation)} data-viewing={viewerItem || batch || privateViewing ? '' : undefined}
      data-photo-operation={photoOperation && !dialog ? '' : undefined}
      data-arriving={intro === 'arrival' ? '' : undefined} onAnimationEnd={event => {
        if (event.target === event.currentTarget && event.animationName === 'gallery-arrive') setIntro('')
      }}>
      <Sidebar state={state} active={scope} navigate={navigate} createFolder={() => setDialog({ kind: 'create' })}
        expanded={expanded} setExpanded={resizeSidebar} />
      <div className="app-body" ref={body}>
        <Titlebar privateScope={privateScope} search={search} setSearch={value => { setSearch(value); clearSelection(); scrollRef.current?.scrollTo({ top: 0 }) }}
          searchRef={searchRef} openImport={showImport} importing={Boolean(busy)}
          changeTheme={changeTheme} openLanguage={event => showPopup(event, 'language')}
          undo={state.canUndo && !busy ? undoMove : undefined} updateReady={Boolean(update?.available)}
          openSettings={isDesktop ? event => { closePopup(); setDialog({ kind: 'settings', trigger: event.currentTarget }) } : undefined} />
        <main className="gallery-scroll" ref={scrollRef} data-selecting={selecting || undefined}>
          <div className="gallery-wrap">
            <div className="library-header">
              <div className="page-heading">
                <div>
                {folder && <button className="breadcrumb" onClick={() => navigate('all')}><ChevronLeft size={15} /> {t('Медиатека')}</button>}
                <h1>{query && galleryScope ? t('Поиск') : folder?.name || t(scopes[scope] || 'Медиатека')}</h1>
                  {scope !== 'series' && !privateScope && <div className="page-summary" aria-live="polite">
                  {loaded ? quantity(scope === 'deleted' ? deleted.length : current.length, fileForms, language) : t('Загружаем медиатеку…')}
                  {loaded && scope === 'all' && filter === 'all' && !query && <><span className="inline-dot" />{quantity(state.folders.filter(item => item.kind !== 'collection').length, folderForms, language)}</>}
                  </div>}
                </div>
              {(folder?.kind === 'collection' || (folder?.kind === 'physical' && isDesktop && !state.demo)) &&
                <button type="button" className="outline-button folder-delete" onClick={() => setDialog({ kind: 'delete', folder })}>
                  <Trash2 size={16} strokeWidth={1.75} /><span>{t(folder.kind === 'collection' ? 'Удалить подборку' : 'Удалить папку')}</span>
                </button>}
              </div>
              {galleryScope && <GalleryToolbar filter={filter} setFilter={next => { scrollRef.current?.scrollTo({ top: 0 }); clearSelection(); setFilter(next) }}
                sort={sort} openSort={event => showPopup(event, 'sort')} view={view}
                selecting={selecting} canSelect={selectable.length > 0 && !busy} toggleSelect={toggleSelection}
                setView={next => { setView(next); saveSetting('view', next) }} />}
            </div>
            {galleryScope && loaded && !state.demo && <LibraryFilters items={state.items} folders={state.folders} filters={libraryFilters}
              onChange={value => { setLibraryFilters(value); clearSelection(); scrollRef.current?.scrollTo({ top: 0 }) }} />}
            {scope === 'series' && loaded && <SeriesView items={state.items} playback={state.playback} query={deferredQuery}
              openEpisode={(item, ordered) => openMedia(item, false, ordered)}
              setWatched={(id, watched) => updatePlayback(id, { watched })} />}
            {scope === 'deleted' && loaded && <DeletedPhotos items={deleted} working={Boolean(photoOperation || busy)}
              restore={ids => changeDeleted(ids)} recycle={item => setDialog({ kind: 'recycle-deleted', item, ids: [item.id], trigger: document.activeElement })}
              recycleAll={() => setDialog({ kind: 'recycle-deleted', ids: deleted.map(item => item.id), trigger: document.activeElement })} />}
            {privateScope && <PrivateGallery onViewing={setPrivateViewing} view={view}
              setView={next => { setView(next); saveSetting('view', next) }} />}
            {feature && <Feature item={feature} open={() => openMedia(feature)} favorite={() => toggleFavorite(feature.id)} />}
            {galleryScope && <section id="gallery-panel" role="tabpanel" aria-labelledby={'tab-' + filter} className="gallery-panel">
              {loaded && (!intro || intro === 'arrival' || introMotion || prepared) && (current.length ? <GalleryGrid items={current} view={view} key={scope + ':' + filter + ':' + view}
                selecting={selecting} picked={picked ?? emptySelection} choose={choosePhoto}
                onOpen={openMedia} favorite={toggleFavorite} onMenu={(event, item) => showPopup(event, 'item', item)} /> :
                <EmptyGallery search={query || hasLibraryFilters(libraryFilters)} scope={scope} filter={filter} collection={folder?.kind === 'collection'}
                  clear={() => { setSearch(''); setLibraryFilters(emptyLibraryFilters) }} clearFilter={() => setFilter('all')} openImport={showImport} />)}
            </section>}
          </div>
        </main>
        {selecting && <SelectionDock count={picked.size} total={selectable.length} working={photoOperation || busy}
          menuOpen={popup?.kind === 'photo-folders'} close={() => { closePopup(); clearSelection(true) }}
          selectAll={() => { pickAnchor.current = null; setPicked(picked.size === selectable.length ? new Set() : new Set(selectable)) }}
          openFolders={event => showPopup(event, 'photo-folders')} remove={() => confirmPhotoDeletion([...picked])}
          edit={isDesktop ? openBatch : undefined} />}
      </div>
    </div>
    {popup?.kind === 'import' && <Menu anchor={popup.anchor} onClose={closePopup}>
      <MenuItem icon={FolderPlus} onClick={() => importItems(() => mediaApi.import('folder'))}>{t('Добавить папку')}</MenuItem>
      <MenuItem icon={Upload} onClick={() => importItems(() => mediaApi.import('file'))}>{t('Добавить файлы')}</MenuItem>
      {isDesktop && <>
        <MenuItem icon={RefreshCw} disabled={state.demo && !state.sources} onClick={() => importItems(() => mediaApi.refresh(), 'refresh')}>{t('Обновить медиатеку')}</MenuItem>
        <div className="menu-divider" role="separator" />
        <MenuItem icon={HardDriveDownload} disabled={state.demo || !(state.items.length || state.deleted?.length)} onClick={() => importItems(() => mediaApi.backup(), 'backup')}>{t('Создать резервную копию…')}</MenuItem>
        <MenuItem icon={HardDriveUpload} onClick={() => importItems(() => mediaApi.restore(), 'restore')}>{t('Восстановить из копии…')}</MenuItem>
        <MenuItem icon={FolderOpen} onClick={() => openStorage('media')}>{t('Открыть хранилище Folio')}</MenuItem>
        {state.linked > 0 && <MenuItem icon={RefreshCw} onClick={() => importItems(() => mediaApi.migrate(), 'migrate')}>{t('Скопировать прежние оригиналы')}</MenuItem>}
      </>}
    </Menu>}
    {popup?.kind === 'language' && <Menu anchor={popup.anchor} onClose={closePopup}>
      {languages.map(option => <MenuItem key={option.id} lang={option.id} checked={language === option.id}
        onClick={() => changeLanguage(option.id)}>{option.label}</MenuItem>)}
    </Menu>}
    {popup?.kind === 'sort' && <Menu anchor={popup.anchor} onClose={closePopup}>
      {sortOptions.map(option => <MenuItem key={option.id} checked={sort === option.id} onClick={() => {
        scrollRef.current?.scrollTo({ top: 0 })
        setSort(option.id)
        saveSetting('sort', option.id)
        closePopup()
      }}>{t(option.description)}</MenuItem>)}
    </Menu>}
    {popup?.kind === 'photo-folders' && picked?.size > 0 && <PhotoFolderMenu anchor={popup.anchor} onClose={closePopup} folders={state.folders}
      choose={folder => runPhotoAction([...picked], { folderId: folder.id, name: folder.name })}
      create={() => { setDialog({ kind: 'create-photo-folder', ids: [...picked], trigger: popup.anchor }); closePopup() }} />}
    {popup?.kind === 'item' && activePopupItem && <Menu anchor={popup.anchor} onClose={closePopup}>
      <MenuItem icon={Heart} onClick={() => toggleFavorite(activePopupItem.id)}>{t(activePopupItem.favorite ? 'Убрать из избранного' : 'В избранное')}</MenuItem>
      {isDesktop && activePopupItem.kind !== 'gif' && <MenuItem icon={SlidersHorizontal} onClick={() => {
        closePopup()
        openMedia(activePopupItem, true)
        focusReturn.current = popup.anchor
      }}>{t('Редактировать')}</MenuItem>}
      {mediaApi.wallpaper && activePopupItem.kind === 'photo' && <MenuItem icon={Monitor}
        onClick={() => setWallpaper(activePopupItem)}>{t('Сделать обоями')}</MenuItem>}
      <MenuItem icon={FolderPlus} onClick={() => setPopup({ ...popup, kind: 'assign' })}>{t('Добавить в подборку')}</MenuItem>
      {isDesktop && !activePopupItem.demo && <MenuItem icon={FolderOpen} onClick={() => { closePopup(); mediaApi.reveal(activePopupItem.id) }}>{t('Показать в Проводнике')}</MenuItem>}
      {canRemovePhoto(activePopupItem) && <><div className="menu-divider" role="separator" />
        <MenuItem icon={Tags} onClick={() => {
          setDialog({ kind: 'photo-tags', item: activePopupItem, tags: activePopupItem.tags ?? [], trigger: popup.anchor })
          closePopup()
        }}>{t('Изменить теги')}</MenuItem>
        <MenuItem icon={Trash2} danger disabled={Boolean(busy)} onClick={() => confirmPhotoDeletion([activePopupItem.id], activePopupItem)}>{t('Удалить фото')}</MenuItem>
      </>}
    </Menu>}
    {popup?.kind === 'assign' && activePopupItem && <Menu anchor={popup.anchor} onClose={closePopup}>
      {collections.map(item => <MenuItem key={item.id} icon={Folder} checked={item.members.includes(activePopupItem.id)} onClick={() => toggleMembership(item.id, activePopupItem.id)}>{item.name}</MenuItem>)}
      <MenuItem icon={Plus} onClick={() => { closePopup(); setDialog({ kind: 'create', item: activePopupItem }) }}>{t('Новая подборка')}</MenuItem>
    </Menu>}
    {dialog?.kind === 'create' && <Dialog title={t('Новая подборка')} onClose={() => { if (!dialog.waiting) setDialog(null) }}>
      <form onSubmit={saveCollection}>
        <label className="field-label">{t('Название')}<input name="name" type="text" placeholder={t('Например, Путешествия')} maxLength={70} autoFocus required disabled={dialog.waiting} /></label>
        <div className="dialog-actions"><button className="outline-button" type="button" disabled={dialog.waiting} onClick={() => setDialog(null)}>{t('Отмена')}</button>
          <button className="primary-button" type="submit" disabled={dialog.waiting}>{t('Создать')}</button></div>
      </form>
    </Dialog>}
    {dialog?.kind === 'delete' && (() => {
      const collection = dialog.folder.kind === 'collection'
      const inside = collection ? [] : state.items.filter(item => item.folderId === dialog.folder.id)
      const photos = inside.filter(item => item.kind === 'photo').length
      const others = inside.length - photos
      return <Dialog title={t(collection ? 'Удалить подборку' : 'Удалить папку')} onClose={() => { if (!dialog.waiting) setDialog(null) }}>
        {collection ? <p>{t('Подборка «{name}» будет удалена из медиатеки.', { name: dialog.folder.name })}</p> : <>
          <p>{photos ? t('{count} из папки «{name}» переместятся в «Недавно удалённые». Оттуда их можно восстановить.', {
            count: quantity(photos, photoForms, language), name: dialog.folder.name,
          }) : t('Пустая папка «{name}» исчезнет из списка. Файлы не затрагиваются.', { name: dialog.folder.name })}</p>
          {others > 0 && <p>{t('Видео и GIF ({count}) останутся, поэтому папка сохранится.', { count: others })}</p>}
        </>}
        <div className="dialog-actions"><button className="outline-button" autoFocus disabled={dialog.waiting} onClick={() => setDialog(null)}>{t('Отмена')}</button>
          <button className="danger-button" disabled={dialog.waiting || (!collection && others > 0 && !photos)} onClick={deleteCollection}>
            {t(!collection && photos ? 'Удалить вместе с фото' : 'Удалить')}</button></div>
      </Dialog>
    })()}
    {dialog?.kind === 'create-photo-folder' && <Dialog title={t('Новая папка')} onClose={cancelPhotoDialog}>
      <form onSubmit={createPhotoFolder}>
        <label className="field-label">{t('Название')}<input name="name" type="text" placeholder={t('Например, Путешествия')} maxLength={70} autoFocus required disabled={dialog.waiting} /></label>
        <div className="dialog-actions"><button className="outline-button" type="button" disabled={dialog.waiting} onClick={cancelPhotoDialog}>{t('Отмена')}</button>
          <button className="primary-button" type="submit" disabled={dialog.waiting}>{t('Создать')}</button></div>
      </form>
    </Dialog>}
    {dialog?.kind === 'settings' && <LibrarySettings close={cancelPhotoDialog} progress={storageProgress} update={update} moved={result => {
      setState(result.state)
      notify(t(result.retained ? 'Медиатека перенесена. Часть файлов осталась в прежней папке.' : 'Медиатека перенесена'), Boolean(result.retained))
    }} watchedAdded={result => {
      setState(result.state)
      notify(result.added ? t('Добавлено {count}', { count: quantity(result.added, fileForms, language) }) +
        (result.skippedDuplicates ? ' · ' + t('Пропущено {count}', { count: quantity(result.skippedDuplicates, duplicateForms, language) }) : '')
        : t('Folio следит за папкой. Новые файлы появятся сами.'), false, result.added ? result.folderId : undefined)
    }} />}
    {dialog?.kind === 'photo-tags' && <Dialog title={t('Теги фотографии')} onClose={cancelPhotoDialog}>
      <form onSubmit={saveTags}>
        <PhotoTagsField tags={dialog.tags} onChange={tags => setDialog({ ...dialog, tags })} disabled={dialog.waiting} autoFocus />
        <div className="dialog-actions"><button className="outline-button" type="button" disabled={dialog.waiting} onClick={cancelPhotoDialog}>{t('Отмена')}</button>
          <button className="primary-button" type="submit" disabled={dialog.waiting}>{t('Сохранить')}</button></div>
      </form>
    </Dialog>}
    {dialog?.kind === 'recycle-deleted' && <Dialog title={t('В корзину Windows')} onClose={cancelPhotoDialog}>
      <p>{dialog.item ? t('Копия «{name}» будет перемещена в корзину Windows.', { name: dialog.item.name })
        : t('Все удалённые фото ({count}) будут перемещены в корзину Windows. В Folio их уже не восстановить.', { count: dialog.ids.length })}</p>
      <div className="dialog-actions"><button className="outline-button" autoFocus disabled={dialog.waiting} onClick={cancelPhotoDialog}>{t('Отмена')}</button>
        <button className="danger-button photo-delete-confirm" disabled={dialog.waiting} onClick={() => changeDeleted(dialog.ids, true)}>
          <Trash2 size={15} aria-hidden="true" /> {t(dialog.item ? 'Переместить' : 'Удалить все')}</button></div>
    </Dialog>}
    {dialog?.kind === 'remove-photo' && <Dialog title={t(singleRemoval ? 'Удалить фото' : 'Удалить фотографии')} onClose={cancelPhotoDialog}>
      <p>{singleRemoval
        ? t('Фото «{name}» попадёт в раздел «Недавно удалённые».', { name: dialog.item.name })
        : t('В раздел «Недавно удалённые» попадёт {count}.', { count: quantity(dialog.ids.length, photoForms, language) })}</p>
      <div className="dialog-actions" aria-busy={dialog.waiting || undefined}>
        <button className="outline-button" autoFocus disabled={dialog.waiting} onClick={cancelPhotoDialog}>{t('Отмена')}</button>
        <button className="danger-button photo-delete-confirm" disabled={dialog.waiting} onClick={() => runPhotoAction(dialog.ids)}>
          <Trash2 size={15} aria-hidden="true" /> {t('Удалить')}
        </button>
      </div>
    </Dialog>}
    {dialog?.kind === 'backup' && <Dialog title={t('Резервная копия готова')} onClose={() => setDialog(null)}>
      <p>{t('Сохранено {count}. Для переноса скопируйте папку целиком.', { count: quantity(dialog.count, fileForms, language) })}</p>
      <p className="backup-path">{dialog.path}</p>
      <div className="dialog-actions"><button className="outline-button" onClick={() => setDialog(null)}>{t('Закрыть')}</button>
        <button className="primary-button" autoFocus onClick={() => openStorage('backup')}>{t('Открыть папку')}</button></div>
    </Dialog>}
    {batch && <BatchEditor items={batch.map(id => itemById.get(id)).filter(Boolean)} progress={storageProgress}
      close={closeBatch} saved={batchSaved} />}
    {viewerItem && <Viewer item={viewerItem} close={closeViewer} favorite={() => toggleFavorite(viewerItem.id)} blocked={Boolean(dialog || photoOperation)}
      startEditing={viewer.editing} edited={openEditedCopy}
      playbackProgress={state.playback?.[viewerItem.id]} onPlaybackProgress={updatePlayback} onFrameSaved={savedFrame}
      setWallpaper={mediaApi.wallpaper ? () => setWallpaper(viewerItem) : undefined}
      remove={!busy && canRemovePhoto(viewerItem) ? () => confirmPhotoDeletion([viewerItem.id], viewerItem) : undefined}
      previous={viewer.index > 0 ? () => stepMedia(-1) : undefined}
      next={viewer.index < viewer.ids.length - 1 ? () => stepMedia(1) : undefined}
      direction={viewer.direction}
      neighbor={itemById.get(viewer.ids[viewer.index + (viewer.direction || 1)])} />}
    {dragging && <div className="drop-veil"><div><Images size={36} strokeWidth={1.4} /><h2>{t('Добавить в медиатеку')}</h2><p>{t('Отпустите, чтобы импортировать файлы')}</p></div></div>}
    {(progressJob || (watchJob && !batch && !photoOperation && dialog?.kind !== 'settings')) && isDesktop && <div className="toast storage-progress" role="status">
      <LoaderCircle size={19} aria-hidden="true" />
      <span>{progressJob ? t(jobLabels[progressJob]) : t('Импорт из «{name}»', { name: watchJob.name })}
        {storageProgress?.total > 0 && <> · {storageProgress.done} / {storageProgress.total}</>}</span>
    </div>}
    {toast && <div className={'toast' + (toast.error ? ' is-error' : '')} role="status">
      {toast.error ? <CircleAlert size={19} /> : <Check size={19} />}<span>{toast.text}</span>
      {toast.openFolder && (toast.openFolder.photo || toast.openFolder.settings || state.folders.some(entry => entry.id === toast.openFolder)) &&
        <button type="button" className="toast-folder" onClick={() => {
          if (toast.openFolder.settings) {
            if (!viewer && !batch && !dialog && !intro) setDialog({ kind: 'settings', trigger: document.activeElement })
          } else if (toast.openFolder.photo) {
            const photo = itemById.get(toast.openFolder.photo)
            if (photo) openMedia(photo)
          } else navigate(toast.openFolder)
          setToast(null)
        }}>{t(toast.openFolder.settings ? 'Подробнее' : toast.openFolder.photo ? 'Открыть фото' : 'Открыть папку')}</button>}
      <IconButton icon={X} size={14} label={t('Скрыть уведомление')} onClick={() => setToast(null)} />
    </div>}
    {intro && !prepared && <Intro phase={intro} finish={finishIntro} warmGallery={introMotion ? mediaApi.warmIntroGallery : undefined} />}
  </div></div></Localization.Provider>
}

createRoot(document.getElementById('root')).render(<App />)
