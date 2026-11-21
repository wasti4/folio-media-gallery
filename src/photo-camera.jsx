import { useLayoutEffect, useRef, useState } from 'react'

const fittedView = { scale: 1, x: 0, y: 0 }
const maxZoom = 8
const bounded = (value, bound) => Math.max(-bound, Math.min(bound, value))
const transform = ({ scale, x, y }) => 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + scale + ')'

export function usePhotoCamera(key, ready) {
  const stage = useRef(null)
  const picture = useRef(null)
  const view = useRef(fittedView)
  const geometry = useRef(null)
  const motion = useRef(null)
  const gesture = useRef(null)
  const scheduled = useRef(0)
  const target = useRef(null)
  const [scale, setScale] = useState(1)

  function constrain(next) {
    const area = geometry.current
    if (!area || next.scale <= 1) return fittedView
    return { scale: next.scale,
      x: bounded(next.x, Math.max(0, (area.photoWidth * next.scale - area.width) / 2)),
      y: bounded(next.y, Math.max(0, (area.photoHeight * next.scale - area.height) / 2)),
    }
  }

  function draw(next) {
    const clamped = constrain(next)
    const changed = clamped.scale !== view.current.scale
    view.current = clamped
    if (picture.current) picture.current.style.transform = transform(clamped)
    if (stage.current) stage.current.dataset.zoomed = String(clamped.scale > 1)
    if (changed) setScale(clamped.scale)
  }

  function settleAnimation() {
    const animation = motion.current
    const photo = picture.current
    if (!animation || !photo) return
    if (animation.playState === 'running') {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(photo).transform)
      draw({ scale: Math.max(1, matrix.a), x: matrix.e, y: matrix.f })
    }
    animation.cancel()
    motion.current = null
  }

  function zoom(nextScale, x, y, animated) {
    const viewport = stage.current
    const photo = picture.current
    if (!viewport || !photo || !geometry.current || gesture.current?.moving) return
    settleAnimation()
    const box = viewport.getBoundingClientRect()
    const focusX = x === undefined ? 0 : x - box.left - box.width / 2
    const focusY = y === undefined ? 0 : y - box.top - box.height / 2
    const old = view.current
    const step = Math.max(1, Math.min(maxZoom, nextScale))
    const ratio = step / old.scale
    draw({ scale: step, x: focusX - (focusX - old.x) * ratio, y: focusY - (focusY - old.y) * ratio })
    if (animated && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion.current = photo.animate([{ transform: transform(old) }, { transform: transform(view.current) }],
        { duration: 170, easing: 'cubic-bezier(.2,.76,.3,1)' })
    }
  }

  function toggle(x, y) {
    if (!ready || !geometry.current) return
    const step = Math.min(maxZoom, Math.max(2, 1 / geometry.current.fit))
    zoom(view.current.scale > 1 ? 1 : step, x, y, true)
  }

  function flushPan() {
    cancelAnimationFrame(scheduled.current)
    scheduled.current = 0
    if (target.current) draw(target.current)
    target.current = null
  }

  function release(event) {
    if (gesture.current?.id !== event.pointerId) return
    flushPan()
    gesture.current = null
    delete event.currentTarget.dataset.panning
  }

  function begin(event) {
    if (!ready || event.button !== 0 || !event.isPrimary || view.current.scale <= 1) return
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moving: false }
  }

  function pan(event) {
    const drag = gesture.current
    if (!drag || drag.id !== event.pointerId || (!drag.moving && !(event.buttons & 1))) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moving) {
      if (Math.hypot(dx, dy) < 4) return
      settleAnimation()
      drag.origin = view.current
      drag.moving = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.dataset.panning = ''
    }
    target.current = { scale: drag.origin.scale, x: drag.origin.x + dx, y: drag.origin.y + dy }
    if (!scheduled.current) scheduled.current = requestAnimationFrame(flushPan)
  }

  useLayoutEffect(() => {
    const viewport = stage.current
    const photo = picture.current
    if (!viewport || !photo?.naturalWidth) return
    view.current = fittedView
    setScale(1)
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = viewport
      if (!width || !height || !photo.naturalHeight) return
      const fit = Math.min(width / photo.naturalWidth, height / photo.naturalHeight)
      const previous = geometry.current
      geometry.current = { width, height, fit, photoWidth: photo.naturalWidth * fit, photoHeight: photo.naturalHeight * fit }
      if (!previous || previous.width !== width || previous.height !== height) draw(view.current)
    }
    const wheel = event => {
      if (viewport.getAttribute('aria-busy') === 'true' || !event.deltaY) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1)
      zoom(view.current.scale * Math.exp(-delta * .0019), event.clientX, event.clientY, false)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      viewport.removeEventListener('wheel', wheel)
      motion.current?.cancel()
      motion.current = null
      cancelAnimationFrame(scheduled.current)
      scheduled.current = 0
      target.current = null
      gesture.current = null
      geometry.current = null
      delete viewport.dataset.panning
    }
  }, [key])

  return { stage, picture, scale, toggle, handlers: {
    onDoubleClick: event => { if (event.button === 0 && event.target === picture.current) toggle(event.clientX, event.clientY) },
    onPointerDown: begin, onPointerMove: pan, onPointerUp: release, onPointerCancel: release, onLostPointerCapture: release,
  } }
}
