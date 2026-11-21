import { demoFolders, demoItems } from '../shared/demo.mjs'
import { audioExtensions, extension, mediaExtensions, mediaKind, subtitleExtensions } from '../shared/formats.mjs'
import { translate } from '../shared/locale.mjs'

export const demoAsset = name => (import.meta.env?.BASE_URL ?? '/') + 'demo/' + name
export const isDesktop = Boolean(window.luma)

const browse = (extensions, directory = false, multiple = true) => new Promise(resolve => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = multiple
  input.hidden = true
  if (directory) input.webkitdirectory = true
  else input.accept = extensions.map(ext => '.' + ext).join(',')
  document.body.append(input)
  function finish(files) {
    input.remove()
    resolve(files)
  }
  input.addEventListener('change', () => finish([...input.files]), { once: true })
  input.addEventListener('cancel', () => finish([]), { once: true })
  input.click()
})

export function setting(key, fallback) {
  try { return JSON.parse(localStorage.getItem('luma-' + key)) ?? fallback } catch { return fallback }
}

export function saveSetting(key, value) {
  try { localStorage.setItem('luma-' + key, JSON.stringify(value)) } catch { /* Storage is optional in preview. */ }
}

const pickerOptions = {
  audio: audioExtensions,
  subtitle: subtitleExtensions,
}

function vttTime(assTime) {
  const [hours, minutes, seconds] = assTime.trim().split(':')
  return hours.padStart(2, '0') + ':' + minutes + ':' + seconds.padEnd(6, '0')
}

async function browserSubtitles(file) {
  const bytes = await file.arrayBuffer()
  let type = 'utf-8'
  try { new TextDecoder(type, { fatal: true }).decode(bytes) } catch { type = 'windows-1251' }
  const source = new TextDecoder(type).decode(bytes)
  const ext = extension(file.name)
  if (ext === 'vtt') return source
  const text = ext === 'srt' ? source.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2') :
    source.split(/\r?\n/).filter(line => line.startsWith('Dialogue:')).map(line => {
      const [, from, to, ...fields] = line.split(',')
      const caption = fields.slice(6).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n')
      return vttTime(from) + ' --> ' + vttTime(to) + '\n' + caption
    }).join('\n\n')
  return 'WEBVTT\n\n' + text
}

function browserApi() {
  const t = message => translate(document.documentElement.lang, message)
  const preferences = setting('preview-library', { favorite: {}, recent: {}, collections: [] })
  const local = new Map()
  const selected = new Map()
  let sources = 0
  const persist = () => saveSetting('preview-library', preferences)
  const demo = demoItems.map(item => ({
    ...item, url: demoAsset(item.filename), viewUrl: demoAsset(item.filename), preview: demoAsset(item.poster),
  }))
  const find = id => local.get(id) || demo.find(item => item.id === id)

  function state() {
    const items = local.size ? [...local.values()] : demo
    const folders = local.size ? [...new Map(items.map(item => [
      item.folderId, { id: item.folderId, name: item.folderName, kind: 'physical' },
    ])).values()] : demoFolders
    return {
      demo: !local.size, sources, folders: [...folders, ...preferences.collections],
      items: items.map(item => ({
        ...item, favorite: Boolean(preferences.favorite[item.id]), openedAt: preferences.recent[item.id] || 0,
      })),
    }
  }

  function drop(files) {
    let added = 0
    for (const file of files) {
      const kind = mediaKind(file.name)
      if (!kind) continue
      const relative = file.webkitRelativePath || file.name
      const parts = relative.split('/')
      const id = 'web-' + relative + '-' + file.size + '-' + file.lastModified
      if (local.has(id)) continue
      const url = URL.createObjectURL(file)
      local.set(id, {
        id, filename: file.name, name: file.name.replace(/\.[^.]+$/, ''),
        kind, ext: extension(file.name), size: file.size, modifiedAt: file.lastModified,
        folderName: parts.length > 1 ? parts.at(-2) : 'Импортированные файлы',
        folderId: 'web-folder-' + parts.slice(0, -1).join('/'),
        url, viewUrl: url, preview: kind === 'video' ? '' : url,
      })
      added += 1
    }
    return { state: state(), added, skipped: 0 }
  }

  function tracks(id) {
    const list = selected.get(id) || []
    if (id !== 'demo-dolomites') return list
    return [
      { id: 'demo-wave-audio', label: t('Звук озера'), kind: 'audio', external: true, url: demoAsset('dolomites.ambient.m4a') },
      { id: 'demo-ru', label: t('Русские субтитры'), kind: 'subtitle', external: true, url: demoAsset('captions/dolomites.ru.vtt') },
      ...list,
    ]
  }

  function inspect(id) {
    const extra = tracks(id)
    return {
      duration: find(id)?.duration || 0,
      audio: [{ id: 'original', label: t('Оригинальный звук') }, ...extra.filter(track => track.kind === 'audio')],
      subtitles: extra.filter(track => track.kind === 'subtitle'),
      defaultAudio: 'original',
    }
  }

  return {
    state,
    drop,
    async import(kind) {
      const files = await browse(mediaExtensions, kind === 'folder')
      if (!files.length) return null
      if (kind === 'folder') sources += 1
      return drop(files)
    },
    refresh: () => ({ state: state(), skipped: 0 }),
    favorite(id) {
      preferences.favorite[id] = !preferences.favorite[id]
      persist()
      return state()
    },
    opened(id) {
      const time = Date.now()
      preferences.recent[id] = time
      persist()
      return time
    },
    createCollection(name) {
      const id = 'collection-' + crypto.randomUUID()
      preferences.collections.push({ id, name, kind: 'collection', members: [] })
      persist()
      return { id, state: state() }
    },
    toggleCollection(id, member) {
      const collection = preferences.collections.find(item => item.id === id)
      if (collection) {
        collection.members = collection.members.includes(member) ?
          collection.members.filter(item => item !== member) : [...collection.members, member]
        persist()
      }
      return state()
    },
    removeCollection(id) {
      preferences.collections = preferences.collections.filter(item => item.id !== id)
      persist()
      return state()
    },
    inspect,
    play(id, options) {
      const extra = tracks(id)
      return {
        mode: 'direct', offset: 0, url: find(id)?.url,
        audioUrl: extra.find(track => track.id === options.audioId)?.url,
        subtitleUrl: extra.find(track => track.id === options.subtitleId)?.url,
      }
    },
    release() {},
    async attach(id, kind) {
      const [file] = await browse(pickerOptions[kind], false, false)
      if (!file) return null
      const data = kind === 'subtitle' ? new Blob([await browserSubtitles(file)], { type: 'text/vtt' }) : file
      const key = crypto.randomUUID()
      const option = { id: key, kind, label: file.name, external: true, url: URL.createObjectURL(data) }
      selected.set(id, [...(selected.get(id) || []), option])
      return { id: key, info: inspect(id) }
    },
  }
}

export const mediaApi = window.luma ?? browserApi()
