import path from 'node:path'

const day = 24 * 60 * 60_000
const retryWait = 15 * 60_000
export const backupInterval = Object.freeze({ daily: day, weekly: 7 * day })
const time = value => Number.isFinite(value) && value > 0 ? value : null

export function backupSettings(value, now = Date.now()) {
  return {
    directory: typeof value?.directory === 'string' && path.isAbsolute(value.directory) ? value.directory : '',
    frequency: Object.hasOwn(backupInterval, value?.frequency) ? value.frequency : 'off',
    since: time(value?.since) ?? now,
    lastSuccessAt: time(value?.lastSuccessAt),
    lastDirectory: typeof value?.lastDirectory === 'string' ? value.lastDirectory : '',
    lastAttemptAt: time(value?.lastAttemptAt),
    lastFailure: typeof value?.lastFailure === 'string' ? value.lastFailure : '',
  }
}

export function createBackupSchedule({ read, save, available, backup, now = Date.now }) {
  let running
  function status() {
    const settings = backupSettings(read(), now())
    let nextAt = settings.directory && backupInterval[settings.frequency]
      ? (settings.lastSuccessAt ?? settings.since) + backupInterval[settings.frequency] : null
    if (nextAt && settings.lastFailure && settings.lastAttemptAt) nextAt = Math.max(nextAt, settings.lastAttemptAt + retryWait)
    return { ...settings, nextAt, running: Boolean(running) }
  }

  function tick() {
    if (running) return running
    const settings = status()
    if (!available() || !settings.nextAt || now() < settings.nextAt) return Promise.resolve(null)
    const attemptedAt = now()
    running = Promise.resolve().then(async () => {
      let result
      let failure
      try {
        result = await backup(settings.directory)
      } catch (error) {
        failure = error?.message || 'Не удалось создать резервную копию.'
      }
      const current = backupSettings(read(), now())
      if (current.directory === settings.directory && current.frequency === settings.frequency && current.since === settings.since) {
        const outcome = result ? { lastSuccessAt: now(), lastDirectory: result.directory } : {}
        await save({ ...current, ...outcome, lastAttemptAt: attemptedAt, lastFailure: failure ?? '' })
      }
      return result ?? null
    }).finally(() => { running = null })
    return running
  }

  return { status, tick }
}
