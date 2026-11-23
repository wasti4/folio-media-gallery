import { limit } from './edits.mjs'

// Looks only shift the regular adjustments, so the live preview and the saved copy use the same pipeline.
export const photoLooks = Object.freeze([
  { id: 'vivid', name: 'Яркий', tone: { contrast: 18, saturation: 32, highlights: -12, shadows: 10 } },
  { id: 'warm', name: 'Тёплый', tone: { warmth: 38, saturation: 8, exposure: 4 } },
  { id: 'cool', name: 'Холодный', tone: { warmth: -36, contrast: 8, saturation: -6 } },
  { id: 'matte', name: 'Матовый', tone: { contrast: -28, shadows: 34, saturation: -22, brightness: 6 } },
  { id: 'drama', name: 'Драма', tone: { contrast: 38, highlights: -32, shadows: -18, saturation: -14, sharpness: 18 } },
  { id: 'film', name: 'Плёнка', tone: { warmth: 14, contrast: 12, highlights: -22, shadows: 16, saturation: -12 } },
  { id: 'mono', name: 'Ч/б', tone: { saturation: -100, contrast: 22 } },
])

export const defaultLookAmount = 100

export function withLook(edit, look) {
  const preset = photoLooks.find(entry => entry.id === look?.id)
  if (!preset) return edit
  const scale = limit(look.amount, 0, 100, defaultLookAmount) / 100
  const result = { ...edit }
  for (const [key, value] of Object.entries(preset.tone)) {
    result[key] = Math.round(limit((edit[key] ?? 0) + value * scale, key === 'sharpness' ? 0 : -100, 100))
  }
  return result
}
