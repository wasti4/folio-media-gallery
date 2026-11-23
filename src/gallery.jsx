import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDownWideNarrow, Check, ChevronDown, Clock3, Clapperboard, Copy, Ellipsis, Film,
  Folder, Globe2, HardDrive, Heart, Image, Images, LayoutGrid, List, LockKeyhole, Minus, Play, Plus, Search, Settings2, Square, SquareCheckBig, Trash2, Tv, Undo2, X,
} from 'lucide-react'
import { IconButton, Picture, clock, formatDate } from './ui.jsx'
import { isDesktop, mediaApi } from './media-api.mjs'
import { brandBars, productName } from '../shared/brand.mjs'
import { ThemeSwitch } from './theme-switch.jsx'
import { useLocale } from './localization.jsx'

const destinations = [
  { id: 'all', label: 'Все файлы', Icon: LayoutGrid },
  { id: 'favorites', label: 'Избранное', Icon: Heart },
  { id: 'recent', label: 'Недавние', Icon: Clock3 },
  ...(isDesktop ? [
    { id: 'series', label: 'Сериалы', Icon: Tv },
    { id: 'vault', label: 'Приватная папка', shortLabel: 'Приватное', Icon: LockKeyhole },
    { id: 'deleted', label: 'Недавно удалённые', shortLabel: 'Удалённые', Icon: Trash2 },
  ] : []),
]

export function BrandMark() {
  return <span className="brand-mark"><svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
    {brandBars.map(bar => <polygon key={bar.points} {...bar} />)}
  </svg></span>
}

function SidebarPanelIcon({ size }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect className="sidebar-toggle-panel" x="3.4" y="4.35" width="7.85" height="15.3" rx="2.25" fill="currentColor" />
    <path className="sidebar-toggle-divider" d="M11.25 4.35v15.3" stroke="currentColor" strokeWidth="1.35" />
    <rect x="3.4" y="4.35" width="17.2" height="15.3" rx="3" stroke="currentColor" strokeWidth="1.45" />
  </svg>
}

