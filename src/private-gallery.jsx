import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Image, LayoutGrid, List, Lock, LockKeyhole, Plus } from 'lucide-react'
import { useLocale } from './localization.jsx'
import { mediaApi } from './media-api.mjs'
import { extension } from '../shared/formats.mjs'
import { GalleryGrid } from './gallery.jsx'
import { privateEditPreview } from './photo-preview.jsx'
import { Dialog, IconButton, Picture } from './ui.jsx'
import { Viewer } from './viewer.jsx'
import './private-gallery.css'

const minimumPasswordLength = 12

const problems = {
  PASSWORD_REQUIRED: 'Введите пароль от приватной папки.',
  PASSWORD_LENGTH: 'Выберите пароль длиной не менее 12 символов.',
  UNLOCK_FAILED: 'Проверьте пароль или доступность приватной папки.',
  LOCKED: 'Приватная папка заблокирована.',
  BUSY: 'Дождитесь окончания операции с приватной папкой.',
  EXISTS: 'В этом месте уже есть приватная папка. Выберите другое место или откройте существующую.',
  MISSING_PHOTO: 'Фото не найдено в приватной папке.',
  PHOTO_DAMAGED: 'Файл повреждён или недоступен.',
  CATALOG_FULL: 'Хранилище имён приватной папки заполнено.',
  IN_USE: 'Приватная папка занята другой операцией.',
  CHANGED: 'Приватная папка изменилась. Заблокируйте и откройте её снова.',
  CLEANUP_FAILED: 'Фото удалено из списка. Зашифрованный файл остался на диске.',
  EDIT_LIMIT: 'Копию не удалось сохранить. Максимальный размер PNG — 64 МиБ.',
  FAILED: 'Не удалось выполнить операцию с приватной папкой.',
}

function PrivateThumbnail({ item, load }) {
  const target = useRef(null)
  const [preview, setPreview] = useState('')
  useEffect(() => {
    let active = true
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      observer.disconnect()
      load(item.id, () => active).then(url => { if (active && url) setPreview(url) }).catch(() => {})
    }, { rootMargin: '100px' })
    observer.observe(target.current)
    return () => { active = false; observer.disconnect() }
  }, [item.id, load])
  return <span className="vault-thumbnail" ref={target}><Picture item={{ ...item, preview }} /></span>
}

