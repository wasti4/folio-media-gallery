import { existsSync, renameSync } from 'node:fs'
import path from 'node:path'

const legacyName = 'Luma'

// Folio was called Luma before. Move that profile once so the library, settings and private folder pointer carry over.
export function profileDirectory(appData, name, override) {
  if (override) return override
  const profile = path.join(appData, name)
  const legacy = path.join(appData, legacyName)
  if (existsSync(profile) || !existsSync(legacy)) return profile
  try {
    renameSync(legacy, profile)
    return profile
  } catch (error) {
    // A running older build can keep the old profile open. Use it for now and try again on the next launch.
    console.error('Profile migration skipped: ' + error.message)
    return legacy
  }
}
