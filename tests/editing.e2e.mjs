import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const scratch = await mkdtemp(path.join(tmpdir(), 'folio-editor-'))
const profile = path.join(scratch, 'profile')
const files = [path.join(scratch, 'Coast.jpg'), path.join(scratch, 'Walk.mp4')]
const target = process.env.FOLIO_TEST_EXE
const capture = process.env.FOLIO_EDITOR_CAPTURE
const errors = []
let app

try {
  await copyFile('public/demo/shore.jpg', files[0])
  await copyFile('public/demo/dolomites.mp4', files[1])
  const preferences = path.join(profile, 'Library', 'appearance.json')
  await mkdir(path.dirname(preferences), { recursive: true })
  await writeFile(preferences, JSON.stringify({ onboarded: true, language: 'en', theme: 'dark' }))
  const forceSoftware = process.env.FOLIO_SOFTWARE_PREVIEW === '1'
  app = await electron.launch({
    args: target ? [] : ['.'], ...(target && { executablePath: path.resolve(target) }),
    env: { ...process.env, FOLIO_TEST_PROFILE: profile },
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  if (forceSoftware) await page.evaluate(() => {
    const available = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...options) {
      return type === 'webgl2' ? null : available.call(this, type, ...options)
    }
  })

  await app.evaluate(({ dialog, ipcMain }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
    // Exercise renderer wiring without replacing the wallpaper on the computer running the tests.
    ipcMain.removeHandler('folio:wallpaper')
    globalThis.wallpaperCalls = []
    ipcMain.handle('folio:wallpaper', (_, id) => { globalThis.wallpaperCalls.push(id) })
  }, files)

  const waitForRenderedFrame = () => page.waitForFunction(() => {
    if (document.querySelector('.editor-picture canvas')?.dataset.ready === 'true') return true
    const frame = document.querySelector('.editor-picture img')
    return frame?.getAttribute('src')?.startsWith('/~edit-frame/') && frame.naturalWidth > 0
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const slider = name => page.getByRole('slider', { name, exact: true })

  await button('Import').click()
  await page.getByRole('menuitem', { name: 'Add files', exact: true }).click()
  await button('Open “Coast”').waitFor()
  await button('Actions for “Coast”').click()
  await page.getByRole('menuitem', { name: 'Set as wallpaper', exact: true }).click()
  await page.getByText('Desktop wallpaper updated', { exact: true }).waitFor()
  await page.locator('.toast button').click()

  await button('Open “Coast”').click()
  let previewRequests = 0
  page.on('request', request => { if (request.url().includes('/~edit-frame/')) previewRequests++ })
  await button('Edit').click()
  await waitForRenderedFrame()
  const mat = await page.locator('.editor-picture').boundingBox()
  const editorWindow = await app.browserWindow(page)
  const sampleArea = { x: Math.round(mat.x + mat.width / 2 - 28),
    y: Math.round(mat.y + mat.height / 2 - 28), width: 56, height: 56 }
  // Capture through Electron so the Chromium screenshot does not interrupt the held drag.
  const sample = () => editorWindow.evaluate(async (window, area) => {
    const frame = await window.webContents.capturePage(area)
    return frame.toPNG().toString('base64')
  }, sampleArea)
  async function changedFrame(previous, message) {
    const deadline = performance.now() + 1200
    do {
      const frame = await sample()
      if (frame !== previous) return frame
    } while (performance.now() < deadline)
    assert.fail(message)
  }
  const originalSample = await sample()
  const brightness = slider('Brightness')
  const color = await brightness.boundingBox()
  const sliderCenter = color.x + color.width / 2
  const sliderY = color.y + color.height / 2
  const openedFrames = previewRequests
  await page.mouse.move(sliderCenter, sliderY)
  await page.mouse.down()
  await page.mouse.move(color.x + color.width * .72, sliderY, { steps: 6 })
  const midValue = Number(await brightness.inputValue())
  assert.ok(midValue > 0)
  const midDrag = await changedFrame(originalSample, 'the image must update before releasing the slider')
  await page.mouse.move(color.x + color.width * .89, sliderY, { steps: 6 })
  assert.ok(Number(await brightness.inputValue()) > midValue)
  await changedFrame(midDrag, 'the image should follow successive values during the same drag')
  await page.mouse.up()
  assert.equal(previewRequests, openedFrames, 'adjusting sliders must reuse the decoded photo')
  const graphics = await page.locator('.editor-picture canvas').evaluate(canvas => Boolean(canvas.getContext('webgl2')))
  if (forceSoftware) assert.ok(await page.locator('.editor-picture canvas').evaluate(canvas => Boolean(canvas.getContext('2d'))))
  console.log('Photo changed during one held drag with no additional frame requests (' + (graphics ? 'WebGL' : 'Canvas 2D') + ').')
  const pressed = name => button(name).getAttribute('aria-pressed')
  const adjustedFrame = await sample()
  await button('Mono').click()
  assert.equal(await pressed('Mono'), 'true')
  await slider('Strength').waitFor()
  await changedFrame(adjustedFrame, 'a look must restyle the live preview')
  await page.keyboard.press('Control+z')
  assert.equal(await pressed('None'), 'true', 'undo removes the look')
  assert.ok(Number(await slider('Brightness').inputValue()) > 0, 'undo keeps the earlier slider change')
  await page.keyboard.press('Control+Shift+z')
  assert.equal(await pressed('Mono'), 'true', 'redo restores the look')
  // Away from the centre a plain click would set a large value, so only the reset can bring it back to zero.
  const track = await slider('Brightness').boundingBox()
  await slider('Brightness').dblclick({ position: { x: track.width * .85, y: track.height / 2 } })
  assert.equal(await slider('Brightness').inputValue(), '0', 'double-click resets a slider')
  console.log('Looks, undo and redo, and double-click reset passed.')
  await button('Reset edits').click()
  assert.equal(await pressed('None'), 'true')
  await button('Crop').click()
  const crop = page.getByRole('group', { name: 'Move crop frame', exact: true })
  await crop.waitFor()
  await button('1:1').click()
  if (capture) await page.screenshot({ path: path.join(capture, 'Folio-photo-editor.png'), animations: 'disabled' })
  await button('Rotate right').click()
  await crop.waitFor()
  const cropBox = await crop.boundingBox()
  assert.ok(Math.abs(cropBox.width - cropBox.height) < 3, 'rotation preserves the selected area')
  const corner = page.getByRole('button', { name: 'Crop corner 1' })
  await corner.press('Shift+ArrowRight')
  assert.ok((await crop.boundingBox()).width < cropBox.width)
  const cornerBox = await corner.boundingBox()
  const x = cornerBox.x + cornerBox.width / 2
  const y = cornerBox.y + cornerBox.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 16, y + 12, { steps: 3 })
  await page.mouse.up()
  assert.ok((await crop.boundingBox()).height < cropBox.height - 8)

  await button('Adjust').click()
  for (let attempt = 0; attempt < 12; attempt += 1) await slider('Brightness').press('ArrowRight')
  assert.equal(await slider('Brightness').inputValue(), '12')
  const photoPreview = page.locator('.editor-picture canvas, .editor-picture img')
  await waitForRenderedFrame()
  const beforeComparison = await photoPreview.screenshot()
  await button('Original').click()
  assert.notDeepEqual(await photoPreview.screenshot(), beforeComparison)
  await button('Save copy').click()
  await page.locator('.viewer-heading').getByText('Coast (edit)', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.photo-active')?.naturalWidth > 0)
  await button('Set as wallpaper').click()
  await page.waitForFunction(() => Boolean(document.querySelector('.toast')?.textContent?.includes('Desktop wallpaper updated')))
  await page.locator('.toast button').click()
  const commands = await app.evaluate(() => globalThis.wallpaperCalls)
  assert.equal(commands.length, 2)
  assert.notEqual(commands[0], commands[1])
  await button('Close viewer').click()
  await button('Open “Coast”').waitFor()
  await button('Open “Coast (edit)”').waitFor()
  console.log('Photo editing, crop handles, comparison, saving a separate copy and both wallpaper entry points passed.')

  await button('Open “Walk”').click()
  await button('Edit').click()
  await waitForRenderedFrame()
  await button('Trim').click()
  for (const [name, ratio] of [['Start', .23], ['End', .50]]) {
    const input = slider(name)
    const box = await input.boundingBox()
    await page.mouse.click(box.x + box.width * ratio, box.y + box.height / 2)
  }
  const start = Number(await slider('Start').inputValue())
  const end = Number(await slider('End').inputValue())
  assert.ok(start > 0.5 && end > start + 1 && end < 11, JSON.stringify({ start, end }))
  await button('Play selection').click()
  await page.waitForFunction(() => {
    const video = document.querySelector('.editor-picture video')
    return video?.readyState >= 2 && video.currentTime > 0.15
  }, undefined, { timeout: 16000 })
  await button('Stop selection').click()
  if (capture) await page.screenshot({ path: path.join(capture, 'Folio-video-editor.png'), animations: 'disabled' })
  await button('Save copy').click()
  await page.locator('.viewer-heading').getByText('Walk (edit)', { exact: true }).waitFor({ timeout: 20000 })
  await page.waitForFunction(() => document.querySelector('.video-stage video')?.readyState >= 2)
  const index = JSON.parse(await readFile(path.join(profile, 'Library', 'library.json'), 'utf8'))
  assert.equal(Object.keys(index.items).length, 4)
  assert.deepEqual(errors, [])
  console.log('Video trim, filtered fragment playback, saving, and playback of the saved copy passed.')
} finally {
  await app?.close().catch(() => {})
  await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
