import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'

const profile = await mkdtemp(path.join(tmpdir(), 'folio-appearance-'))
const target = process.env.FOLIO_TEST_EXE
const errors = []
let app

async function launch(args = []) {
  app = await electron.launch({
    args: target ? args : ['.', ...args],
    ...(target && { executablePath: path.resolve(target) }),
    env: { ...process.env, FOLIO_TEST_PROFILE: profile },
    timeout: 25000,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => errors.push(error.message))
  return page
}

async function verifyTheme(page, theme) {
  const toggle = page.getByRole('switch', { name: 'Светлая тема', exact: true })
  await toggle.waitFor()
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme)
  assert.equal(await toggle.getAttribute('aria-checked'), String(theme === 'light'))
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), theme)
  return toggle
}

try {
  await mkdir(path.join(profile, 'Library'))
  await writeFile(path.join(profile, 'Library', 'appearance.json'), JSON.stringify({ onboarded: true, theme: 'dark' }))
  let page = await launch()
  let toggle = await verifyTheme(page, 'dark')
  assert.match(await page.title(), /^Folio/)
  assert.equal(await page.locator('.brand-name').textContent(), 'Folio')
  assert.equal(await page.locator('.brand-mark polygon').count(), 3)
  const darkText = await page.locator('.page-heading h1').evaluate(element => getComputedStyle(element).color)

  await toggle.click()
  toggle = await verifyTheme(page, 'light')
  const lightText = await page.locator('.page-heading h1').evaluate(element => getComputedStyle(element).color)
  assert.notEqual(lightText, darkText)

  await toggle.press('ArrowLeft')
  await verifyTheme(page, 'dark')
  const bounds = await toggle.boundingBox()
  const middle = bounds.y + bounds.height / 2
  await page.mouse.move(bounds.x + 13, middle)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 10, middle, { steps: 7 })
  await page.mouse.up()
  await verifyTheme(page, 'light')

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const data = await readFile(path.join(profile, 'Library', 'appearance.json'), 'utf8').catch(() => '{}')
    if (JSON.parse(data).theme === 'light') break
    assert.ok(attempt < 39, 'Light theme should be saved')
    await delay(50)
  }
  await app.close()
  page = await launch()
  await verifyTheme(page, 'light')
  await app.close()
  page = await launch(['--intro'])
  await page.getByRole('img', { name: 'Hello', exact: true }).waitFor()
  const expansionSupported = await app.evaluate(() =>
    process.platform === 'win32' && Number(process.getSystemVersion().split('.')[2]) >= 22621)
  assert.equal(await page.locator('.window-stage').getAttribute('data-intro-motion'), expansionSupported ? '' : null)
  await page.getByRole('button', { name: 'Нажмите, чтобы продолжить', exact: true }).click()
  await page.getByRole('heading', { name: 'Все кадры вместе', exact: true }).waitFor({ timeout: 2000 })
  const introText = await page.locator('.intro-frame').evaluate(frame => getComputedStyle(frame).color)
  assert.equal(introText, lightText, 'the replayed light intro should use the gallery text color')
  const arrowInset = await page.locator('.intro-language-chevron').evaluate(arrow =>
    arrow.parentElement.getBoundingClientRect().right - arrow.getBoundingClientRect().right)
  assert.ok(arrowInset >= 9 && arrowInset <= 15, 'the arrow should be inset from the selector edge')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const landing = expansionSupported ? app.waitForEvent('window') : Promise.resolve(page)
  const greeting = page
  await greeting.getByRole('button', { name: 'Пропустить', exact: true }).click()
  page = await landing
  await page.waitForFunction(() => document.querySelector('.window-stage:not([data-onboarding])'))
  await verifyTheme(page, 'light')
  if (expansionSupported) assert.equal(greeting.isClosed(), true)
  assert.deepEqual(errors, [])
  console.log('Folio branding, mouse, keyboard, drag and theme persistence passed.')
} finally {
  await app?.close().catch(() => {})
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
}
