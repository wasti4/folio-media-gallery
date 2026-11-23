import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { convertiblePhotos, extension, matchingTrackKind, trackKind } from '../shared/formats.mjs'
import { normalizeLanguage, translate } from '../shared/locale.mjs'
import { isAssetName } from './media-storage.mjs'

export { matchingTrackKind } from '../shared/formats.mjs'

const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32)
const safeInput = ['-protocol_whitelist', 'file,pipe']
const textSubtitles = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text'])
const directExtensions = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv'])
const browserPhotos = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif'])
const previewKey = (item, full) => [item.id, item.modifiedAt, item.size, full].join('-')

const seconds = value => Number(value.toFixed(4)).toString()
const input = (file, start) => [
  '-readrate', '2', '-readrate_initial_burst', '5',
  ...safeInput, ...(start > 0 ? ['-ss', seconds(start)] : []), '-i', file,
]

export function buildStreamArgs({
  videoPath, videoIndex = 0, audioIndex, externalAudio, subtitleFile, start = 0, duration = 0,
}) {
  const audioMap = externalAudio ? '1:a:0' : audioIndex === undefined ? '0:a:0?' : '0:' + audioIndex
  const filters = ['scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2']
  if (subtitleFile) {
    if (start > 0) filters.push('setpts=PTS+' + seconds(start) + '/TB')
    filters.push('ass=' + subtitleFile)
    if (start > 0) filters.push('setpts=PTS-' + seconds(start) + '/TB')
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...input(videoPath, start),
    ...(externalAudio ? input(externalAudio, start) : []),
    '-map', '0:' + videoIndex,
    ...(externalAudio || audioIndex !== null ? [
      '-map', audioMap, '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0' + (externalAudio ? ',apad' : ''),
    ] : ['-an']),
    '-vf', filters.join(','), '-filter_threads', '2', '-c:v', 'libx264', '-threads', '4',
    '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*1.5)',
    ...(duration > start ? ['-t', seconds(duration - start)] : externalAudio ? ['-shortest'] : []),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+skip_trailer',
    '-frag_duration', '750000', '-f', 'mp4', 'pipe:1',
  ]
}

function streamTitle(stream, fallback, languageNames) {
  const tag = stream.tags?.language
  let language = ''
  if (tag && tag !== 'und') {
    try { language = languageNames.of(tag) || tag } catch { language = tag }
  }
  return [stream.tags?.title || language || fallback, (stream.codec_name || '').toUpperCase()].filter(Boolean).join(' · ')
}

function directVideo(ext, video, audio) {
  if (['mp4', 'm4v', 'mov'].includes(ext)) {
    return video?.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(video.pix_fmt) &&
      (!audio || ['aac', 'mp3'].includes(audio.codec_name))
  }
  if (ext === 'webm') {
    return ['vp8', 'vp9', 'av1'].includes(video?.codec_name) && (!audio || ['opus', 'vorbis'].includes(audio.codec_name))
  }
  return ext === 'ogv' && video?.codec_name === 'theora'
}

function textFromFile(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer)
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1251').decode(buffer)
  }
}

async function writeSubtitle(target, contents) {
  const temporary = target + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, target).catch(error => { if (!existsSync(target)) throw error })
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export function resolveTool(name, resources = '') {
  const filename = name + (process.platform === 'win32' ? '.exe' : '')
  const candidates = [process.env.FOLIO_FFMPEG_DIR, resources && path.join(resources, 'ffmpeg')].filter(Boolean)
  return candidates.map(dir => path.resolve(dir, filename)).find(file => existsSync(file)) ?? name
}

export class Playback {
  constructor(library, cache, resources) {
    this.library = library
    this.cache = cache
    this.ffmpeg = resolveTool('ffmpeg', resources)
    this.ffprobe = resolveTool('ffprobe', resources)
    this.probes = new Map()
    this.previews = new Map()
    this.queue = []
    this.runningPreviews = 0
    this.streams = new Map()
  }

  video(id) {
    const item = this.library.file(id)
    if (!item || item.kind !== 'video') throw new Error('Видеофайл недоступен.')
    return item
  }

  externalId(file) {
    const stored = path.relative(this.library.mediaRoot, file).split(path.sep).join('/')
    return 'external-' + hash(isAssetName(stored) ? stored : file)
  }

  async metadata(item) {
    const details = await stat(item.file).catch(() => null)
    if (!details?.isFile()) throw new Error('Файл недоступен. Проверьте подключение папки.')
    const key = [item.file, details.mtimeMs, details.size].join('|')
    if (!this.probes.has(key)) {
      const request = exec(this.ffprobe, [
        '-v', 'error', ...safeInput, '-show_streams', '-show_format', '-of', 'json', item.file,
      ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 20000 })
        .then(({ stdout }) => JSON.parse(stdout))
        .catch(error => {
          this.probes.delete(key)
          if (error.code === 'ENOENT' && directExtensions.has(item.ext)) return null
          if (error.code === 'ENOENT') throw new Error('Для этого формата требуется FFmpeg с FFprobe.')
          throw new Error('Не удалось прочитать видео. Проверьте формат и целостность файла.')
        })
      if (this.probes.size >= 128) this.probes.delete(this.probes.keys().next().value)
      this.probes.set(key, request)
    }
    return this.probes.get(key)
  }

