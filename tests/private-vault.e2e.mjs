import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const base = await realpath(tmpdir())
const scratch = await mkdtemp(path.join(base, 'folio-private-ui-'))
const profile = path.join(scratch, 'profile')
const source = path.join(scratch, 'FolioPrivate-test-name.jpg')
const password = 'Private sunset and morning seas'
const executable = process.env.FOLIO_TEST_EXE
const errors = []
let app

async function launch() {
  app = await electron.launch({
    args: executable ? [] : ['.'], ...(executable && { executablePath: path.resolve(executable) }),
    env: { ...process.env, FOLIO_TEST_PROFILE: profile },
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  return page
}

async function choose(file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (!options.properties.includes('dontAddToRecent')) throw new Error('Private dialog must stay out of recents')
      return { canceled: false, filePaths: [file] }
    }
  }, file)
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
async function assertCenteredAccess(page) {
  const card = await page.locator('form.vault-access').boundingBox()
  const workspace = await page.locator('.gallery-scroll').boundingBox()
  assert.ok(card && workspace, 'the access form and workspace are visible')
  assert.ok(Math.abs(card.x + card.width / 2 - workspace.x - workspace.width / 2) < 4, 'the access form is centered horizontally')
  assert.ok(Math.abs(card.y + card.height / 2 - workspace.y - workspace.height / 2) < 4, 'the access form is centered vertically')
}

async function unlock(page, value) {
  await page.getByLabel('Password', { exact: true }).fill(value)
  await button(page, 'Unlock').click()
}

async function assertNoCleartext(directory, original) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await assertNoCleartext(file, original)
    if (!entry.isFile()) continue
    const data = await readFile(file)
    assert.ok(!data.includes(Buffer.from(path.basename(source))), 'private filename leaked into ' + entry.name)
    assert.ok(!data.includes(Buffer.from(password)), 'password leaked into ' + entry.name)
    assert.ok(!data.includes(original), 'private photo leaked into ' + entry.name)
    assert.ok(!data.includes(Buffer.from(original.toString('base64'))), 'base64 photo leaked into ' + entry.name)
  }
}