export function PrivateGallery({ onViewing, view, setView }) {
  const { t } = useLocale()
  const api = mediaApi.vault
  const [state, setState] = useState(null)
  const [connect, setConnect] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [removal, setRemoval] = useState(null)
  const form = useRef(null)
  const gallery = useRef(null)
  const thumbnailQueue = useRef(Promise.resolve())
  const session = useRef({ active: false, version: 0, busy: false })
  const items = useMemo(() => (state?.items || []).map(({ id, name: filename }) => {
    const ext = extension(filename)
    return { id, filename, name: filename.slice(0, -ext.length - 1), ext,
      kind: ext === 'gif' ? 'gif' : 'photo', folderName: t('Приватное') }
  }), [state, t])
  const viewerIndex = viewer ? items.findIndex(item => item.id === viewer.id) : -1
  const viewing = viewerIndex >= 0

  useLayoutEffect(() => {
    onViewing(viewing)
    return () => { if (viewing) onViewing(false) }
  }, [onViewing, viewing])

  const loadThumbnail = useCallback((id, visible) => {
    const current = session.current
    const version = current.version
    const request = thumbnailQueue.current.then(async () => {
      const live = () => visible() && current.active && current.version === version
      if (!live()) return ''
      const result = await api.thumbnail(id)
      if (!live() || result.error) return ''
      if (typeof result.value === 'string') return result.value
      const image = new Image()
      image.src = result.value.source
      await image.decode()
      if (!live()) return ''
      const preview = privateEditPreview(image, 320, 320)
      return preview === image ? image.src : preview.toDataURL('image/png')
    })
    thumbnailQueue.current = request.catch(() => {})
    return request
  }, [api])

  function clearPhoto() {
    setViewer(null)
    setRemoval(null)
  }

  function closePhoto() {
    const id = viewer?.id
    clearPhoto()
    if (id) requestAnimationFrame(() => gallery.current?.querySelector('[data-media-id="' + id + '"] .card-main')?.focus())
  }

  function showLocked(status) {
    const current = session.current
    current.version++
    current.busy = false
    setBusy(false)
    form.current?.reset()
    clearPhoto()
    setError('')
    setNotice(null)
    setState(status)
    setConnect(false)
  }

  useEffect(() => {
    const current = session.current
    current.active = true
    const version = current.version
    const isCurrent = () => current.active && version === current.version
    const unsubscribe = api.observeLock(status => { if (current.active) showLocked(status) })
    api.state().then(result => {
      if (!isCurrent()) return
      if (result.error) setError(result.error)
      else setState(result.value)
    }).catch(() => { if (isCurrent()) setError('FAILED') })
    return () => {
      current.active = false
      current.version++
      unsubscribe()
      api.lock().catch(() => {})
    }
  }, [api])

  async function run(action, receive) {
    const current = session.current
    if (current.busy) return
    const version = current.version
    const isCurrent = () => current.active && version === current.version
    current.busy = true
    setBusy(true)
    setError('')
    setNotice(null)
    try {
      const result = await action()
      if (!isCurrent()) return
      if (result.error) setError(result.error)
      else if (result.value !== null) receive(result.value)
    } catch {
      if (isCurrent()) setError('FAILED')
    } finally {
      if (isCurrent()) {
        current.busy = false
        setBusy(false)
      }
    }
  }

  function submit(event) {
    event.preventDefault()
    const accessForm = event.currentTarget
    const values = new FormData(accessForm)
    const password = values.get('password')
    const create = !state.configured && !connect
    if (!password || (create && Array.from(password).length < minimumPasswordLength)) {
      setError(create ? 'PASSWORD_LENGTH' : 'PASSWORD_REQUIRED')
      accessForm.elements.password.focus()
      return
    }
    if (create && password !== values.get('confirm')) {
      setError('MISMATCH')
      accessForm.elements.confirm.focus()
      return
    }
    accessForm.reset()
    const authenticate = connect ? api.connect : create ? api.create : api.unlock
    run(() => authenticate(password), result => {
      setConnect(false)
      setState(result)
    })
  }

  function lock() {
    showLocked({ configured: true, unlocked: false, items: [] })
    api.lock().catch(() => {})
  }

  function importPhotos() {
    run(api.import, result => {
      setState(result)
      setNotice({ added: result.added, skipped: result.skipped })
    })
  }

  function seePhoto(photo, direction = 0) {
    run(() => api.image(photo.id), data => {
      setViewer({ id: photo.id, url: data, direction })
    })
  }

  async function savePrivatePhoto(id, data) {
    const current = session.current
    const version = current.version
    const result = await api.saveCopy(id, data, state.generation)
    if (!current.active || current.version !== version) return null
    if (result.error) throw new Error(t(problems[result.error] || problems.FAILED))
    return result.value
  }

  function deletePhoto() {
    run(() => api.remove(removal.id), result => {
      clearPhoto()
      setState(result)
      if (result.cleanupFailed) setError('CLEANUP_FAILED')
    })
  }

  const feedback = error ? <p className={viewing ? 'toast is-error' : 'vault-error'} id="vault-feedback" role="alert">
    {t(error === 'MISMATCH' ? 'Пароли не совпадают.' : problems[error] || problems.FAILED)}
  </p> : null
  if (!state) return <section className="vault-card vault-access vault-loading">
    {feedback || <p role="status">{t('Загружаем приватную папку…')}</p>}
  </section>

  if (!state.unlocked) {
    const creating = !state.configured && !connect
    const passwordInvalid = error === 'PASSWORD_LENGTH' || error === 'PASSWORD_REQUIRED'
    const confirmInvalid = error === 'MISMATCH'
    return <form ref={form} className="vault-card vault-access" onSubmit={submit} onInput={error ? () => setError('') : undefined}
      autoComplete="off" noValidate aria-busy={busy} aria-labelledby="vault-access-title">
      <header className="vault-access-header">
        <div className="vault-emblem"><LockKeyhole size={24} strokeWidth={1.6} aria-hidden="true" /></div>
        <h1 id="vault-access-title">{t(connect ? 'Открыть приватную папку' : creating ? 'Создать приватную папку' : 'Папка заблокирована')}</h1>
        <p>{t(creating ? 'Сохраните пароль для доступа к зашифрованным фото.' : 'Введите пароль от приватной папки.')}</p>
      </header>
      <label>{t('Пароль')}
        <input type="password" name="password" autoComplete="off" maxLength={256} required disabled={busy}
          aria-invalid={passwordInvalid || undefined} aria-describedby={passwordInvalid ? 'vault-feedback' : creating ? 'vault-password-hint' : undefined} />
      </label>
      {creating && <label>{t('Повторите пароль')}
        <input type="password" name="confirm" autoComplete="off" maxLength={256} required disabled={busy}
          aria-invalid={confirmInvalid || undefined} aria-describedby={confirmInvalid ? 'vault-feedback' : undefined} />
      </label>}
      {creating && !passwordInvalid && <p id="vault-password-hint">{t('Не менее {count} символов', { count: minimumPasswordLength })}</p>}
      {feedback}
      <button className="primary-button" type="submit" disabled={busy}>
        {t(busy ? 'Подождите…' : state.configured && !connect ? 'Разблокировать' : 'Выбрать папку…')}
      </button>
      <button className="vault-access-alternate" type="button" disabled={busy} onClick={() => {
        form.current?.reset()
        setConnect(!connect)
        setError('')
      }}>{t(!connect ? 'Открыть существующую папку' : state.configured ? 'Назад' : 'Создать новую папку')}</button>
    </form>
  }

  const current = viewing ? items[viewerIndex] : null
  const portal = gallery.current?.closest('.app-root')
  return <section className="vault-gallery" ref={gallery} aria-busy={busy} aria-label={t('Приватные фото')}>
    <div className="vault-tools">
      <button type="button" className="primary-button" disabled={busy} onClick={importPhotos} aria-describedby="vault-import-note">
        <Plus size={17} aria-hidden="true" />{t('Добавить приватные фото')}
      </button>
      <button type="button" className="outline-button" onClick={lock}><Lock size={16} aria-hidden="true" />{t('Заблокировать папку')}</button>
      <div className="view-toggle" role="group" aria-label={t('Вид галереи')}>
        <IconButton icon={LayoutGrid} label={t('Плитки')} size={16} aria-pressed={view === 'grid'} onClick={() => setView('grid')} />
        <IconButton icon={List} label={t('Список')} size={18} aria-pressed={view === 'list'} onClick={() => setView('list')} />
      </div>
    </div>
    <p id="vault-import-note" className="vault-import-note">{t('Folio создаст зашифрованные копии. Исходные файлы останутся на месте.')}</p>
    {notice && <p className="vault-message" role="status">
      {t('Добавлено {count} фото', { count: notice.added })}
      {notice.skipped ? ' · ' + t('пропущено {count}', { count: notice.skipped }) : ''}
    </p>}
    {!viewing && feedback}
    {items.length ? <GalleryGrid items={items} view={view} onOpen={seePhoto}
      renderPicture={item => <PrivateThumbnail item={item} load={loadThumbnail} />} /> :
      <div className="vault-card vault-empty">
        <Image size={25} aria-hidden="true" /><h2>{t('Пока нет приватных фото')}</h2>
      </div>}
    {current && portal && createPortal(<>
      <Viewer item={{ ...current, viewUrl: viewer.url }} close={closePhoto} backLabel={t('Приватное')}
        direction={viewer.direction} blocked={Boolean(removal)} savePrivatePhoto={savePrivatePhoto}
        previous={viewerIndex > 0 ? () => seePhoto(items[viewerIndex - 1], -1) : undefined}
        next={viewerIndex < items.length - 1 ? () => seePhoto(items[viewerIndex + 1], 1) : undefined}
        remove={() => setRemoval(current)} edited={result => {
          setState(result)
          seePhoto({ id: result.id })
        }} />
      {feedback}
      {removal && <Dialog title={t('Удалить приватное фото?')} onClose={() => { if (!busy) setRemoval(null) }}>
        <p>{t('Folio удалит зашифрованную копию «{name}».', { name: removal.filename })}</p>
        <div className="dialog-actions">
          <button type="button" className="outline-button" autoFocus disabled={busy} onClick={() => setRemoval(null)}>{t('Отмена')}</button>
          <button type="button" className="primary-button" disabled={busy} onClick={deletePhoto}>{t('Удалить')}</button>
        </div>
      </Dialog>}
    </>, portal)}
  </section>
}
