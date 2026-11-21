import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowRightToLine, ArrowLeftToLine, Crop, FlipHorizontal2, FlipVertical2, LoaderCircle, Play, RotateCcw, RotateCw,
  Save, ScanEye, Scissors, SlidersHorizontal, Square,
} from 'lucide-react'
import { flipEdit, fullCrop, hasCrop, hasEdit, limit, minimumCrop, newEdit, rotateEdit } from '../shared/edits.mjs'
import { photoGeometry } from '../shared/photo-look.mjs'
import { translateError } from '../shared/locale.mjs'
import { useLocale } from './localization.jsx'
import { mediaApi, setting } from './media-api.mjs'
import { IconButton } from './ui.jsx'
import { PhotoPreview } from './photo-preview.jsx'
import './editor.css'

const adjustments = [
  ['exposure', 'Экспозиция', -100, true], ['brightness', 'Яркость'], ['contrast', 'Контраст'],
  ['shadows', 'Тени', -100, true], ['highlights', 'Светлые участки', -100, true],
  ['saturation', 'Насыщенность'], ['warmth', 'Теплота', -100, true], ['sharpness', 'Резкость', 0],
]
const tabs = [
  { id: 'adjust', name: 'Коррекция', Icon: SlidersHorizontal },
  { id: 'crop', name: 'Кадр', Icon: Crop },
  { id: 'trim', name: 'Обрезка', Icon: Scissors },
]
const aspectRatios = [['Весь кадр', 0], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16]]
const corners = ['nw', 'ne', 'sw', 'se']

function editTime(seconds) {
  const hundredths = Math.max(0, Math.round(seconds * 100))
  const total = Math.floor(hundredths / 100)
  const prefix = total >= 3600 ? Math.floor(total / 3600) + ':' : ''
  const minutes = prefix ? String(Math.floor(total / 60) % 60).padStart(2, '0') : Math.floor(total / 60)
  return prefix + minutes + ':' + String(total % 60).padStart(2, '0') + '.' + String(hundredths % 100).padStart(2, '0')
}

