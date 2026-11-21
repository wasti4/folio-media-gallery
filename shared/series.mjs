import { extension, mediaKind } from './formats.mjs'

const layoutFolder = /^(?:anime|series|shows?|videos?|video files?|episodes?|mkv|mp4|bdrip|downloads?|imported files|видео(?: файлы)?|сериалы|аниме|серии|эпизоды|импортированные файлы|загрузки|剧集|动画|视频|正片|导入的文件)$/iu
const specialsFolder = /^(?:ova|oad|ona|specials?|bonus|спецвыпуски|特别篇|特典)$/iu
const extras = /^(?:.*[ ._-])?(?:ncop|nced|op|ed)(?:[ ._-]*\d{1,2})?$/iu
const number = '(?<episode>\\d{1,4}(?:[.,]\\d{1,2}(?!\\d))?)'
const end = '(?:v\\d+)?(?=$|[^\\p{L}\\p{N}])'
const boundary = '(?:^|[^\\p{L}\\p{N}])'
const separator = '[ ._#-]*'
const episodeMarkers = '(?:e(?:p(?:isode)?)?|серия|эпизод|эп)'
const specs = [
  { pattern: new RegExp(boundary + '(?:s(?:eason)?|сезон)' + separator + '(?<season>\\d{1,2})' + separator + episodeMarkers + separator + number + end, 'iu') },
  { pattern: new RegExp(boundary + '(?<season>\\d{1,2})x' + number + end, 'iu') },
  { pattern: new RegExp(boundary + '(?:ova|oad|ona|sp(?:ecial)?|спецвыпуск)' + separator + number + end, 'iu'), special: true },
  { pattern: new RegExp(boundary + episodeMarkers + separator + number + end, 'iu') },
  { pattern: new RegExp('第\\s*' + number + '\\s*[话話集]', 'iu') },
  { pattern: new RegExp('(?:^|[ ._])[-–—][ ._]*' + number + end, 'iu') },
  { pattern: new RegExp('^' + number + end, 'iu'), implicit: true },
  { pattern: new RegExp('[ ._–—-]+' + number + '(?:v\\d+)?$', 'iu'), implicit: true },
]

function cleanTitle(value) {
  return value.replace(/[._]+/g, ' ').replace(/^[\s\-–—]+|[\s\-–—]+$/gu, '').replace(/\s+/gu, ' ')
}

function stripTags(value) {
  return value.normalize('NFKC').replace(/\[([^\]]*)\]|\(([^)]*)\)/gu, (_, square, round) => {
    const tag = (square ?? round).trim()
    return /^(?:(?:s\d{1,2})?e)?\d{1,4}(?:[.,]\d{1,2})?(?:v\d+)?$/iu.test(tag) ? ' ' + tag + ' ' : ' '
  }).trim()
}

function titleFolder(directory) {
  const parts = directory.split(/[\\/]+/).filter(Boolean)
  let season
  for (let index = parts.length - 1; index >= 0; index--) {
    const folder = parts[index].normalize('NFKC')
    const name = cleanTitle(stripTags(folder))
    if (layoutFolder.test(name)) continue
    if (specialsFolder.test(name)) {
      season ??= 0
      continue
    }
    const seasonName = /^(?:(.*?)[ ._-]+)?(?:s(?:eason)?|сезон)[ ._-]*(\d{1,2})$/iu.exec(name) ||
      /^(.*?)\s*第\s*(\d{1,2})\s*季$/u.exec(name) ||
      /^(.*?)\s+(\d{1,2})(?:st|nd|rd|th)\s+season$/iu.exec(name) ||
      /^(?:(.*?)\s+)?(\d{1,2})(?:-й)?\s+сезон$/iu.exec(name)
    if (seasonName) {
      season ??= Number(seasonName[2])
      if (!seasonName[1]) continue
      const title = cleanTitle(seasonName[1])
      return { title, season, anchor: [...parts.slice(0, index), title].join('/') }
    }
    if (/^[a-z]:$/iu.test(name)) break
    if (name) return { title: name, season, anchor: [...parts.slice(0, index), name].join('/') }
  }
  return { title: '', season, anchor: directory }
}

export function describeSeriesEpisode(filename, directory = '', makeKey = value => value) {
  if (mediaKind(filename) !== 'video') return null
  const basename = stripTags(filename.slice(0, -(extension(filename).length + 1)))
  if (extras.test(basename)) return null
  const matched = specs.map(spec => ({ ...spec, match: spec.pattern.exec(basename) })).find(spec => spec.match)
  if (!matched) return null
  const { match, implicit, special } = matched
  const episode = Number(match.groups.episode.replace(',', '.'))
  if (implicit && episode >= 1900 && episode <= 2099) return null

  const folder = titleFolder(directory)
  const named = cleanTitle(basename.slice(0, match.index))
  const title = named || folder.title
  if (!title) return null
  const season = special ? 0 : Number(match.groups.season ?? folder.season ?? 1)
  const anchor = folder.anchor.replaceAll('\\', '/').normalize('NFKC').toLowerCase()
  const key = makeKey(anchor + '|' + title.normalize('NFKC').toLowerCase())
  return { key, title, season, episode }
}

export function groupSeries(items, language) {
  const compare = new Intl.Collator(language, { numeric: true, sensitivity: 'base' }).compare
  const groups = new Map()
  for (const item of items) {
    if (item.kind !== 'video') continue
    const info = item.series ?? describeSeriesEpisode(item.filename, item.folderName)
    if (!info?.key) continue
    if (!groups.has(info.key)) groups.set(info.key, { key: info.key, title: info.title, seasons: new Map() })
    const { seasons } = groups.get(info.key)
    if (!seasons.has(info.season)) seasons.set(info.season, [])
    seasons.get(info.season).push({ item, number: info.episode })
  }
  return [...groups.values()].sort((a, b) => compare(a.title, b.title) || compare(a.key, b.key)).map(({ key, title, seasons }) => ({
    key, title,
    seasons: [...seasons].sort(([a], [b]) => a - b).map(([number, episodes]) => ({
      number, episodes: episodes.sort((a, b) => a.number - b.number || compare(a.item.name, b.item.name) || compare(a.item.id, b.item.id)),
    })),
  }))
}
