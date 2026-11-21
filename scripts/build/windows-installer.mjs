import { execFile } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./folio.iss', import.meta.url))
const folders = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)

async function firstFile(candidates) {
  for (const candidate of candidates) {
    const file = await stat(candidate).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    })
    if (file?.isFile()) return realpath(candidate)
  }
}

export async function findInnoSetup() {
  const configured = process.env.FOLIO_ISCC_PATH
  const candidates = configured ? [path.resolve(configured)] :
    [7, 6].flatMap(version => folders.map(folder => path.join(folder, 'Inno Setup ' + version, 'ISCC.exe')))
  const compiler = await firstFile(candidates)
  if (compiler) return compiler
  throw new Error('Установите Inno Setup 6.6+ или задайте путь к ISCC.exe в FOLIO_ISCC_PATH.')
}

async function findSignTool() {
  const configured = process.env.FOLIO_SIGNTOOL_PATH
  if (configured) return firstFile([path.resolve(configured)])
  const sdk = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  const versions = (await readdir(sdk).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
    .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
  return firstFile(versions.map(version => path.join(sdk, version, 'x64', 'signtool.exe')))
}

export async function windowsSigning(required) {
  const thumbprint = process.env.FOLIO_SIGN_CERT_THUMBPRINT?.replace(/\s/g, '')
  if (!thumbprint) {
    if (required || process.env.FOLIO_SIGN_CERT_THUMBPRINT !== undefined) {
      throw new Error('Укажите отпечаток сертификата подписи в FOLIO_SIGN_CERT_THUMBPRINT.')
    }
    return null
  }
  if (!/^[0-9a-f]{40}$/i.test(thumbprint)) throw new Error('Некорректный отпечаток FOLIO_SIGN_CERT_THUMBPRINT.')
  const store = process.env.FOLIO_SIGN_CERT_STORE || 'CurrentUser'
  if (store !== 'CurrentUser' && store !== 'LocalMachine') {
    throw new Error('FOLIO_SIGN_CERT_STORE должен быть CurrentUser или LocalMachine.')
  }
  const tool = await findSignTool()
  if (!tool) throw new Error('Установите Windows SDK или задайте FOLIO_SIGNTOOL_PATH.')
  const args = ['sign', '/s', 'My', ...(store === 'LocalMachine' ? ['/sm'] : []), '/sha1', thumbprint,
    '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256']
  const quotedTool = '$q' + tool.replaceAll('$', () => '$$') + '$q'
  async function verify(file) {
    await execute(tool, ['verify', '/pa', '/tw', file], { windowsHide: true })
  }
  return {
    command: quotedTool + ' ' + args.join(' ') + ' $f',
    async sign(file) {
      await execute(tool, [...args, file], { windowsHide: true })
      await verify(file)
    },
    verify,
  }
}

async function assertX64Executable(file) {
  const handle = await open(file)
  try {
    const dos = Buffer.alloc(64)
    const pe = Buffer.alloc(6)
    await handle.read(dos, 0, dos.length, 0)
    await handle.read(pe, 0, pe.length, dos.readUInt32LE(60))
    if (dos.readUInt16LE(0) !== 0x5a4d || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error('Установщик требует 64-разрядную x64-сборку Folio.')
    }
  } finally {
    await handle.close()
  }
}

export async function compileWindowsInstaller({ compiler, payload, output, version, signing, testId }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Некорректная версия установщика Folio.')
  if (testId && (signing || !/^FolioTest-[a-f0-9]{32}$/.test(testId))) {
    throw new Error('Некорректная конфигурация тестового установщика.')
  }
  await assertX64Executable(path.join(payload, 'Folio.exe'))
  const args = ['/Q', '/O' + output, '/DFolioPayload=' + payload, '/DFolioVersion=' + version]
  if (testId) args.push('/DFolioTestId=' + testId)
  if (signing) args.push('/DFolioSigning', '/Sfolio=' + signing.command)
  await execute(compiler, [...args, script], { windowsHide: true })
  const installer = path.join(output, 'Folio-' + version + '-Setup.exe')
  if (signing) await signing.verify(installer)
  return realpath(installer)
}
