import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Playback, buildStreamArgs, matchingTrackKind } from '../desktop/playback.mjs'
import { localFileResponse } from '../desktop/protocol.mjs'

test('FFmpeg seeks both sources and restores subtitle timestamps while multiplexing external audio', () => {
  const args = buildStreamArgs({
    videoPath: 'D:/Аниме/01.mkv', externalAudio: 'D:/Дорожки/01.flac',
    subtitleFile: 'safe-file.ass', start: 82.5, duration: 1440,
  })
  assert.deepEqual(args.flatMap((arg, index) => arg === '-ss' ? [args[index + 1]] : []), ['82.5', '82.5'])
  assert.ok(args.includes('1:a:0'))
  assert.match(args[args.indexOf('-vf') + 1], /setpts=PTS\+82\.5\/TB,ass=safe-file\.ass,setpts=PTS-82\.5\/TB/)
  assert.ok(args.includes('frag_keyframe+empty_moov+default_base_moof+skip_trailer'))
})

test('auto-discovery matches a language suffix and excludes adjacent episodes', () => {
  assert.equal(matchingTrackKind('Серия 01.mkv', 'Серия 01.RU.ass'), 'subtitle')
  assert.equal(matchingTrackKind('Серия 01.mkv', 'Серия 01 [dub].mka'), 'audio')
  assert.equal(matchingTrackKind('Серия 01.mkv', 'Серия 011.ass'), null)
  assert.equal(matchingTrackKind('Серия 01.mkv', 'Серия 01.mp4'), null)
})

test('external playback IDs follow saved tracks when the library storage moves', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folio-playback-tracks-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = ['01.flac', '01.ass']
  async function inspectAt(name, attachFirst = false) {
    const mediaRoot = path.join(directory, name, 'Media')
    const tracks = files.map(file => path.join(mediaRoot, 'Tracks', 'b'.repeat(32), file))
    await mkdir(path.dirname(tracks[0]), { recursive: true })
    await Promise.all(tracks.map(track => writeFile(track, 'test track')))
    const library = {
      mediaRoot,
      file: () => ({ id: 'episode', kind: 'video', filename: '01.mkv', ext: 'mkv', stored: 'episode', file: '01.mkv' }),
      externalTrackOptions: () => tracks.map((file, index) => ({ file, label: files[index] })),
      rememberTracks: () => [tracks[0]],
    }
    const playback = new Playback(library, path.join(directory, 'Cache'))
    playback.metadata = async () => ({ streams: [{ index: 0, codec_type: 'video' }] })
    if (attachFirst) {
      const attached = await playback.attach('episode', tracks[0], 'audio')
      assert.equal(attached.info.audio[0].id, attached.id)
    }
    const selection = await playback.inspect('episode')
    return { audioId: selection.audio[0].id, subtitleId: selection.subtitles[0].id }
  }
  const original = await inspectAt('original', true)
  assert.deepEqual(await inspectAt('restored'), original)
  assert.notEqual(original.audioId, original.subtitleId)
})

test('local media handles open, suffix and unsatisfiable byte ranges', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'luma-ranges-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'test.mp4')
  await writeFile(file, 'abcdefghij')
  for (const [range, status, content, body] of [
    ['bytes=2-', 206, 'bytes 2-9/10', 'cdefghij'],
    ['bytes=-4', 206, 'bytes 6-9/10', 'ghij'],
    ['bytes=10-', 416, 'bytes */10', ''],
  ]) {
    const response = await localFileResponse(file, new Request('https://test.local/file', { headers: { range } }))
    assert.equal(response.status, status)
    assert.equal(response.headers.get('content-range'), content)
    assert.equal(await response.text(), body)
  }
})
