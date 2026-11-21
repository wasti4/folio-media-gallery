import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarDate, emptyLibraryFilters, hasLibraryFilters, matchesLibrarySearch, normalizeTags } from '../shared/library-search.mjs'

const photo = {
  id: 'photo',
  kind: 'photo',
  name: 'Вечер у маяка',
  filename: 'IMG_2321.JPG',
  folderId: 'seaside',
  folderName: 'Поездки на море',
  ext: 'jpg',
  capturedAt: new Date(2024, 1, 29, 23, 12).getTime(),
  modifiedAt: new Date(2026, 4, 19, 8).getTime(),
  tags: ['Балтика', 'Golden Hour'],
}

test('tag normalization preserves display spelling, collapses equivalent tags, and handles translated commas', () => {
  assert.deepEqual(normalizeTags(' Балтика,  Golden Hour，балтика，golden hour， 海滨 ,,  '), ['Балтика', 'Golden Hour', '海滨'])
  assert.deepEqual(normalizeTags([' café ', 'Cafe\u0301', null, '', 'good', 'invalid\u0000tag']), ['café', 'good'])
  assert.deepEqual(normalizeTags(undefined), [])
})

test('text search includes tags and existing name, folder, and extension fields', () => {
  assert.equal(matchesLibrarySearch(photo, { query: ' GOLDEN ' }), true)
  assert.equal(matchesLibrarySearch(photo, { query: 'Маяка' }), true)
  assert.equal(matchesLibrarySearch(photo, { query: '2321.jpg' }), true)
  assert.equal(matchesLibrarySearch(photo, { query: 'на море' }), true)
  assert.equal(matchesLibrarySearch(photo, { query: 'jpg' }), true)
  assert.equal(matchesLibrarySearch(photo, { query: 'alpine' }), false)
  assert.equal(matchesLibrarySearch({ id: 'legacy' }, { query: 'any' }), false)
})

test('calendar date prefers capture time and falls back to the modified date', () => {
  assert.equal(calendarDate(photo), '2024-02-29')
  assert.equal(calendarDate({ ...photo, capturedAt: Number.NaN }), '2026-05-19')
  assert.equal(calendarDate({ ...photo, capturedAt: Number.MAX_VALUE }), '2026-05-19')
  assert.equal(calendarDate({}), '')
})

test('date bounds are inclusive and tags, folders, and timeline filters compose', () => {
  const filters = { from: '2024-02-29', to: '2024-02-29', year: '2024', month: '02', tag: 'балтика', folderId: 'seaside' }
  assert.equal(hasLibraryFilters(emptyLibraryFilters), false)
  assert.equal(hasLibraryFilters(filters), true)
  assert.equal(matchesLibrarySearch(photo, { query: 'golden', filters }), true)
  assert.equal(matchesLibrarySearch(photo, { filters: { ...filters, from: '2024-03-01' } }), false)
  assert.equal(matchesLibrarySearch(photo, { filters: { ...filters, to: '2024-02-28' } }), false)
  assert.equal(matchesLibrarySearch(photo, { filters: { ...filters, year: '2025' } }), false)
  assert.equal(matchesLibrarySearch(photo, { filters: { ...filters, month: '03' } }), false)
  assert.equal(matchesLibrarySearch(photo, { filters: { ...filters, tag: 'Golden' } }), false)
  assert.equal(matchesLibrarySearch(photo, { filters: { ...filters, folderId: 'mountains' } }), false)
  assert.equal(matchesLibrarySearch({}, { filters: { to: '2024-02-29' } }), false)
})
