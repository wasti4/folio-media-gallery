import { hasCrop } from './edits.mjs'

export const luminanceWeights = [0.2126, 0.7152, 0.0722]
export const sharpWeight = sharpness => Math.round(sharpness * 2) / 256

export function hasPhotoTone(edit) {
  return Boolean(edit.exposure || edit.brightness || edit.contrast || edit.highlights || edit.shadows || edit.warmth)
}

export function photoLookup(edit) {
  const table = new Uint8ClampedArray(256 * 4)
  const gain = 2 ** (edit.exposure / 50)
  const contrast = 2 ** (edit.contrast / 100)
  const offset = edit.brightness / 250
  const heat = edit.warmth / 1250
  for (let index = 0; index < 256; index++) {
    const level = index / 255
    const shade = 12.20703125 * level * (1 - level) ** 4
    const light = 12.20703125 * (1 - level) * level ** 4
    const neutral = ((level - 0.5) * contrast + 0.5) * gain + offset +
      (edit.shadows * shade + edit.highlights * light) / 550
    const tint = heat * (0.6 + 0.4 * level)
    const position = index * 4
    table[position] = (neutral + tint) * 255
    table[position + 1] = neutral * 255
    table[position + 2] = (neutral - tint) * 255
    table[position + 3] = 255
  }
  return table
}

export function photoGeometry(sourceWidth, sourceHeight, edit) {
  const sideways = edit.rotation % 2 === 1
  const frameWidth = sideways ? sourceHeight : sourceWidth
  const frameHeight = sideways ? sourceWidth : sourceHeight
  const crop = hasCrop(edit.crop) ? edit.crop : { x: 0, y: 0, width: 1, height: 1 }
  const pixels = (length, fraction) => Math.floor(length * Number(fraction.toFixed(6)))
  const left = pixels(frameWidth, crop.x)
  const top = pixels(frameHeight, crop.y)
  const width = Math.max(1, Math.min(frameWidth - left, pixels(frameWidth, crop.width)))
  const height = Math.max(1, Math.min(frameHeight - top, pixels(frameHeight, crop.height)))
  function sample(x, y) {
    const u = edit.flipX ? frameWidth - 1 - x : x
    const v = edit.flipY ? frameHeight - 1 - y : y
    if (edit.rotation === 1) return [v, sourceHeight - 1 - u]
    if (edit.rotation === 2) return [sourceWidth - 1 - u, sourceHeight - 1 - v]
    if (edit.rotation === 3) return [sourceWidth - 1 - v, u]
    return [u, v]
  }
  const origin = sample(left, top)
  const across = sample(left + 1, top)
  const down = sample(left, top + 1)
  return { width, height, origin, column: across.map((value, index) => value - origin[index]),
    row: down.map((value, index) => value - origin[index]) }
}