export function Sidebar({ state, active, navigate, createFolder, expanded, setExpanded }) {
  const { t, language } = useLocale()
  const scroll = useRef(null)
  const [lens, setLens] = useState(null)
  const folderActive = state.folders.some(folder => folder.id === active)
  useLayoutEffect(() => {
    const root = scroll.current
    const measure = () => {
      const row = root.querySelector('[data-rail-current]')
      if (!row) return setLens(null)
      setLens({ top: row.offsetTop, height: row.offsetHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [active, expanded, state.folders.length, language])

  return <aside className="sidebar" aria-label={t('Разделы медиатеки')} data-expanded={expanded}>
    <div className="brand" aria-label={productName}>
      <BrandMark />
      <span className="brand-name rail-label">{productName}</span>
    </div>
    <div className="sidebar-scroll" ref={scroll}>
      {lens && <div className="sidebar-lens" aria-hidden="true" style={{ '--rail-top': lens.top + 'px', height: lens.height }} />}
      <nav className="side-group" aria-label={t('Медиатека')}>
        <div className="side-heading rail-label section-heading">{t('Медиатека')}</div>
        {destinations.map(({ id, label, shortLabel = label, Icon }) => <button type="button" key={id} className={'side-row' + (active === id ? ' selected' : '')}
          data-rail-current={active === id ? '' : undefined} data-destination={id}
          title={t(label)} aria-label={t(label)} aria-current={active === id ? 'page' : undefined} onClick={() => navigate(id)}>
          <Icon className="side-icon" size={18} strokeWidth={1.7} />
          <span className="side-name rail-label">{t(shortLabel)}</span>
          {id === 'all' && <span className="side-count rail-label">{state.items.length}</span>}
        </button>)}
      </nav>
      <nav className="side-group folder-group" aria-label={t('Папки')}>
        <div className="folder-list" id="sidebar-folders" inert={!expanded}>
          <div className="side-heading"><span>{t('Папки')}</span><IconButton icon={Plus} size={16} label={t('Новая подборка')} onClick={createFolder} /></div>
          {state.folders.map(folder => <button type="button" key={folder.id} className={'side-row file-folder' + (active === folder.id ? ' selected' : '')}
            data-folder-id={folder.id}
            data-rail-current={expanded && active === folder.id ? '' : undefined}
            title={folder.location || folder.name} aria-current={active === folder.id ? 'page' : undefined} onClick={() => navigate(folder.id)}>
            <Folder size={17} strokeWidth={1.7} className="side-icon folder-icon" />
            <span className="side-name">{folder.name}</span>
          </button>)}
        </div>
        <button type="button" className={'side-row folder-trigger' + (folderActive ? ' selected' : '')} inert={expanded}
          data-rail-current={!expanded && folderActive ? '' : undefined} hidden={expanded}
          title={t('Папки')} aria-label={t('Папки')} aria-expanded="false" onClick={() => setExpanded(true)}>
          <Folder className="side-icon" size={18} strokeWidth={1.65} />
        </button>
      </nav>
    </div>
    <div className="storage rail-label" aria-hidden={!expanded}>
      <HardDrive size={16} strokeWidth={1.65} />
      <span>{t(state.demo ? 'Демо-коллекция' : 'Локальная библиотека')}</span>
    </div>
    <div className="sidebar-footer">
      <IconButton icon={SidebarPanelIcon} size={20} className="sidebar-toggle" aria-controls="sidebar-folders"
        label={t(expanded ? 'Свернуть боковую панель' : 'Развернуть боковую панель')} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} />
    </div>
  </aside>
}

export function Titlebar({ search, setSearch, searchRef, openImport, importing, changeTheme, openLanguage, openSettings, undo, privateScope }) {
  const { t } = useLocale()
  const [maximized, setMaximized] = useState(false)
  const maximize = async () => setMaximized(await mediaApi.window('maximize'))
  useEffect(() => mediaApi.observeWindow?.(setMaximized), [])
  return <header className="titlebar" onDoubleClick={event => { if (isDesktop && event.target === event.currentTarget) maximize() }}>
    {!privateScope && <label className="search-field">
      <Search size={17} strokeWidth={1.8} />
      <input ref={searchRef} type="search" aria-label={t('Поиск в медиатеке')} placeholder={t('Поиск в медиатеке')} value={search} onChange={event => setSearch(event.target.value)} />
      {search ? <IconButton icon={X} size={15} label={t('Очистить поиск')} onClick={() => { setSearch(''); searchRef.current.focus() }} /> : <kbd>Ctrl K</kbd>}
    </label>}
    <div className="title-actions">
      <ThemeSwitch change={changeTheme} />
      <IconButton icon={Globe2} label={t('Язык интерфейса')} data-popup-trigger aria-haspopup="menu" onClick={openLanguage} />
      {undo && <IconButton icon={Undo2} label={t('Отменить перемещение')} onClick={undo} />}
      {openSettings && <IconButton icon={Settings2} label={t('Настройки медиатеки')} onClick={openSettings} />}
      {!privateScope && <button className="primary-button import-button" type="button" onClick={openImport} data-popup-trigger aria-label={t('Импорт')} aria-haspopup="menu" disabled={importing}>
        <Plus size={17} strokeWidth={1.8} />
        <span>{t(importing ? 'Импорт…' : 'Импорт')}</span>
      </button>}
      {isDesktop && <div className="window-controls" aria-label={t('Управление окном')}>
        <IconButton icon={Minus} size={15} label={t('Свернуть окно')} onClick={() => mediaApi.window('minimize')} />
        <IconButton icon={maximized ? Copy : Square} size={13} label={t(maximized ? 'Восстановить окно' : 'Развернуть окно')} onClick={maximize} />
        <IconButton icon={X} size={16} label={t('Закрыть окно')} className="window-close" onClick={() => mediaApi.window('close')} />
      </div>}
    </div>
  </header>
}

export function Feature({ item, open, favorite }) {
  const { t } = useLocale()
  return <section className="feature" aria-labelledby="feature-title">
    <Picture item={item} className="feature-image" eager />
    <div className="feature-shade" />
    <div className="feature-content">
      <div className="feature-type"><Film size={14} strokeWidth={1.7} /> {t('Видео')} <span /> {clock(item.duration)}</div>
      <h2 id="feature-title">{item.name}</h2>
      <p>{t('Сумерки в Доломитах')}</p>
      <button type="button" className="feature-play" onClick={open}><Play size={15} fill="currentColor" /> {t('Смотреть')}</button>
    </div>
    <IconButton icon={Heart} label={t(item.favorite ? 'Убрать видео из избранного' : 'Добавить видео в избранное')} aria-pressed={item.favorite}
      className={'feature-favorite glass-button' + (item.favorite ? ' is-favorite' : '')} onClick={favorite} />
  </section>
}

const types = [
  { id: 'all', label: 'Все', Icon: LayoutGrid },
  { id: 'photo', label: 'Фото', Icon: Image },
  { id: 'video', label: 'Видео', Icon: Clapperboard },
  { id: 'gif', label: 'GIF', Icon: null },
]

function TypeTabs({ value, change }) {
  const { t, language } = useLocale()
  const rail = useRef(null)
  const [lens, setLens] = useState({ left: 4, width: 0 })
  useLayoutEffect(() => {
    const measure = () => {
      const active = rail.current?.querySelector('[aria-selected="true"]')
      if (active) setLens({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rail.current)
    return () => observer.disconnect()
  }, [value, language])

  function keyboard(event, index) {
    const shifts = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: types.length - 1 }
    if (!(event.key in shifts)) return
    const next = (shifts[event.key] + types.length) % types.length
    event.preventDefault()
    change(types[next].id)
    rail.current.querySelectorAll('button')[next].focus()
  }

  return <div className="type-tabs" role="tablist" aria-label={t('Тип медиа')} ref={rail}>
    <div className="liquid-selection" style={{ width: lens.width, transform: 'translateX(' + lens.left + 'px)' }} />
    {types.map(({ id, label, Icon }, index) => <button type="button" className="type-tab" role="tab" id={'tab-' + id} key={id}
      aria-selected={id === value} aria-controls="gallery-panel" tabIndex={id === value ? 0 : -1}
      onClick={() => change(id)} onKeyDown={event => keyboard(event, index)}>
      {Icon && <Icon size={15} strokeWidth={1.8} />}
      {t(label)}
    </button>)}
  </div>
}

export const sortOptions = [
  { id: 'newest', name: 'По дате', description: 'Сначала новые' },
  { id: 'oldest', name: 'По дате', description: 'Сначала старые' },
  { id: 'capture', name: 'Дата съёмки', description: 'По дате съёмки' },
  { id: 'name', name: 'По имени', description: 'По имени' },
  { id: 'kind', name: 'По типу', description: 'По типу' },
]

export function GalleryToolbar({ filter, setFilter, sort, openSort, view, setView, selecting, canSelect, toggleSelect }) {
  const { t } = useLocale()
  return <div className="gallery-toolbar">
    <TypeTabs value={filter} change={setFilter} />
    <div className="gallery-actions">
      <button type="button" title={t('Сортировка')} className="sort-button" aria-haspopup="menu" data-popup-trigger onClick={openSort}>
        <ArrowDownWideNarrow size={17} strokeWidth={1.7} />
        <span>{t(sortOptions.find(option => option.id === sort)?.name || 'По дате')}</span>
        <ChevronDown size={13} strokeWidth={1.8} />
      </button>
      <div className="view-toggle" role="group" aria-label={t('Вид галереи')}>
        <IconButton icon={LayoutGrid} label={t('Плитки')} size={16} aria-pressed={view === 'grid'} onClick={() => setView('grid')} />
        <IconButton icon={List} label={t('Список')} size={18} aria-pressed={view === 'list'} onClick={() => setView('list')} />
      </div>
      {isDesktop && <button type="button" className="outline-button gallery-select" aria-pressed={selecting}
        aria-label={t(selecting ? 'Готово' : 'Выбрать')} disabled={!selecting && !canSelect} onClick={toggleSelect}>
        {selecting ? <Check size={16} /> : <SquareCheckBig size={16} />}
        <span>{t(selecting ? 'Готово' : 'Выбрать')}</span>
      </button>}
    </div>
  </div>
}

function MediaCard({ item, onOpen, onMenu, favorite, eager, selecting, picked, onPick, index, renderPicture }) {
  const { t, language } = useLocale()
  const canPick = selecting && item.kind === 'photo' && !item.demo
  return <article className={'media-card media-' + item.kind} data-media-id={item.id} data-picked={picked || undefined}
    data-pickable={canPick || undefined}>
    <button type="button" className="card-main" onClick={canPick ? onPick : onOpen} disabled={selecting && !canPick}
      role={canPick ? 'checkbox' : undefined} aria-checked={canPick ? picked : undefined}
      aria-label={t(canPick ? 'Выбрать «{name}»' : 'Открыть «{name}»', { name: item.name })}>
      <div className="media-thumb">
        {renderPicture ? renderPicture(item) : <Picture item={item} eager={eager} />}
        {canPick && <span className="card-selection" aria-hidden="true" style={{ '--pick-delay': Math.min(index, 12) * 10 + 'ms' }}>
          <Check size={15} strokeWidth={2.6} />
        </span>}
        <span className={'format-label format-' + item.kind}>{item.kind === 'video' && <Film size={12} />} {item.ext.toUpperCase()}</span>
        {item.kind === 'video' && <span className="thumb-play"><Play size={17} fill="currentColor" /></span>}
        {item.duration > 0 && <span className="duration-label">{clock(item.duration)}</span>}
      </div>
      <span className="card-caption">
        <strong title={item.filename}>{item.name}</strong>
        <span><span className="caption-folder" title={item.folderName}>{item.folderName}</span>{item.modifiedAt != null && <><span className="inline-dot" /><span className="caption-date">{formatDate(item.modifiedAt, language)}</span></>}</span>
      </span>
    </button>
    {!selecting && <>
      {favorite && <IconButton icon={Heart} className={'card-favorite glass-button' + (item.favorite ? ' is-favorite' : '')}
        size={16} label={t(item.favorite ? 'Убрать из избранного' : 'В избранное')} aria-pressed={item.favorite} onClick={favorite} />}
      {onMenu && <IconButton icon={Ellipsis} className="card-more" label={t('Действия для «{name}»', { name: item.name })} aria-haspopup="menu" data-popup-trigger onClick={onMenu} />}
    </>}
  </article>
}

const initialRange = { start: 0, end: 24, before: 0, after: 0 }
const overscanRows = 3
const maxGalleryHeight = 8_000_000

export function GalleryGrid({ items, view, onOpen, onMenu, favorite, selecting, picked, choose, renderPicture }) {
  const grid = useRef(null)
  const [range, setRange] = useState(initialRange)
  const count = items.length
  const windowed = count > 96

  useLayoutEffect(() => {
    if (!windowed) return
    const element = grid.current
    const root = element.closest('.gallery-scroll')
    let frame = 0
    let columns = 0
    let stride = 0
    let gap = 0

    function update() {
      if (!stride) return
      const rows = Math.ceil(count / columns)
      const fullHeight = rows * stride - gap
      const surface = Math.min(fullHeight, maxGalleryHeight)
      const viewport = root.clientHeight
      const offset = root.getBoundingClientRect().top - element.getBoundingClientRect().top
      // Keep scrolling addressable beyond Chromium's maximum layout height.
      const position = fullHeight > surface && offset > 0 ? offset * (fullHeight - viewport) / (surface - viewport) : offset
      const first = Math.max(0, Math.min(rows - 1, Math.floor(position / stride) - overscanRows))
      const last = Math.min(rows, Math.max(first + 1, Math.ceil((position + viewport) / stride) + overscanRows))
      const mountedHeight = (last - first) * stride - gap
      const before = Math.max(0, Math.min(surface - mountedHeight, first * stride - (position - offset)))
      const after = surface - before - mountedHeight
      const start = first * columns
      const end = Math.min(count, last * columns)
      setRange(current => current.start === start && current.end === end && current.before === before && current.after === after
        ? current : { start, end, before, after })
    }

    function measure() {
      const style = getComputedStyle(element)
      columns = style.gridTemplateColumns.split(' ').length
      gap = parseFloat(style.rowGap) || 0
      const firstRow = Array.from(element.children).slice(0, columns)
      stride = Math.max(0, ...firstRow.map(card => card.getBoundingClientRect().height)) + gap
      update()
    }

    function scroll() {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(root)
    root.addEventListener('scroll', scroll, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', scroll)
      cancelAnimationFrame(frame)
    }
  }, [count, view, windowed])

  const { start, end, before, after } = range
  // Keep a row available for measurement when a filter reduces a scrolled-down list.
  const visible = windowed ? items.slice(start < count ? start : 0, start < count ? end : initialRange.end) : items
  return <div className={'media-grid media-view-' + view} ref={grid}
    style={windowed ? { paddingBlockStart: before, paddingBlockEnd: after } : undefined}>
    {visible.map((item, index) => <MediaCard key={item.id} item={item} eager={index < 6} index={index}
      selecting={selecting} picked={picked?.has(item.id)} onPick={event => choose(item.id, event.shiftKey)} renderPicture={renderPicture}
      onOpen={() => onOpen(item)} favorite={favorite && (() => favorite(item.id))} onMenu={onMenu && (event => onMenu(event, item))} />)}
  </div>
}

export function EmptyGallery({ search, scope, filter, collection, clear, clearFilter, openImport }) {
  const { t } = useLocale()
  const { Icon, title, detail } = search ? { Icon: Search, title: 'Ничего не найдено', detail: 'Попробуйте другое название или расширение.' }
    : filter !== 'all' ? { Icon: Images, title: 'Нет файлов этого типа', detail: 'Покажите все типы медиа, чтобы продолжить просмотр.' }
      : scope === 'favorites' ? { Icon: Heart, title: 'Пока без избранного', detail: 'Нажмите на сердечко у файла, чтобы сохранить его здесь.' }
      : scope === 'recent' ? { Icon: Clock3, title: 'Пока ничего не открывали', detail: 'Просмотренные файлы появятся здесь.' }
        : collection ? { Icon: Folder, title: 'Подборка пуста', detail: 'Добавьте файлы через меню «Действия» на карточке.' }
          : { Icon: Images, title: 'Здесь пока нет файлов', detail: 'Выберите другой тип медиа или импортируйте файлы.' }
  return <div className="gallery-empty">
    <div className="empty-icon"><Icon size={27} strokeWidth={1.35} /></div>
    <h2>{t(title)}</h2><p>{t(detail)}</p>
    {search && <button className="outline-button" onClick={clear}>{t('Очистить поиск')}</button>}
    {!search && filter !== 'all' && <button className="outline-button" type="button" onClick={clearFilter}>{t('Показать все типы')}</button>}
    {!search && filter === 'all' && scope === 'all' && <button className="outline-button" type="button" data-popup-trigger onClick={openImport}>{t('Импорт')}</button>}
  </div>
}
