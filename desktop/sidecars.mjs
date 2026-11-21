import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { mediaKind, trackKind } from '../shared/formats.mjs'
import { backupManifest } from './library-backup.mjs'
import { isWithin } from './media-storage.mjs'

const words = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const folderWords = name => words(name).replace(/^\d+ /, '')
const genericVideo = /^(?:videos?|video files?|episodes?|mkv|mp4|bdrip|видео(?: файлы)?|серии|эпизоды|视频|正片)$/u
const trackFolderWords = '(?:(?:external|ext|внешние) )?(?:audio(?: ?tracks?)?|sound ?tracks?|dubs?|voice ?overs?|sub(?:s|titles?)|captions?|аудио(?: ?дорожки)?|озвучк[аи]|звук(?:овые дорожки)?|дорожки|субтитры|сабы|字幕|音轨|配音)'
const trackFolder = new RegExp('^' + trackFolderWords + '(?: |$)', 'u')
const genericTracks = new RegExp('^' + trackFolderWords + '$', 'u')
const seasonFolder = /^(?:season|s|сезон) ?(\d{1,2})$/u
const seasonOf = name => {
  const match = seasonFolder.exec(words(name)) || /^第(\d{1,2})季$/u.exec(name)
  return match ? Number(match[1]) : null
}
const videoFolder = name => genericVideo.test(folderWords(name)) || seasonOf(name) !== null || /^[1-3]$/.test(name)
const separateSeries = /(?:^|[ ._-])(ova|oad|ona|specials?|ncop|nced|op|ed|sp)(?=[ ._\d-]|$)/u

const number = '(?<episode>\\d{1,4}(?:[.,]\\d{1,2}(?!\\d))?)'
const end = '(?:v\\d+)?(?=$|[^\\p{L}\\p{N}])'
const prefix = '(?:^|[^\\p{L}\\p{N}])'
const episodePatterns = [
  new RegExp(prefix + 's(?:eason)?[ ._-]*(?<season>\\d{1,2})[ ._-]*e(?:p(?:isode)?)?[ ._-]*' + number + end, 'iu'),
  new RegExp(prefix + '(?<season>\\d{1,2})x' + number + end, 'iu'),
  new RegExp(prefix + '(?:e(?:p(?:isode)?)?|серия|эпизод|эп)[ ._#-]*' + number + end, 'iu'),
  new RegExp('第\\s*' + number + '\\s*[话話集]', 'iu'),
  new RegExp('(?:^|[ ._])[-–—][ ._]*' + number + end, 'iu'),
  new RegExp('^' + number + end, 'iu'),
  new RegExp('[ ._-]' + number + '(?:v\\d+)?$', 'iu'),
]

function describe(root, file) {
  const dirs = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)
  const stem = path.parse(file).name.normalize('NFKC').toLowerCase()
  const basename = stem.replace(/\[([^\]]*)\]|\(([^)]*)\)/gu, (_, square, round) => {
    const tag = (square ?? round).trim()
    return /^(?:s\d{1,2}e)?\d{1,4}(?:[.,]\d{1,2})?(?:v\d+)?$/u.test(tag) ? ' ' + tag + ' ' : ' '
  }).trim()
  const matched = episodePatterns.map(pattern => pattern.exec(basename)).find(Boolean)
  const range = matched && /^(?: *[-–—] *| *e)\d/u.test(basename.slice(matched.index + matched[0].length))
  const episode = matched && !range ? Number(matched.groups.episode.replace(',', '.')) : null
  const season = matched?.groups.season === undefined
    ? dirs.map(seasonOf).findLast(value => value !== null) ?? null
    : Number(matched.groups.season)
  const groups = dirs.filter((dir, index) => seasonOf(dir) === null &&
    (index > 0 || (!videoFolder(dir) && !genericTracks.test(folderWords(dir)))))
  const title = matched ? words(basename.slice(0, matched.index)) : ''
  return {
    file, name: words(basename), rawName: words(stem), episode, season, range,
    title: groups.some(group => words(group) === title) ? '' : title,
    special: separateSeries.exec(basename)?.[1] ?? '',
    label: [...groups, path.basename(file)].join(' · ').slice(-255),
  }
}

const prefixed = (title, text) => Boolean(title) && (text === title || text.startsWith(title + ' '))

