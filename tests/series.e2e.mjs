import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

const base = await realpath(tmpdir())
const scratch = await mkdtemp(path.join(base, 'folio-series-'))
const profile = path.join(scratch, 'profile')
const showFolder = path.join(scratch, 'Signal')
const filename = '[Release] Signal - 02 [1080p].mkv'
const seasonOne = path.join(showFolder, 'Season 1', '01.mp4')
const seasonTwo = path.join(showFolder, 'Season 2')
const video = path.join(seasonTwo, 'Videos', filename)
const defaultAudio = path.join(seasonTwo, 'Audio', 'Studio A', '02.flac')
const audio = path.join(seasonTwo, 'Audio', 'Studio B', '02.flac')
const subtitle = path.join(seasonTwo, 'Subtitles', '02.en.srt')
const executable = process.env.FOLIO_TEST_EXE
const ffmpeg = executable ? path.join(path.dirname(path.resolve(executable)), 'resources', 'ffmpeg', 'ffmpeg.exe') :
  process.env.LUMA_FFMPEG_DIR ? path.join(process.env.LUMA_FFMPEG_DIR, 'ffmpeg.exe') : 'ffmpeg'
const execute = promisify(execFile)
const errors = []
let app

async function launch() {
  app = await electron.launch({
    args: executable ? [] : ['.'],
    ...(executable && { executablePath: path.resolve(executable) }),
    env: { ...process.env, LUMA_TEST_PROFILE: profile },
    timeout: 25000,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  return page
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
async function openSeries(page) {
  await button(page, 'Сериалы').click()
  await button(page, 'Открыть сериал «Signal»').click()
}
function playEpisode(page) {
  return button(page, 'Открыть «' + path.parse(filename).name + '»').click()
}
async function poll(read, ready) {
  const until = Date.now() + 10000
  while (Date.now() < until) {
    const value = await read()
    if (ready(value)) return value
    await delay(80)
  }
  assert.fail('Timed out waiting for saved playback state.')
}

try {
  const settings = path.join(profile, 'Library', 'appearance.json')
  await Promise.all([seasonOne, video, defaultAudio, audio, subtitle, settings].map(file => mkdir(path.dirname(file), { recursive: true })))
  const make = args => execute(ffmpeg, ['-nostdin', '-v', 'error', ...args], { windowsHide: true, timeout: 20000 })
  await Promise.all([
    copyFile(path.resolve('public/demo/tokyo.mp4'), seasonOne),
    make(['-f', 'lavfi', '-i', 'color=black:s=256x144:r=24', '-t', '14', '-an', '-c:v', 'libx264', '-threads', '1', video]),
    make(['-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '14', '-c:a', 'flac', defaultAudio]),
    make(['-f', 'lavfi', '-i', 'sine=frequency=470', '-t', '14', '-c:a', 'flac', audio]),
    writeFile(subtitle, '1\n00:00:00,000 --> 00:00:14,000\nSIGNAL SUBTITLE\n'),
    writeFile(settings, JSON.stringify({ onboarded: true, language: 'ru' })),
  ])
  let page = await launch()
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, showFolder)
  await page.locator('.import-button').click()
  await page.getByRole('menuitem', { name: 'Добавить папку', exact: true }).click()
  await openSeries(page)
  assert.equal(await page.locator('.series-card').count(), 0)
  assert.equal(await page.getByRole('heading', { name: 'Signal', exact: true }).count(), 1)
  await button(page, 'Сезон 1').click()
  await button(page, 'Отметить просмотренным').click()
  await page.getByText('Просмотрено 1 из 2', { exact: true }).waitFor()
  await button(page, 'Сезон 2').click()
  await playEpisode(page)
  await page.waitForFunction(() => document.querySelector('.video-stage video')?.currentTime > .1)
  const id = await page.evaluate(async filename => (await window.luma.state()).items.find(item => item.filename === filename).id, filename)
  const info = await page.evaluate(id => window.luma.inspect(id), id)
  assert.deepEqual(info.audio.map(track => track.label), ['Studio A · 02.flac', 'Studio B · 02.flac'])
  await button(page, 'Аудиодорожки').click()
  await page.getByRole('menuitemcheckbox', { name: 'Studio B · 02.flac', exact: true }).click()
  await button(page, 'Субтитры').click()
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
  await button(page, 'Пауза').click()
  await page.locator('.viewer').press('ArrowRight')
  await page.waitForFunction(() => Number(document.querySelector('.timeline')?.value) > 5 &&
    document.querySelector('.video-stage video')?.readyState >= 2)
  await button(page, 'Сохранить кадр').click()
  await page.getByText('Кадр сохранён в медиатеке', { exact: true }).waitFor()
  const image = await page.evaluate(async () => {
    const photo = (await window.luma.state()).items.find(item => item.kind === 'photo')
    const img = new Image()
    img.src = photo.viewUrl
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(img, 0, 0)
    return {
      ext: photo.ext,
      width: img.naturalWidth,
      height: img.naturalHeight,
      caption: context.getImageData(0, 0, canvas.width, canvas.height).data.some((channel, index) => index % 4 === 0 && channel > 215),
    }
  })
  assert.deepEqual(image, { ext: 'png', width: 256, height: 144, caption: true })
  await button(page, 'Закрыть просмотр').click()
  const saved = await poll(() => page.evaluate(async id => (await window.luma.state()).playback?.[id], id),
    record => record?.position > 5)
  assert.equal(saved.audioId, info.audio[1].id)
  assert.equal(saved.subtitleId, info.subtitles[0].id)
  await app.close()

  page = await launch()
  await openSeries(page)
  await page.getByText('Просмотрено 1 из 2', { exact: true }).waitFor()
  await page.getByText('Продолжить с ' + Math.floor(saved.position / 60) + ':' + String(Math.floor(saved.position % 60)).padStart(2, '0'), { exact: true }).waitFor()
  await playEpisode(page)
  await page.waitForFunction(() => document.querySelector('.video-stage video')?.currentTime > .1)
  await button(page, 'Пауза').click()
  const resumed = await poll(() => page.evaluate(async id => {
    const decoded = document.querySelector('.video-stage video')?.currentTime
    const position = (await window.luma.state()).playback?.[id]?.position
    return { decoded, position }
  }, id), value => value.decoded > .1 && value.position > saved.position)
  assert.ok(Math.abs(resumed.position - resumed.decoded - saved.position) < .005, JSON.stringify({ resumed, saved }))
  await button(page, 'Аудиодорожки').click()
  assert.equal(await page.getByRole('menuitemcheckbox', { name: 'Studio B · 02.flac', exact: true }).getAttribute('aria-checked'), 'true')
  await page.keyboard.press('Escape')
  await button(page, 'Субтитры').click()
  assert.equal(await page.getByRole('menuitemcheckbox', { name: '02.en.srt', exact: true }).getAttribute('aria-checked'), 'true')
  await page.keyboard.press('Escape')
  await button(page, 'Воспроизвести').click()
  await page.waitForFunction(() => document.querySelector('.video-stage video')?.currentTime > .65)
  const closePosition = await page.locator('.video-stage video').evaluate(element => element.currentTime)
  await app.close()
  app = null
  const { playback } = JSON.parse(await readFile(path.join(profile, 'Library', 'library.json'), 'utf8'))
  assert.ok(playback[id].position >= saved.position + closePosition - .02, JSON.stringify({ closePosition, saved, final: playback[id] }))
  assert.ok(playback[id].position < saved.position + closePosition + 1)
  assert.deepEqual(errors, [])
  console.log('Series and season navigation, watched marks, position and external track restoration, and decoded PNG frame passed.')
} finally {
  await app?.close().catch(() => {})
  if (path.dirname(scratch) === base && await realpath(scratch).catch(() => null) === scratch) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
  }
}
