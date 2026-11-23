import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { profileDirectory } from '../desktop/profile.mjs'

async function scratch(run) {
  const appData = await mkdtemp(path.join(tmpdir(), 'folio-profile-'))
  try {
    await run(appData)
  } finally {
    await rm(appData, { recursive: true, force: true })
  }
}

test('the former Luma profile moves to Folio with its library intact', () => scratch(async appData => {
  const legacy = path.join(appData, 'Luma')
  await mkdir(path.join(legacy, 'Library'), { recursive: true })
  await writeFile(path.join(legacy, 'Library', 'library.json'), '{"version":2}')
  const profile = profileDirectory(appData, 'Folio')
  assert.equal(profile, path.join(appData, 'Folio'))
  assert.equal(await readFile(path.join(profile, 'Library', 'library.json'), 'utf8'), '{"version":2}')
  await assert.rejects(readFile(path.join(legacy, 'Library', 'library.json')), { code: 'ENOENT' })
}))

test('an existing Folio profile wins and the Luma folder stays untouched', () => scratch(async appData => {
  await mkdir(path.join(appData, 'Folio'))
  await mkdir(path.join(appData, 'Luma'))
  await writeFile(path.join(appData, 'Luma', 'library.json'), 'old')
  assert.equal(profileDirectory(appData, 'Folio'), path.join(appData, 'Folio'))
  assert.equal(await readFile(path.join(appData, 'Luma', 'library.json'), 'utf8'), 'old')
}))

test('a fresh install and a test profile override need no migration', () => scratch(async appData => {
  assert.equal(profileDirectory(appData, 'Folio'), path.join(appData, 'Folio'))
  await mkdir(path.join(appData, 'Luma'))
  const override = path.join(appData, 'test-profile')
  assert.equal(profileDirectory(appData, 'Folio', override), override)
  assert.equal(profileDirectory(appData, 'Folio', ''), path.join(appData, 'Folio'))
}))