function score(video, track) {
  if (video.season !== null && track.season !== null && video.season !== track.season) return 0
  if (video.episode !== null && track.episode !== null && video.episode !== track.episode) return 0
  if ((video.range || track.range) && video.rawName !== track.rawName) return 0
  const sameSeason = video.season !== null && video.season === track.season ? 4 : 0
  if (prefixed(video.rawName, track.rawName)) return 30 + sameSeason
  if (prefixed(video.name, track.name)) return 20 + sameSeason
  if (video.episode === null || video.episode !== track.episode || video.special !== track.special) return 0
  const sameTitle = prefixed(video.title, track.title) || prefixed(track.title, video.title)
  if (video.title && track.title && !sameTitle) return 0
  return 10 + sameSeason + (sameTitle ? 1 : 0)
}

function matchBundle(root, { videos, tracks }) {
  const names = new Map()
  const episodes = new Map()
  const matches = new Map()
  function index(map, key, video) {
    if (key === '' || key === null) return
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(video)
  }
  for (const file of videos) {
    const video = describe(root, file)
    index(names, video.name, video)
    index(names, video.rawName, video)
    index(episodes, video.episode, video)
  }
  for (const file of tracks) {
    const track = describe(root, file)
    const candidates = new Set(episodes.get(track.episode))
    for (const name of new Set([track.name, track.rawName])) {
      for (let prefix = name; prefix; prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf(' ')))) {
        for (const video of names.get(prefix) ?? []) candidates.add(video)
      }
    }
    let highest = 0
    let chosen
    for (const video of candidates) {
      const rating = score(video, track)
      if (rating > highest) {
        highest = rating
        chosen = video.file
      } else if (rating === highest) chosen = undefined
    }
    if (!chosen) continue
    if (!matches.has(chosen)) matches.set(chosen, [])
    matches.get(chosen).push({ file, label: track.label })
  }
  return matches
}

export function createSidecarSearch(storage, inventories = new Map()) {
  const known = new Map()
  const nearby = new Map()
  const imported = new Map()
  const empty = new Map()
  const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

  for (const [root, inventory] of inventories) {
    if (!inventory.videos.length || !inventory.tracks.length) continue
    // A fully imported package can have arbitrary folder names. Avoid pooling separate shows.
    const branches = new Set(inventory.videos.map(file => path.relative(root, path.dirname(file)).split(path.sep)[0]))
    if (branches.size !== 1) continue
    for (const [file, tracks] of matchBundle(root, inventory)) {
      if (!imported.has(file)) imported.set(file, [])
      imported.get(file).push(...tracks)
    }
  }

  function list(directory) {
    if (isWithin(storage, directory)) return Promise.resolve([])
    if (!known.has(directory)) {
      known.set(directory, readdir(directory, { withFileTypes: true }).then(entries =>
        entries.some(entry => entry.isFile() && entry.name === backupManifest) ? [] : entries, () => []))
    }
    return known.get(directory)
  }

  async function gather(directory, accepts, files) {
    const pending = [directory]
    while (pending.length) {
      const folder = pending.pop()
      for (const entry of await list(folder)) {
        const file = path.join(folder, entry.name)
        if (entry.isDirectory()) pending.push(file)
        else if (entry.isFile() && accepts(entry.name)) files.push(file)
      }
    }
  }

  async function scan(directory) {
    const entries = await list(directory)
    const dirs = entries.filter(entry => entry.isDirectory())
    const sidecarDirs = dirs.filter(entry => trackFolder.test(folderWords(entry.name)))
    const tracks = entries.filter(entry => entry.isFile() && trackKind(entry.name)).map(entry => path.join(directory, entry.name))
    if (!tracks.length && !sidecarDirs.length) return empty
    const videos = entries.filter(entry => entry.isFile() && mediaKind(entry.name) === 'video').map(entry => path.join(directory, entry.name))
    for (const entry of dirs) {
      const folder = path.join(directory, entry.name)
      if (sidecarDirs.includes(entry)) await gather(folder, trackKind, tracks)
      else if (videoFolder(entry.name)) await gather(folder, name => mediaKind(name) === 'video', videos)
    }
    return matchBundle(directory, { videos, tracks })
  }

  return async file => {
    const candidates = new Map()
    let folder = path.dirname(file)
    // Ascend through layout folders, stopping at the title's own directory.
    for (;;) {
      if (!nearby.has(folder)) nearby.set(folder, scan(folder))
      for (const track of (await nearby.get(folder)).get(file) ?? []) {
        if (!candidates.has(track.file)) candidates.set(track.file, track)
      }
      const parent = path.dirname(folder)
      if (parent === folder || path.dirname(parent) === parent || !videoFolder(path.basename(folder))) break
      folder = parent
    }
    for (const track of imported.get(file) ?? []) {
      if (!candidates.has(track.file)) candidates.set(track.file, track)
    }
    return [...candidates.values()].sort((a, b) => order.compare(a.label, b.label) || order.compare(a.file, b.file))
  }
}
