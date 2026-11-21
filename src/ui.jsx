import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Clapperboard, Image, X } from 'lucide-react'
import { languages, translate } from '../shared/locale.mjs'
import { useLocale } from './localization.jsx'

export function IconButton({ icon: Icon, label, className = '', size = 18, ...props }) {
  return <button type="button" title={label} aria-label={label} className={'icon-button ' + className} {...props}><Icon size={size} strokeWidth={1.75} /></button>
}

export function Menu({ anchor, onClose, placement = 'down', children, className = '' }) {
  const popup = useRef(null)
  const [location, setLocation] = useState(null)
  useLayoutEffect(() => {
    const item = popup.current
    const rect = anchor.getBoundingClientRect()
    const bottom = placement === 'up' || rect.bottom + 6 + item.offsetHeight > innerHeight - 8
    setLocation({
      left: Math.max(10, Math.min(innerWidth - item.offsetWidth - 10, rect.right - item.offsetWidth)),
      top: Math.max(10, bottom ? rect.top - item.offsetHeight - 7 : rect.bottom + 7),
    })
  }, [anchor, placement, children])

  useEffect(() => {
    const outside = event => {
      if (!popup.current?.contains(event.target) && !event.target.closest?.('[data-popup-trigger]')) onClose()
    }
    const resize = () => onClose()
    const scrolling = anchor.closest('.gallery-scroll')
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    scrolling?.addEventListener('scroll', onClose, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', resize)
      scrolling?.removeEventListener('scroll', onClose)
    }
  }, [anchor, onClose])

  useEffect(() => {
    if (anchor.matches(':focus-visible')) popup.current?.querySelector('button:not(:disabled)')?.focus()
  }, [anchor])

  function keyboard(event) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      onClose()
      anchor.focus()
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const buttons = [...popup.current.querySelectorAll('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement)
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }

  return createPortal(
    <div className={'popup ' + className} ref={popup} style={location ?? { visibility: 'hidden' }} role="menu" onKeyDown={keyboard}>{children}</div>,
    document.fullscreenElement || document.body,
  )
}

export function MenuItem({ icon: Icon, children, checked, danger, ...props }) {
  return <button type="button" className={'menu-item' + (danger ? ' is-danger' : '')} role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} {...props}>
    {Icon && <Icon size={16} strokeWidth={1.7} />}
    <span>{children}</span>
    {checked && <Check size={15} className="menu-check" />}
  </button>
}

export function Picture({ item, className = '', eager = false }) {
  const [error, setError] = useState(false)
  useEffect(() => setError(false), [item.preview])
  const Placeholder = item.kind === 'video' ? Clapperboard : Image
  if (!item.preview || error) return <span className={'thumb-placeholder ' + className}><Placeholder size={29} strokeWidth={1.3} /></span>
  return <img className={className} src={item.preview} loading={eager ? 'eager' : 'lazy'} decoding="async" alt="" draggable="false" onError={() => setError(true)} />
}

export function Dialog({ title, onClose, children, className = '' }) {
  const { t } = useLocale()
  return <div className="dialog-veil" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className={'dialog-card ' + className} role="dialog" aria-modal="true" aria-labelledby="dialog-title"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
        if (event.key === 'Tab') {
          const items = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
          if (event.shiftKey && document.activeElement === items[0]) {
            event.preventDefault()
            items.at(-1)?.focus()
          } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
            event.preventDefault()
            items[0]?.focus()
          }
        }
      }}>
      <header><h2 id="dialog-title">{title}</h2><IconButton icon={X} label={t('Закрыть')} onClick={onClose} /></header>
      {children}
    </section>
  </div>
}

export function clock(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor(total % 3600 / 60)
  const s = (total % 60).toString().padStart(2, '0')
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s
}

const dateFormats = Object.fromEntries(languages.map(({ id }) => [id, [
  new Intl.DateTimeFormat(id, { day: 'numeric', month: 'short' }),
  new Intl.DateTimeFormat(id, { day: 'numeric', month: 'short', year: 'numeric' }),
]]))
export const formatDate = (value, language = 'ru') =>
  dateFormats[language][Number(new Date(value).getFullYear() !== new Date().getFullYear())].format(value)

export function quantity(amount, [one, few, many], language = 'ru') {
  if (language === 'en') return amount + ' ' + translate(language, one) + (amount === 1 ? '' : 's')
  if (language === 'zh-CN') return amount + ' ' + translate(language, one)
  const rem = amount % 100
  const last = amount % 10
  return amount + ' ' + (last === 1 && rem !== 11 ? one : last >= 2 && last <= 4 && !(rem >= 12 && rem <= 14) ? few : many)
}
