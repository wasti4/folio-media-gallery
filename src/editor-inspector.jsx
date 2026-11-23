import { useDeferredValue, useMemo, useState } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { limit, newEdit } from '../shared/edits.mjs'
import { luminanceWeights, photoGeometry, photoLookup } from '../shared/photo-look.mjs'
import { defaultLookAmount, photoLooks, withLook } from '../shared/photo-looks.mjs'
import { useLocale } from './localization.jsx'
import { IconButton } from './ui.jsx'

export const adjustmentGroups = [
  { id: 'light', name: 'Свет', adjustments: [
    ['exposure', 'Экспозиция', -100, true], ['brightness', 'Яркость'], ['contrast', 'Контраст'],
    ['highlights', 'Светлые участки', -100, true], ['shadows', 'Тени', -100, true],
  ] },
  { id: 'color', name: 'Цвет', adjustments: [['warmth', 'Теплота', -100, true], ['saturation', 'Насыщенность']] },
  { id: 'detail', name: 'Детали', adjustments: [['sharpness', 'Резкость', 0]] },
]
const histogramBins = 96
const thumbnailSize = 96
const byte = value => Math.max(0, Math.min(255, Math.round(value)))
const stepKeys = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }

function drawable(image, width, height, cover = false) {
  const sourceWidth = image.naturalWidth ?? image.width
  const sourceHeight = image.naturalHeight ?? image.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (cover) {
    const side = Math.min(sourceWidth, sourceHeight)
    context.drawImage(image, (sourceWidth - side) / 2, (sourceHeight - side) / 2, side, side, 0, 0, width, height)
  } else context.drawImage(image, 0, 0, width, height)
  return { canvas, context, data: context.getImageData(0, 0, width, height) }
}

// Mirrors the colour steps of the live preview: saturation first, then the per-channel tone curve.
function toned(r, g, b, lookup, saturation) {
  const gray = r * luminanceWeights[0] + g * luminanceWeights[1] + b * luminanceWeights[2]
  return [
    lookup[byte(r + (r - gray) * saturation) * 4],
    lookup[byte(g + (g - gray) * saturation) * 4 + 1],
    lookup[byte(b + (b - gray) * saturation) * 4 + 2],
  ]
}

function sampleFor(image) {
  const width = image.naturalWidth ?? image.width
  const height = image.naturalHeight ?? image.height
  const scale = Math.min(1, 200 / Math.max(width, height))
  const sampleWidth = Math.max(1, Math.round(width * scale))
  const sampleHeight = Math.max(1, Math.round(height * scale))
  return { width: sampleWidth, height: sampleHeight, pixels: drawable(image, sampleWidth, sampleHeight).data.data }
}

function histogramPath(sample, edit) {
  const { width, height, origin, column, row } = photoGeometry(sample.width, sample.height, edit)
  const lookup = photoLookup(edit)
  const saturation = edit.saturation / 100
  const offset = ([x, y]) => (x + y * sample.width) * 4
  const first = offset(origin)
  const dx = offset(column)
  const dy = offset(row)
  const bins = new Float64Array(histogramBins)
  for (let y = 0; y < height; y++) {
    let index = first + y * dy
    for (let x = 0; x < width; x++, index += dx) {
      const [r, g, b] = toned(sample.pixels[index], sample.pixels[index + 1], sample.pixels[index + 2], lookup, saturation)
      const level = r * luminanceWeights[0] + g * luminanceWeights[1] + b * luminanceWeights[2]
      bins[Math.min(histogramBins - 1, Math.floor(level / 256 * histogramBins))]++
    }
  }
  const smooth = Array.from(bins, (value, index) =>
    (bins[Math.max(0, index - 1)] + value * 2 + bins[Math.min(histogramBins - 1, index + 1)]) / 4)
  // Ignore the clipped end bins when scaling so a burnt sky does not flatten everything else.
  const peak = Math.max(1, ...smooth.slice(1, -1))
  const points = smooth.map((value, index) => index + ',' + (100 - Math.min(1, value / peak) * 94).toFixed(2))
  return 'M0,100 L' + points.join(' L') + ' L' + (histogramBins - 1) + ',100 Z'
}

export function Histogram({ image, edit }) {
  const { t } = useLocale()
  const sample = useMemo(() => sampleFor(image), [image])
  const deferred = useDeferredValue(edit)
  const signature = JSON.stringify(deferred)
  const path = useMemo(() => histogramPath(sample, deferred), [sample, signature])
  return <figure className="editor-histogram" aria-label={t('Гистограмма')}>
    <svg viewBox={'0 0 ' + (histogramBins - 1) + ' 100'} preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
  </figure>
}

