import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Camera, Captions, ChevronLeft, ChevronRight, CircleAlert, Headphones, Heart, ImageOff, LoaderCircle, Maximize, Minimize,
  Monitor, Pause, Play, Plus, RotateCcw, SlidersHorizontal, Trash2, Volume2, VolumeX, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { isDesktop, mediaApi, saveSetting, setting } from './media-api.mjs'
import { IconButton, Menu, MenuItem, clock } from './ui.jsx'
import { translateError } from '../shared/locale.mjs'
import { useLocale } from './localization.jsx'
import { Editor } from './editor.jsx'
import { usePhotoCamera } from './photo-camera.jsx'
import './viewer.css'

const kindNames = { photo: 'Фото', video: 'Видео', gif: 'GIF' }
const imageKey = item => item.viewUrl + '|' + item.modifiedAt

export function Viewer({
  item, close, favorite, previous, next, neighbor, direction, startEditing, edited, setWallpaper, remove, blocked,
  playbackProgress, onPlaybackProgress, onFrameSaved,
}) {
  const { t } = useLocale()
  const frame = useRef(null)
  const [full, setFull] = useState(false)
  const [displayedPhoto, setDisplayedPhoto] = useState(null)
  const [editing, setEditing] = useState(Boolean(startEditing))
  const editButton = useRef(null)
  const background = item.kind === 'video' ? item.preview : (displayedPhoto?.preview || item.preview)
  const ready = item.kind !== 'video' && displayedPhoto && imageKey(displayedPhoto) === imageKey(item)
  const preload = ready && neighbor?.kind !== 'video' && (neighbor?.size ?? 0) <= 16 * 1024 * 1024 ? neighbor?.viewUrl : undefined

  const fullscreen = useCallback(() => {
    const operation = document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen()
    operation?.catch(() => {})
  }, [])

  useEffect(() => {
    const update = () => setFull(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  useLayoutEffect(() => {
    if (!blocked && !frame.current?.contains(document.activeElement)) frame.current?.focus()
  }, [item.id, blocked])

  useEffect(() => {
    if (!preload) return
    const image = new Image()
    image.fetchPriority = 'low'
    image.src = preload
    image.decode().catch(() => {})
    return () => image.removeAttribute('src')
  }, [preload])

  function keyboard(event) {
    if (event.defaultPrevented || editing || blocked) return
    if (event.key === 'Escape') {
      if (document.fullscreenElement) fullscreen()
      else close()
      event.preventDefault()
    }
    if (item.kind === 'video' || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); previous?.() }
    if (event.key === 'ArrowRight') { event.preventDefault(); next?.() }
    if (event.key === 'Delete' && remove && !event.repeat) { event.preventDefault(); remove() }
    if (['f', 'а'].includes(event.key.toLowerCase())) fullscreen()
  }

  return <section className={'viewer' + (editing ? ' editor-open' : '')} ref={frame} tabIndex={-1} role="dialog" aria-modal="true" aria-label={item.name} onKeyDown={keyboard} inert={blocked}>
    <div className="viewer-background" style={{ backgroundImage: background ? 'url("' + background + '")' : undefined }} />
    {editing ? <Editor key={item.id} item={item} close={() => {
      setEditing(false)
      requestAnimationFrame(() => editButton.current?.focus())
    }} saved={result => { setEditing(false); edited(result) }} /> : <>
    <header className="viewer-top">
      <button type="button" className="viewer-back glass-button" onClick={close}><ArrowLeft size={17} /> <span>{t('Медиатека')}</span></button>
      <div className="viewer-heading"><strong title={item.filename}>{item.name}</strong><span>{t(kindNames[item.kind])}{item.kind !== 'gif' && ' · ' + item.ext.toUpperCase()}</span></div>
      <div className="viewer-top-actions">
        {setWallpaper && item.kind === 'photo' && <IconButton icon={Monitor} label={t('Сделать обоями')}
          className="glass-button" onClick={setWallpaper} />}
        {isDesktop && item.kind !== 'gif' && <IconButton icon={SlidersHorizontal} label={t('Редактировать')}
          className="glass-button" ref={editButton} onClick={() => setEditing(true)} />}
        <IconButton icon={Heart} label={t(item.favorite ? 'Убрать из избранного' : 'В избранное')} aria-pressed={item.favorite}
          className={'glass-button' + (item.favorite ? ' is-favorite' : '')} onClick={favorite} />
        {remove && <IconButton icon={Trash2} label={t('Удалить фото')} className="glass-button photo-delete" onClick={remove} />}
        <IconButton icon={X} label={t('Закрыть просмотр')} className="glass-button" onClick={close} />
      </div>
    </header>
    {item.kind === 'video' ?
      <Player key={item.id} item={item} full={full} fullscreen={fullscreen} playbackProgress={playbackProgress}
        onPlaybackProgress={onPlaybackProgress} onFrameSaved={onFrameSaved} /> :
      <PhotoView item={item} direction={direction} full={full} fullscreen={fullscreen} onDisplay={setDisplayedPhoto} />}
    <div className={'viewer-navigation' + (item.kind === 'video' ? ' video-navigation' : '')}>
      {previous && <IconButton icon={ChevronLeft} label={t('Предыдущий файл')} className="glass-button" onClick={previous} />}
      {next && <IconButton icon={ChevronRight} label={t('Следующий файл')} className="glass-button next-file" onClick={next} />}
    </div>
    </>}
  </section>
}

function PhotoView({ item, direction, full, fullscreen, onDisplay }) {
  const { t } = useLocale()
  const target = imageKey(item)
  const loading = useRef(null)
  const [frames, setFrames] = useState({ shown: null, leaving: null, direction: 0 })
  const [failed, setFailed] = useState(null)
  const displayedKey = frames.shown && imageKey(frames.shown)
  const leavingKey = frames.leaving && imageKey(frames.leaving)
  const pending = displayedKey !== target
  const broken = failed === target
  const pictures = [frames.leaving, frames.shown].filter(Boolean)
  if (pending && leavingKey !== target) pictures.push(item)
  const camera = usePhotoCamera(displayedKey, !pending && !broken)

  useLayoutEffect(() => {
    setFailed(null)
    const image = loading.current
    if (!image) return
    let current = true
    image.decode().then(() => {
      if (!current) return
      const animate = direction && !matchMedia('(prefers-reduced-motion: reduce)').matches
      setFrames(previous => ({ shown: item, leaving: animate ? previous.shown : null, direction }))
      onDisplay(item)
    }, () => {
      if (current) setFailed(target)
    })
    return () => { current = false }
  }, [target])

  function finishSlide(event, key) {
    if (event.target !== event.currentTarget || event.animationName !== 'photo-slide-in') return
    setFrames(current => current.leaving && imageKey(current.shown) === key ? { ...current, leaving: null } : current)
  }

  return <div className="photo-view">
    <div ref={camera.stage} className="photo-stage" data-slide={frames.direction < 0 ? 'back' : undefined}
      aria-busy={pending && !broken} {...camera.handlers}>
      {pictures.map(candidate => {
        const key = imageKey(candidate)
        const active = key === displayedKey
        const phase = active ? (frames.leaving ? 'entering' : 'settled') : key === leavingKey ? 'leaving' : 'pending'
        return <div className="photo-frame" key={key} data-phase={phase} aria-hidden={!active}
          onAnimationEnd={phase === 'entering' ? event => finishSlide(event, key) : undefined}>
          <img ref={active ? camera.picture : key === target ? loading : undefined}
            className={'photo-' + (active ? 'active' : phase)} alt={candidate.name} src={candidate.viewUrl} draggable="false" />
        </div>
      })}
      {broken && <div className="viewer-error photo-status" role="alert"><ImageOff size={29} strokeWidth={1.4} /><p>{t('Не удалось открыть изображение.')}</p></div>}
      {!frames.shown && !broken && <div className="player-loading photo-status" role="status"><LoaderCircle size={19} /> {t('Открываем изображение')}</div>}
    </div>
    <div className="photo-controls glass-button">
      <IconButton icon={camera.scale > 1 ? ZoomOut : ZoomIn} label={t(camera.scale > 1 ? 'Вписать в окно' : 'Увеличить фото')}
        disabled={pending} onClick={() => camera.toggle()} />
      {camera.scale > 1 && <span className="photo-magnification">{Number(camera.scale.toFixed(2))}×</span>}
      <IconButton icon={full ? Minimize : Maximize} label={t(full ? 'Выйти из полного экрана' : 'Полный экран')} onClick={fullscreen} />
    </div>
  </div>
}

function currentPlaybackPosition(state) {
  const { connection, element, duration } = state
  if (!connection || state.switching || state.finished || !element?.readyState ||
    element.dataset.generation !== String(state.generation)) return state.position
  const now = connection.offset + element.currentTime
  return duration ? Math.min(now, duration) : now
}

function Player({ item, full, fullscreen, playbackProgress, onPlaybackProgress, onFrameSaved }) {
  const { t, language } = useLocale()
  const readableError = useCallback(error => translateError(language, error, 'Не удалось открыть видео.'), [language])
  const video = useRef(null)
  const separateAudio = useRef(null)
  const seekingTimer = useRef(null)
  const saving = useRef(false)
  const initial = useRef(playbackProgress ?? {})
  const report = useRef(onPlaybackProgress)
  const session = useRef({
    generation: 0, position: initial.current.position ?? 0, duration: initial.current.duration || item.duration || 0,
    wanted: true, force: false, switching: false, connection: null, target: 0,
    selected: null, reported: initial.current, lastReport: 0, element: null, mounted: false, finished: false,
  })
  const [source, setSource] = useState(null)
  const [info, setInfo] = useState(null)
  const [choices, setChoices] = useState({ audioId: '', subtitleId: '' })
  const [duration, setDuration] = useState(session.current.duration)
  const [position, setPosition] = useState(session.current.position)
  const [seekDraft, setSeekDraft] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [frameError, setFrameError] = useState('')
  const [frameSaved, setFrameSaved] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  const [savingFrame, setSavingFrame] = useState(false)
  const [menu, setMenu] = useState(null)
  const [volume, setVolume] = useState(() => Math.min(1, Math.max(0, Number(setting('volume', 0.8)) || 0)))
  const [muted, setMuted] = useState(false)
  const closeMenu = useCallback(() => setMenu(null), [])

  const registerVideo = useCallback(element => {
    video.current = element
    // The last element can still report its position when the viewer is removed.
    if (element) session.current.element = element
  }, [])

  const savePlayback = useCallback((extra = {}) => {
    const state = session.current
    if (!report.current || !state.selected) return
    const position = currentPlaybackPosition(state)
    const progress = { ...state.selected, position, duration: state.duration, ...extra }
    const changed = Object.fromEntries(Object.entries(progress).filter(([key, value]) => state.reported[key] !== value))
    state.lastReport = performance.now()
    if (!Object.keys(changed).length) return
    state.reported = { ...state.reported, ...changed }
    return report.current(item.id, changed)
  }, [item.id])

  useLayoutEffect(() => { report.current = onPlaybackProgress }, [onPlaybackProgress])
  useLayoutEffect(() => {
    const state = session.current
    state.mounted = true
    const flush = () => savePlayback()
    const stopObserving = mediaApi.observePlaybackFlush?.(() => {
      state.element?.pause()
      return flush()
    })
    window.addEventListener('pagehide', flush)
    return () => {
      savePlayback()
      state.mounted = false
      stopObserving?.()
      window.removeEventListener('pagehide', flush)
    }
  }, [savePlayback])

  const load = useCallback(async (selected, target, play = true, forceCompatible = false) => {
    const state = session.current
    const generation = ++state.generation
    const previous = state.connection
    state.connection = null
    state.target = target
    state.position = target
    state.selected = selected
    state.wanted = play
    state.switching = true
    state.finished = false
    video.current?.pause()
    separateAudio.current?.pause()
    if (previous?.token) mediaApi.release(previous.token)
    setError('')
    setFrameError('')
    setFrameReady(false)
    setLoading(true)
    setPlaying(false)
    setPosition(target)
    try {
      const connection = await mediaApi.play(item.id, { ...selected, start: target, forceCompatible })
      if (generation !== state.generation) {
        if (connection.token) mediaApi.release(connection.token)
        return
      }
      if (!connection.url) throw new Error('Видеофайл недоступен.')
      state.connection = { ...connection, generation }
      state.position = connection.mode === 'stream' ? connection.offset : target
      setSource(state.connection)
    } catch (failure) {
      if (generation !== state.generation) return
      state.switching = false
      setLoading(false)
      setError(readableError(failure))
    }
  }, [item.id, readableError])

  useEffect(() => {
    let mounted = true
    const state = session.current
    async function start() {
      try {
        const inspected = await mediaApi.inspect(item.id)
        if (!mounted) return
        setInfo(inspected)
        if (inspected.duration) {
          state.duration = inspected.duration
          setDuration(inspected.duration)
        }
        const saved = state.selected ?? initial.current
        const selected = {
          audioId: inspected.audio.some(track => track.id === saved.audioId) ? saved.audioId : inspected.defaultAudio,
          subtitleId: inspected.subtitles.some(track => track.id === saved.subtitleId) ? saved.subtitleId : '',
        }
        setChoices(selected)
        load(selected, state.position, state.wanted)
      } catch (failure) {
        if (!mounted) return
        setLoading(false)
        setError(readableError(failure))
      }
    }
    start()
    return () => {
      mounted = false
      state.generation += 1
      if (state.connection?.token) mediaApi.release(state.connection.token)
      clearTimeout(seekingTimer.current)
    }
  }, [item.id, load])

  useEffect(() => {
    if (video.current) {
      video.current.volume = volume
      video.current.muted = muted || Boolean(source?.audioUrl)
    }
    if (separateAudio.current) {
      separateAudio.current.volume = volume
      separateAudio.current.muted = muted
    }
  }, [source, muted, volume])

  useEffect(() => {
    if (!frameSaved) return
    const timer = setTimeout(() => setFrameSaved(false), 2400)
    return () => clearTimeout(timer)
  }, [frameSaved])

  function playVideo(element) {
    element?.play().catch(failure => {
      if (failure.name === 'NotAllowedError' && element === video.current && element.dataset.generation === String(session.current.generation)) {
        session.current.wanted = false
        setPlaying(false)
        setLoading(false)
      }
    })
  }

  function syncAudio(force = false) {
    const audio = separateAudio.current
    const element = video.current
    if (!audio || !element || !audio.readyState) return
    if (force || Math.abs(audio.currentTime - element.currentTime) > 0.2) {
      audio.currentTime = element.currentTime
    }
    if (!element.paused && element.readyState >= 3 && audio.paused) audio.play().catch(() => {})
  }

  function ready(event) {
    const state = session.current
    if (source?.generation !== state.generation) return
    const element = event.currentTarget
    if (source.mode === 'direct') {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        state.duration = element.duration
        setDuration(element.duration)
      }
      if (state.target > 0) element.currentTime = state.duration > 0 ?
        Math.min(state.target, Math.max(0, state.duration - 0.001)) : state.target
    }
    state.switching = false
    state.position = currentPlaybackPosition(state)
    setPosition(state.position)
    if (state.wanted) playVideo(element)
  }

  const isCurrent = () => source?.generation === session.current.generation

  function updateClock() {
    const state = session.current
    if (!isCurrent() || state.switching || state.finished) return
    state.position = currentPlaybackPosition(state)
    setPosition(state.position)
    if (performance.now() - state.lastReport >= 5000) savePlayback()
    syncAudio()
  }

  function updateFrame(event) {
    if (!isCurrent()) return
    const element = event.currentTarget
    setFrameReady(element.readyState >= 2 && !element.seeking)
  }

  function finished() {
    if (!isCurrent()) return
    const state = session.current
    state.wanted = false
    state.finished = true
    state.position = 0
    setPlaying(false)
    separateAudio.current?.pause()
    savePlayback({ watched: true })
  }

  function videoError() {
    const state = session.current
    if (!isCurrent()) return
    if (isDesktop && source.mode === 'direct' && !state.force) {
      state.force = true
      load(choices, state.position, state.wanted, true)
      return
    }
    state.switching = false
    separateAudio.current?.pause()
    setFrameReady(false)
    setPlaying(false)
    setLoading(false)
    setError(t(isDesktop ? 'Не удалось воспроизвести видео с выбранными дорожками.' : 'Этот формат можно открыть в Folio для Windows.'))
  }

  function seek(value, play = session.current.wanted) {
    const target = Math.max(0, duration ? Math.min(duration - 0.12, value) : value)
    const state = session.current
    clearTimeout(seekingTimer.current)
    setSeekDraft(null)
    state.finished = false
    state.position = target
    if (state.connection?.mode === 'direct' && !state.switching && video.current?.readyState) {
      video.current.currentTime = target
      setPosition(target)
      if (play) playVideo(video.current)
      syncAudio(true)
    } else {
      load(choices, target, play, state.force)
    }
    savePlayback()
  }

  function previewSeek(value) {
    setSeekDraft(value)
    clearTimeout(seekingTimer.current)
    seekingTimer.current = setTimeout(() => seek(value), 190)
  }

  function togglePlayback() {
    const state = session.current
    const element = video.current
    if (error) return
    if (state.finished || (isCurrent() && element?.ended)) {
      state.wanted = true
      seek(0, true)
      return
    }
    state.wanted = !state.wanted
    if (isCurrent()) {
      if (state.wanted && element?.readyState) playVideo(element)
      else {
        element?.pause()
        savePlayback()
      }
    }
  }

  function changeTrack(kind, id) {
    closeMenu()
    const selected = { ...choices, [kind + 'Id']: id }
    setChoices(selected)
    const state = session.current
    clearTimeout(seekingTimer.current)
    setSeekDraft(null)
    load(selected, currentPlaybackPosition(state), state.wanted, state.force)
    savePlayback()
  }

  async function attach(kind) {
    closeMenu()
    const generation = session.current.generation
    try {
      const result = await mediaApi.attach(item.id, kind)
      if (!result || generation !== session.current.generation) return
      setInfo(result.info)
      changeTrack(kind, result.id)
    } catch (failure) {
      if (generation !== session.current.generation) return
      setError(readableError(failure))
    }
  }

  async function saveFrame() {
    const element = video.current
    const state = session.current
    if (saving.current || !isCurrent() || state.switching || !element?.videoWidth || !element.videoHeight ||
      element.readyState < 2 || element.seeking) return
    saving.current = true
    setSavingFrame(true)
    setFrameError('')
    setFrameSaved(false)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = element.videoWidth
      canvas.height = element.videoHeight
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Не удалось сохранить кадр.')
      context.drawImage(element, 0, 0)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Не удалось сохранить кадр.')
      const result = await mediaApi.saveVideoFrame(item.id, new Uint8Array(await blob.arrayBuffer()))
      if (result) {
        onFrameSaved?.(result)
        if (state.mounted) setFrameSaved(true)
      }
    } catch (failure) {
      if (state.mounted) setFrameError(translateError(language, failure, 'Не удалось сохранить кадр.'))
    } finally {
      saving.current = false
      if (state.mounted) setSavingFrame(false)
    }
  }

  function toggleMenu(event, kind) {
    const anchor = event.currentTarget
    setMenu(current => current?.kind === kind ? null : { anchor, kind })
  }

  useEffect(() => {
    function keys(event) {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || menu ||
        event.target.closest?.('input, [role="menu"]')) return
      const key = event.key.toLowerCase()
      if (key === ' ' && !event.target.closest?.('button')) {
        event.preventDefault()
        togglePlayback()
      }
      if (key === 'arrowleft' || key === 'arrowright') {
        if (!info) return
        event.preventDefault()
        seek(currentPlaybackPosition(session.current) + (key === 'arrowleft' ? -5 : 5))
      }
      if (key === 'f' || key === 'а') fullscreen()
      if (key === 'm' || key === 'ь') setMuted(value => !value)
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  })

  const shown = seekDraft ?? position
  return <div className="player" onKeyDown={event => {
    if (menu && event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      closeMenu()
    }
  }}>
    <div className="video-stage">
      <video key={source?.generation} ref={registerVideo} src={source?.url} data-generation={source?.generation}
        poster={item.preview} preload="auto" playsInline
        onLoadedMetadata={ready} onLoadedData={updateFrame} onTimeUpdate={updateClock} onError={videoError}
        onClick={togglePlayback} onDoubleClick={fullscreen} aria-label={item.name}
        onPlay={() => { if (isCurrent()) setPlaying(true) }}
        onPause={() => {
          if (!isCurrent()) return
          setPlaying(false)
          separateAudio.current?.pause()
          savePlayback()
        }}
        onPlaying={() => { if (isCurrent()) { setLoading(false); syncAudio(true) } }}
        onCanPlay={event => { if (isCurrent()) { setLoading(false); updateFrame(event) } }}
        onWaiting={() => {
          if (!isCurrent()) return
          if (session.current.wanted) setLoading(true)
          separateAudio.current?.pause()
        }}
        onSeeking={() => { if (isCurrent()) setFrameReady(false) }}
        onSeeked={event => {
          if (!isCurrent()) return
          syncAudio(true)
          updateFrame(event)
          savePlayback()
        }}
        onEnded={finished}>
        {source?.subtitleUrl && <track kind="subtitles" src={source.subtitleUrl} label={t('Субтитры')}
          srcLang={source.subtitleUrl.startsWith('blob:') ? 'und' : 'ru'} default />}
      </video>
      {source?.audioUrl && <audio key={source.audioUrl} ref={separateAudio} src={source.audioUrl} preload="auto" onCanPlay={() => syncAudio(true)}
        onError={() => setError(t('Не удалось открыть внешнюю аудиодорожку.'))} />}
      {loading && !error && <div className="player-loading" role="status"><LoaderCircle size={24} /> {t('Загружаем видео')}</div>}
      {error && <div className="viewer-error" role="alert"><CircleAlert size={25} /><p>{error}</p><button className="outline-button"
        onClick={() => load(choices, session.current.position, true, session.current.force)}>{t('Повторить')}</button></div>}
      {frameError && <div className="video-frame-message" role="alert">{frameError}</div>}
      {!frameError && full && frameSaved && <div className="video-frame-message" role="status">{t('Кадр сохранён')}</div>}
    </div>
    <div className="player-controls">
      <input className="timeline" type="range" aria-label={t('Позиция воспроизведения')} min="0" max={duration || 0} step="0.1"
        value={Math.min(shown, duration || 0)} disabled={!duration || !info} onChange={event => previewSeek(Number(event.target.value))}
        style={{ '--fill': (duration ? Math.min(100, 100 * shown / duration) : 0) + '%' }} />
      <div className="player-row">
        <div className="transport">
          <IconButton icon={playing ? Pause : Play} label={t(playing ? 'Пауза' : 'Воспроизвести')} className="transport-play" onClick={togglePlayback} />
          <IconButton icon={RotateCcw} label={t('Назад на 5 секунд')} className="rewind-control" disabled={!info}
            onClick={() => seek(currentPlaybackPosition(session.current) - 5)} />
          <span className="player-time">{clock(shown)}<span>/</span>{clock(duration)}</span>
        </div>
        <div className="player-options">
          <div className="volume-controls">
            <IconButton icon={muted || volume === 0 ? VolumeX : Volume2} label={t(muted ? 'Включить звук' : 'Выключить звук')} onClick={() => setMuted(value => !value)} />
            <input className="volume-slider" type="range" aria-label={t('Громкость')} min="0" max="1" step="0.01" value={muted ? 0 : volume}
              style={{ '--fill': (muted ? 0 : 100 * volume) + '%' }} onChange={event => { const value = +event.target.value; setVolume(value); setMuted(false); saveSetting('volume', value) }} />
          </div>
          <span className="control-divide" />
          <IconButton icon={Headphones} label={t('Аудиодорожки')} className={choices.audioId && choices.audioId !== info?.defaultAudio ? 'track-active' : ''}
            data-popup-trigger aria-haspopup="menu" disabled={!info} onClick={event => toggleMenu(event, 'audio')} />
          <IconButton icon={Captions} label={t('Субтитры')} className={choices.subtitleId ? 'track-active' : ''}
            data-popup-trigger aria-haspopup="menu" disabled={!info} onClick={event => toggleMenu(event, 'subtitle')} />
          {isDesktop && typeof mediaApi.saveVideoFrame === 'function' && <IconButton icon={Camera} label={t('Сохранить кадр')}
            disabled={!frameReady || savingFrame || Boolean(error)} aria-busy={savingFrame} onClick={saveFrame} />}
          <IconButton icon={full ? Minimize : Maximize} label={t(full ? 'Выйти из полного экрана' : 'Полный экран')} onClick={fullscreen} />
        </div>
      </div>
    </div>
    {menu && info && <Menu anchor={menu.anchor} onClose={closeMenu} className="player-menu" placement="up">
      <div className="menu-heading">{t(menu.kind === 'audio' ? 'Аудиодорожки' : 'Субтитры')}</div>
      {menu.kind === 'subtitle' && <MenuItem checked={!choices.subtitleId} onClick={() => changeTrack('subtitle', '')}>{t('Выключены')}</MenuItem>}
      {(menu.kind === 'audio' ? info.audio : info.subtitles).map(track => <MenuItem key={track.id} checked={choices[menu.kind + 'Id'] === track.id}
        title={track.label} onClick={() => changeTrack(menu.kind, track.id)}>{track.label}</MenuItem>)}
      <div className="menu-divider" />
      <MenuItem icon={Plus} onClick={() => attach(menu.kind)}>{t(menu.kind === 'audio' ? 'Открыть аудиофайл…' : 'Открыть файл субтитров…')}</MenuItem>
    </Menu>}
  </div>
}
