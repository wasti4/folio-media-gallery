export const photoExtensions = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif']
export const videoExtensions = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'mpeg', 'mpg', 'ts', 'm2ts', 'mts', 'flv', 'ogv', '3gp']
export const audioExtensions = ['mka', 'm4a', 'aac', 'flac', 'mp3', 'wav', 'ac3', 'eac3', 'opus', 'ogg', 'wma', 'aiff', 'dts']
export const subtitleExtensions = ['srt', 'ass', 'ssa', 'vtt']
export const mediaExtensions = [...photoExtensions, ...videoExtensions, 'gif']
export const convertiblePhotos = new Set(['tif', 'tiff', 'heic', 'heif'])

export function extension(filename) {
  return (/\.([^.\/\\]+)$/.exec(filename)?.[1] ?? '').toLowerCase()
}

export function mediaKind(filename) {
  const ext = extension(filename)
  if (ext === 'gif') return 'gif'
  if (photoExtensions.includes(ext)) return 'photo'
  if (videoExtensions.includes(ext)) return 'video'
  return null
}

export function trackKind(file) {
  const ext = extension(file)
  if (audioExtensions.includes(ext)) return 'audio'
  if (subtitleExtensions.includes(ext)) return 'subtitle'
  return null
}

export function matchingTrackKind(video, sidecar) {
  const stem = filename => filename.replace(/\.[^.\\/]+$/, '').toLowerCase()
  const base = stem(video)
  const name = stem(sidecar)
  const suffix = name.slice(base.length)
  return name.startsWith(base) && (!suffix || /^[. _-]/.test(suffix)) ? trackKind(sidecar) : null
}

const mimeTypes = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  ogv: 'video/ogg', mkv: 'video/x-matroska', vtt: 'text/vtt',
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff',
}

export const contentType = filename => mimeTypes[extension(filename)] ?? 'application/octet-stream'
