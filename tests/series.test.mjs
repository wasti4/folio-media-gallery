import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSeriesEpisode, groupSeries } from '../shared/series.mjs'

test('release tags, numeric filenames and season folders identify episodes across seasons', () => {
  const identify = (filename, directory) => describeSeriesEpisode(filename, directory, key => 'key:' + key)
  const first = identify('[Studio] Northern Lights - 01v2 [1080p].mkv', 'D:\\Anime\\Northern Lights\\Season 01\\Videos')
  const second = identify('02.mp4', 'D:\\Anime\\Northern Lights S02')
  const third = identify('Northern.Lights.S03E05.WEB-DL.mp4', 'D:\\Anime\\Northern Lights')
  assert.deepEqual([first.season, first.episode, second.season, second.episode, third.season, third.episode], [1, 1, 2, 2, 3, 5])
  assert.equal(first.title, 'Northern Lights')
  assert.equal(first.key, second.key)
  assert.equal(first.key, third.key)
  assert.match(first.key, /^key:/)
  assert.notEqual(identify('01.mkv', 'D:\\Other\\Northern Lights\\Season 01').key, first.key)
  assert.notEqual(identify('01.mkv', 'D:\\Anime\\Southern Lights\\Season 01').key, first.key)
})

test('episode matching recognizes localized labels, special episodes and decimal numbers', () => {
  const episode = (filename, directory) => {
    const { title, season, episode } = describeSeriesEpisode(filename, directory)
    return [title, season, episode]
  }
  assert.deepEqual(episode('Северный свет Сезон 2 Серия 03.mkv'), ['Северный свет', 2, 3])
  assert.deepEqual(episode('风起 第12话.mp4', 'C:\\表演\\风起\\第2季'), ['风起', 2, 12])
  assert.deepEqual(episode('North - 10.5v2.mkv'), ['North', 1, 10.5])
  assert.deepEqual(episode('North OVA 02.mkv', 'D:\\Shows\\North'), ['North', 0, 2])
  assert.deepEqual(episode('The Quiet Show.2x04.mp4'), ['The Quiet Show', 2, 4])
  assert.deepEqual(episode('North - [02] [1080p].mkv'), ['North', 1, 2])
})

test('series names come from an episode even inside a generically named release pack', () => {
  const first = describeSeriesEpisode('[Group] Moon Story - 01 [1080p].mkv', 'D:\\Anime pack\\Видео\\Season 1')
  const second = describeSeriesEpisode('Moon.Story.S02E01.mkv', 'D:\\Anime pack\\Видео\\Season 2')
  assert.equal(first.title, 'Moon Story')
  assert.equal(first.key, second.key)
})

test('standalone videos and release extras are excluded from Series', () => {
  for (const filename of ['Tokyo.mp4', 'Winter holiday 2024.mp4', 'Holiday - 1080p.mkv', '2024-12-24.mp4', 'North NCOP 01.mkv']) {
    assert.equal(describeSeriesEpisode(filename, 'D:\\Downloads'), null, filename)
  }
  assert.equal(describeSeriesEpisode('Signal - 09.jpg', 'D:\\Shows'), null)
})

test('grouping sorts titles, seasons and episode numbers and handles legacy folder metadata', () => {
  const video = (id, filename, folderName, series) => ({ id, kind: 'video', filename, name: filename, folderName, series })
  const aurora = (season, episode) => ({ key: 'aurora', title: 'Aurora', season, episode })
  const items = [
    video('ten', '10.mkv', 'Season 1', aurora(1, 10)),
    video('second', '01.mkv', 'Season 2', aurora(2, 1)),
    video('two', '02.mkv', 'Season 1', aurora(1, 2)),
    video('old', '[Group] Zenith - 01 [1080p].mkv', 'Videos'),
    { ...video('photo', 'Aurora - 07.jpg', 'Aurora'), kind: 'photo' },
  ]
  const [first, second] = groupSeries(items, 'en')
  assert.equal(first.title, 'Aurora')
  assert.deepEqual(first.seasons.map(season => [season.number, season.episodes.map(({ item }) => item.id)]), [[1, ['two', 'ten']], [2, ['second']]])
  assert.equal(second.title, 'Zenith')
  assert.equal(second.seasons[0].episodes[0].item.id, 'old')
})
