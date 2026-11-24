import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { translate } from '../shared/locale.mjs'

const cyrillic = /[А-Яа-яЁё]/
const literal = "'((?:[^'\\\\\\n]|\\\\.)*)'"
const patterns = [
  new RegExp('\\bt\\(\\s*' + literal, 'g'),
  new RegExp('\\btranslate\\([^,()]+,\\s*' + literal, 'g'),
  new RegExp('new (?:\\w+)?Error\\(' + literal + '\\)', 'g'),
]

async function sources() {
  const files = []
  for (const folder of ['src', 'desktop', 'shared']) {
    for (const name of await readdir(folder)) {
      if (/\.(jsx|mjs|cjs)$/.test(name) && name !== 'locale.mjs') files.push(path.join(folder, name))
    }
  }
  return files
}

test('every interface string and error message has English and Chinese text', async () => {
  const missing = []
  for (const file of await sources()) {
    const text = await readFile(file, 'utf8')
    for (const pattern of patterns) {
      for (const [, raw] of text.matchAll(pattern)) {
        const message = raw.replace(/\\'/g, "'")
        if (!cyrillic.test(message)) continue
        for (const language of ['en', 'zh-CN']) {
          if (translate(language, message) === message) missing.push(language + ' · ' + file + ' · ' + message)
        }
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [])
})
