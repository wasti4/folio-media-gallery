import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, FlipHorizontal2, FlipVertical2, LoaderCircle, RotateCcw, RotateCw, Save, ScanEye } from 'lucide-react'
import { flipEdit, fullCrop, hasEdit, newEdit, rotateEdit } from '../shared/edits.mjs'
import { photoGeometry } from '../shared/photo-look.mjs'
import { defaultLookAmount, withLook } from '../shared/photo-looks.mjs'
import { translateError } from '../shared/locale.mjs'
import { useLocale } from './localization.jsx'
import { mediaApi } from './media-api.mjs'
import { IconButton, Picture, quantity } from './ui.jsx'
import { PhotoPreview } from './photo-preview.jsx'
import { AdjustmentGroups, Histogram, LookPicker } from './editor-inspector.jsx'
import './editor.css'

const photoForms = ['фотография', 'фотографии', 'фотографий']

// One look and one set of adjustments for many photos. Each photo keeps its framing, and every result is a
// new copy next to its original, exactly like "Save copy" in the single-photo editor.
export function BatchEditor({ items, close, saved, progress }) {
  const { t, language } = useLocale()
  const [edit, setEdit] = useState(newEdit)
  const [look, setLook] = useState(null)
  const [active, setActive] = useState(0)
  const [frame, setFrame] = useState(null)
  const [original, setOriginal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const stageRef = useRef(null)
  const closeRef = useRef(null)
  const alive = useRef(true)
  const item = items[Math.min(active, items.length - 1)]
  const tone = { ...withLook(edit, look), crop: { ...fullCrop } }
  const changed = hasEdit(tone, 0)
  const liveEdit = original ? newEdit() : tone
  const geometry = frame ? photoGeometry(frame.width, frame.height, liveEdit) : null
  const ratio = geometry ? geometry.width / geometry.height : 1.5
  const pictureWidth = Math.max(1, Math.min(stage.width, stage.height * ratio))

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
    return () => {
      alive.current = false
      mediaApi.stopEditPreview().catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!item) return
    let current = true
    setFrame(null)
    mediaApi.editFrame(item.id, { original: true }).then(async url => {
      if (!url || !current) return
      const image = new Image()
      image.src = url
      await image.decode()
      if (current) setFrame({ image, width: image.naturalWidth, height: image.naturalHeight })
    }).catch(failure => {
      if (current) setError(translateError(language, failure, 'Не удалось подготовить предпросмотр.'))
    })
    return () => { current = false }
  }, [item?.id, language])

  useEffect(() => {
    const keydown = event => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape' && !saving) {
        event.preventDefault()
        close()
      }
      if (event.code === 'Backslash' && !event.ctrlKey && !event.altKey) setOriginal(true)
    }
    const keyup = event => { if (event.code === 'Backslash') setOriginal(false) }
    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('keyup', keyup)
    }
  }, [close, saving])

  function change(changer) {
    setError('')
    setOriginal(false)
    setEdit(changer)
  }

  async function save() {
    if (!changed || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await mediaApi.saveEdits(items.map(entry => entry.id), tone)
      if (alive.current) saved(result)
    } catch (failure) {
      if (alive.current) setError(translateError(language, failure, 'Не удалось сохранить копию.'))
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  const done = progress?.total ? progress.done : 0
  return <section className="viewer editor-open batch-editor" role="dialog" aria-modal="true" aria-label={t('Пакетная правка')}>
    <div className="viewer-background" style={{ backgroundImage: item?.preview ? 'url("' + item.preview + '")' : undefined }} />
    <header className="editor-header">
      <button type="button" className="editor-button editor-back" ref={closeRef} onClick={close} disabled={saving}>
        <ArrowLeft size={17} /><span>{t('Отмена')}</span>
      </button>
      <div className="editor-title">
        <strong>{t('Пакетная правка')}</strong>
        <span>{quantity(items.length, photoForms, language)} · {t('копии сохранятся рядом с оригиналами')}</span>
      </div>
      <div className="editor-header-actions">
        <IconButton icon={RotateCcw} className="editor-tool" label={t('Сбросить правки')} disabled={!changed || saving}
          onClick={() => { change(() => newEdit()); setLook(null) }} />
        <button type="button" className="primary-button editor-save" disabled={!changed || saving} onClick={save}>
          <Save size={15} /><span>{t('Сохранить копии')}</span>
        </button>
      </div>
    </header>
    <div className="editor-layout">
      <main className="editor-workspace" aria-label={t('Предпросмотр')}>
        <div className="editor-mat" ref={stageRef}>
          <div className={'editor-picture' + (frame ? ' is-ready' : '')} style={{ width: pictureWidth, height: pictureWidth / ratio }}>
            {frame && geometry ? <PhotoPreview image={frame.image} edit={liveEdit} geometry={geometry} label={item.name} /> :
              item && <img src={item.preview} alt={item.name} draggable="false" />}
            {original && frame && <span className="editor-original-badge" aria-hidden="true">{t('Исходник')}</span>}
          </div>
          {!frame && !error && <div className="editor-indicator" role="status"><LoaderCircle size={17} />{t('Готовим предпросмотр')}</div>}
        </div>
        <div className="editor-preview-bar batch-strip">
          <div className="batch-thumbs" role="group" aria-label={t('Выбранные фото')}>
            {items.map((entry, index) => <button key={entry.id} type="button" className="batch-thumb" aria-pressed={index === active}
              title={entry.name} aria-label={t('Показать «{name}»', { name: entry.name })} disabled={saving} onClick={() => setActive(index)}>
              <Picture item={entry} />
            </button>)}
          </div>
          <button type="button" className="editor-button editor-compare" aria-pressed={original} disabled={!frame}
            onClick={() => setOriginal(value => !value)}>
            <ScanEye size={16} /><span>{t('Исходник')}</span>
          </button>
        </div>
      </main>
      <aside className="editor-inspector" aria-label={t('Инструменты редактирования')}>
        <div className="editor-panel-body">
          <fieldset className="editor-fields" disabled={saving}>
            {frame?.image && <Histogram image={frame.image} edit={liveEdit} />}
            {frame?.image && <LookPicker image={frame.image} look={look} amount={amount => setLook(current => current && { ...current, amount })}
              pick={id => { setOriginal(false); setLook(id ? { id, amount: look?.amount ?? defaultLookAmount } : null) }} />}
            <section className="editor-section">
              <h3 className="editor-section-title">{t('Поворот')}</h3>
              <div className="editor-rotation batch-rotation">
                <IconButton icon={RotateCcw} className="editor-tool" label={t('Повернуть влево')} onClick={() => change(current => rotateEdit(current, -1))} />
                <IconButton icon={RotateCw} className="editor-tool" label={t('Повернуть вправо')} onClick={() => change(current => rotateEdit(current, 1))} />
                <IconButton icon={FlipHorizontal2} className="editor-tool" label={t('Отразить по горизонтали')}
                  aria-pressed={edit.flipX} onClick={() => change(current => flipEdit(current, true))} />
                <IconButton icon={FlipVertical2} className="editor-tool" label={t('Отразить по вертикали')}
                  aria-pressed={edit.flipY} onClick={() => change(current => flipEdit(current, false))} />
              </div>
            </section>
            <AdjustmentGroups edit={edit} video={false}
              reset={keys => change(current => ({ ...current, ...Object.fromEntries(keys.map(key => [key, 0])) }))}
              change={(key, value) => change(current => ({ ...current, [key]: value }))} />
          </fieldset>
        </div>
        {error && <p className="editor-error" role="alert">{error}</p>}
        {saving ? <div className="editor-export" role="status">
          <span><LoaderCircle size={16} />{t('Сохраняем копии')}{progress?.total > 0 && ' · ' + done + ' / ' + progress.total}</span>
          <progress max={progress?.total || 1} value={progress?.total ? done : undefined} />
          <button type="button" className="editor-button" onClick={() => mediaApi.cancelEditSave().catch(() => {})}>{t('Остановить')}</button>
        </div> : <span className="editor-format editor-output">PNG</span>}
      </aside>
    </div>
  </section>
}
