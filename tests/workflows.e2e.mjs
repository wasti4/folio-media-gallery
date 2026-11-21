import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

const scratch = await mkdtemp(path.join(tmpdir(), 'folio-workflows-'))
const profile = path.join(scratch, 'source')
const restoredProfile = path.join(scratch, 'restored')
const exportParent = path.join(scratch, 'export')
const original = path.join(scratch, 'Coast.jpg')
const executable = process.env.FOLIO_TEST_EXE
const capture = process.env.FOLIO_WORKFLOW_CAPTURE_DIR
const errors = []
const execute = promisify(execFile)
let app

async function launch(directory) {
  app = await electron.launch({
    args: executable ? [] : ['.'],
    ...(executable && { executablePath: path.resolve(executable) }),
    env: { ...process.env, LUMA_TEST_PROFILE: directory },
    timeout: 25000,
  })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(10000)
  return page
}

async function screenshot(page, name, animations = 'disabled') {
  if (capture) await page.screenshot({ path: path.join(capture, name + '.png'), animations })
}

async function language(page, button, name) {
  await page.getByRole('button', { name: button, exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name, exact: true }).click()
}

async function choose(page, title, filename) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, filename)
  await page.locator('.import-button').click()
  await page.getByRole('menuitem', { name: title, exact: true }).click()
}

async function openPhoto(page) {
  await page.getByRole('button', { name: 'Open “Coast”', exact: true }).click()
  await page.waitForFunction(() => {
    const photo = document.querySelector('.photo-stage .photo-active')
    return photo?.naturalWidth > 0 && photo.alt === 'Coast'
  })
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click()
}

async function verifyAnimePlayback(page) {
  const series = path.join(scratch, 'Signal pack')
  const video = path.join(series, 'Videos', '[Release] Signal - 02 [1080p].mkv')
  const subtitle = path.join(series, 'Subtitles', '02.en.srt')
  const firstAudio = path.join(series, 'Audio', 'Studio A', '02.mka')
  const secondAudio = path.join(series, 'Audio', 'Studio B', '02.flac')
  await Promise.all([video, subtitle, firstAudio, secondAudio].map(file => mkdir(path.dirname(file), { recursive: true })))
  const ffmpeg = executable ? path.join(path.dirname(path.resolve(executable)), 'resources', 'ffmpeg', 'ffmpeg.exe') :
    process.env.LUMA_FFMPEG_DIR ? path.join(process.env.LUMA_FFMPEG_DIR, 'ffmpeg.exe') : 'ffmpeg'
  const make = args => execute(ffmpeg, ['-nostdin', '-v', 'error', ...args], { windowsHide: true, timeout: 20000 })
  await Promise.all([
    make(['-f', 'lavfi', '-i', 'color=black:s=256x144:r=12', '-t', '8', '-an', '-c:v', 'libx264', '-threads', '1', video]),
    make(['-f', 'lavfi', '-i', 'sine=frequency=320', '-t', '8', '-c:a', 'flac', firstAudio]),
    make(['-f', 'lavfi', '-i', 'sine=frequency=470', '-t', '8', '-c:a', 'flac', secondAudio]),
    writeFile(subtitle, '1\n00:00:00,000 --> 00:00:08,000\nSIGNAL SUBTITLE\n'),
  ])

  await choose(page, 'Add folder', series)
  const episode = page.getByRole('button', { name: 'Open “' + path.parse(video).name + '”', exact: true })
  await episode.click()
  const player = page.locator('.video-stage video')
  await page.waitForFunction(() => document.querySelector('.video-stage video')?.currentTime > .15)
  const audio = page.getByRole('button', { name: 'Audio tracks', exact: true })
  await audio.click()
  assert.equal(await page.getByRole('menuitemcheckbox', { name: 'Studio A · 02.mka', exact: true }).getAttribute('aria-checked'), 'true')
  const firstStream = await player.getAttribute('src')
  await page.getByRole('menuitemcheckbox', { name: 'Studio B · 02.flac', exact: true }).click()
  await page.waitForFunction(source => {
    const video = document.querySelector('.video-stage video')
    return video?.getAttribute('src') !== source && video?.currentTime > .15
  }, firstStream)
  await page.getByRole('button', { name: 'Subtitles', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '02.en.srt', exact: true }).click()
  await page.waitForFunction(() => {
    const video = document.querySelector('.video-stage video')
    if (!video || video.readyState < 2) return false
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0)
    return context.getImageData(0, 0, canvas.width, canvas.height).data.some((channel, index) => index % 4 === 0 && channel > 215)
  })
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click()
  console.log('Anime package import, automatic external audio, dub selection, and rendered external subtitles passed.')
}

