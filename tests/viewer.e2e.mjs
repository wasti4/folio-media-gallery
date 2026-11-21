import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

const profile = await mkdtemp(path.join(tmpdir(), 'folio-viewer-'))
const target = process.env.FOLIO_TEST_EXE
const capture = process.env.FOLIO_CAPTURE
const execute = promisify(execFile)
let app

async function record(page) {
  if (!capture) return async () => {}
  const client = await page.context().newCDPSession(page)
  const frames = []
  const start = performance.now()
  client.on('Page.screencastFrame', ({ data, sessionId }) => {
    frames.push({ time: performance.now() - start, data })
    client.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 87, maxWidth: 1000, maxHeight: 750, everyNthFrame: 1 })
  return async () => {
    await client.send('Page.stopScreencast')
    await client.detach()
    assert.ok(frames.length >= 5, 'Screencast should capture the initial photo and four changes')
    const list = ['ffconcat version 1.0']
    for (const [index, frame] of frames.entries()) {
      const name = 'frame-' + index + '.jpg'
      await writeFile(path.join(profile, name), Buffer.from(frame.data, 'base64'))
      const next = frames[index + 1]?.time ?? frame.time + 250
      list.push("file '" + name + "'", 'duration ' + (Math.max(16, next - frame.time) / 1000).toFixed(4))
    }
    list.push("file 'frame-" + (frames.length - 1) + ".jpg'")
    const inputs = path.join(profile, 'capture.ffconcat')
    await writeFile(inputs, list.join('\n') + '\n', 'utf8')
    await execute('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', inputs,
      '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(capture),
    ], { windowsHide: true, timeout: 30000 })
    console.log('Capture saved to ' + capture)
  }
}

