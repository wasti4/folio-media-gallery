import { useId, useMemo, useState } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { calendarDate, emptyLibraryFilters, hasLibraryFilters } from '../shared/library-search.mjs'
import { useLocale } from './localization.jsx'
import './library-search.css'

function getOptions(items) {
  const tags = new Map()
  const timeline = new Map()
  const months = new Set()
  for (const item of items) {
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      if (typeof tag !== 'string') continue
      const key = tag.normalize('NFC').toLowerCase()
      if (!tags.has(key)) tags.set(key, tag)
    }
    const date = calendarDate(item)
    if (!date) continue
    const [year, month] = date.split('-')
    if (!timeline.has(year)) timeline.set(year, new Set())
    timeline.get(year).add(month)
    months.add(month)
  }
  return { tags, timeline, months }
}

function optionsWithSelected(values, selected) {
  return [...new Set(selected ? [...values, selected] : values)]
}

export function LibraryFilters({ items, folders, filters, onChange }) {
  const { t, language } = useLocale()
  const [expanded, setExpanded] = useState(false)
  const controls = useId()
  const { tags, timeline, months } = useMemo(() => getOptions(items), [items])
  const collator = useMemo(() => new Intl.Collator(language, { numeric: true, sensitivity: 'base' }), [language])
  const monthName = useMemo(() => new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' }), [language])
  const active = hasLibraryFilters(filters)
  const availableYears = optionsWithSelected(timeline.keys(), filters.year).sort().reverse()
  const availableMonths = optionsWithSelected(filters.year ? timeline.get(filters.year) ?? [] : months, filters.month).sort()
  const availableTags = optionsWithSelected(tags.keys(), filters.tag)
    .sort((a, b) => collator.compare(tags.get(a) ?? a, tags.get(b) ?? b))
  const availableFolders = folders.filter(folder => folder.kind !== 'collection')
    .sort((a, b) => collator.compare(a.name, b.name))

  function update(event) {
    const { name, value } = event.currentTarget
    const next = { ...filters, [name]: value }
    if (name === 'year') next.month = ''
    onChange(next)
  }

  return <div className="library-filters">
    <div className="library-filter-actions">
      <button type="button" className="outline-button library-filter-toggle" aria-expanded={expanded} aria-controls={controls}
        data-active={active || undefined} onClick={() => setExpanded(value => !value)}>
        <SlidersHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
        {t('Фильтры')}
        <ChevronDown className="library-filter-chevron" size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {active && <button type="button" className="library-filter-reset" onClick={() => onChange(emptyLibraryFilters)}>
        {t('Сбросить фильтры')}
      </button>}
    </div>
    <div id={controls} className="library-filter-panel" hidden={!expanded} role="group" aria-label={t('Фильтры')}>
      <label>{t('Дата с')}<input type="date" name="from" value={filters.from} max={filters.to || undefined} onChange={update} /></label>
      <label>{t('Дата по')}<input type="date" name="to" value={filters.to} min={filters.from || undefined} onChange={update} /></label>
      <label>{t('Тег')}<select name="tag" value={filters.tag} onChange={update}>
        <option value="">{t('Все теги')}</option>
        {availableTags.map(tag => <option value={tag} key={tag}>{tags.get(tag) ?? tag}</option>)}
      </select></label>
      <label>{t('Папка')}<select name="folderId" value={filters.folderId} onChange={update}>
        <option value="">{t('Все папки')}</option>
        {availableFolders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
      </select></label>
      <label>{t('Год')}<select name="year" value={filters.year} onChange={update}>
        <option value="">{t('Все годы')}</option>
        {availableYears.map(year => <option value={year} key={year}>{year}</option>)}
      </select></label>
      <label>{t('Месяц')}<select name="month" value={filters.month} onChange={update}>
        <option value="">{t('Все месяцы')}</option>
        {availableMonths.map(month => <option value={month} key={month}>{monthName.format(Date.UTC(2020, Number(month) - 1, 1))}</option>)}
      </select></label>
    </div>
  </div>
}

export function PhotoTagsField({ tags, onChange, disabled, autoFocus }) {
  const { t } = useLocale()
  const help = useId()
  const input = useId()
  return <div className="field-label">
    <label htmlFor={input}>{t('Теги')}</label>
    <input id={input} type="text" name="tags" value={Array.isArray(tags) ? tags.join(', ') : tags ?? ''}
      disabled={disabled} autoFocus={autoFocus} aria-describedby={help} onChange={event => onChange(event.currentTarget.value)} />
    <span id={help} className="photo-tag-format">{t('Через запятую')}</span>
  </div>
}