try {
  await mkdir(exportParent)
  await copyFile(path.resolve('public/demo/shore.jpg'), original)
  let page = await launch(profile)
  const startup = await app.evaluate(({ BrowserWindow, screen }) => {
    const current = BrowserWindow.getAllWindows()[0]
    const bounds = current.getBounds()
    return { id: current.id, bounds, area: screen.getDisplayMatching(bounds).workArea, color: current.getBackgroundColor() }
  })
  assert.equal(startup.bounds.width, Math.min(760, startup.area.width), 'the first greeting must use a compact native window')
  assert.equal(startup.bounds.height, Math.min(530, startup.area.height))
  assert.ok(await page.locator('.intro-frame').evaluate(frame => {
    const rect = frame.getBoundingClientRect()
    return rect.left <= 1 && rect.top <= 1 && innerWidth - rect.right <= 1 && innerHeight - rect.bottom <= 1
  }), 'the intro should cover the native window to its edges')
  for (const greeting of ['Hello', 'Привет', '你好']) {
    const word = page.getByRole('img', { name: greeting, exact: true })
    await word.waitFor()
    await page.waitForFunction(text => {
      const strokes = document.querySelectorAll('.intro-hello[aria-label="' + text + '"] .intro-pen-stroke')
      const amount = parseFloat(strokes[0] && getComputedStyle(strokes[0]).strokeDashoffset)
      return amount > .1 && amount < .9 && parseFloat(getComputedStyle(strokes[strokes.length - 1]).strokeDashoffset) >= 1
    }, greeting)
    if (capture) {
      await page.waitForFunction(text => {
        const hello = document.querySelector('.intro-hello[aria-label="' + text + '"]')
        const lastStroke = hello?.querySelector('.intro-pen-stroke:last-child')
        return lastStroke && parseFloat(getComputedStyle(lastStroke).strokeDashoffset) === 0
      }, greeting)
      const sample = { Hello: 'hello', Привет: 'privet', 你好: 'nihao' }[greeting]
      await screenshot(page, 'folio-' + sample, 'allow')
    }
  }
  await page.getByRole('img', { name: 'Hello', exact: true }).waitFor()
  const theme = await page.locator('html').getAttribute('data-theme')
  const surface = await page.locator('.intro-frame').evaluate(frame => getComputedStyle(frame).backgroundColor)
  assert.notEqual(startup.color, '#000000', 'the native size change needs an opaque background')
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), theme)
  await page.getByRole('combobox', { name: 'Язык интерфейса' }).selectOption('en')
  assert.equal(await page.getByRole('heading', { name: 'All your moments together' }).count(), 0)
  await page.mouse.click(38, 470)
  await page.getByRole('heading', { name: 'All your moments together' }).waitFor()
  assert.equal(await page.locator('.intro-frame').evaluate(frame => getComputedStyle(frame).backgroundColor), surface)
  await screenshot(page, 'folio-intro')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('heading', { name: 'Watch your way' }).waitFor()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('heading', { name: 'Take your library with you' }).waitFor()
  await app.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0]
    globalThis.folioWindowSizes = []
    current.on('resize', () => globalThis.folioWindowSizes.push({
      width: current.getBounds().width, at: performance.now(), color: current.getBackgroundColor(),
    }))
  })
  await page.getByRole('button', { name: 'Open Folio', exact: true }).click()
  await page.getByRole('heading', { name: 'Library', exact: true }).waitFor()
  const arrived = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    return { count: windows.length, id: windows[0].id, width: windows[0].getBounds().width, sizes: globalThis.folioWindowSizes }
  })
  assert.equal(arrived.count, 1)
  assert.equal(arrived.id, startup.id, 'the greeting and gallery should share the original window')
  assert.equal(arrived.width, Math.min(1312, startup.area.width))
  if (arrived.width > startup.bounds.width) {
    assert.ok(new Set(arrived.sizes.map(event => event.width)).size >= 10, 'the native window should grow through intermediate sizes')
    assert.ok(arrived.sizes.at(-1).at - arrived.sizes[0].at < 650, 'the native window should expand promptly')
    assert.ok(arrived.sizes.every(event => event.color === startup.color), 'the background must stay covered until the resize has finished')
  }

  const toggle = page.locator('.sidebar-toggle')
  const controls = await toggle.getAttribute('aria-controls')
  assert.equal(controls, 'sidebar-folders')
  assert.equal(await page.locator('#' + controls).count(), 1)
  const iconLeft = await page.locator('.side-icon').first().evaluate(icon => icon.getBoundingClientRect().left)
  for (const expanded of [true, false, true]) {
    const moving = await toggle.evaluate(button => {
      button.click()
      return document.querySelector('.app-body').getAnimations().some(animation => animation.playState === 'running')
    })
    assert.ok(moving, 'sidebar toggle should animate the content shift')
    assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded))
    await page.waitForFunction(() => document.querySelector('.app-body').getAnimations().length === 0)
    const settled = await page.locator('.side-icon').first().evaluate(icon => icon.getBoundingClientRect().left)
    assert.ok(Math.abs(settled - iconLeft) < 1, 'the sidebar icons should stay anchored')
  }
  await screenshot(page, 'folio-sidebar')
  await language(page, 'Interface language', '简体中文')
  await page.getByRole('heading', { name: '媒体库', exact: true }).waitFor()
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  await screenshot(page, 'folio-chinese')
  await app.close()

  page = await launch(profile)
  await page.getByRole('heading', { name: '媒体库', exact: true }).waitFor()
  assert.equal(await page.locator('.intro-frame').count(), 0)
  assert.equal(await page.locator('.sidebar-toggle').getAttribute('aria-expanded'), 'true')
  await language(page, '界面语言', 'English')
  await page.getByRole('heading', { name: 'Library', exact: true }).waitFor()
  console.log('First-run greetings and feature tour, English and Chinese persistence, sidebar expansion and collapse passed.')

  await choose(page, 'Add files', original)
  const card = page.getByRole('button', { name: 'Open “Coast”', exact: true })
  await card.waitFor()
  await unlink(original)
  await openPhoto(page)
  await page.getByRole('button', { name: 'Actions for “Coast”', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to collection', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New collection', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Travel memories')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'Travel memories', exact: true }).click()
  await page.getByRole('heading', { name: 'Travel memories', exact: true }).waitFor()
  await card.waitFor()

  await choose(page, 'Create backup…', exportParent)
  const backupDialog = page.getByRole('dialog', { name: 'Backup complete', exact: true })
  await backupDialog.waitFor()
  const backup = await backupDialog.locator('.backup-path').textContent()
  const manifest = JSON.parse(await readFile(path.join(backup, 'folio-library.json'), 'utf8'))
  assert.equal(manifest.items.length, 1)
  assert.match(manifest.items[0].sha256, /^[a-f0-9]{64}$/)
  const relocated = path.join(scratch, 'relocated backup')
  await rename(backup, relocated)
  await backupDialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await copyFile(path.resolve('public/demo/shore.jpg'), original)
  const second = path.join(scratch, 'Second view.jpg')
  await copyFile(path.resolve('public/demo/forest.jpg'), second)
  await choose(page, 'Add files', second)
  await page.getByRole('button', { name: 'Open “Second view”', exact: true }).waitFor()
  await card.click()
  await page.waitForFunction(() => document.querySelector('.photo-active')?.naturalWidth > 0)
  await page.keyboard.press('Delete')
  const removalDialog = page.getByRole('dialog', { name: 'Delete photo', exact: true })
  await removalDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Full screen', exact: true }).click()
  await page.waitForFunction(() => Boolean(document.fullscreenElement))
  await page.getByRole('button', { name: 'Delete photo', exact: true }).click()
  await removalDialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog', { name: 'Second view', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click()
  await page.getByText('Photo deleted from the library', { exact: true }).waitFor()
  assert.ok((await readFile(path.join(profile, 'Library', 'Media', ...manifest.items[0].stored.split('/')))).length > 0)
  assert.ok((await readFile(original)).length > 0)
  assert.equal(await card.count(), 0)
  await choose(page, 'Restore from backup…', relocated)
  await openPhoto(page)
  await app.close()

  const settings = path.join(restoredProfile, 'Library', 'appearance.json')
  await mkdir(path.dirname(settings), { recursive: true })
  await writeFile(settings, JSON.stringify({ onboarded: true, language: 'en' }))
  page = await launch(restoredProfile)
  await choose(page, 'Restore from backup…', relocated)
  await openPhoto(page)
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Travel memories', exact: true }).click()
  await page.getByRole('heading', { name: 'Travel memories', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Open “Coast”', exact: true }).count(), 1)
  await choose(page, 'Restore from backup…', relocated)
  await page.getByText('Backup merged into the library', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Open “Coast”', exact: true }).count(), 1)
  await page.getByRole('button', { name: 'Actions for “Coast”', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete photo', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete photo', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByText('Photo deleted from the library', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'All files', exact: true }).click()
  await page.getByRole('heading', { name: 'No files here yet', exact: true }).waitFor()
  await choose(page, 'Restore from backup…', relocated)
  await openPhoto(page)
  await verifyAnimePlayback(page)
  assert.deepEqual(errors, [])
  console.log('Desktop import, photo deletion and cancellation, local and relocated backup restores, and idempotent merge passed.')
} finally {
  await app?.close().catch(() => {})
  await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
