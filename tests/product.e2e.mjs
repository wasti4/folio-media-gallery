import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const base = await realpath(tmpdir())
const scratch = await mkdtemp(path.join(base, 'folio-18-'))
const profile = path.join(scratch, 'profile')
const source = path.join(scratch, 'Travel')
const destination = path.join(scratch, 'Library on D')
const backups = path.join(scratch, 'Backups')
const appearance = path.join(profile, 'Library', 'appearance.json')
const executable = process.env.FOLIO_TEST_EXE
const errors = []
let app

async function launch() {
  app = await electron.launch({
    args: executable ? [] : ['.'], ...(executable && { executablePath: path.resolve(executable) }),
    env: { ...process.env, LUMA_TEST_PROFILE: profile },
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  return page
}

async function choose(files) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
  }, files)
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const menu = (page, name) => page.getByRole('menuitem', { name, exact: true })
const search = page => page.getByRole('searchbox', { name: 'Search the library', exact: true })

try {
  await Promise.all([source, destination, backups, path.dirname(appearance)].map(folder => mkdir(folder, { recursive: true })))
  await writeFile(appearance, JSON.stringify({ onboarded: true, theme: 'dark', language: 'en' }))
  const coast = path.join(source, 'Coast.jpg')
  const forest = path.join(source, 'Forest.jpg')
  const duplicate = path.join(scratch, 'Coast copy.jpg')
  await copyFile('public/demo/shore.jpg', coast)
  await copyFile('public/demo/forest.jpg', forest)
  await copyFile(coast, duplicate)
  const may = new Date(2021, 4, 14, 12)
  const june = new Date(2022, 5, 14, 12)
  await utimes(coast, may, may)
  await utimes(forest, june, june)

  let page = await launch()
  await choose([source])
  await button(page, 'Import').click()
  await menu(page, 'Add folder').click()
  await button(page, 'Open “Coast”').waitFor()

  await app.evaluate(({ dialog }) => {
    globalThis.checkedDuplicates = []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.checkedDuplicates.push({ title: options.title, detail: options.detail })
      return { response: 0 }
    }
  })
  await choose([duplicate])
  await button(page, 'Import').click()
  await menu(page, 'Add files').click()
  await page.getByText('Skipped 1 duplicate', { exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.checkedDuplicates), [{ title: 'Exact duplicates', detail: 'Coast copy.jpg' }])
  assert.equal(await button(page, 'Open “Coast copy”').count(), 0)

  await button(page, 'Actions for “Coast”').click()
  await menu(page, 'Edit tags').click()
  await page.getByRole('textbox', { name: 'Tags', exact: true }).fill('Sea, Trip')
  await button(page, 'Save').click()
  await search(page).fill('Trip')
  await button(page, 'Open “Coast”').waitFor()
  assert.equal(await button(page, 'Open “Forest”').count(), 0)
  await search(page).fill('')
  await button(page, 'Filters').click()
  await page.getByRole('combobox', { name: 'Year', exact: true }).selectOption('2022')
  await button(page, 'Open “Forest”').waitFor()
  assert.equal(await button(page, 'Open “Coast”').count(), 0)
  await button(page, 'Clear filters').click()

  await button(page, 'Select').click()
  await page.getByRole('checkbox', { name: 'Select “Coast”', exact: true }).click()
  await button(page, 'Move to folder').click()
  await menu(page, 'New folder…').click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Moved photos')
  await button(page, 'Create').click()
  await page.locator('.selection-dock').waitFor({ state: 'detached' })
  await button(page, 'Undo move').waitFor()
  await page.keyboard.press('Control+z')
  await page.getByText('Move undone', { exact: true }).waitFor()
  assert.equal(await button(page, 'Undo move').count(), 0)

  await button(page, 'Actions for “Coast”').click()
  await menu(page, 'Delete photo').click()
  await page.getByRole('dialog', { name: 'Delete photo', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  const sidebarToggle = page.locator('.sidebar-toggle')
  if (await sidebarToggle.getAttribute('aria-expanded') === 'false') await sidebarToggle.click()
  for (const [languageMenu, language, full, short] of [
    ['Interface language', 'Русский', 'Недавно удалённые', 'Удалённые'],
    ['Язык интерфейса', '简体中文', '最近删除', '已删除'],
    ['界面语言', 'English', 'Recently deleted', 'Deleted'],
  ]) {
    await button(page, languageMenu).click()
    await page.getByRole('menuitemcheckbox', { name: language, exact: true }).click()
    const deleted = button(page, full)
    const label = deleted.locator('.side-name')
    assert.equal(await label.textContent(), short)
    await label.evaluate(() => document.fonts.ready.then(() => true))
    assert.ok(await label.evaluate(node => node.scrollWidth <= node.clientWidth), `${short} should fit on one line`)
    assert.equal(await deleted.getAttribute('title'), full)
  }
  await button(page, 'Recently deleted').click()
  await button(page, 'Restore “Coast”').click()
  await page.getByRole('heading', { name: 'No deleted photos yet', exact: true }).waitFor()
  await button(page, 'All files').click()
  await button(page, 'Open “Coast”').waitFor()

  await button(page, 'Library settings').click()
  const settings = page.getByRole('dialog', { name: 'Library settings', exact: true })
  await choose([destination])
  await button(settings, 'Move library…').click()
  await settings.getByText(destination, { exact: true }).waitFor()
  await choose([backups])
  await button(settings, 'Choose folder…').click()
  await settings.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('daily')
  await page.waitForFunction(async () => (await window.luma.librarySettings()).backup.frequency === 'daily')
  await app.close()

  const config = JSON.parse(await readFile(appearance, 'utf8'))
  config.automaticBackup.since = Date.now() - 2 * 86_400_000
  await writeFile(appearance, JSON.stringify(config))
  page = await launch()
  await button(page, 'Open “Coast”').waitFor()
  const settingsData = await page.waitForFunction(async () => {
    const next = await window.luma.librarySettings()
    return next.backup.lastSuccessAt ? next : null
  }, undefined, { timeout: 15000 }).then(value => value.jsonValue())
  assert.equal(settingsData.directory, destination)
  assert.ok(settingsData.mediaBytes > 0)
  const manifest = JSON.parse(await readFile(path.join(settingsData.backup.lastDirectory, 'folio-library.json'), 'utf8'))
  assert.deepEqual(manifest.items.find(item => item.filename === 'Coast.jpg').tags, ['Sea', 'Trip'])
  assert.equal(manifest.items.length, 2)
  assert.deepEqual(errors, [])
  console.log('Duplicate prompt, tags, date filters, undo, photo recovery, storage relocation and scheduled backup passed.')
} finally {
  await app?.close().catch(() => {})
  if (path.dirname(scratch) === base && await realpath(scratch).catch(() => null) === scratch) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
  }
}
