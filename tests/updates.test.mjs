import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  Updater, checkInterval, compareVersions, describeRelease, installerArguments, installerName, parseVersion,
  releaseFeed, removeFinishedDownloads,
} from '../desktop/updates.mjs'

const bytes = randomBytes(1536 * 1024)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const download = version => 'https://github.com/wasti4/folio-media-gallery/releases/download/v' + version + '/' + installerName(version)

function release(version, overrides = {}, asset = {}) {
  return {
    tag_name: 'v' + version, draft: false, prerelease: false,
    html_url: 'https://github.com/wasti4/folio-media-gallery/releases/tag/v' + version,
    assets: [
      { name: 'Folio-' + version + '-portable.zip', size: 10, digest: 'sha256:' + '0'.repeat(64), browser_download_url: download(version) },
      { name: installerName(version), size: bytes.length, digest: 'sha256:' + sha256, browser_download_url: download(version), ...asset },
    ],
    ...overrides,
  }
}

async function scratch(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(path.join(base, 'folio-updates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function server(routes) {
  const requests = []
  const fetch = async (url, options = {}) => {
    requests.push(url)
    options.signal?.throwIfAborted()
    const route = routes[url]
    if (!route) return new Response('missing', { status: 404 })
    return typeof route === 'function' ? route(options) : route.clone()
  }
  return { fetch, requests }
}

function updater(root, fetch, saved = {}) {
  let settings = saved
  const events = []
  const instance = new Updater({
    version: '1.9.0', fetch, directory: path.join(root, 'Updates'), installable: true,
    read: () => settings, save: async value => { settings = value }, publish: status => events.push(status),
    now: () => 5 * checkInterval,
  })
  return { instance, events, settings: () => settings }
}

test('versions compare numerically and reject anything but plain releases', () => {
  assert.deepEqual(parseVersion('v1.10.2'), [1, 10, 2])
  assert.equal(parseVersion('1.10.0-beta.1'), null)
  assert.equal(parseVersion('latest'), null)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0)
  assert.equal(compareVersions('1.9.0', '1.9.1'), -1)
})

test('only a newer, published release with a verified installer can be installed', () => {
  const newer = describeRelease(release('1.10.0'), '1.9.0')
  assert.equal(newer.version, '1.10.0')
  assert.equal(newer.page, 'https://github.com/wasti4/folio-media-gallery/releases/tag/v1.10.0')
  assert.deepEqual(newer.installer, { name: 'Folio-1.10.0-Setup.exe', url: download('1.10.0'), size: bytes.length, sha256 })

  assert.equal(describeRelease(release('1.9.0'), '1.9.0'), null)
  assert.equal(describeRelease(release('1.8.4'), '1.9.0'), null)
  assert.equal(describeRelease(release('1.10.0', { prerelease: true }), '1.9.0'), null)
  assert.equal(describeRelease(release('1.10.0', { draft: true }), '1.9.0'), null)
  assert.equal(describeRelease({ tag_name: 'nightly' }, '1.9.0'), null)

  for (const asset of [{ digest: undefined }, { digest: 'md5:abc' }, { browser_download_url: 'https://example.com/Folio-1.10.0-Setup.exe' },
    { browser_download_url: 'http://github.com/wasti4/folio-media-gallery/releases/download/v1.10.0/Folio-1.10.0-Setup.exe' },
    { size: 512 }, { size: 3 * 1024 ** 3 }]) {
    const described = describeRelease(release('1.10.0', {}, asset), '1.9.0')
    assert.equal(described.version, '1.10.0', JSON.stringify(asset))
    assert.equal(described.installer, null, JSON.stringify(asset))
  }
  assert.equal(describeRelease(release('1.10.0', { html_url: 'https://evil.example/releases' }), '1.9.0').page, null)
})

test('a test feed may serve installers from its own origin only', () => {
  const feed = 'http://127.0.0.1:4000/releases/latest'
  const local = release('1.10.0', { html_url: 'http://127.0.0.1:4000/page' }, { browser_download_url: 'http://127.0.0.1:4000/setup.exe' })
  assert.equal(describeRelease(local, '1.9.0', feed).installer.url, 'http://127.0.0.1:4000/setup.exe')
  assert.equal(describeRelease(local, '1.9.0').installer, null)
  const foreign = release('1.10.0', {}, { browser_download_url: 'http://127.0.0.1:5000/setup.exe' })
  assert.equal(describeRelease(foreign, '1.9.0', feed).installer, null)
})

test('the installer runs silently in the interface language and restarts Folio', () => {
  assert.deepEqual(installerArguments('ru'), ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RELAUNCH=1', '/LANG=russian'])
  assert.equal(installerArguments('zh-CN').at(-1), '/LANG=chinesesimplified')
  assert.equal(installerArguments('xx').at(-1), '/LANG=english')
})

test('checks run once a day unless turned off, and remember when they ran', async t => {
  const root = await scratch(t)
  const { fetch, requests } = server({ [releaseFeed]: Response.json(release('1.10.0')) })
  const { instance, settings, events } = updater(root, fetch)
  assert.equal(instance.due(), true)
  const status = await instance.tick()
  assert.equal(status.state, 'available')
  assert.deepEqual(status.available, { version: '1.10.0', page: release('1.10.0').html_url, downloadable: true })
  assert.equal(settings().checkedAt, 5 * checkInterval)
  assert.deepEqual(events.map(event => event.state), ['checking', 'available'])
  assert.equal(instance.due(), false)
  await instance.tick()
  assert.equal(requests.length, 1)

  const off = updater(root, fetch, { automatic: false })
  assert.equal(off.instance.due(), false)
  assert.equal((await off.instance.tick()).state, 'idle')
  assert.equal((await off.instance.check()).state, 'available', 'a manual check still works')
  assert.equal(off.settings().automatic, false)
})

test('no release, an older release and a failed request are reported apart', async t => {
  const root = await scratch(t)
  assert.equal((await updater(root, server({}).fetch).instance.check()).state, 'current')
  assert.equal((await updater(root, server({ [releaseFeed]: Response.json(release('1.9.0')) }).fetch).instance.check()).state, 'current')
  const failing = updater(root, server({ [releaseFeed]: new Response('busy', { status: 503 }) }).fetch, { checkedAt: 7 })
  const status = await failing.instance.check()
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'Не удалось проверить обновления.')
  assert.equal(failing.settings().checkedAt, 7, 'a failed check is retried on the next tick')
})

test('the installer is downloaded, verified and reused', async t => {
  const root = await scratch(t)
  const { fetch, requests } = server({ [releaseFeed]: Response.json(release('1.10.0')), [download('1.10.0')]: new Response(bytes) })
  const { instance, events } = updater(root, fetch)
  await writeFile(path.join(root, 'stale.txt'), 'x')
  await instance.check()
  const status = await instance.download()
  assert.equal(status.state, 'ready')
  assert.equal(status.progress, 1)
  assert.ok(events.some(event => event.state === 'downloading'))
  const file = instance.readyInstaller()
  assert.equal(file, path.join(root, 'Updates', 'Folio-1.10.0-Setup.exe'))
  assert.deepEqual(await readFile(file), bytes)

  const again = updater(root, fetch)
  await again.instance.check()
  assert.equal((await again.instance.download()).state, 'ready')
  assert.equal(requests.filter(url => url === download('1.10.0')).length, 1, 'a verified file is not downloaded twice')
})

test('a damaged or interrupted download leaves nothing to install', async t => {
  const root = await scratch(t)
  const damaged = Buffer.from(bytes)
  damaged[42] ^= 1
  const broken = server({ [releaseFeed]: Response.json(release('1.10.0')), [download('1.10.0')]: new Response(damaged) })
  const { instance } = updater(root, broken.fetch)
  await instance.check()
  const status = await instance.download()
  assert.equal(status.state, 'available')
  assert.equal(status.error, 'Загруженное обновление повреждено. Попробуйте ещё раз.')
  assert.equal(instance.readyInstaller(), null)
  assert.deepEqual(await readdir(path.join(root, 'Updates')), [])

  let cancel
  const stalled = server({
    [releaseFeed]: Response.json(release('1.10.0')),
    [download('1.10.0')]: options => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1024))
        options.signal.addEventListener('abort', () => controller.error(options.signal.reason))
        cancel()
      },
    }), { headers: { 'content-length': String(bytes.length) } }),
  })
  const waiting = updater(root, stalled.fetch)
  cancel = () => waiting.instance.cancel()
  await waiting.instance.check()
  const canceled = await waiting.instance.download()
  assert.equal(canceled.state, 'available')
  assert.equal(canceled.error, '', 'canceling is not an error')
  assert.deepEqual(await readdir(path.join(root, 'Updates')), [])
})

test('portable copies and unverifiable releases are pointed to the release page instead', async t => {
  const root = await scratch(t)
  const { fetch } = server({ [releaseFeed]: Response.json(release('1.10.0', {}, { digest: undefined })) })
  const { instance } = updater(root, fetch)
  const status = await instance.check()
  assert.equal(status.available.downloadable, false)
  await assert.rejects(instance.download(), /страницы выпуска/)

  const portable = updater(root, server({ [releaseFeed]: Response.json(release('1.10.0')) }).fetch)
  portable.instance.installable = false
  assert.equal((await portable.instance.check()).available.downloadable, false)
})

test('installers that were already applied are cleaned up', async t => {
  const root = await scratch(t)
  for (const name of ['Folio-1.8.0-Setup.exe', 'Folio-1.9.0-Setup.exe', 'Folio-1.9.0-Setup.exe.part', 'Folio-1.10.0-Setup.exe', 'notes.txt']) {
    await writeFile(path.join(root, name), 'x')
  }
  await removeFinishedDownloads(root, '1.9.0')
  assert.deepEqual(await readdir(root), ['Folio-1.10.0-Setup.exe'])
})
