import assert from 'node:assert/strict'
import test from 'node:test'
import { hasEdit, newEdit, normalizeEdit } from '../shared/edits.mjs'
import { photoLooks, withLook } from '../shared/photo-looks.mjs'

test('a look adds its adjustments on top of manual values and scales with its amount', () => {
  const manual = { ...newEdit(), contrast: 10, rotation: 1 }
  const vivid = photoLooks.find(look => look.id === 'vivid')
  const full = withLook(manual, { id: 'vivid', amount: 100 })
  assert.equal(full.contrast, 10 + vivid.tone.contrast)
  assert.equal(full.saturation, vivid.tone.saturation)
  assert.equal(full.rotation, 1)
  const half = withLook(manual, { id: 'vivid', amount: 50 })
  assert.equal(half.saturation, Math.round(vivid.tone.saturation / 2))
  assert.equal(manual.saturation, 0, 'the manual edit stays untouched')
})

test('combined values stay inside the ranges the exporter accepts', () => {
  for (const look of photoLooks) {
    for (const extreme of [-100, 100]) {
      const manual = { ...newEdit(), exposure: extreme, brightness: extreme, contrast: extreme, shadows: extreme,
        highlights: extreme, saturation: extreme, warmth: extreme, sharpness: Math.max(0, extreme) }
      const combined = withLook(manual, { id: look.id, amount: 100 })
      assert.deepEqual(normalizeEdit(combined), combined, look.id + ' at ' + extreme)
    }
  }
})

test('no look, an unknown look and a zero amount leave the photo unchanged', () => {
  const manual = newEdit()
  assert.equal(withLook(manual, null), manual)
  assert.equal(withLook(manual, { id: 'missing', amount: 100 }), manual)
  assert.equal(hasEdit(withLook(manual, { id: 'mono', amount: 0 }), 0), false)
  assert.equal(hasEdit(withLook(manual, { id: 'mono', amount: 100 }), 0), true)
})
