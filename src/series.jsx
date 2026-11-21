import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, Layers, Play } from 'lucide-react'
import { groupSeries } from '../shared/series.mjs'
import { useLocale } from './localization.jsx'
import { IconButton, Picture, clock } from './ui.jsx'
import './series.css'

const episodesOf = series => series.seasons.flatMap(season => season.episodes)
const hasResume = progress => progress?.position > 0 && !progress.watched

export function SeriesView({ items, playback = {}, query = '', openEpisode, setWatched }) {
  const { t, language } = useLocale()
  const [selected, setSelected] = useState(null)
  const [seasonNumber, setSeasonNumber] = useState(null)
  const root = useRef(null)
  const focus = useRef(null)
  const groups = useMemo(() => groupSeries(items, language), [items, language])
  const search = query.trim().toLocaleLowerCase(language)
  const matches = value => value?.toLocaleLowerCase(language).includes(search)
  const shown = search ? groups.filter(series => matches(series.title) ||
    episodesOf(series).some(({ item }) => matches(item.name) || matches(item.folderName))) : groups
  const series = shown.find(item => item.key === selected)

  useLayoutEffect(() => {
    if (!focus.current) return
    const target = focus.current
    focus.current = null
    root.current?.querySelector(target)?.focus()
  }, [selected])

  if (!shown.length) return <div className="gallery-empty">
    <span className="empty-icon"><Layers size={26} strokeWidth={1.5} /></span>
    <h2>{t(search ? 'Сериалы не найдены' : 'Сериалов пока нет')}</h2>
    {!search && <p>{t('Добавьте папку с сериями или видео с номерами эпизодов в именах файлов.')}</p>}
  </div>

  if (!series) return <div className="series-grid" ref={root}>
    {shown.map(group => {
      const episodes = episodesOf(group)
      const watched = episodes.filter(({ item }) => playback[item.id]?.watched).length
      const cover = group.seasons.find(season => season.number > 0)?.episodes[0] ?? episodes[0]
      const progress = t('Просмотрено {watched} из {total}', { watched, total: episodes.length })
      return <button className="series-card" type="button" key={group.key} data-series-key={group.key}
        aria-label={t('Открыть сериал «{name}»', { name: group.title })} aria-description={progress} onClick={() => {
          const resume = group.seasons.find(season => season.episodes.some(({ item }) => hasResume(playback[item.id])))
          setSeasonNumber((resume ?? group.seasons.find(season => season.number > 0) ?? group.seasons[0]).number)
          focus.current = '.series-title'
          setSelected(group.key)
        }}>
        <span className="series-card-cover"><Picture item={cover.item} /></span>
        <span className="series-card-details">
          <strong title={group.title}>{group.title}</strong>
          <span>{progress}</span>
        </span>
        <span className="series-card-progress" aria-hidden="true" style={{ '--series-progress': watched / episodes.length * 100 + '%' }} />
      </button>
    })}
  </div>

  const season = series.seasons.find(item => item.number === seasonNumber) ?? series.seasons[0]
  const episodes = episodesOf(series)
  const orderedItems = episodes.map(({ item }) => item)
  const watched = episodes.filter(({ item }) => playback[item.id]?.watched).length
  const episodeNumbers = new Intl.NumberFormat(language, { useGrouping: false })

  return <section className="series-detail" ref={root} aria-labelledby="series-title">
    <button type="button" className="breadcrumb series-back" onClick={() => {
      focus.current = '[data-series-key="' + CSS.escape(series.key) + '"]'
      setSelected(null)
    }}><ChevronLeft size={15} />{t('Все сериалы')}</button>
    <div className="series-heading">
      <h2 className="series-title" id="series-title" tabIndex={-1}>{series.title}</h2>
      <span>{t('Просмотрено {watched} из {total}', { watched, total: episodes.length })}</span>
    </div>
    <div className="series-seasons">
      {series.seasons.map(({ number }) => <button key={number} type="button" className="outline-button"
        aria-pressed={season.number === number} onClick={() => setSeasonNumber(number)}>
        {number ? t('Сезон {number}', { number }) : t('Спецвыпуски')}
      </button>)}
    </div>
    <ul className="series-episodes">
      {season.episodes.map(({ item, number }) => {
        const progress = playback[item.id]
        const label = t('Эпизод {number}', { number: episodeNumbers.format(number) })
        const status = progress?.watched ? t('Просмотрено') :
          hasResume(progress) ? t('Продолжить с {time}', { time: clock(progress.position) }) : null
        const fraction = hasResume(progress) && progress.duration > 0 ? Math.min(1, progress.position / progress.duration) : 0
        return <li className="series-episode" key={item.id}>
          <button type="button" className="series-episode-open" title={item.filename}
            aria-label={t('Открыть «{name}»', { name: item.name })} aria-description={status ?? undefined}
            onClick={() => openEpisode(item, orderedItems)}>
            <span className="series-episode-cover"><Picture item={item} /><span className="series-episode-play"><Play size={18} fill="currentColor" /></span></span>
            <span className="series-episode-label"><strong>{label}</strong><span>{item.name}</span></span>
            {status && <span className="series-episode-status">{status}</span>}
            {fraction > 0 && <span className="series-episode-progress" aria-hidden="true" style={{ '--series-progress': fraction * 100 + '%' }} />}
          </button>
          <IconButton icon={Check} className="series-watched" aria-pressed={Boolean(progress?.watched)}
            label={t(progress?.watched ? 'Отметить непросмотренным' : 'Отметить просмотренным')}
            onClick={() => setWatched(item.id, !progress?.watched)} />
        </li>
      })}
    </ul>
  </section>
}
