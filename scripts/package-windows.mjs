import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { resolveTool } from '../desktop/playback.mjs'
import { productName } from '../shared/brand.mjs'
import { compileWindowsInstaller, findInnoSetup, windowsSigning } from './build/windows-installer.mjs'

if (process.platform !== 'win32') throw new Error('Сборку для Windows нужно запускать в Windows.')

const args = process.argv.slice(2)
const withInstaller = args.includes('--installer')
const requireSigning = args.includes('--require-signing')
if (args.some(arg => !['--installer', '--require-signing'].includes(arg)) || (requireSigning && !withInstaller)) {
  throw new Error('Использование: npm run package:win -- [--installer [--require-signing]]')
}
const signing = withInstaller ? await windowsSigning(requireSigning) : null
const compiler = withInstaller ? await findInnoSetup() : null

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const electron = require('electron')
const icon = path.join(root, 'build', 'icon.ico')
const release = path.join(root, 'release')
const executableName = productName + '.exe'
await mkdir(release, { recursive: true })
if (await realpath(release) !== release) throw new Error('Каталог release должен находиться внутри проекта.')

function insideRelease(directory) {
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== release) throw new Error('Путь сборки выходит за пределы каталога release.')
  return resolved
}

async function removeBuild(directory) {
  const resolved = await realpath(directory)
  if (resolved !== insideRelease(directory)) throw new Error('Путь сборки указывает за пределы её каталога.')
  await rm(resolved, { recursive: true, force: true })
}

async function executablePath(tool) {
  const resolved = resolveTool(tool)
  if (path.isAbsolute(resolved)) return resolved
  const { stdout } = await execute('where.exe', [resolved + '.exe'], { windowsHide: true }).catch(() => {
    throw new Error('Установите FFmpeg и FFprobe или задайте FOLIO_FFMPEG_DIR для сборки.')
  })
  return stdout.trim().split(/\r?\n/)[0]
}

async function brandedExecutable(destination) {
  const image = Data.IconFile.from(await readFile(icon))
  const binary = NtExecutable.from(await readFile(electron), { ignoreCert: true })
  const resources = NtExecutableResource.from(binary)
  for (const group of Resource.IconGroupEntry.fromEntries(resources.entries)) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, image.icons.map(item => item.data))
  }
  const [version] = Resource.VersionInfo.fromEntries(resources.entries)
  const [major, minor, patch] = metadata.version.split('.').map(Number)
  version.setFileVersion(major, minor, patch, 0, 1033)
  version.setProductVersion(major, minor, patch, 0, 1033)
  version.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: productName + ' Media Gallery', ProductName: productName, InternalName: productName, OriginalFilename: executableName,
  })
  version.outputToResourceEntries(resources.entries)
  resources.outputResource(binary)
  await writeFile(destination, Buffer.from(binary.generate()))
}

async function bundleTools(destination) {
  await mkdir(destination, { recursive: true })
  const notes = ['FFmpeg and FFprobe', 'https://ffmpeg.org/', 'Windows builds https://www.gyan.dev/ffmpeg/builds/', '']
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = await executablePath(name)
    const { stdout } = await execute(file, ['-hide_banner', '-version'], { windowsHide: true })
    notes.push(stdout.trim(), '')
    await copyFile(file, path.join(destination, name + '.exe'))
  }
  const { stdout: license } = await execute(path.join(destination, 'ffmpeg.exe'), ['-hide_banner', '-L'], { windowsHide: true })
  notes.push(license.trim())
  await writeFile(path.join(destination, 'FFmpeg.txt'), notes.join('\n'), 'utf8')
  await copyFile(path.join(root, 'build', 'GPL-3.0.txt'), path.join(destination, 'GPL-3.0.txt'))
}

// Chromium reads a locale file only for its own built-in strings and falls back to en-US for any other
// system language. Folio's interface is translated by the app itself, so the other 52 files are dead weight.
const keptLocales = new Set(['en-US.pak', 'ru.pak', 'zh-CN.pak'])
const shipped = source => source !== electron && path.basename(source) !== 'default_app.asar' &&
  (path.basename(path.dirname(source)) !== 'locales' || keptLocales.has(path.basename(source)))

const buildName = productName + '-' + metadata.version
const firstBuild = insideRelease(path.join(release, buildName))
const destination = await mkdir(firstBuild).then(() => firstBuild).catch(error => {
  if (error.code !== 'EEXIST') throw error
  return mkdtemp(path.join(release, buildName + '-'))
})
let installerStage
try {
  await cp(path.dirname(electron), destination, { recursive: true, filter: shipped })
  const resources = path.join(destination, 'resources')
  const app = path.join(resources, 'app')
  await mkdir(app, { recursive: true })
  for (const directory of ['desktop', 'shared', 'dist']) {
    await cp(path.join(root, directory), path.join(app, directory), { recursive: true })
  }
  await copyFile(path.join(root, 'package.json'), path.join(app, 'package.json'))
  await copyFile(icon, path.join(resources, 'icon.ico'))
  const licenseDirectory = path.join(resources, 'licenses')
  await mkdir(licenseDirectory, { recursive: true })
  for (const name of ['@fontsource-variable/manrope', 'lucide-react', 'react', 'react-dom']) {
    await copyFile(path.join(root, 'node_modules', name, 'LICENSE'), path.join(licenseDirectory, name.split('/').at(-1) + '.txt'))
  }
  await bundleTools(path.join(resources, 'ffmpeg'))
  const executable = path.join(destination, executableName)
  await brandedExecutable(executable)
  if (compiler) {
    if (signing) await signing.sign(executable)
    installerStage = await mkdtemp(path.join(release, '.folio-installer-'))
    const stagedInstaller = await compileWindowsInstaller({
      compiler, payload: destination, output: installerStage, version: metadata.version, signing,
    })
    const installer = insideRelease(path.join(release, path.basename(stagedInstaller)))
    await rename(stagedInstaller, installer)
    console.log(installer)
    if (!signing) console.log('Установщик без цифровой подписи (FOLIO_SIGN_CERT_THUMBPRINT не задан).')
  }
  console.log(executable)
} catch (error) {
  await removeBuild(destination).catch(() => {})
  throw error
} finally {
  if (installerStage) await removeBuild(installerStage).catch(() => {})
}