  async tracks(item) {
    const inspected = await this.metadata(item)
    const streams = inspected?.streams || []
    const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
    if (inspected && !video) throw new Error('В файле нет видеодорожки.')
    const audio = streams.filter(stream => stream.codec_type === 'audio')
    const subs = streams.filter(stream => stream.codec_type === 'subtitle' && textSubtitles.has(stream.codec_name))
    const defaultAudio = audio.find(stream => stream.disposition?.default) || audio[0]
    const locale = normalizeLanguage(this.library.language)
    const languageNames = new Intl.DisplayNames([locale], { type: 'language' })
    const entries = item.stored || (item.demo && !this.library.demoPath) ? [] :
      await readdir(path.dirname(item.file), { withFileTypes: true }).catch(() => [])
    const files = new Map(this.library.externalTrackOptions(item.id).map(track => [track.file, track.label]))
    for (const entry of entries) {
      if (entry.isFile() && matchingTrackKind(item.filename, entry.name)) files.set(path.join(path.dirname(item.file), entry.name), entry.name)
    }

    const extra = []
    for (const [file, label] of files) {
      const kind = trackKind(file)
      if (!kind || !(await stat(file).catch(() => null))?.isFile()) continue
      extra.push({ id: this.externalId(file), label, kind, file, external: true })
    }
    return {
      duration: Math.max(0, Number(video?.duration || inspected?.format?.duration) || 0),
      width: video?.width, height: video?.height,
      videoIndex: video?.index,
      defaultAudio: defaultAudio?.index ?? null,
      direct: inspected ? directVideo(item.ext, video, defaultAudio) : true,
      audio: [
        ...audio.map((stream, index) => ({ id: 'audio-' + stream.index, index: stream.index,
          label: streamTitle(stream, translate(locale, 'Дорожка {number}', { number: index + 1 }), languageNames) })),
        ...extra.filter(option => option.kind === 'audio'),
      ],
      subtitles: [
        ...subs.map((stream, index) => ({ id: 'subtitle-' + stream.index, index: stream.index,
          label: streamTitle(stream, translate(locale, 'Субтитры {number}', { number: index + 1 }), languageNames) })),
        ...extra.filter(option => option.kind === 'subtitle'),
      ],
    }
  }

  async inspect(id) {
    const { width, height, duration, audio, subtitles, defaultAudio } = await this.tracks(this.video(id))
    const views = options => options.map(({ id: key, label, external }) => ({ id: key, label, external: Boolean(external) }))
    return { width, height, duration, audio: views(audio), subtitles: views(subtitles),
      defaultAudio: defaultAudio === null ? audio[0]?.id ?? '' : 'audio-' + defaultAudio }
  }

  async attach(id, file, kind) {
    this.video(id)
    if (trackKind(file) !== kind) throw new Error('Выберите файл подходящего формата.')
    const [stored] = await this.library.rememberTracks(id, [file])
    return { info: await this.inspect(id), id: this.externalId(stored) }
  }

