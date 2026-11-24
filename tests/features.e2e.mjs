import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

// Watched folders, batch editing and updates, end to end. Updates come from a local test feed, which only a
// development run accepts, so this test always starts Folio from the project folder.
const base = await realpath(tmpdir())
const scratch = await mkdtemp(path.join(base, 'folio-features-'))
const profile = path.join(scratch, 'profile')
const watched = path.join(scratch, 'Screenshots')
const capture = process.env.FOLIO_FEATURES_CAPTURE_DIR
const installer = randomBytes(1536 * 1024)
const errors = []
let app
let server

const button = (page, name) => page.getByRole('button', { name, exact: true })
const shot = (page, name) => capture && page.screenshot({ path: path.join(capture, name + '.png') })

function serveUpdates() {
  const routes = new Map()
  server = createServer((request, response) => {
    const route = routes.get(request.url)
    if (!route) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Type': route.type, 'Content-Length': route.body.length })
    response.end(route.body)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + server.address().port
    const release = {
      tag_name: 'v99.0.0', draft: false, prerelease: false, html_url: origin + '/releases/v99.0.0',
      assets: [{ name: 'Folio-99.0.0-Setup.exe', size: installer.length, browser_download_url: origin + '/download/setup.exe',
        digest: 'sha256:' + createHash('sha256').update(installer).digest('hex') }],
    }
    routes.set('/releases/latest', { type: 'application/json', body: Buffer.from(JSON.stringify(release)) })
    routes.set('/download/setup.exe', { type: 'application/octet-stream', body: installer })
    resolve(origin + '/releases/latest')
  }))
}

try {
  const feed = await serveUpdates()
  const settingsFile = path.join(profile, 'Library', 'appearance.json')
  await mkdir(path.dirname(settingsFile), { recursive: true })
  await mkdir(watched, { recursive: true })
  await writeFile(settingsFile, JSON.stringify({ onboarded: true, language: 'en', theme: 'dark', updates: { automatic: false } }))
  await copyFile('public/demo/shore.jpg', path.join(watched, 'Shore.jpg'))
  await copyFile('public/demo/forest.jpg', path.join(watched, 'Forest.jpg'))

  app = await electron.launch({ args: ['.'], env: { ...process.env, FOLIO_TEST_PROFILE: profile, FOLIO_UPDATE_FEED: feed } })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, watched)

  // A watched folder is imported right away and keeps bringing in what appears in it later.
  await button(page, 'Settings').click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await button(settings, 'Watch a folder…').click()
  await settings.getByText(watched, { exact: true }).waitFor()
  await page.getByText('Added 2 files', { exact: true }).waitFor()
  await shot(page, 'settings')

  // Updates: a manual check finds the test release, and the installer is downloaded and verified.
  await button(settings, 'Check now').click()
  await settings.getByText('Version 99.0.0 is available', { exact: true }).waitFor()
  await button(settings, 'Download update').click()
  await settings.getByText('Version 99.0.0 is downloaded and ready to install', { exact: true }).waitFor()
  await button(settings, 'Restart and update').waitFor()
  assert.deepEqual(await readFile(path.join(profile, 'Updates', 'Folio-99.0.0-Setup.exe')), installer)
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).updates.automatic, false)
  await settings.getByRole('checkbox', { name: 'Check for updates automatically', exact: true }).check()
  await page.waitForFunction(async () => (await window.folio.updates.status()).automatic === true)
  await shot(page, 'updates')
  await button(settings, 'Close').click()

  await button(page, 'Open “Shore”').waitFor()
  await copyFile('public/demo/lake.jpg', path.join(watched, 'Lake.jpg'))
  await copyFile('public/demo/lake.jpg', path.join(watched, 'Lake again.jpg'))
  await writeFile(path.join(watched, 'Draft.jpg.crdownload'), 'still downloading')
  await page.getByText('1 file added from Screenshots', { exact: true }).waitFor({ timeout: 30000 })
  await page.waitForTimeout(3000)
  const lakes = (await page.evaluate(() => window.folio.state())).items.filter(item => item.name.startsWith('Lake'))
  assert.equal(lakes.length, 1, 'an exact copy is skipped')
  assert.equal((await page.evaluate(() => window.folio.state())).items.some(item => item.name.startsWith('Draft')), false)

  // Batch editing: two photos get the same look, and each is saved as a new copy.
  const before = (await page.evaluate(() => window.folio.state())).items.length
  await button(page, 'Select').click()
  await page.getByRole('checkbox', { name: 'Select “Shore”', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Select “Forest”', exact: true }).click()
  await button(page, 'Edit selected photos').click()
  const editor = page.getByRole('dialog', { name: 'Batch edit', exact: true })
  await editor.locator('canvas').waitFor()
  assert.equal(await button(editor, 'Save copies').isDisabled(), true, 'nothing to save before a change')
  await button(editor, 'Mono').click()
  await button(editor, 'Rotate right').click()
  await button(editor, 'Show Forest').click()
  await editor.locator('canvas').waitFor()
  await shot(page, 'batch-editor')
  await button(editor, 'Save copies').click()
  await page.getByText('Copies saved: 2', { exact: true }).waitFor({ timeout: 30000 })
  const after = (await page.evaluate(() => window.folio.state())).items
  assert.equal(after.length, before + 2)
  const copies = after.filter(item => item.name.endsWith('(edit)'))
  assert.deepEqual(copies.map(item => item.name).sort(), ['Forest (edit)', 'Shore (edit)'])
  assert.equal(await editor.count(), 0)

  // Stop watching: the folder stays in the library, new files no longer arrive. The settings button now
  // carries a mark for the waiting update.
  await button(page, 'Settings — update available').click()
  await button(settings, 'Stop watching Screenshots').click()
  await settings.getByText(watched, { exact: true }).waitFor({ state: 'detached' })
  await button(settings, 'Close').click()
  await copyFile('public/demo/tram.jpg', path.join(watched, 'Tram.jpg'))
  await page.waitForTimeout(7000)
  assert.equal(await button(page, 'Open “Tram”').count(), 0)
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')).watchedFolders, [])
  assert.deepEqual(errors, [])
  console.log('Watched folders, batch editing and updates passed.')
} finally {
  await app?.close().catch(() => {})
  server?.close()
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}
