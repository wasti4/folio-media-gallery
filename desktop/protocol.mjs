import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { contentType } from '../shared/formats.mjs'

function parseRange(range, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0)
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return Number.isSafeInteger(start) && start <= end && end < size ? { start, end } : null
}

export async function localFileResponse(file, request) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return new Response(null, { status: 404 })
  const range = request.headers.get('range')
  const limits = range ? parseRange(range, info.size) : null
  const headers = { 'Content-Type': contentType(file), 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' }
  if (range && !limits) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + info.size } })
  }
  if (limits) headers['Content-Range'] = `bytes ${limits.start}-${limits.end}/${info.size}`
  headers['Content-Length'] = String(limits ? limits.end - limits.start + 1 : info.size)
  const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file, limits ?? {}))
  return new Response(body, { status: limits ? 206 : 200, headers })
}