try {
  await mkdir(path.join(profile, 'Library'))
  await writeFile(path.join(profile, 'Library', 'appearance.json'), JSON.stringify({ onboarded: true }))
  app = await electron.launch({
    args: target ? [] : ['.'],
    ...(target && { executablePath: path.resolve(target) }),
    env: { ...process.env, LUMA_TEST_PROFILE: profile },
    timeout: 25000,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('tab', { name: 'Фото', exact: true }).click()
  await page.getByRole('button', { name: 'Открыть «На краю Исландии»', exact: true }).click()
  const heading = page.locator('.viewer-heading strong')
  await page.waitForFunction(() => document.querySelector('.photo-stage img')?.naturalWidth > 0 &&
    getComputedStyle(document.querySelector('.viewer')).opacity === '1')
  const photo = page.locator('.photo-active')
  await photo.waitFor()
  const fitted = await photo.boundingBox()
  const point = { x: fitted.x + fitted.width * .63, y: fitted.y + fitted.height * .48 }
  await page.mouse.dblclick(point.x, point.y)
  await page.waitForFunction(width => document.querySelector('.photo-active').getBoundingClientRect().width > width * 1.8, fitted.width)
  await page.waitForFunction(() => !document.querySelector('.photo-active').getAnimations().some(work => work.playState === 'running'))
  const zoomed = await photo.boundingBox()
  assert.ok(Math.abs((point.x - zoomed.x) / zoomed.width - .63) < .015, 'zoom should stay anchored under the mouse')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(point.x + 90, point.y + 35, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  const moved = await photo.boundingBox()
  assert.ok(moved.x > zoomed.x + 70 && moved.y > zoomed.y + 20, 'the photo should follow a left-button drag')
  const viewport = await page.locator('.photo-stage').evaluate(node => ({
    overflow: getComputedStyle(node).overflow, left: node.scrollLeft, top: node.scrollTop,
  }))
  assert.ok(['hidden', 'clip'].includes(viewport.overflow) && viewport.left === 0 && viewport.top === 0)
  await page.mouse.dblclick(point.x, point.y)
  await page.waitForFunction(width => document.querySelector('.photo-active').getBoundingClientRect().width <= width + 1, fitted.width)
  console.log('Double-click zoom, pointer anchoring, left-button panning and return to fit passed.')
  const stop = await record(page)
  await page.evaluate(() => {
    const viewer = document.querySelector('.viewer')
    window.folioSlides = []
    viewer.querySelector('.photo-stage').addEventListener('animationstart', event => {
      if (event.animationName !== 'photo-slide-in') return
      const animation = event.target.getAnimations().find(work => work.animationName === event.animationName)
      window.folioSlides.push({
        x: new DOMMatrixReadOnly(getComputedStyle(event.target).transform).m41,
        duration: animation?.effect.getTiming().duration,
        outgoing: Boolean(document.querySelector('.photo-leaving')),
      })
    })
    const samples = []
    const sample = () => {
      const current = document.querySelector('.viewer')
      const shown = [...current.querySelectorAll('.photo-stage img')]
        .some(img => img.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility === 'visible')
      samples.push({ sameShell: current === viewer, opacity: +getComputedStyle(current).opacity, shown })
      window.folioFrame = requestAnimationFrame(sample)
    }
    window.folioSamples = samples
    sample()
  })
  if (capture) await pause(240)
  for (const [key, name] of [
    ['ArrowRight', 'Архитектура света'],
    ['ArrowRight', 'Пески Намиба'],
    ['ArrowLeft', 'Архитектура света'],
    ['ArrowLeft', 'На краю Исландии'],
  ]) {
    const before = await page.evaluate(() => window.folioSlides.length)
    await page.keyboard.press(key)
    await page.waitForFunction(expected => document.querySelector('.viewer-heading strong')?.textContent === expected &&
      [...document.querySelectorAll('.photo-stage img')].some(img => img.alt === expected && img.naturalWidth &&
        getComputedStyle(img).visibility === 'visible'), name)
    assert.equal(await heading.textContent(), name)
    await page.waitForFunction(count => window.folioSlides.length > count, before, { timeout: 2000 })
    const slide = await page.evaluate(index => window.folioSlides[index], before)
    assert.ok(slide.outgoing, 'the departing image should remain during the slide')
    assert.ok(slide.duration > 120 && slide.duration < 300, 'the slide should stay quick')
    assert.equal(Math.sign(slide.x), key === 'ArrowRight' ? 1 : -1)
    if (capture) await pause(470)
  }
  const samples = await page.evaluate(() => {
    cancelAnimationFrame(window.folioFrame)
    return window.folioSamples
  })
  await stop()
  assert.deepEqual(errors, [])
  assert.ok(samples.length > 2, 'Transition should span several observable frames')
  const minimum = Math.min(...samples.map(frame => frame.opacity))
  console.log(JSON.stringify({ frames: samples.length, minimumOpacity: minimum,
    remounted: samples.some(frame => !frame.sameShell), blankPhoto: samples.some(frame => !frame.shown) }))
  assert.ok(samples.every(frame => frame.sameShell && frame.opacity === 1 && frame.shown),
    'Changing photos must keep the viewer fully visible and a decoded image on screen')
  await page.waitForFunction(() => !document.querySelector('.photo-leaving'))

  await page.getByRole('button', { name: 'Полный экран', exact: true }).click()
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('viewer'))
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode
    window.restoreDecode = () => { HTMLImageElement.prototype.decode = decode }
    HTMLImageElement.prototype.decode = function () {
      const result = decode.call(this)
      if (this.alt !== 'Архитектура света' || !this.classList.contains('photo-pending')) return result
      return result.then(() => new Promise(resolve => { window.finishSlowPhoto = resolve }))
    }
  })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => Boolean(window.finishSlowPhoto))
  assert.equal(await page.locator('.photo-active').getAttribute('alt'), 'На краю Исландии')
  assert.equal(await page.locator('.photo-stage').getAttribute('aria-busy'), 'true')
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.photo-active')?.alt === 'Пески Намиба')
  await page.evaluate(() => window.finishSlowPhoto())
  assert.equal(await page.locator('.photo-active').getAttribute('alt'), 'Пески Намиба')
  assert.equal(await page.evaluate(() => document.fullscreenElement?.classList.contains('viewer')), true)
  await page.getByRole('button', { name: 'Выйти из полного экрана', exact: true }).click()
  await page.waitForFunction(() => !document.fullscreenElement)
  await page.evaluate(() => window.restoreDecode())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.photo-active')?.alt === 'Архитектура света')
  assert.equal(await page.locator('.photo-leaving').count(), 0)
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.photo-active')?.alt === 'Пески Намиба')
  await page.getByRole('button', { name: 'Закрыть просмотр', exact: true }).click()
  await page.getByRole('button', { name: 'Недавние', exact: true }).click()
  assert.equal(await page.locator('.media-card').count(), 3)
  assert.match(await page.locator('.media-card').first().innerText(), /Пески Намиба/)
  console.log('Fullscreen and the current image survive slow decode and rapid navigation.')
} finally {
  await app?.close().catch(() => {})
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
}
