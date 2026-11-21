import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createBackupSchedule, backupInterval } from '../desktop/backup-schedule.mjs'

const location = path.resolve('backup drive')
const start = Date.UTC(2025, 0, 12)

test('a daily backup waits until due, then records the verified backup location once', async () => {
  let settings = { directory: location, frequency: 'daily', since: start }
  let now = start
  let copies = 0
  const schedule = createBackupSchedule({
    read: () => settings, save: value => { settings = value }, now: () => now, available: () => true,
    backup: async directory => {
      assert.equal(directory, location)
      copies += 1
      return { directory: path.join(location, 'Folio-snapshot'), count: 2 }
    },
  })
  await schedule.tick()
  assert.equal(copies, 0)
  assert.equal(schedule.status().nextAt, start + backupInterval.daily)
  now += backupInterval.daily
  await Promise.all([schedule.tick(), schedule.tick()])
  assert.equal(copies, 1)
  assert.equal(schedule.status().lastSuccessAt, now)
  assert.equal(schedule.status().lastDirectory, path.join(location, 'Folio-snapshot'))
  await schedule.tick()
  assert.equal(copies, 1)
})

test('an unavailable backup drive reports the failed attempt and retries without erasing previous success', async () => {
  let now = start + backupInterval.weekly
  let settings = { directory: location, frequency: 'weekly', since: start, lastSuccessAt: start, lastDirectory: 'previous' }
  let available = false
  let copies = 0
  const schedule = createBackupSchedule({
    read: () => settings, save: value => { settings = value }, now: () => now, available: () => available,
    backup: async () => { copies += 1; throw Object.assign(new Error('drive offline'), { code: 'ENOENT' }) },
  })
  await schedule.tick()
  assert.equal(copies, 0)
  available = true
  await schedule.tick()
  assert.equal(copies, 1)
  assert.equal(settings.lastSuccessAt, start)
  assert.equal(schedule.status().lastFailure, 'drive offline')
  await schedule.tick()
  assert.equal(copies, 1)
  now += 16 * 60_000
  await schedule.tick()
  assert.equal(copies, 2)
})