function selectedArea(aspect, sourceAspect) {
  if (!aspect) return { ...fullCrop }
  const proportion = aspect / sourceAspect
  const width = Math.max(minimumCrop, Math.min(1, proportion))
  const height = Math.max(minimumCrop, Math.min(1, 1 / proportion))
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

function moveCrop(crop, direction, deltaX, deltaY) {
  const { x, y, width, height } = crop
  if (!direction) return { ...crop, x: limit(x + deltaX, 0, 1 - width), y: limit(y + deltaY, 0, 1 - height) }
  const right = x + width
  const bottom = y + height
  const left = direction.includes('w') ? limit(x + deltaX, 0, right - minimumCrop) : x
  const top = direction.includes('n') ? limit(y + deltaY, 0, bottom - minimumCrop) : y
  return {
    x: left, y: top,
    width: (direction.includes('e') ? limit(right + deltaX, x + minimumCrop, 1) : right) - left,
    height: (direction.includes('s') ? limit(bottom + deltaY, y + minimumCrop, 1) : bottom) - top,
  }
}

function CropFrame({ crop, change }) {
  const { t } = useLocale()
  const drag = useRef(null)

  function begin(event, corner) {
    if (event.button !== 0) return
    event.stopPropagation()
    const rect = event.currentTarget.closest('.editor-picture').getBoundingClientRect()
    const { clientX, clientY, pointerId } = event
    drag.current = { crop, corner, rect, clientX, clientY, pointerId }
    event.currentTarget.setPointerCapture(pointerId)
  }

  function moving(event) {
    const active = drag.current
    if (active?.pointerId !== event.pointerId) return
    change(moveCrop(active.crop, active.corner, (event.clientX - active.clientX) / active.rect.width,
      (event.clientY - active.clientY) / active.rect.height))
  }

  function keyboard(event, corner) {
    const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const direction = deltas[event.key]
    if (!direction) return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 0.04 : 0.006
    change(moveCrop(crop, corner, direction[0] * step, direction[1] * step))
  }

  return <div className="editor-crop-frame" role="group" tabIndex={0} aria-label={t('Переместить рамку')}
    style={{ left: crop.x * 100 + '%', top: crop.y * 100 + '%', width: crop.width * 100 + '%', height: crop.height * 100 + '%' }}
    onPointerDown={event => begin(event, '')} onPointerMove={moving} onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={event => keyboard(event, '')}>
    {corners.map((corner, index) => <button type="button" key={corner} className={'editor-crop-handle ' + corner}
      aria-label={t('Угол рамки {number}', { number: index + 1 })}
      onPointerDown={event => begin(event, corner)} onKeyDown={event => keyboard(event, corner)} />)}
  </div>
}

function Adjustment({ label, value, min = -100, change }) {
  const style = { '--range-fill': (value - min) / (100 - min) * 100 + '%' }
  return <label className="editor-adjustment">
    <span><span>{label}</span><output>{value > 0 && min < 0 ? '+' : ''}{value}</output></span>
    <input type="range" aria-label={label} min={min} max={100} value={value} style={style} onChange={event => change(event.target.valueAsNumber)} />
  </label>
}

function TrimFields({ edit, duration, at, point }) {
  const { t } = useLocale()
  const step = Math.min(duration, 0.01)
  return <>
    {['start', 'end'].map((side, index) => <div className="editor-trim-control" key={side}>
      <label className="editor-adjustment">
        <span><span>{t(index === 0 ? 'Начало' : 'Конец')}</span><output>{editTime(edit[side])}</output></span>
        <input type="range" aria-label={t(index === 0 ? 'Начало' : 'Конец')} min={0} max={duration} step={step} value={edit[side]}
          style={{ '--range-fill': edit[side] / duration * 100 + '%' }}
          onChange={event => point(side, event.target.valueAsNumber)} />
      </label>
      <IconButton className="editor-tool" icon={index === 0 ? ArrowRightToLine : ArrowLeftToLine}
        label={t(index === 0 ? 'Начать с этого кадра' : 'Закончить на этом кадре')} onClick={() => point(side, at)} />
    </div>)}
    <div className="editor-duration"><span>{t('Длительность фрагмента')}</span><output>{editTime(edit.end - edit.start)}</output></div>
  </>
}

export function Editor({ item, close, saved }) {
  const { t, language } = useLocale()
  const video = item.kind === 'video'
  const [info, setInfo] = useState(null)
  const [edit, setEdit] = useState(newEdit())
  const [tool, setTool] = useState('adjust')
  const [original, setOriginal] = useState(false)
  const [position, setPosition] = useState(0)
  const [streamTime, setStreamTime] = useState(0)
  const [clip, setClip] = useState(null)
  const [clipLoading, setClipLoading] = useState(false)
  const [clipSize, setClipSize] = useState(null)
  const [frame, setFrame] = useState(null)
  const [previewing, setPreviewing] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const stageRef = useRef(null)
  const closeRef = useRef(null)
  const clipRef = useRef(null)
  const clipSerial = useRef(0)
  const alive = useRef(true)
  const outputInFlight = useRef(false)
  const duration = info?.duration || 0
  const cropMode = tool === 'crop' && !original
  const frameOptions = video && JSON.stringify({
    edit: cropMode ? { ...edit, crop: fullCrop } : edit,
    at: position, original, unframed: cropMode,
  })
  const changed = hasEdit(edit, duration)
  const frameCurrent = frame && (!video || (frame.unframed === cropMode && frame.rotation === edit.rotation &&
    frame.original === original && frame.flipX === edit.flipX && frame.flipY === edit.flipY))
  const liveEdit = original ? newEdit() : cropMode ? { ...edit, crop: fullCrop } : edit
  const liveGeometry = !video && frame ? photoGeometry(frame.width, frame.height, liveEdit) : null
  const transposed = edit.rotation % 2 === 1
  const outputCrop = original ? fullCrop : edit.crop
  const sideways = transposed && !original
  const outputWidth = Math.max(1, Math.floor(((sideways ? info?.height : info?.width) || 1) * outputCrop.width))
  const outputHeight = Math.max(1, Math.floor(((sideways ? info?.width : info?.height) || 1) * outputCrop.height))
  const fallback = transposed && !original ? (info?.height || 16) / (info?.width || 9) : (info?.width || 16) / (info?.height || 9)
  const size = clip ? clipSize : liveGeometry || frame
  const ratio = size?.width && size.height ? size.width / size.height : fallback
  const cropAspect = cropMode && frameCurrent ? ratio : fallback
  const pictureWidth = Math.max(1, Math.min(stage.width, stage.height * ratio))
  const at = clip ? Math.min(edit.end, streamTime) : position
  const title = t(video ? 'Редактор видео' : 'Редактор фото')

  useLayoutEffect(() => {
    const target = stageRef.current
    const resize = () => setStage({ width: target.clientWidth, height: target.clientHeight })
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(target)
    closeRef.current?.focus()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    alive.current = true
    mediaApi.editInfo(item.id).then(result => {
      if (!alive.current) return
      setInfo(result)
      setEdit(newEdit(result.duration))
    }).catch(failure => {
      if (!alive.current) return
      setError(translateError(language, failure, 'Не удалось прочитать медиафайл.'))
      setPreviewing(false)
    })
    const unsubscribe = mediaApi.observeEdit(setProgress)
    return () => {
      alive.current = false
      clipSerial.current++
      if (clipRef.current) mediaApi.release(clipRef.current.token).catch(() => {})
      mediaApi.stopEditPreview().catch(() => {})
      unsubscribe()
    }
  }, [item.id, language])

  useEffect(() => {
    const escape = event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !outputInFlight.current) {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [close])

  useEffect(() => {
    if (video) return
    let current = true
    async function load() {
      try {
        const url = await mediaApi.editFrame(item.id, { original: true })
        if (!url || !current) return
        const image = new Image()
        image.src = url
        await image.decode()
        if (current) setFrame({ image, width: image.naturalWidth, height: image.naturalHeight })
      } catch (failure) {
        if (current) setError(translateError(language, failure, 'Не удалось подготовить предпросмотр.'))
      } finally {
        if (current) setPreviewing(false)
      }
    }
    load()
    return () => { current = false }
  }, [video, item.id, language])

  useEffect(() => {
    if (!video || !info || clip || clipLoading || saving) return
    let current = true
    const options = JSON.parse(frameOptions)
    const request = setTimeout(async () => {
      setPreviewing(true)
      try {
        const url = await mediaApi.editFrame(item.id, options)
        if (!url || !current) return
        const image = new Image()
        image.src = url
        await image.decode()
        if (current) setFrame({ url, width: image.naturalWidth, height: image.naturalHeight,
          unframed: options.unframed, original: options.original, rotation: options.edit.rotation,
          flipX: options.edit.flipX, flipY: options.edit.flipY })
      } catch (failure) {
        if (current) setError(translateError(language, failure, 'Не удалось подготовить предпросмотр.'))
      } finally {
        if (current) setPreviewing(false)
      }
    }, 90)
    return () => {
      current = false
      clearTimeout(request)
    }
  }, [video, info, frameOptions, clip, clipLoading, saving, item.id, language])

  function stopClip() {
    clipSerial.current++
    if (clipRef.current) mediaApi.release(clipRef.current.token).catch(() => {})
    clipRef.current = null
    setClip(null)
    setClipLoading(false)
    setClipSize(null)
  }

  function changeEdit(changer) {
    if (clipRef.current || clipLoading) stopClip()
    setOriginal(false)
    setError('')
    setEdit(changer)
  }

  function pickTool(value) {
    if (clipRef.current || clipLoading) stopClip()
    setTool(value)
    setOriginal(false)
  }

  function switchOriginal() {
    if (clipRef.current || clipLoading) stopClip()
    setOriginal(matching => !matching)
  }

  function point(side, seconds) {
    const margin = Math.min(duration, 0.08)
    const time = side === 'start' ? limit(seconds, 0, edit.end - margin) : limit(seconds, edit.start + margin, duration)
    changeEdit(current => ({ ...current, [side]: time }))
    setPosition(time)
  }

  function scrub(seconds) {
    if (clipRef.current || clipLoading) stopClip()
    setError('')
    setPosition(seconds)
  }

  async function toggleClip() {
    if (clipRef.current || clipLoading) {
      stopClip()
      return
    }
    setError('')
    setOriginal(false)
    setStreamTime(edit.start)
    setClipLoading(true)
    const request = ++clipSerial.current
    try {
      const connection = await mediaApi.editClip(item.id, edit)
      if (request !== clipSerial.current) {
        await mediaApi.release(connection.token)
        return
      }
      clipRef.current = connection
      setClip(connection)
    } catch (failure) {
      if (request === clipSerial.current) setError(translateError(language, failure, 'Не удалось воспроизвести фрагмент.'))
    } finally {
      if (request === clipSerial.current) setClipLoading(false)
    }
  }

  async function save() {
    if (!changed || outputInFlight.current) return
    outputInFlight.current = true
    stopClip()
    setSaving(true)
    setProgress(0)
    setError('')
    try {
      const result = await mediaApi.saveEdit(item.id, edit)
      if (result && alive.current) saved(result)
    } catch (failure) {
      if (alive.current) setError(translateError(language, failure, 'Не удалось сохранить копию.'))
    } finally {
      outputInFlight.current = false
      if (alive.current) setSaving(false)
    }
  }

  function reset() {
    changeEdit(() => newEdit(duration))
    setPosition(0)
  }

  return <>
    <header className="editor-header">
      <button type="button" className="editor-button editor-back" ref={closeRef} onClick={close} disabled={saving}>
        <ArrowLeft size={17} /><span>{t('Отмена')}</span>
      </button>
      <div className="editor-title"><strong>{title}</strong><span title={item.filename}>{item.name}</span></div>
      <div className="editor-header-actions">
        <IconButton icon={RotateCcw} className="editor-tool" label={t('Сбросить правки')} disabled={!changed || saving} onClick={reset} />
        <button type="button" className="primary-button editor-save" disabled={!info || !changed || saving} onClick={save}>
          <Save size={15} /><span>{t('Сохранить копию')}</span>
        </button>
      </div>
    </header>
    <div className="editor-layout">
      <main className="editor-workspace" aria-label={t('Предпросмотр')}>
        <div className="editor-mat" ref={stageRef}>
          <div className={'editor-picture' + (frame || clip ? ' is-ready' : '')}
            style={{ width: pictureWidth, height: pictureWidth / ratio }}>
            {clip ? <video src={clip.url} autoPlay playsInline aria-label={item.name}
              onLoadedMetadata={event => {
                const element = event.currentTarget
                element.volume = limit(setting('volume', 0.8), 0, 1)
                setClipSize({ width: element.videoWidth, height: element.videoHeight })
              }}
              onTimeUpdate={event => setStreamTime(clip.offset + event.currentTarget.currentTime)}
              onEnded={stopClip} onError={() => {
                stopClip()
                setError(t('Не удалось воспроизвести фрагмент.'))
              }} /> : liveGeometry ? <PhotoPreview image={frame.image} edit={liveEdit} geometry={liveGeometry} label={item.name} /> :
                <img src={frame?.url || item.preview} alt={item.name} draggable="false" />}
            {!clip && cropMode && frameCurrent && !saving && <CropFrame crop={edit.crop}
              change={crop => setEdit(current => ({ ...current, crop }))} />}
          </div>
          {!frame && !error && <div className="editor-indicator" role="status"><LoaderCircle size={17} />{t('Готовим предпросмотр')}</div>}
        </div>
        <div className="editor-preview-bar">
          {video && <IconButton className="editor-tool editor-transport" icon={clip || clipLoading ? Square : Play}
            label={t(clip || clipLoading ? 'Остановить фрагмент' : 'Воспроизвести фрагмент')} disabled={!info || saving}
            onClick={toggleClip} />}
          {video && duration > 0 && <div className="editor-scrub">
            <div className="editor-scrub-selection" style={{ left: edit.start / duration * 100 + '%', right: (1 - edit.end / duration) * 100 + '%' }} />
            <input type="range" min={0} max={duration} step={Math.min(duration, 0.01)} value={at}
              aria-label={t('Позиция кадра')} disabled={saving} onChange={event => scrub(event.target.valueAsNumber)} />
          </div>}
          {video && duration > 0 && <span className="editor-time">{editTime(at)} <span>/</span> {editTime(duration)}</span>}
          {!video && frame && <span className="editor-format">{outputWidth} × {outputHeight}</span>}
          <button type="button" className="editor-button editor-compare" aria-pressed={original} onClick={switchOriginal} disabled={saving || !info}>
            <ScanEye size={16} /><span>{t('Исходник')}</span>
          </button>
        </div>
      </main>
      <aside className="editor-inspector" aria-label={t('Инструменты редактирования')}>
        <div className="editor-tabs" role="group" aria-label={t('Инструменты редактирования')}>
          {tabs.filter(tab => tab.id !== 'trim' || duration > 0).map(({ id, name, Icon }) => <button key={id} type="button"
            aria-pressed={tool === id} disabled={saving || !info} onClick={() => pickTool(id)}><Icon size={15} />{t(name)}</button>)}
        </div>
        <fieldset className="editor-fields" disabled={saving || !info}>
          {tool === 'adjust' && adjustments.filter(([, , , photoOnly]) => !photoOnly || !video).map(([key, name, min]) => <Adjustment key={key} label={t(name)} value={edit[key]}
            min={min} change={value => changeEdit(current => ({ ...current, [key]: value }))} />)}
          {tool === 'crop' && <>
            <span className="editor-field-title">{t('Формат кадра')}</span>
            <div className="editor-aspects">
              {aspectRatios.map(([name, aspect]) => <button key={name} type="button" className="editor-button"
                aria-pressed={aspect ? hasCrop(edit.crop) && Math.abs(cropAspect * edit.crop.width / edit.crop.height - aspect) < 0.025 : !hasCrop(edit.crop)}
                onClick={() => changeEdit(current => ({ ...current, crop: selectedArea(aspect, cropAspect) }))}>{t(name)}</button>)}
            </div>
            <div className="editor-rotation">
              <IconButton icon={RotateCcw} className="editor-tool" label={t('Повернуть влево')} onClick={() => changeEdit(edit => rotateEdit(edit, -1))} />
              <IconButton icon={RotateCw} className="editor-tool" label={t('Повернуть вправо')} onClick={() => changeEdit(edit => rotateEdit(edit, 1))} />
              <IconButton icon={FlipHorizontal2} className="editor-tool" label={t('Отразить по горизонтали')}
                aria-pressed={edit.flipX} onClick={() => changeEdit(edit => flipEdit(edit, true))} />
              <IconButton icon={FlipVertical2} className="editor-tool" label={t('Отразить по вертикали')}
                aria-pressed={edit.flipY} onClick={() => changeEdit(edit => flipEdit(edit, false))} />
            </div>
          </>}
          {tool === 'trim' && duration > 0 && <TrimFields edit={edit} duration={duration} at={at} point={point} />}
        </fieldset>
        {error && <p className="editor-error" role="alert">{error}</p>}
        {previewing && frame && !saving && !clip && <span className="editor-previewing" role="status">{t('Готовим предпросмотр')}</span>}
        {saving ? <div className="editor-export" role="status">
          <span><LoaderCircle size={16} />{t('Сохраняем копию')}{video && progress > 0 && ' · ' + Math.round(progress * 100) + '%'}</span>
          <progress max={1} value={progress || undefined} />
          <button type="button" className="editor-button" onClick={() => mediaApi.cancelEditSave().catch(() => {})}>{t('Отменить сохранение')}</button>
        </div> : <span className="editor-format editor-output">{video ? 'MP4' : 'PNG'}</span>}
      </aside>
    </div>
  </>
}
