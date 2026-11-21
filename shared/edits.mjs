export const fullCrop = { x: 0, y: 0, width: 1, height: 1 }
export const minimumCrop = 0.025

export function newEdit(duration = 0) {
  return {
    brightness: 0, contrast: 0, saturation: 0, sharpness: 0, rotation: 0,
    exposure: 0, shadows: 0, highlights: 0, warmth: 0, flipX: false, flipY: false,
    crop: { ...fullCrop }, start: 0, end: duration,
  }
}

export function limit(value, min, max, fallback = min) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

export function normalizeEdit(input, duration = 0) {
  const crop = input?.crop
  const x = limit(crop?.x, 0, 1 - minimumCrop)
  const y = limit(crop?.y, 0, 1 - minimumCrop)
  const gap = Math.min(duration, 0.08)
  const start = limit(input?.start, 0, duration - gap)
  const turn = Math.round(limit(input?.rotation, -3, 3, 0))
  return {
    brightness: limit(input?.brightness, -100, 100, 0),
    contrast: limit(input?.contrast, -100, 100, 0),
    saturation: limit(input?.saturation, -100, 100, 0),
    sharpness: limit(input?.sharpness, 0, 100),
    exposure: limit(input?.exposure, -100, 100, 0),
    shadows: limit(input?.shadows, -100, 100, 0),
    highlights: limit(input?.highlights, -100, 100, 0),
    warmth: limit(input?.warmth, -100, 100, 0),
    rotation: (turn + 4) % 4,
    flipX: input?.flipX === true,
    flipY: input?.flipY === true,
    crop: { x, y, width: limit(crop?.width, minimumCrop, 1 - x, 1 - x), height: limit(crop?.height, minimumCrop, 1 - y, 1 - y) },
    start,
    end: limit(input?.end, start + gap, duration, duration),
  }
}

export function rotateEdit(edit, direction) {
  const { x, y, width, height } = edit.crop
  return {
    ...edit,
    rotation: (edit.rotation + direction + 4) % 4,
    flipX: edit.flipY,
    flipY: edit.flipX,
    crop: direction > 0 ? { x: 1 - y - height, y: x, width: height, height: width } :
      { x: y, y: 1 - x - width, width: height, height: width },
  }
}

export function flipEdit(edit, horizontal) {
  const { x, y, width, height } = edit.crop
  const reflected = horizontal ? { x: 1 - x - width, y } : { x, y: 1 - y - height }
  const axis = horizontal ? 'flipX' : 'flipY'
  return { ...edit, [axis]: !edit[axis], crop: { ...edit.crop, ...reflected } }
}

export function hasCrop({ x, y, width, height }) {
  return x > 0.00001 || y > 0.00001 || width < 0.99999 || height < 0.99999
}

export function hasEdit(edit, duration) {
  return Boolean(edit.brightness || edit.contrast || edit.saturation || edit.sharpness || edit.exposure ||
    edit.shadows || edit.highlights || edit.warmth || edit.rotation || edit.flipX || edit.flipY ||
    hasCrop(edit.crop) || edit.start || Math.abs(edit.end - duration) > 0.001)
}
