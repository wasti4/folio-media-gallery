import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Captions, ChevronDown, FolderClosed, HardDriveDownload, Headphones, Play } from 'lucide-react'
import { languages } from '../shared/locale.mjs'
import { BrandMark } from './gallery.jsx'
import { Greeting, greetingCount } from './greetings.jsx'
import { useLocale } from './localization.jsx'
import { demoAsset } from './media-api.mjs'
import { IconButton } from './ui.jsx'
import './intro.css'

const pages = [
  ['Все кадры вместе', 'Собирайте фото, видео и GIF в одной медиатеке. Folio хранит оригиналы локально и даёт разложить их по подборкам.'],
  ['Смотрите по-своему', 'Смотрите видео в полном экране и подключайте свои аудиодорожки и субтитры.'],
  ['Медиатека едет с вами', 'Сохраните переносимую копию с оригиналами, подборками и дорожками. На новом компьютере восстановите её прямо в Folio.'],
]

function Artwork({ page, t }) {
  if (page === 0) return <div className="intro-art intro-stack" aria-hidden="true">
    {['tokyo.jpg', 'arches.jpg', 'shore.jpg'].map(file => <img src={demoAsset(file)} alt="" decoding="async" key={file} />)}
  </div>
  if (page === 1) return <div className="intro-art intro-film" aria-hidden="true">
    <img src={demoAsset('dolomites.jpg')} alt="" decoding="async" />
    <span className="intro-film-play"><Play size={23} fill="currentColor" /></span>
    <div className="intro-film-controls"><Headphones size={15} /><Captions size={16} /></div>
  </div>
  return <div className="intro-art intro-vault" aria-hidden="true">
    <div className="intro-vault-icon"><HardDriveDownload size={48} strokeWidth={1.4} /></div>
    <div className="intro-vault-label"><strong>{t('Резервная копия')}</strong>
      <span><FolderClosed size={15} />{t('Оригиналы')}</span>
      <span><FolderClosed size={15} />{t('Подборки')}</span>
    </div>
  </div>
}

export function Intro({ phase, finish }) {
  const { t, language, changeLanguage } = useLocale()
  const [greeting, setGreeting] = useState(0)
  const [welcome, setWelcome] = useState('writing')
  const [steps, setSteps] = useState({ current: 0, previous: null, direction: 1 })
  const frame = useRef(null)
  const page = steps.current
  const waiting = welcome === 'writing'
  const interactive = phase === 'tour'
  const continueLabel = t('Нажмите, чтобы продолжить')

  useEffect(() => { frame.current?.focus() }, [])

  function startTour() {
    frame.current?.focus({ preventScroll: true })
    setWelcome('leaving')
  }

  function move(index) {
    if (index !== page) setSteps({ current: index, previous: page, direction: index > page ? 1 : -1 })
  }

  function next() {
    if (page + 1 === pages.length) finish()
    else move(page + 1)
  }

  function keyboard(event) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      finish()
    }
    if (waiting && event.target === frame.current && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      startTour()
    }
    if (!waiting && event.target.tagName !== 'SELECT') {
      if (event.key === 'ArrowRight' && page < pages.length - 1) {
        event.preventDefault()
        move(page + 1)
      }
      if (event.key === 'ArrowLeft' && page > 0) {
        event.preventDefault()
        move(page - 1)
      }
    }
    if (event.key === 'Tab') {
      const inputs = [...event.currentTarget.querySelectorAll('button:not(:disabled), select')]
      if (event.shiftKey && (document.activeElement === inputs[0] || document.activeElement === frame.current)) {
        event.preventDefault()
        inputs.at(-1)?.focus()
      } else if (!event.shiftKey && document.activeElement === inputs.at(-1)) {
        event.preventDefault()
        inputs[0]?.focus()
      }
    }
  }

  return <section ref={frame} className="intro-frame" role="dialog" aria-modal={interactive} aria-label={t('Знакомство с Folio')}
      aria-hidden={!interactive} inert={!interactive} data-phase={phase} data-welcome={welcome} tabIndex={-1} onKeyDown={keyboard}>
      <header className="intro-header">
        <div className="intro-brand"><BrandMark /><span>Folio</span></div>
        <div className="intro-settings">
          <span className="intro-language-control">
            <select className="intro-language" aria-label={t('Язык интерфейса')} value={language} onChange={event => changeLanguage(event.target.value)}>
              {languages.map(option => <option key={option.id} value={option.id} lang={option.id}>{option.label}</option>)}
            </select>
            <ChevronDown className="intro-language-chevron" size={13} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <button type="button" className="intro-skip" onClick={finish}>{t('Пропустить')}</button>
        </div>
      </header>
      {welcome !== 'done' && <div className="intro-greetings" aria-hidden={!waiting} onAnimationEnd={event => {
        if (event.target === event.currentTarget && event.animationName === 'intro-greetings-out') setWelcome('done')
      }}>
        <Greeting key={greeting} index={greeting} advance={() => {
          if (waiting && interactive) setGreeting(value => (value + 1) % greetingCount)
        }} />
        <span className="intro-hint" aria-hidden="true">{continueLabel}</span>
      </div>}
      {waiting && <button type="button" className="intro-continue" aria-label={continueLabel} onClick={startTour} />}
      {!waiting && <>
        <div className="intro-pages" style={{ '--step-direction': steps.direction }}>
          {[steps.previous, page].filter(index => index !== null).map(index => {
            const leaving = index !== page
            return <article className="intro-page" key={index} aria-hidden={leaving} data-leaving={leaving} onAnimationEnd={event => {
              if (event.target === event.currentTarget && event.animationName === 'intro-page-out') {
                setSteps(current => current.previous === index ? { ...current, previous: null } : current)
              }
            }}>
              <Artwork page={index} t={t} />
              <div className="intro-copy">
                <h1>{t(pages[index][0])}</h1>
                <p>{t(pages[index][1])}</p>
              </div>
            </article>
          })}
        </div>
        <footer className="intro-footer">
          <IconButton icon={ArrowLeft} label={t('Назад')} disabled={page === 0} className="intro-back" onClick={() => move(page - 1)} />
          <div className="intro-indicators">
            {pages.map((_, index) => <button type="button" key={index} aria-current={index === page ? 'step' : undefined}
              aria-label={t('Экран {number} из {total}', { number: index + 1, total: pages.length })} onClick={() => move(index)} />)}
          </div>
          <button type="button" className="primary-button intro-next" onClick={next}>
            {t(page + 1 === pages.length ? 'Открыть Folio' : 'Далее')} <ArrowRight size={16} />
          </button>
        </footer>
      </>}
  </section>
}
