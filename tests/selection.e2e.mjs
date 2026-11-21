import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const base = await realpath(tmpdir())
const scratch = await mkdtemp(path.join(base, 'folio-selection-'))
const profile = path.join(scratch, 'profile')
const source = path.join(scratch, 'source')
const incoming = path.join(source, 'Incoming')
const archive = path.join(source, 'Archive')
const target = process.env.FOLIO_TEST_EXE
const captures = process.env.FOLIO_SELECTION_CAPTURE_DIR
let app

try {
  const settings = path.join(profile, 'Library', 'appearance.json')
  await mkdir(path.dirname(settings), { recursive: true })
  await writeFile(settings, JSON.stringify({ onboarded: true, language: 'en', theme: 'dark' }))
  await Promise.all([incoming, archive].map(folder => mkdir(folder, { recursive: true })))
  const original = path.resolve('public/demo/shore.jpg')
  await Promise.all(['Alba', 'Bloom', 'Coast', 'Dune'].map(name => copyFile(original, path.join(incoming, name + '.jpg'))))
  await copyFile(original, path.join(archive, 'Extra.jpg'))
  app = await electron.launch({
    args: target ? [] : ['.'], ...(target && { executablePath: path.resolve(target) }),
    env: { ...process.env, LUMA_TEST_PROFILE: profile },
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const button = name => page.getByRole('button', { name, exact: true })
  const menu = name => page.getByRole('menuitem', { name, exact: true })
  const check = name => page.getByRole('checkbox', { name: 'Select “' + name + '”', exact: true })
  const photo = name => button('Open “' + name + '”')
  const capture = name => captures && page.screenshot({ path: path.join(captures, name + '.png') })

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, source)
  await button('Import').click()
  await menu('Add folder').click()
  await photo('Alba').waitFor()
  await button('Expand sidebar').click()
  await button('Incoming').click()
  await page.locator('.sort-button').click()
  await page.getByRole('menuitemcheckbox', { name: 'By name', exact: true }).click()
  await button('Select').click()
  await check('Alba').click()
  await check('Coast').click({ modifiers: ['Shift'] })
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 3)
  assert.equal(await page.locator('.selection-count').innerText(), '3 selected')
  await capture('selection')

  await page.evaluate(() => {
    window.photoFlights = []
    window.photoReflows = 0
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target.hasAttribute('data-photo-reflow')) window.photoReflows++
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.photo-flight')) window.photoFlights.push(node.dataset.action)
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-photo-reflow'] })
  })

  await button('Move to folder').click()
  await capture('folder-picker')
  await menu('New folder…').click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Picks')
  await button('Create').click()
  if (captures) {
    await page.locator('.photo-flight').first().waitFor()
    await page.waitForFunction(() => document.querySelector('.photo-flight')?.getAnimations()[0]?.currentTime > 90)
    await capture('folder-flight')
  }
  await photo('Dune').waitFor()
  await page.waitForFunction(() => window.photoFlights.filter(action => action === 'move').length >= 3)
  assert.ok(await page.evaluate(() => window.photoReflows > 0))
  assert.equal(await photo('Alba').count(), 0)
  await button('Picks').click()
  await photo('Coast').waitFor()
  assert.equal(await page.locator('.media-card').count(), 3)
  await button('Select').click()
  await check('Alba').click()
  await button('Move to folder').click()
  await menu('Archive').click()
  await photo('Bloom').waitFor()
  await page.waitForFunction(() => !document.querySelector('.selection-dock'))
  assert.equal(await photo('Alba').count(), 0)

  await button('Select').click()
  await page.keyboard.press('Control+a')
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 2)
  await page.keyboard.press('Delete')
  const confirm = page.getByRole('dialog', { name: 'Delete photos', exact: true })
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 2)
  await button('Delete selected photos').click()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('heading', { name: 'No files here yet', exact: true }).waitFor()
  await page.waitForFunction(() => window.photoFlights.filter(action => action === 'remove').length >= 2)
  await button('Archive').click()
  await photo('Alba').waitFor()
  assert.equal(await photo('Extra').count(), 1)

  await button('Incoming').click()
  await photo('Dune').click()
  await page.waitForFunction(() => document.querySelector('.photo-active')?.naturalWidth > 0)
  await button('Delete photo').click()
  await page.getByRole('dialog', { name: 'Delete photo', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await page.waitForFunction(() => window.photoFlights.filter(action => action === 'remove').length >= 3)
  await button('Archive').click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const flights = await page.evaluate(() => window.photoFlights.length)
  await button('Select').click()
  await check('Extra').click()
  await button('Delete selected photos').click()
  await page.getByRole('dialog', { name: 'Delete photo', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await photo('Alba').waitFor()
  assert.equal(await photo('Extra').count(), 0)
  assert.equal(await page.evaluate(() => window.photoFlights.length), flights)
  assert.ok((await readFile(path.join(incoming, 'Bloom.jpg'))).length > 0)
  assert.ok((await readFile(path.join(incoming, 'Dune.jpg'))).length > 0)
  assert.deepEqual(errors, [])
  console.log('Range selection, select all, folder placement, recycling, thumbnail flights, card reflow and reduced motion passed.')
} finally {
  await app?.close().catch(() => {})
  if (await realpath(scratch) === scratch && path.dirname(scratch) === base) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
  }
}
