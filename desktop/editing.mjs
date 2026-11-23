import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { hasCrop, limit, newEdit, normalizeEdit } from '../shared/edits.mjs'
import { hasPhotoTone, luminanceWeights, photoLookup, sharpWeight } from '../shared/photo-look.mjs'

const exec = promisify(execFile)
const baseArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '2']
const decimal = value => Number(value.toFixed(6)).toString()
const scaleTo = (width, height) => 'scale=w=min(' + width + '\\,iw):h=min(' + height + '\\,ih):force_original_aspect_ratio=decrease'
const evenVideo = 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p'

function sourceArgs(file, at = 0) {
  return ['-protocol_whitelist', 'file,pipe', '-threads', '2', ...(at > 0 ? ['-ss', decimal(at)] : []), '-i', file]
}

function looksEdited(edit, { crop = true, preview = false, video = false, squarePixels = false } = {}) {
  const filters = []
  if (squarePixels) filters.push('scale=w=max(1\\,round(iw*sar)):h=ih', 'setsar=1')
  if (edit.rotation === 1) filters.push('transpose=clock')
  if (edit.rotation === 2) filters.push('hflip', 'vflip')
  if (edit.rotation === 3) filters.push('transpose=cclock')
  if (edit.flipX) filters.push('hflip')
  if (edit.flipY) filters.push('vflip')
  if (crop && hasCrop(edit.crop)) {
    const { x, y, width, height } = edit.crop
    filters.push('crop=w=max(1\\,floor(iw*' + decimal(width) + ')):h=max(1\\,floor(ih*' + decimal(height) +
      ')):x=floor(iw*' + decimal(x) + '):y=floor(ih*' + decimal(y) + '):exact=1')
  }
  if (video && (edit.brightness || edit.contrast || edit.saturation)) {
    filters.push('eq=brightness=' + decimal(edit.brightness / 250) + ':contrast=' + decimal(2 ** (edit.contrast / 100)) +
      ':saturation=' + decimal(1 + edit.saturation / 100))
  }
  if (video && edit.sharpness) filters.push('unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=' + decimal(edit.sharpness / 55))
  if (preview) filters.push(scaleTo(1152, 900))
  return filters
}

function photoFilters(edit, lut) {
  const filters = []
  if (edit.sharpness || edit.saturation || lut) filters.push('format=gbrap')
  if (edit.sharpness) {
    const strength = Math.round(sharpWeight(edit.sharpness) * 256)
    const kernel = [0, -strength, 0, -strength, 256 + 4 * strength, -strength, 0, -strength, 0].join(' ')
    filters.push('convolution=' + [0, 1, 2].map(channel => channel + 'm=' + kernel + ':' + channel + 'rdiv=0.00390625').join(':'))
  }
  if (edit.saturation) {
    const scale = 1 + edit.saturation / 100
    const matrix = ['r', 'g', 'b'].flatMap((row, channel) => ['r', 'g', 'b'].map((column, index) =>
      row + column + '=' + decimal((1 - scale) * luminanceWeights[index] + (channel === index ? scale : 0))))
    filters.push('colorchannelmixer=' + matrix.join(':'))
  }
  if (lut) filters.push('lut1d=file=photo-look.cube:interp=nearest')
  return filters
}

function photoCube(edit) {
  const table = photoLookup(edit)
  const value = index => Math.min(1, (table[index] + 0.25) / 255).toFixed(8)
  const rows = ['LUT_1D_SIZE 256']
  for (let index = 0; index < table.length; index += 4) rows.push(value(index) + ' ' + value(index + 1) + ' ' + value(index + 2))
  return rows.join('\n') + '\n'
}

function toolError(error, fallback) {
  if (error.code === 'ENOENT') return new Error('Для этого формата требуется FFmpeg с FFprobe.')
  if (/no space left|not enough space|disk is full/i.test(error.stderr || error.message)) return new Error('Недостаточно места на диске.')
  if (process.env.FOLIO_DEBUG && error.stderr) console.error(String(error.stderr).slice(-2000))
  return new Error(fallback)
}

