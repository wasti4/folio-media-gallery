export const emptyLibraryFilters = Object.freeze({ from: '', to: '', tag: '', folderId: '', year: '', month: '' })

const lowerTag = value => value.normalize('NFC').toLowerCase()

export function normalizeTags(value) {
  const tags = new Map()
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== 'string') continue
    for (const part of entry.split(/[,，]/)) {
      const label = part.trim().normalize('NFC')
      if (!label || /[\u0000-\u001f\u007f]/.test(label)) continue
      const key = lowerTag(label)
      if (!tags.has(key)) tags.set(key, label)
    }
  }
  return [...tags.values()]
}

export function calendarDate(item) {
  for (const value of [item.capturedAt, item.modifiedAt]) {
    if (!Number.isFinite(value)) continue
    const date = new Date(value)
    const year = date.getFullYear()
    if (!(year >= 1 && year <= 9999)) continue
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return String(year).padStart(4, '0') + '-' + month + '-' + day
  }
  return ''
}

export function hasLibraryFilters(filters = emptyLibraryFilters) {
  return Boolean(filters.from || filters.to || filters.tag || filters.folderId || filters.year || filters.month)
}

export function matchesLibrarySearch(item, { query = '', filters = emptyLibraryFilters, language = 'ru' } = {}) {
  if (filters.folderId && item.folderId !== filters.folderId) return false
  const tags = Array.isArray(item.tags) ? item.tags : []
  if (filters.tag) {
    const selected = lowerTag(filters.tag)
    if (!tags.some(tag => typeof tag === 'string' && lowerTag(tag) === selected)) return false
  }
  if (filters.from || filters.to || filters.year || filters.month) {
    const date = calendarDate(item)
    if (!date || (filters.from && date < filters.from) || (filters.to && date > filters.to)) return false
    if (filters.year && date.slice(0, 4) !== filters.year) return false
    if (filters.month && date.slice(5, 7) !== filters.month) return false
  }
  const fold = value => value.normalize('NFC').toLocaleLowerCase(language)
  const text = fold(query.trim())
  return !text || [item.name, item.filename, item.folderName, item.ext, ...tags]
    .some(value => typeof value === 'string' && fold(value).includes(text))
}
