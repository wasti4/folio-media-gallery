import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PrivateVault } from '../desktop/private-vault.mjs'

const password = 'evening coast private phrase'
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0d0AAAAASUVORK5CYII=', 'base64')

async function fixture(t) {
  const temp = await realpath(tmpdir())
  const base = await mkdtemp(path.join(temp, 'folio-vault-'))
  t.after(async () => {
    if (path.dirname(base) === temp && await realpath(base).catch(() => null) === base) {
      await rm(base, { recursive: true, force: true })
    }
  })
  return base
}

test('a private vault encrypts names and bytes and rejects damaged records and stale catalog writes', async t => {
  const base = await fixture(t)
  const profile = path.join(base, 'profile')
  await mkdir(profile)
  const file = path.join(base, 'Personal-name.png')
  await writeFile(file, photo)
  const pointer = path.join(profile, 'private-vault.json')
  const vault = await PrivateVault.open(pointer)
  assert.deepEqual(vault.status(), { configured: false, unlocked: false, items: [] })
  await assert.rejects(vault.create(base, 'short'), { code: 'PASSWORD_LENGTH' })
  await vault.create(base, password)
  assert.equal((await vault.addFiles([file, path.join(base, 'unsupported.svg')])).added, 1)
  const item = vault.status().items[0]
  assert.equal(item.name, 'Personal-name.png')
  assert.equal(await vault.readImage(item.id), 'data:image/png;base64,' + photo.toString('base64'))
  const { directory } = JSON.parse(await readFile(pointer, 'utf8'))
  for (const name of await readdir(directory)) {
    const encrypted = await readFile(path.join(directory, name))
    assert.equal(encrypted.includes(photo), false)
    assert.equal(encrypted.includes(Buffer.from(item.name)), false)
    assert.equal(encrypted.includes(Buffer.from(password)), false)
    assert.equal(name.includes(item.name), false)
  }
  assert.deepEqual(await readFile(file), photo)
  vault.lock()
  assert.deepEqual(vault.status(), { configured: true, unlocked: false, items: [] })
  await assert.rejects(vault.readImage(item.id), { code: 'LOCKED' })

  const reopened = await PrivateVault.open(pointer)
  await assert.rejects(reopened.unlock('wrong password'), { code: 'UNLOCK_FAILED' })
  assert.equal(reopened.status().unlocked, false)
  await reopened.unlock(password)
  const generation = reopened.generation
  const edit = await reopened.saveCopy(item.id, 'data:image/png;base64,' + photo.toString('base64'), generation)
  assert.equal(edit.items.at(-1).name, 'Personal-name (edit).png')
  assert.deepEqual(await reopened.remove(edit.id).then(status => status.items), [item])
  const stored = path.join(directory, item.id + '.bin')
  const damaged = await readFile(stored)
  damaged[20] ^= 1
  await writeFile(stored, damaged)
  await assert.rejects(reopened.readImage(item.id), { code: 'PHOTO_DAMAGED' })

  const otherProfile = path.join(base, 'other-profile')
  await mkdir(otherProfile)
  const other = await PrivateVault.open(path.join(otherProfile, 'private-vault.json'))
  await other.connect(directory, password)
  assert.deepEqual(other.status().items, [item])
  const lockFile = path.join(directory, '.write-lock')
  await writeFile(lockFile, '')
  await assert.rejects(other.addFiles([file]), { code: 'IN_USE' })
  await unlink(lockFile)
  assert.equal((await other.remove(item.id)).cleanupFailed, false)
  assert.deepEqual(other.status().items, [])
  await assert.rejects(lstat(stored), { code: 'ENOENT' })
  await assert.rejects(reopened.addFiles([file]), { code: 'CHANGED' })
  assert.deepEqual(await readdir(directory), ['vault.dat'])
  reopened.lock()
  await reopened.unlock(password)
  await assert.rejects(reopened.saveCopy(item.id, 'data:image/png;base64,' + photo.toString('base64'), generation), { code: 'LOCKED' })
  assert.deepEqual(await readFile(file), photo)
  other.lock()
  reopened.lock()
})

test('locking cancels an in-flight password check', async t => {
  const base = await fixture(t)
  const vault = await PrivateVault.open(path.join(base, 'private-vault.json'))
  await vault.create(base, password)
  vault.lock()
  const attempt = vault.unlock(password)
  vault.lock()
  await assert.rejects(attempt, { code: 'LOCKED' })
  assert.equal(vault.status().unlocked, false)
})
