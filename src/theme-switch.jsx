import { useEffect, useRef, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import './theme.css'
import { useLocale } from './localization.jsx'

export function ThemeSwitch({ change }) {
  const { t } = useLocale()
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme)
  const light = theme === 'light'
  const gesture = useRef(null)
  const suppressClick = useRef(false)
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  function select(next) {
    if (next === theme) return
    setTheme(next)
    change(next)
  }

  function progress(active, clientX) {
    return Math.max(0, Math.min(1, (clientX - active.startOfTravel) / active.travel))
  }

  function endDrag(button) {
    gesture.current = null
    cancelAnimationFrame(frame.current)
    frame.current = 0
    button.removeAttribute('data-dragging')
    button.style.removeProperty('--drag-progress')
  }

  return <button type="button" role="switch" aria-label={t('Светлая тема')} aria-checked={light}
    title={t(light ? 'Переключить на тёмную тему' : 'Переключить на светлую тему')}
    className="theme-switch"
    onClick={event => {
      if (suppressClick.current && event.detail) {
        suppressClick.current = false
        return
      }
      select(light ? 'dark' : 'light')
    }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'Home') {
        event.preventDefault()
        select('dark')
      }
      if (event.key === 'ArrowRight' || event.key === 'End') {
        event.preventDefault()
        select('light')
      }
    }}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return
      suppressClick.current = false
      const button = event.currentTarget
      const { left, width, height } = button.getBoundingClientRect()
      gesture.current = {
        id: event.pointerId, start: event.clientX, moved: false, fraction: Number(light),
        startOfTravel: left + height / 2, travel: Math.max(1, width - height),
      }
      button.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      const active = gesture.current
      if (active?.id !== event.pointerId) return
      const button = event.currentTarget
      if (!active.moved) {
        if (Math.abs(event.clientX - active.start) <= 4) return
        active.moved = true
        button.setAttribute('data-dragging', '')
      }
      active.fraction = progress(active, event.clientX)
      if (!frame.current) frame.current = requestAnimationFrame(() => {
        frame.current = 0
        button.style.setProperty('--drag-progress', active.fraction)
      })
    }}
    onPointerUp={event => {
      const active = gesture.current
      if (active?.id !== event.pointerId) return
      endDrag(event.currentTarget)
      if (!active.moved) return
      suppressClick.current = true
      select(progress(active, event.clientX) >= 0.5 ? 'light' : 'dark')
    }}
    onLostPointerCapture={event => { if (gesture.current?.id === event.pointerId) endDrag(event.currentTarget) }}>
    <Moon className="theme-marker theme-marker-night" size={13} strokeWidth={1.6} aria-hidden="true" />
    <Sun className="theme-marker theme-marker-day" size={13} strokeWidth={1.6} aria-hidden="true" />
    <span className="theme-lens" aria-hidden="true">
      <span className="theme-orb">
        <Moon className="theme-glyph theme-moon" size={15} strokeWidth={1.7} />
        <Sun className="theme-glyph theme-sun" size={16} strokeWidth={1.7} />
      </span>
    </span>
  </button>
}
