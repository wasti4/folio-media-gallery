export function normalizePlayback(value) {
  const patch = {}
  if (!value || typeof value !== 'object') return patch
  for (const key of ['position', 'duration']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) patch[key] = Math.min(value[key], 31_536_000)
  }
  for (const key of ['audioId', 'subtitleId']) {
    if (typeof value[key] === 'string' && /^[\w-]{0,128}$/.test(value[key])) patch[key] = value[key]
  }
  if (typeof value.watched === 'boolean') patch.watched = value.watched
  return patch
}
