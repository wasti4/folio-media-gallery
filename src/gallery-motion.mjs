const ease = 'cubic-bezier(.22, .72, .3, 1)'
const maxFlights = 9
const wait = duration => new Promise(resolve => setTimeout(resolve, duration))

function intersection(rect, area) {
  const left = Math.max(rect.left, area.left)
  const top = Math.max(rect.top, area.top)
  const width = Math.min(rect.right, area.right) - left
  const height = Math.min(rect.bottom, area.bottom) - top
  return width > 8 && height > 8 ? { left, top, width, height } : null
}

function thumbnail(image, box, id) {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 168 / Math.max(box.width, box.height))
  canvas.width = Math.max(1, Math.round(box.width * scale))
  canvas.height = Math.max(1, Math.round(box.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#666462'
  context.fillRect(0, 0, canvas.width, canvas.height)
  if (image?.complete && image.naturalWidth) {
    const fit = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
    const width = image.naturalWidth * fit
    const height = image.naturalHeight * fit
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
  }
  return { canvas, box, id }
}

export function capturePhotoAction(scroll, ids, viewer) {
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  const cards = new Map()
  const photos = []
  if (viewer) {
    const image = viewer.querySelector('.photo-active')
    const stage = image?.closest('.photo-stage')
    if (stage && image.naturalWidth && image.naturalHeight) {
      const surface = image.getBoundingClientRect()
      const fit = Math.min(surface.width / image.naturalWidth, surface.height / image.naturalHeight)
      const width = image.naturalWidth * fit
      const height = image.naturalHeight * fit
      const left = surface.left + (surface.width - width) / 2
      const top = surface.top + (surface.height - height) / 2
      const frame = intersection({ left, top, right: left + width, bottom: top + height }, stage.getBoundingClientRect())
      if (frame) photos.push(thumbnail(image, frame, ids[0]))
    }
  } else if (scroll) {
    const selected = new Set(ids)
    const viewport = scroll.getBoundingClientRect()
    for (const card of scroll.querySelectorAll('.media-card')) {
      const id = card.dataset.mediaId
      const bounds = card.getBoundingClientRect()
      cards.set(id, { card, bounds, visible: Boolean(intersection(bounds, viewport)) })
      if (!selected.has(id) || photos.length >= maxFlights) continue
      const surface = card.querySelector('.media-thumb')
      const frame = intersection(surface.getBoundingClientRect(), viewport)
      if (frame) photos.push(thumbnail(surface.querySelector('img'), frame, id))
    }
  }
  return { scroll, cards, photos: photos.filter(Boolean), fromViewer: Boolean(viewer) }
}

function reflowCards({ scroll, cards }, animations, moved) {
  if (!scroll || !cards.size) return
  const viewport = scroll.getBoundingClientRect()
  const changes = []
  for (const card of scroll.querySelectorAll('.media-card')) {
    const previous = cards.get(card.dataset.mediaId)
    if (!previous) continue
    const next = card.getBoundingClientRect()
    if (!previous.visible && !intersection(next, viewport)) continue
    const x = previous.bounds.left - next.left
    const y = previous.bounds.top - next.top
    if (Math.hypot(x, y) >= 2) changes.push({ card, x, y })
  }
  for (const { card, x, y } of changes) {
    card.setAttribute('data-photo-reflow', '')
    moved.push(card)
    animations.push(card.animate([
      { translate: x + 'px ' + y + 'px' },
      { translate: '0px 0px' },
    ], { duration: 255, easing: ease }))
  }
}

function land(layer, point, target, action, animations) {
  const mark = document.createElement('span')
  mark.className = 'photo-arrival'
  mark.dataset.action = action
  Object.assign(mark.style, { left: point.x + 'px', top: point.y + 'px' })
  for (const offset of [[-22, -7], [-9, -22], [16, -17], [23, 4]]) {
    const spark = document.createElement('i')
    spark.style.setProperty('--spark-x', offset[0] + 'px')
    spark.style.setProperty('--spark-y', offset[1] + 'px')
    mark.append(spark)
  }
  layer.append(mark)
  animations.push(target.animate([
    { scale: '.91' }, { scale: '1.15', offset: .43 }, { scale: '1' },
  ], { duration: 220, easing: ease }))
}

export async function animatePhotoAction(capture, { ids, departing, action, target, icon, commit }) {
  if (!capture || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    commit()
    return
  }
  const layer = document.createElement('div')
  layer.className = 'photo-motion-layer'
  layer.setAttribute('aria-hidden', 'true')
  document.body.append(layer)
  const animations = []
  const moved = []
  try {
    const anchor = target?.getBoundingClientRect()
    if (!anchor?.width || capture.fromViewer) {
      target = document.createElement('span')
      target.className = 'photo-motion-target'
      if (anchor?.width) Object.assign(target.style, { top: anchor.top + 'px', left: anchor.left + 'px', right: 'auto' })
      if (icon) target.append(icon)
      layer.append(target)
    }
    const end = target.getBoundingClientRect()
    const point = { x: end.left + end.width / 2, y: end.top + end.height / 2 }
    const chosen = new Set(ids)
    const photos = capture.photos.filter(photo => chosen.has(photo.id))
    const duration = 390
    const interval = 23

    for (const [index, { canvas, box }] of photos.entries()) {
      const x = point.x - box.left - box.width / 2
      const y = point.y - box.top - box.height / 2
      const tilt = (index % 2 ? 1 : -1) * (8 + index % 4)
      const shrink = Math.min(.24, 17 / Math.max(box.width, box.height))
      canvas.className = 'photo-flight'
      canvas.dataset.action = action
      Object.assign(canvas.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' })
      layer.append(canvas)
      animations.push(canvas.animate([
        { transform: 'translate3d(0,0,0) scale(1)', opacity: .93 },
        { transform: `translate3d(${x * .08}px,${y * .07 - 13}px,0) rotate(${tilt}deg) scale(.77)`, opacity: 1, offset: .23 },
        { transform: `translate3d(${x * .88}px,${y * .9 - 20}px,0) rotate(${tilt / 2}deg) scale(${Math.max(.21, shrink)})`, opacity: .98, offset: .8 },
        { transform: `translate3d(${x}px,${y}px,0) scale(${shrink})`, opacity: 0 },
      ], { duration, delay: index * interval, easing: ease, fill: 'both' }))
    }
    let exit = 0
    for (const id of departing) {
      const entry = capture.cards.get(id)
      if (!entry?.visible) continue
      const { card } = entry
      animations.push(card.animate([
        { opacity: 1, scale: '1' }, { opacity: 0, scale: '.96' },
      ], { duration: 124, delay: Math.min(4, exit++) * 12, easing: ease, fill: 'forwards' }))
    }
    const exitTime = exit || photos.length ? 175 : 0
    if (exitTime) await wait(exitTime)
    commit()
    reflowCards(capture, animations, moved)
    if (photos.length) await wait(duration + (photos.length - 1) * interval - exitTime - 53)
    land(layer, point, target, action, animations)
    await wait(225)
  } finally {
    for (const animation of animations) animation.cancel()
    for (const card of moved) card.removeAttribute('data-photo-reflow')
    layer.remove()
  }
}