function lookThumbnails(image) {
  const base = drawable(image, thumbnailSize, thumbnailSize, true)
  const source = base.data.data
  const result = { none: base.canvas.toDataURL('image/jpeg', 0.9) }
  for (const look of photoLooks) {
    const edit = withLook(newEdit(), { id: look.id, amount: defaultLookAmount })
    const lookup = photoLookup(edit)
    const saturation = edit.saturation / 100
    const target = base.context.createImageData(thumbnailSize, thumbnailSize)
    for (let index = 0; index < source.length; index += 4) {
      const [r, g, b] = toned(source[index], source[index + 1], source[index + 2], lookup, saturation)
      target.data[index] = r
      target.data[index + 1] = g
      target.data[index + 2] = b
      target.data[index + 3] = 255
    }
    base.context.putImageData(target, 0, 0)
    result[look.id] = base.canvas.toDataURL('image/jpeg', 0.9)
  }
  return result
}

export function LookPicker({ image, look, pick, amount }) {
  const { t } = useLocale()
  const thumbnails = useMemo(() => lookThumbnails(image), [image])
  const choices = [{ id: 'none', name: 'Без образа' }, ...photoLooks]
  return <section className="editor-section editor-looks" aria-labelledby="editor-looks-title">
    <h3 className="editor-section-title" id="editor-looks-title">{t('Образы')}</h3>
    <div className="editor-look-grid">
      {choices.map(choice => {
        const selected = choice.id === 'none' ? !look : look?.id === choice.id
        return <button key={choice.id} type="button" className="editor-look" aria-pressed={selected}
          onClick={() => pick(choice.id === 'none' ? null : choice.id)}>
          <img src={thumbnails[choice.id]} alt="" draggable="false" />
          <span>{t(choice.name)}</span>
        </button>
      })}
    </div>
    {look && <Adjustment label={t('Сила')} value={look.amount} min={0} resetTo={defaultLookAmount} unit="%"
      change={amount} />}
  </section>
}

export function Adjustment({ label, value, min = -100, change, resetTo = 0, unit = '' }) {
  const bipolar = min < 0
  const zero = bipolar ? 50 : 0
  const at = (value - min) / (100 - min) * 100
  const style = { '--range-from': Math.min(zero, at) + '%', '--range-to': Math.max(zero, at) + '%' }
  function keyboard(event) {
    const direction = stepKeys[event.key]
    if (!direction || !event.shiftKey) return
    event.preventDefault()
    change(limit(value + direction * 10, min, 100))
  }
  return <label className={'editor-adjustment' + (value !== resetTo ? ' is-changed' : '')}
    onDoubleClick={() => { if (value !== resetTo) change(resetTo) }}>
    <span><span>{label}</span><output>{value > 0 && bipolar ? '+' : ''}{value}{unit}</output></span>
    <span className={'editor-range' + (bipolar ? ' is-bipolar' : '')}>
      <input type="range" aria-label={label} min={min} max={100} value={value} style={style} onKeyDown={keyboard}
        onChange={event => change(event.target.valueAsNumber)} />
    </span>
  </label>
}

export function AdjustmentGroups({ edit, video, change, reset }) {
  const { t } = useLocale()
  const [collapsed, setCollapsed] = useState({})
  return adjustmentGroups.map(group => {
    const adjustments = group.adjustments.filter(([, , , photoOnly]) => !photoOnly || !video)
    if (!adjustments.length) return null
    const open = !collapsed[group.id]
    const changed = adjustments.some(([key]) => edit[key])
    const name = t(group.name)
    return <section key={group.id} className="editor-section editor-group">
      <div className="editor-group-head">
        <button type="button" className="editor-group-toggle" aria-expanded={open}
          onClick={() => setCollapsed(current => ({ ...current, [group.id]: open }))}>
          <ChevronDown size={14} aria-hidden="true" /><span>{name}</span>
        </button>
        {changed && <IconButton icon={RotateCcw} size={13} className="editor-group-reset" label={t('Сбросить «{name}»', { name })}
          onClick={() => reset(adjustments.map(([key]) => key))} />}
      </div>
      {open && <div className="editor-group-body">
        {adjustments.map(([key, label, min]) => <Adjustment key={key} label={t(label)} value={edit[key]} min={min}
          change={value => change(key, value)} />)}
      </div>}
    </section>
  })
}
