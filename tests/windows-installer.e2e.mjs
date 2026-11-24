import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { compileWindowsInstaller, findInnoSetup } from '../scripts/build/windows-installer.mjs'
import { installerArguments } from '../desktop/updates.mjs'

if (process.platform !== 'win32') throw new Error('This test requires Windows.')
const [previousPayload, nextPayload, workDirectory] = process.argv.slice(2)
assert.ok(previousPayload && nextPayload && workDirectory,
  'Usage: node tests/windows-installer.e2e.mjs <previous portable folder> <next portable folder> <test work directory>')

const execute = promisify(execFile)
const work = await realpath(workDirectory)
const scratch = await mkdtemp(path.join(work, 'folio-installer-test-'))
const install = path.join(scratch, 'Installed Folio')
const profile = path.join(scratch, 'Test profile')
const installerId = 'FolioTest-' + randomUUID().replaceAll('-', '')
const entry = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + installerId + '_is1'
const original = path.join(scratch, 'Installer test.jpg')
const executable = path.join(install, 'Folio.exe')
const libraryFile = path.join(profile, 'Library', 'library.json')
const appearanceFile = path.join(profile, 'Library', 'appearance.json')
const env = { ...process.env, FOLIO_TEST_PROFILE: profile, TEMP: scratch, TMP: scratch }
const silent = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']
let app
let passed = false

const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const readVersion = async payload => (await readJson(path.join(payload, 'resources', 'app', 'package.json'))).version
const exists = async file => access(file).then(() => true, () => false)
const run = (file, args) => execute(file, args, { env, windowsHide: true, timeout: 120000 })

async function registeredVersion() {
  const { stdout } = await run('reg.exe', ['query', entry, '/v', 'DisplayVersion', '/reg:64'])
  return stdout.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1]
}

async function uninstall() {
  const files = await readdir(install).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const uninstaller = files.find(file => /^unins\d{3}\.exe$/i.test(file))
  if (!uninstaller) return false
  await run(path.join(install, uninstaller), [...silent, '/LOG=' + path.join(scratch, 'uninstall.log')])
  return true
}

async function launch(version) {
  app = await electron.launch({ executablePath: executable, env, timeout: 30000 })
  const actual = await app.evaluate(({ app }) => ({ version: app.getVersion(), profile: app.getPath('userData') }))
  assert.equal(actual.version, version)
  assert.equal(actual.profile, profile)
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.folio))
  return page
}

async function close() {
  await app.close()
  app = undefined
}

// Folio processes started from the test installation, wherever they came from.
async function installedProcesses() {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name = 'Folio.exe'\" | ForEach-Object { [string]$_.ProcessId + '|' + $_.ExecutablePath }"])
  const target = path.resolve(executable).toLowerCase()
  return stdout.split(/\r?\n/).map(line => line.trim().split('|')).filter(([, file]) => file && path.resolve(file).toLowerCase() === target)
    .map(([pid]) => Number(pid))
}

async function waitForProcesses(present) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const running = await installedProcesses()
    if (present ? running.length : !running.length) return running
    await delay(250)
  }
  return installedProcesses()
}