try {
  await mkdir(path.join(profile, 'Library'), { recursive: true })
  await writeFile(path.join(profile, 'Library', 'appearance.json'), JSON.stringify({ onboarded: true, theme: 'dark', language: 'en' }))
  const demo = await readFile('public/demo/shore.jpg')
  const comment = Buffer.from('Unique fixture for the Folio private folder test')
  const marker = Buffer.from([0xff, 0xfe, 0, comment.length + 2])
  const original = Buffer.concat([demo.subarray(0, 2), marker, comment, demo.subarray(2)])
  await writeFile(source, original)
  let page = await launch()
  await button(page, 'Private folder').click()
  await page.getByRole('heading', { name: 'Create a private folder', exact: true }).waitFor()
  await assertCenteredAccess(page)
  if (process.env.FOLIO_VAULT_CAPTURE_DIR) {
    await page.screenshot({ path: path.join(process.env.FOLIO_VAULT_CAPTURE_DIR, 'private-access.png'), animations: 'disabled' })
  }
  assert.equal(await button(page, 'Import').count(), 0)
  await choose(scratch)
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByLabel('Confirm password', { exact: true }).fill('short')
  await button(page, 'Choose folder…').click()
  await page.getByRole('alert').filter({ hasText: 'Choose a password with at least 12 characters.' }).waitFor()
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password', { exact: true }).fill(password)
  await button(page, 'Choose folder…').click()
  await page.getByRole('heading', { name: 'No private photos yet', exact: true }).waitFor()
  assert.equal(await button(page, 'Add private photos').getAttribute('aria-describedby'), 'vault-import-note')
  await page.getByText('Folio creates encrypted copies. The source files stay in place.', { exact: true }).waitFor()

  await choose(source)
  await button(page, 'Add private photos').click()
  const name = path.basename(source)
  const stem = path.parse(source).name
  const open = (name = stem) => button(page, 'Open “' + name + '”').click()
  await page.locator('.vault-thumbnail img').waitFor()
  await open()
  await page.waitForFunction(expected => {
    const image = document.querySelector('.viewer .photo-active')
    return image?.alt === expected && image.naturalWidth > 0 && image.src.startsWith('data:image/jpeg;')
  }, stem)
  if (process.env.FOLIO_VAULT_CAPTURE_DIR) {
    await page.locator('.viewer').screenshot({ path: path.join(process.env.FOLIO_VAULT_CAPTURE_DIR, 'private-viewer.png'), animations: 'disabled' })
  }
  const { items } = await page.evaluate(async () => (await window.folio.vault.state()).value)
  assert.equal(items.length, 1)
  const id = items[0].id
  assert.equal(await page.evaluate(async target => {
    const state = await window.folio.state()
    return state.items.some(item => item.filename === target)
  }, name), false)

  await page.keyboard.press('Escape')
  await button(page, 'All files').click()
  assert.equal(await page.locator('.viewer').count(), 0)
  await page.waitForFunction(async () => !(await window.folio.vault.state()).value.unlocked)
  assert.deepEqual(await page.evaluate(async id => window.folio.vault.image(id), id), { error: 'LOCKED' })
  await button(page, 'Private folder').click()
  await unlock(page, 'wrong password')
  await page.getByRole('alert').filter({ hasText: 'Check the password' }).waitFor()
  await unlock(page, password)
  await open()
  await page.locator('.photo-active').waitFor()

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.minimize()
    window.restore()
  })
  await page.getByRole('heading', { name: 'Folder locked', exact: true }).waitFor()
  await assertCenteredAccess(page)
  assert.equal(await page.locator('.viewer').count(), 0)
  await app.close()
  await assertNoCleartext(profile, original)
  const folder = path.join(scratch, 'Folio Private')
  await assertNoCleartext(folder, original)
  const moved = path.join(scratch, 'Moved vault')
  await rename(folder, moved)

  page = await launch()
  await button(page, 'Private folder').click()
  await page.getByRole('heading', { name: 'Folder locked', exact: true }).waitFor()
  await unlock(page, password)
  await page.getByRole('alert').filter({ hasText: 'Check the password' }).waitFor()
  await button(page, 'Open an existing folder').click()
  await assertCenteredAccess(page)
  await choose(moved)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await button(page, 'Choose folder…').click()
  await open()
  const before = await page.locator('.photo-active').evaluate(image => [image.naturalWidth, image.naturalHeight])
  await button(page, 'Full screen').click()
  await page.waitForFunction(() => Boolean(document.fullscreenElement))
  await page.evaluate(() => document.exitFullscreen())
  await button(page, 'Edit').click()
  await page.locator('.editor-picture canvas[data-ready="true"]').waitFor()
  const brightness = page.getByRole('slider', { name: 'Brightness', exact: true })
  await brightness.press('ArrowRight')
  assert.ok(Number(await brightness.inputValue()) > 0)
  await button(page, 'Crop').click()
  await button(page, 'Rotate right').click()
  await button(page, 'Save copy').click()
  await page.waitForFunction(name => document.querySelector('.photo-active')?.alt === name, stem + ' (edit)')
  const rendered = await page.locator('.photo-active').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, src: image.src }))
  assert.deepEqual([rendered.width, rendered.height], [before[1], before[0]])
  assert.match(rendered.src, /^data:image\/png;base64,/)
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(name => document.querySelector('.photo-active')?.alt === name, stem)
  await button(page, 'Next file').click()
  await page.waitForFunction(name => document.querySelector('.photo-active')?.alt === name, stem + ' (edit)')
  await assertNoCleartext(moved, Buffer.from(rendered.src.split(',')[1], 'base64'))
  await button(page, 'Delete photo').click()
  const confirm = page.getByRole('dialog', { name: 'Delete private photo?', exact: true })
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await open()
  await button(page, 'Delete photo').click()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('heading', { name: 'No private photos yet', exact: true }).waitFor()
  assert.deepEqual(await readFile(source), original)
  assert.deepEqual(errors, [])
  await app.close()
  app = null
  await assertNoCleartext(profile, Buffer.from(rendered.src.split(',')[1], 'base64'))
  console.log('Private thumbnails, viewer navigation and fullscreen, encrypted edits, locking, reopen, and profile leakage checks passed.')
} finally {
  await app?.close().catch(() => {})
  if (path.dirname(scratch) === base && await realpath(scratch).catch(() => null) === scratch) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
  }
}