function runExport(tool, args, duration, cwd, signal, notify) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let failure, diagnostics = '', unfinished = ''
    let lastUpdate = 0
    child.on('error', error => { failure = error })
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000) })
    child.stdout.on('data', chunk => {
      const lines = (unfinished + chunk).split('\n')
      unfinished = lines.pop()
      for (const line of lines) {
        if (!duration || !line.startsWith('out_time_us=')) continue
        const now = Date.now()
        const seconds = Number(line.slice('out_time_us='.length)) / 1000000
        if (!Number.isFinite(seconds) || now - lastUpdate < 150) continue
        lastUpdate = now
        notify(Math.max(0, Math.min(0.99, seconds / duration)))
      }
    })
    child.on('close', code => {
      if (signal.aborted) reject(signal.reason)
      else if (failure || code !== 0) reject(Object.assign(failure || new Error('FFmpeg ' + code), { stderr: diagnostics }))
      else resolve()
    })
  })
}

const wallpaperScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Folio -Name DesktopWallpaper -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="SystemParametersInfoW", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
[return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
public static extern bool Set(uint action, uint param, string file, uint flags);
'@
if (-not [Folio.DesktopWallpaper]::Set(20, 0, $env:FOLIO_WALLPAPER_FILE, 3)) {
  throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
`

export class MediaEditor {
  constructor(library, playback, profile) {
    this.library = library
    this.playback = playback
    this.profile = profile
    this.frames = new Map()
    this.frameRequest = null
    this.saving = null
  }

  async source(id) {
    const item = this.library.file(id)
    if (!item || !['photo', 'video'].includes(item.kind)) throw new Error('Этот файл нельзя редактировать.')
    const video = item.kind === 'video'
    const inspected = await this.playback.metadata(item)
    const stream = inspected?.streams?.find(entry => entry.codec_type === 'video' && !entry.disposition?.attached_pic)
    if (!stream) throw new Error('Не удалось прочитать медиафайл.')
    const [numerator, denominator] = (stream.sample_aspect_ratio || '1:1').split(':').map(Number)
    const squarePixels = numerator > 0 && denominator > 0 && numerator !== denominator
    const sideways = stream.side_data_list?.some(entry => Math.abs(Number(entry.rotation)) % 180 === 90)
    const width = Math.round(stream.width * (squarePixels ? numerator / denominator : 1))
    const duration = [stream.duration, inspected.format?.duration, item.duration].map(Number)
      .find(seconds => Number.isFinite(seconds) && seconds > 0) || 0
    return {
      item, video, squarePixels, stream: stream.index, width: sideways ? stream.height : width,
      height: sideways ? width : stream.height, duration: video ? duration : 0,
    }
  }

  async inspect(id) {
    const { width, height, duration } = await this.source(id)
    return { width, height, duration }
  }

  stopPreview() {
    this.frameRequest?.abort()
    this.frameRequest = null
  }

  async frame(id, options) {
    this.stopPreview()
    const controller = new AbortController()
    this.frameRequest = controller
    const { signal } = controller
    try {
      const source = await this.source(id)
      signal.throwIfAborted()
      const edit = options?.original === true ? newEdit(source.duration) : normalizeEdit(options?.edit, source.duration)
      const at = limit(options?.at, 0, Math.max(0, source.duration - 0.06))
      const filters = looksEdited(edit, { ...source, crop: options?.unframed !== true, preview: true })
      const key = createHash('sha256').update(JSON.stringify([id, source.item.modifiedAt, at, filters])).digest('hex').slice(0, 32)
      if (!this.frames.has(key)) {
        const { stdout } = await exec(this.playback.ffmpeg, [
          ...baseArgs, ...sourceArgs(source.item.file, at), '-map', '0:' + source.stream, '-vf', filters.join(','),
          '-frames:v', '1', '-c:v', 'png', '-threads', '1', '-f', 'image2pipe', 'pipe:1',
        ], { encoding: 'buffer', windowsHide: true, timeout: 22000, maxBuffer: 9 * 1024 * 1024, signal })
        if (!stdout.length) throw new Error('No frame available')
        signal.throwIfAborted()
        this.frames.set(key, stdout)
        while (this.frames.size > 5) this.frames.delete(this.frames.keys().next().value)
      }
      return '/~edit-frame/' + key
    } catch (error) {
      if (signal.aborted) return null
      throw toolError(error, 'Не удалось подготовить предпросмотр.')
    } finally {
      if (this.frameRequest === controller) this.frameRequest = null
    }
  }

  renderFrame(key, request) {
    const image = this.frames.get(key)
    if (!image) return new Response(null, { status: 404 })
    return new Response(request.method === 'HEAD' ? null : image, { headers: {
      'Content-Type': 'image/png', 'Content-Length': String(image.length), 'Cache-Control': 'private, max-age=60',
    } })
  }

  async clip(id, input) {
    const source = await this.source(id)
    if (!source.video) throw new Error('Видеофайл недоступен.')
    const edit = normalizeEdit(input, source.duration)
    const filters = [...looksEdited(edit, { ...source, preview: true }), evenVideo]
    return this.playback.openStream([
      ...baseArgs, '-readrate', '2', '-readrate_initial_burst', '2', ...sourceArgs(source.item.file, edit.start),
      '-map', '0:' + source.stream, '-map', '0:a:0?', '-vf', filters.join(','),
      ...(edit.end > edit.start ? ['-t', decimal(edit.end - edit.start)] : []),
      '-c:v', 'libx264', '-threads', '3', '-preset', 'ultrafast', '-crf', '23', '-tune', 'zerolatency',
      '-c:a', 'aac', '-ac', '2', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+skip_trailer',
      '-frag_duration', '650000', '-f', 'mp4', 'pipe:1',
    ], edit.start)
  }

  async save(id, input, progress = () => {}) {
    if (this.saving) throw new Error('Копия уже сохраняется.')
    this.stopPreview()
    const controller = new AbortController()
    this.saving = controller
    const { signal } = controller
    try {
      const source = await this.source(id)
      const edit = normalizeEdit(input, source.duration)
      const filters = looksEdited(edit, source)
      const lut = !source.video && hasPhotoTone(edit)
      if (source.video) filters.push(evenVideo)
      else filters.push(...photoFilters(edit, lut))
      const duration = edit.end - edit.start
      return await this.library.keepEdit(source.item, source.video ? 'mp4' : 'png', async file => {
        signal.throwIfAborted()
        const cwd = path.dirname(file)
        const cube = path.join(cwd, 'photo-look.cube')
        try {
          if (lut) await writeFile(cube, photoCube(edit), { encoding: 'utf8', flag: 'wx' })
          await runExport(this.playback.ffmpeg, [
          ...baseArgs, '-nostats', '-progress', 'pipe:1', ...sourceArgs(source.item.file, edit.start),
          '-map', '0:' + source.stream, '-map_metadata', '-1',
          ...(filters.length ? ['-vf', filters.join(',')] : []),
          ...(source.video ? [
            '-map', '0:a?', ...(duration > 0 ? ['-t', decimal(duration)] : []),
            '-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '19',
            '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
          ] : ['-frames:v', '1', '-c:v', 'png', '-threads', '2', '-pix_fmt', 'rgba', '-update', '1']),
          '-n', file,
          ], duration, cwd, signal, progress)
        } finally {
          if (lut) await rm(cube, { force: true }).catch(() => {})
        }
      }, signal)
    } catch (error) {
      if (signal.aborted) return null
      throw toolError(error, 'Не удалось сохранить копию.')
    } finally {
      if (this.saving === controller) this.saving = null
    }
  }

  cancelSave() {
    this.saving?.abort()
  }

  close() {
    this.stopPreview()
    this.cancelSave()
    this.frames.clear()
  }

  async prepareWallpaper(id) {
    const item = this.library.file(id)
    if (item?.kind !== 'photo') throw new Error('Для обоев выберите фотографию.')
    const info = await stat(item.file)
    const key = createHash('sha256').update(JSON.stringify([id, info.mtimeMs, info.size])).digest('hex').slice(0, 24)
    const folder = path.join(this.profile, 'Wallpapers')
    await mkdir(folder, { recursive: true })
    const target = path.join(folder, 'Folio-' + key + '.bmp')
    if (await stat(target).then(result => result.isFile() && result.size > 54, () => false)) return target
    const temp = path.join(folder, randomUUID() + '.bmp')
    try {
      await exec(this.playback.ffmpeg, [
        ...baseArgs, ...sourceArgs(item.file), '-map', '0:V:0', '-vf', scaleTo(3840, 3840),
        '-frames:v', '1', '-pix_fmt', 'bgr24', '-update', '1', temp,
      ], { windowsHide: true, timeout: 30000 })
      await rename(temp, target)
      return target
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }

  async setWallpaper(id) {
    if (process.platform !== 'win32') throw new Error('Установка обоев доступна в Windows.')
    const file = await this.prepareWallpaper(id).catch(error => {
      throw toolError(error, 'Не удалось установить обои.')
    })
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try {
      await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', wallpaperScript], {
        windowsHide: true, timeout: 18000, env: { ...process.env, FOLIO_WALLPAPER_FILE: file },
      })
    } catch (error) {
      if (process.env.FOLIO_DEBUG && error.stderr) console.error(String(error.stderr).slice(-2000))
      throw new Error('Не удалось установить обои.')
    }
  }
}