  async subtitleAsset(item, track) {
    if (!track) return null
    const details = await stat(track.file || item.file)
    const name = 'sub-' + hash([item.file, track.id, details.mtimeMs, details.size].join('|')) + '.ass'
    const target = path.join(this.cache, name)
    if (existsSync(target)) return name
    await mkdir(this.cache, { recursive: true })
    let source
    try {
      if (track.file) {
        if (details.size > 16 * 1024 * 1024) throw new Error('Размер субтитров превышает 16 МБ.')
        const contents = textFromFile(await readFile(track.file))
        if (['ass', 'ssa'].includes(extension(track.file))) {
          if (!contents.includes('[Events]')) throw new Error('Проверьте формат файла субтитров.')
          await writeSubtitle(target, contents)
          return name
        }
        source = path.join(this.cache, randomUUID() + '.' + extension(track.file))
        await writeFile(source, contents, 'utf8')
      }
      const { stdout } = await exec(this.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', ...safeInput, '-i', source || item.file,
        '-map', source ? '0:s:0' : '0:' + track.index, '-c:s', 'ass', '-f', 'ass', 'pipe:1',
      ], { windowsHide: true, timeout: 25000, maxBuffer: 24 * 1024 * 1024 })
      await writeSubtitle(target, stdout)
      return name
    } finally {
      if (source) await rm(source, { force: true }).catch(() => {})
    }
  }

  async open(id, { audioId = '', subtitleId = '', start = 0, forceCompatible = false } = {}) {
    const item = this.video(id)
    const info = await this.tracks(item)
    const audio = audioId ? info.audio.find(option => option.id === audioId) : info.defaultAudio === null ? info.audio[0] : null
    const subtitle = subtitleId ? info.subtitles.find(option => option.id === subtitleId) : null
    if ((audioId && !audio) || (subtitleId && !subtitle)) throw new Error('Выбранная дорожка недоступна.')
    const localDefault = !audio || (!audio.external && audio.index === info.defaultAudio)
    if (!forceCompatible && localDefault && !subtitle && info.direct && info.audio.filter(track => !track.external).length <= 1) {
      return { url: '/~file/' + id, mode: 'direct', offset: 0 }
    }
    const offset = Math.max(0, Math.min(Number(start) || 0, info.duration ? Math.max(0, info.duration - 0.12) : 24 * 60 * 60))
    const subtitleFile = await this.subtitleAsset(item, subtitle).catch(error => {
      if (error.message.startsWith('Размер') || error.message.startsWith('Проверьте')) throw error
      throw new Error('Не удалось подготовить субтитры. Проверьте выбранный файл.')
    })
    if (info.videoIndex === undefined) throw new Error('Для выбора дорожек требуется FFmpeg с FFprobe.')
    const args = buildStreamArgs({
      videoPath: item.file, videoIndex: info.videoIndex, audioIndex: audio?.index ?? info.defaultAudio,
      externalAudio: audio?.file, subtitleFile, start: offset, duration: info.duration,
    })
    return this.openStream(args, offset)
  }

  openStream(args, offset = 0) {
    while (this.streams.size >= 12) this.release(this.streams.keys().next().value)
    const token = randomUUID()
    this.streams.set(token, { args, children: new Set() })
    return { url: '/~stream/' + token, mode: 'stream', offset, token }
  }

  stream(token, request) {
    const session = this.streams.get(token)
    if (!session) return new Response(null, { status: 404 })
    const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' }
    if (request.method === 'HEAD') return new Response(null, { headers })
    const child = spawn(this.ffmpeg, session.args, {
      cwd: this.cache, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    session.children.add(child)
    let diagnostics = ''
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000) })
    child.on('error', error => { child.stdout.destroy(error) })
    const abort = () => child.kill()
    request.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('close', abort)
    child.on('close', code => {
      request.signal.removeEventListener('abort', abort)
      session.children.delete(child)
      if (code && diagnostics && process.env.FOLIO_DEBUG) console.error(diagnostics)
    })
    return new Response(Readable.toWeb(child.stdout), { headers })
  }

  release(token) {
    const session = this.streams.get(token)
    for (const child of session?.children || []) child.kill()
    this.streams.delete(token)
  }

  close() {
    for (const token of this.streams.keys()) this.release(token)
  }

  preview(item, full = false) {
    if (item.demo) return Promise.resolve(path.join(this.library.demoPath, item.poster))
    // Small browser-readable originals cost less to display than a separate FFmpeg thumbnail.
    if (!full && item.kind === 'photo' && item.size <= 16 * 1024 && browserPhotos.has(item.ext)) return Promise.resolve(item.file)
    const key = previewKey(item, full)
    if (!this.previews.has(key)) {
      const work = new Promise((resolve, reject) => {
        this.queue.push(() => this.makePreview(item, key, full).then(resolve, reject))
        this.drainPreviews()
      })
      this.previews.set(key, work)
      if (this.previews.size > 400) this.previews.delete(this.previews.keys().next().value)
    }
    return this.previews.get(key)
  }

  forgetPreview(item) {
    for (const full of [false, true]) {
      const key = previewKey(item, full)
      const pending = this.previews.get(key)
      this.previews.delete(key)
      const file = path.join(this.cache, hash(key) + '.jpg')
      Promise.resolve(pending).catch(() => {}).then(() => rm(file, { force: true })).catch(() => {})
    }
  }

  drainPreviews() {
    while (this.runningPreviews < 3 && this.queue.length) {
      this.runningPreviews += 1
      this.queue.shift()().finally(() => {
        this.runningPreviews -= 1
        this.drainPreviews()
      })
    }
  }

  async makePreview(item, key, full) {
    const target = path.join(this.cache, hash(key) + '.jpg')
    if (existsSync(target)) return target
    await mkdir(this.cache, { recursive: true })
    const temporary = path.join(this.cache, randomUUID() + '.jpg')
    try {
      await exec(this.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
        ...safeInput, '-i', item.file, '-map', '0:V:0', '-frames:v', '1',
        ...(!full ? ['-vf', 'scale=w=min(640\\,iw):h=-2'] : []),
        '-threads', '1', '-q:v', '3', '-update', '1', temporary,
      ], { windowsHide: true, timeout: 15000 })
      await rename(temporary, target)
      return target
    } catch (error) {
      if (item.kind !== 'video' && !convertiblePhotos.has(item.ext)) return item.file
      throw error
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