try {
  const previous = await readVersion(previousPayload)
  const next = await readVersion(nextPayload)
  assert.notEqual(previous, next, 'Installers must contain different packaged app versions.')
  const compiler = await findInnoSetup()
  const oldSetup = await compileWindowsInstaller({ compiler, payload: await realpath(previousPayload), output: scratch,
    version: previous, testId: installerId })
  const newSetup = await compileWindowsInstaller({ compiler, payload: await realpath(nextPayload), output: scratch,
    version: next, testId: installerId })

  await mkdir(profile)
  await copyFile(new URL('../public/demo/shore.jpg', import.meta.url), original)
  const source = await readFile(original)
  await assert.rejects(() => run(oldSetup, [...silent, '/LANG=english', '/DIR=' + profile,
    '/LOG=' + path.join(scratch, 'library-guard.log')]), { code: 7 })
  assert.deepEqual(await readdir(profile), [])
  await run(oldSetup, [...silent, '/LANG=english', '/DIR=' + install, '/LOG=' + path.join(scratch, 'install.log')])
  assert.equal(await registeredVersion(), previous)
  await mkdir(path.dirname(appearanceFile), { recursive: true })
  await writeFile(appearanceFile, JSON.stringify({ onboarded: true }))
  let page = await launch(previous)
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
  }, original)

  const imported = await page.evaluate(async () => {
    const { state, added } = await window.folio.import('files')
    const item = state.items.find(item => item.filename === 'Installer test.jpg')
    if (!item) throw new Error('The imported photo was not present in the previous version.')
    await window.folio.favorite(item.id)
    const collection = await window.folio.createCollection('Installer test collection')
    await window.folio.toggleCollection(collection.id, item.id)
    const openedAt = await window.folio.opened(item.id)
    await window.folio.theme('dark')
    return { added, itemId: item.id, collectionId: collection.id, openedAt }
  })
  assert.equal(imported.added, 1)
  await close()
  await unlink(original)
  const beforeUpdate = await readJson(libraryFile)
  const appearanceBeforeUpdate = await readJson(appearanceFile)
  const stored = path.join(profile, 'Library', 'Media', ...beforeUpdate.items[imported.itemId].stored.split('/'))
  assert.deepEqual(await readFile(stored), source)

  const unrelated = path.join(install, 'Unmanaged note.txt')
  await writeFile(unrelated, 'Retain files outside the installer inventory.')
  // Omit /DIR: the new installer must find the registered custom location.
  await run(newSetup, [...silent, '/LANG=russian', '/LOG=' + path.join(scratch, 'upgrade.log')])
  assert.deepEqual(await installedProcesses(), [], 'a plain silent install does not start Folio')
  assert.equal(await registeredVersion(), next)
  assert.equal(await readVersion(install), next)
  assert.deepEqual(await readJson(libraryFile), beforeUpdate)
  assert.deepEqual(await readJson(appearanceFile), appearanceBeforeUpdate)
  assert.deepEqual(await readFile(stored), source)
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const { stdout } = await run(path.join(install, 'resources', 'ffmpeg', tool + '.exe'), ['-version'])
    assert.ok(stdout.startsWith(tool + ' version '))
  }

  page = await launch(next)
  const state = await page.evaluate(() => window.folio.state())
  const item = state.items.find(item => item.id === imported.itemId)
  assert.equal(item?.favorite, true)
  assert.equal(item.openedAt, imported.openedAt)
  assert.deepEqual(state.folders.find(folder => folder.id === imported.collectionId)?.members, [item.id])
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark')
  const accessible = await page.evaluate(async url => {
    const response = await fetch(url)
    return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength }
  }, item.url)
  assert.deepEqual(accessible, { ok: true, bytes: source.length })
  await close()
  // Folio's own updater runs the installer silently and expects Folio to come back once the files are in place.
  await run(newSetup, [...installerArguments('en'), '/LOG=' + path.join(scratch, 'self-update.log')])
  const relaunched = await waitForProcesses(true)
  assert.ok(relaunched.length > 0, 'the updater arguments restart Folio after installing')
  for (const pid of relaunched) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => {})
  assert.deepEqual(await waitForProcesses(false), [])
  assert.equal(await registeredVersion(), next)
  const beforeUninstall = await readJson(libraryFile)
  const appearanceBeforeUninstall = await readJson(appearanceFile)

  assert.equal(await uninstall(), true)
  for (let attempt = 0; attempt < 40 && await exists(executable); attempt++) await delay(250)
  assert.equal(await exists(executable), false)
  await assert.rejects(() => registeredVersion(), { code: 1 })
  assert.equal(await readFile(unrelated, 'utf8'), 'Retain files outside the installer inventory.')
  assert.deepEqual(await readJson(libraryFile), beforeUninstall)
  assert.deepEqual(await readJson(appearanceFile), appearanceBeforeUninstall)
  assert.deepEqual(await readFile(stored), source)
  passed = true
  console.log(`Folio ${previous} → ${next}: per-user install, custom location reuse, bundled FFmpeg tools, preserved original, favorite, collection, history and theme, relaunch after a self-update, and library retained after uninstall.`)
} finally {
  if (app) await close().catch(error => console.error(error.message))
  if (passed) {
    if (path.dirname(await realpath(scratch)) !== work) throw new Error('Installer test output escaped its work directory.')
    await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
  } else {
    await uninstall().catch(error => console.error(error.message))
    console.error('Installer test workspace retained at ' + scratch)
  }
}
