import { useEffect, useState } from 'react'
import { FolderOpen, HardDrive, History, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react'
import { useLocale } from './localization.jsx'
import { mediaApi } from './media-api.mjs'
import { Dialog, IconButton, Picture } from './ui.jsx'
import { translateError } from '../shared/locale.mjs'
import './library-settings.css'

function sizeLabel(bytes, language) {
  if (bytes == null) return '—'
  const formats = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte']
  const power = Math.min(formats.length - 1, Math.max(0, Math.floor(Math.log10(Math.max(bytes, 1)) / 3)))
  return new Intl.NumberFormat(language, { style: 'unit', unit: formats[power], maximumFractionDigits: 1 }).format(bytes / 1000 ** power)
}

export function LibrarySettings({ close, moved, progress }) {
  const { t, language } = useLocale()
  const [info, setInfo] = useState(null)
  const [action, setAction] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    mediaApi.librarySettings().then(result => { if (active) setInfo(result) }, failure => {
      if (active) setError(translateError(language, failure))
    })
    const unsubscribe = mediaApi.observeBackupStatus(status => setInfo(current => current && { ...current, backup: status }))
    return () => { active = false; unsubscribe() }
  }, [language])

  async function perform(name, operation) {
    setAction(name)
    setError('')
    try { await operation() } catch (failure) { setError(translateError(language, failure)) } finally { setAction('') }
  }

  const date = value => value ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(value) : '—'
  const backup = info?.backup
  return <Dialog title={t('Настройки медиатеки')} onClose={() => { if (!action) close() }} className="library-settings">
    {!info && !error && <div className="settings-loading" role="status"><LoaderCircle size={18} />{t('Загружаем медиатеку…')}</div>}
    {info && <>
      <section className="settings-section">
        <h3><HardDrive size={18} />{t('Хранилище')}</h3>
        <div className="settings-path" title={info.directory}>{info.directory}</div>
        <dl className="settings-sizes">
          <div><dt>{t('Файлы медиатеки')}</dt><dd>{sizeLabel(info.mediaBytes, language)}</dd></div>
          <div><dt>{t('Миниатюры и кэш')}</dt><dd>{sizeLabel(info.cacheBytes, language)}</dd></div>
          <div><dt>{t('Свободно на диске')}</dt><dd>{sizeLabel(info.availableBytes, language)}</dd></div>
        </dl>
        <button type="button" className="outline-button" disabled={Boolean(action || backup.running)} onClick={() => perform('move', async () => {
          const result = await mediaApi.moveLibrary()
          if (!result) return
          moved(result)
          setInfo(await mediaApi.librarySettings())
        })}><FolderOpen size={16} />{t('Перенести медиатеку…')}</button>
        {action === 'move' && progress?.total > 0 && <progress aria-label={t('Переносим медиатеку')} max={progress.total} value={progress.done} />}
      </section>
      <section className="settings-section">
        <h3><History size={18} />{t('Автоматические копии')}</h3>
        <div className="settings-backup-path">
          <div className="settings-path" title={backup.directory || undefined}>{backup.directory || t('Папка ещё не выбрана')}</div>
          <button type="button" className="outline-button" disabled={Boolean(action || backup.running)} onClick={() =>
            perform('schedule', async () => {
              const status = await mediaApi.automaticBackupFolder()
              setInfo(current => ({ ...current, backup: status }))
            })}>{t('Выбрать папку…')}</button>
        </div>
        <label className="settings-frequency">{t('Расписание')}
          <select aria-label={t('Расписание')} value={backup.frequency} disabled={!backup.directory || Boolean(action || backup.running)}
            onChange={event => {
              const frequency = event.target.value
              perform('schedule', async () => {
                const status = await mediaApi.automaticBackupFrequency(frequency)
                setInfo(current => ({ ...current, backup: status }))
              })
            }}>
            <option value="off">{t('Выключено')}</option>
            <option value="daily">{t('Ежедневно')}</option>
            <option value="weekly">{t('Еженедельно')}</option>
          </select>
        </label>
        <dl className="settings-backup-dates">
          <div><dt>{t('Последняя успешная копия')}</dt><dd>{date(backup.lastSuccessAt)}</dd></div>
          <div><dt>{t('Следующий запуск')}</dt><dd>{backup.running ? t('Создаём резервную копию') : date(backup.nextAt)}</dd></div>
        </dl>
        <p>{t('Копии по расписанию создаются, пока Folio открыт.')}</p>
        {backup.lastFailure && <p className="settings-error" role="status">{translateError(language, { message: backup.lastFailure })}</p>}
      </section>
    </>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </Dialog>
}

const pageSize = 48

export function DeletedPhotos({ items, restore, recycle, recycleAll, working }) {
  const { t, language } = useLocale()
  const [requested, setPage] = useState(0)
  const last = Math.max(0, Math.ceil(items.length / pageSize) - 1)
  const page = Math.min(requested, last)
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' })
  if (!items.length) return <div className="gallery-empty">
    <div className="empty-icon"><Trash2 size={26} strokeWidth={1.4} /></div>
    <h2>{t('Удалённых фото пока нет')}</h2>
  </div>
  return <section className="deleted-view" aria-busy={working}>
    <div className="deleted-actions">
      <span>{t('Восстановленные фото вернутся в свои папки и подборки.')}</span>
      <div className="deleted-bulk">
        <button type="button" className="outline-button" disabled={working} onClick={() => restore(items.map(item => item.id))}>
          <RotateCcw size={15} />{t('Восстановить все')}
        </button>
        <button type="button" className="danger-button" disabled={working} onClick={recycleAll}>
          <Trash2 size={15} />{t('Удалить все')}
        </button>
      </div>
    </div>
    <div className="deleted-grid">
      {items.slice(page * pageSize, (page + 1) * pageSize).map(item => <article className="media-card deleted-card" key={item.id}>
        <div className="media-thumb"><Picture item={{ ...item, kind: 'photo' }} /></div>
        <div className="card-caption">
          <strong title={item.filename}>{item.name}</strong>
          <span><span className="caption-folder" title={item.folderName}>{item.folderName}</span><span className="inline-dot" /><span className="caption-date">{date.format(item.deletedAt)}</span></span>
        </div>
        <div className="deleted-card-actions">
          <IconButton icon={RotateCcw} label={t('Восстановить «{name}»', { name: item.name })} disabled={working} onClick={() => restore([item.id])} />
          <IconButton icon={Trash2} label={t('В корзину Windows')} disabled={working} onClick={() => recycle(item)} />
        </div>
      </article>)}
    </div>
    {last > 0 && <div className="deleted-pages">
      <button type="button" className="outline-button" disabled={working || page === 0} onClick={() => setPage(page - 1)}>{t('Предыдущая страница')}</button>
      <span>{page + 1} / {last + 1}</span>
      <button type="button" className="outline-button" disabled={working || page === last} onClick={() => setPage(page + 1)}>{t('Следующая страница')}</button>
    </div>}
  </section>
}
