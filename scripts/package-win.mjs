/**
 * One-command Windows packaging for GenOffice.
 *
 * Usage (from the repo root, or double-click package.bat):
 *   npm run package:win                    full flow: build everything, pack, verify
 *   node scripts/package-win.mjs --version 1.2.3   set the app version, then package
 *   node scripts/package-win.mjs --bump patch      bump patch (0.10.0 -> 0.10.1), then package
 *   node scripts/package-win.mjs --bump minor      bump minor (0.10.0 -> 0.11.0), then package
 *   node scripts/package-win.mjs --skip-build      reuse the existing apps/ * /out and cli dist
 *   node scripts/package-win.mjs --sidecar         force a sidecar rebuild even if one is staged
 *   node scripts/package-win.mjs --skip-smoke      don't launch the packed app at the end
 *
 * The version lives in apps/shell/package.json ("version"); it names the
 * installer (GenOffice Setup <version>.exe), the installed app, and is baked
 * into the bundled genoffice CLI automatically by electron-builder's
 * beforePack hook.
 *
 * Why this script exists (three packaging pitfalls it works around):
 *
 * 1. Toolchain PATH. `npm run build:all` compiles the sheets sidecar with cargo
 *    (x86_64-pc-windows-gnu), which needs rustup's cargo and a MinGW-w64
 *    toolchain. The script adds the standard rustup and WinLibs (winget)
 *    install locations to PATH automatically, and stages the built sidecar to
 *    the `target/x86_64-pc-windows-gnu/release/` path electron-builder expects.
 *
 * 2. Download mirrors. Electron and the electron-builder binary packages are
 *    fetched from npmmirror unless the standard env vars are already set.
 *
 * 3. Truncated app.asar. electron-builder 26.15.3 can finish "successfully"
 *    while leaving resources/app.asar cut short (the header then references
 *    bytes past EOF and the packaged app exits with code 1 on launch). The
 *    script validates the asar after packing; if it is truncated it re-packs
 *    it with @electron/asar from apps/shell/out and rebuilds the NSIS
 *    installer from the fixed directory via --prepackaged.
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  closeSync,
  readSync,
  fstatSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHELL = join(ROOT, 'apps', 'shell')
const RELEASE = join(SHELL, 'release')
const UNPACKED = join(RELEASE, 'win-unpacked')
const SIDECAR_DEV = join(
  ROOT,
  'apps',
  'sheets',
  'native',
  'xlsx-engine',
  'target',
  'release',
  'xlsx-sidecar.exe',
)
const SIDECAR_STAGED = join(
  ROOT,
  'apps',
  'sheets',
  'native',
  'xlsx-engine',
  'target',
  'x86_64-pc-windows-gnu',
  'release',
  'xlsx-sidecar.exe',
)

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const skipBuild = flags.has('--skip-build')
const forceSidecar = flags.has('--sidecar')
const skipSmoke = flags.has('--skip-smoke')

/** value of `--flag value` / `--flag=value` from the argv list */
function flagValue(flag) {
  const inline = args.find((a) => a.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const at = args.indexOf(flag)
  if (at !== -1 && args[at + 1] && !args[at + 1].startsWith('--')) return args[at + 1]
  return null
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/
const explicitVersion = flagValue('--version')
const bumpPart = flagValue('--bump')
if (explicitVersion && bumpPart) {
  console.error('Use either --version <x.y.z> or --bump <patch|minor|major>, not both.')
  process.exit(1)
}
if (bumpPart && !['patch', 'minor', 'major'].includes(bumpPart)) {
  console.error(`--bump must be patch, minor or major (got "${bumpPart}")`)
  process.exit(1)
}
if (explicitVersion && !SEMVER_RE.test(explicitVersion)) {
  console.error(`--version must be x.y.z (got "${explicitVersion}")`)
  process.exit(1)
}

/**
 * Apply --version / --bump to apps/shell/package.json. This field drives the
 * installer name, the installed app version, and (via electron-builder's
 * beforePack hook) the version baked into the bundled genoffice CLI.
 */
function applyVersionRequest() {
  if (!explicitVersion && !bumpPart) return null
  const pkgPath = join(SHELL, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const current = pkg.version
  let next
  if (explicitVersion) {
    next = explicitVersion
  } else {
    const [maj, min, pat] = current.split('.').map(Number)
    next =
      bumpPart === 'major'
        ? `${maj + 1}.0.0`
        : bumpPart === 'minor'
          ? `${maj}.${min + 1}.0`
          : `${maj}.${min}.${pat + 1}`
  }
  if (next === current) {
    console.log(`[version] already at ${current}`)
    return current
  }
  pkg.version = next
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`[version] ${current} -> ${next} (apps/shell/package.json)`)
  return next
}

/** run a command, streaming output; hard-fail the script on non-zero exit */
function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`)
  const r = spawnSync(cmd, {
    shell: true,
    stdio: 'inherit',
    cwd: ROOT,
    ...opts,
  })
  if (r.status !== 0) {
    console.error(`\ncommand failed (exit ${r.status}): ${cmd}`)
    process.exit(r.status ?? 1)
  }
}

/** true when a file exists and is non-empty */
function nonEmpty(path) {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

// ---- 1. toolchain PATH ------------------------------------------------------

/** add rustup's cargo and any winget-installed WinLibs MinGW to PATH; returns whether cargo is runnable */
function ensureToolchainPaths() {
  const home = process.env.USERPROFILE ?? process.env.HOME
  const extra = []
  const cargoBin = join(home ?? '', '.cargo', 'bin')
  if (existsSync(join(cargoBin, 'cargo.exe'))) extra.push(cargoBin)
  const wingetPkgs = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const dir of readdirSync(wingetPkgs)) {
      if (/^BrechtSanders\.WinLibs/i.test(dir)) {
        const mingwBin = join(wingetPkgs, dir, 'mingw64', 'bin')
        if (existsSync(join(mingwBin, 'gcc.exe'))) extra.push(mingwBin)
      }
    }
  } catch {
    // no winget packages dir: the toolchain may already be on the user's PATH
  }
  // also the layouts setup-dev.bat installs to: the winget-independent
  // GenOfficeTools root (its path is recorded in install-root + the
  // GENOFFICE_TOOLS_ROOT user env var), wherever the user pointed it
  const toolsRoots = []
  const localToolsRoot = join(process.env.LOCALAPPDATA ?? '', 'GenOfficeTools')
  toolsRoots.push(process.env.GENOFFICE_TOOLS_ROOT)
  try {
    toolsRoots.push(readFileSync(join(localToolsRoot, 'install-root'), 'utf8').trim())
  } catch {
    // no marker file: setup-dev.bat has not run on this machine
  }
  for (const root of toolsRoots) {
    if (!root) continue
    const mingwBin = join(root, 'mingw64', 'bin')
    if (existsSync(join(mingwBin, 'gcc.exe'))) extra.push(mingwBin)
  }
  if (extra.length) {
    process.env.PATH = [...extra, process.env.PATH].join(process.platform === 'win32' ? ';' : ':')
    console.log(`[env] added to PATH: ${extra.join(', ')}`)
  }
  const probe = spawnSync('cargo', ['--version'], { shell: true, encoding: 'utf8' })
  return probe.status === 0
}

// ---- 2. sidecar -------------------------------------------------------------

function ensureSidecar(cargoAvailable) {
  if (!forceSidecar && nonEmpty(SIDECAR_STAGED)) {
    console.log('[sidecar] staged x86_64-pc-windows-gnu sidecar already present')
    return
  }
  if (!cargoAvailable) {
    if (nonEmpty(SIDECAR_DEV)) {
      console.log('[sidecar] cargo not on PATH; staging the existing target/release build')
    } else {
      console.error(
        '[sidecar] no sidecar found and cargo is unavailable.\n' +
          'Install Rust (https://rustup.rs, x86_64-pc-windows-gnu toolchain) and a\n' +
          'MinGW-w64 toolchain (winget install BrechtSanders.WinLibs.POSIX.MSVCRT),\n' +
          'then re-run this script.',
      )
      process.exit(1)
    }
  } else {
    console.log('[sidecar] building xlsx-sidecar (release)...')
    run(
      'cargo build --release --manifest-path apps/sheets/native/xlsx-engine/Cargo.toml --config apps/sheets/native/xlsx-engine/.cargo/config.toml',
    )
  }
  mkdirSync(dirname(SIDECAR_STAGED), { recursive: true })
  copyFileSync(SIDECAR_DEV, SIDECAR_STAGED)
  console.log(`[sidecar] staged to ${SIDECAR_STAGED}`)
}

// ---- 3. asar validation / repair -------------------------------------------

const require = createRequire(import.meta.url)

/** read the full asar pickle header; returns { header, dataStart, fileSize } */
function readAsarHeader(path) {
  const fd = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(16)
    readFull(fd, prefix, 0, 16, 0)
    const pickleSize = prefix.readUInt32LE(4)
    const jsonLen = prefix.readUInt32LE(12)
    const jsonBuf = Buffer.alloc(jsonLen)
    readFull(fd, jsonBuf, 0, jsonLen, 16)
    const header = JSON.parse(jsonBuf.toString('utf8'))
    return { header, dataStart: 8 + pickleSize, fileSize: fstatSync(fd).size }
  } finally {
    closeSync(fd)
  }
}

/** readSync in a loop: a single call may return short */
function readFull(fd, buffer, offset, length, position) {
  let done = 0
  while (done < length) {
    const n = readSync(fd, buffer, offset + done, length - done, position + done)
    if (n <= 0) throw new Error(`short read at ${position}: ${done}/${length}`)
    done += n
  }
}

/** walk asar header entries; cb(path, entry) for every file */
function walkFiles(node, prefix, cb) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) walkFiles(entry, path, cb)
    else cb(path, entry)
  }
}

/** true when every file entry in the asar lies fully inside the physical file */
function asarIsComplete(path) {
  try {
    const { header, dataStart, fileSize } = readAsarHeader(path)
    let ok = true
    walkFiles(header, '', (p, entry) => {
      if (dataStart + Number(entry.offset) + entry.size > fileSize) {
        console.error(`[asar] entry past EOF: ${p}`)
        ok = false
      }
    })
    return ok
  } catch (err) {
    console.error(`[asar] header unreadable: ${err.message}`)
    return false
  }
}

/** repack apps/shell/out (+ the ws runtime dep) into a fresh app.asar */
function repackAppAsar(dest) {
  const asar = require('@electron/asar')
  const shellPkg = JSON.parse(readFileSync(join(SHELL, 'package.json'), 'utf8'))
  const staging = join(RELEASE, 'asar-staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, 'node_modules'), { recursive: true })
  cpSync(join(SHELL, 'out'), join(staging, 'out'))
  cpSync(join(ROOT, 'node_modules', 'ws'), join(staging, 'node_modules', 'ws'))
  // the manifest electron-builder would synthesize: main is all the runtime needs
  writeFileSync(
    join(staging, 'package.json'),
    JSON.stringify({
      name: shellPkg.name,
      productName: shellPkg.productName,
      version: shellPkg.version,
      main: shellPkg.main,
      private: true,
    }),
  )
  asar.createPackage(staging, dest)
  rmSync(staging, { recursive: true, force: true })
}

// ---- 4. smoke test ----------------------------------------------------------

function smokeTest() {
  const exe = join(UNPACKED, 'GenOffice.exe')
  console.log('[smoke] launching the packed app for 8s...')
  return new Promise((resolvePromise) => {
    const child = spawn(exe, [], { cwd: UNPACKED, stdio: 'ignore' })
    setTimeout(() => {
      const alive = child.exitCode === null && !child.signalCode
      if (alive) {
        console.log('[smoke] PASS — app is running with a live process')
        spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { shell: true, stdio: 'ignore' })
      } else {
        console.error(`[smoke] FAIL — app exited early (code ${child.exitCode})`)
      }
      resolvePromise(alive)
    }, 8000)
  })
}

// ---- main -------------------------------------------------------------------

async function main() {
  console.log('=== GenOffice Windows packaging ===')
  if (process.platform !== 'win32') {
    console.error('This script packages for Windows and must run on Windows.')
    process.exit(1)
  }

  // direct GitHub downloads time out on many networks; default both mirrors
  // to npmmirror unless the caller already configured them
  process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??=
    'https://npmmirror.com/mirrors/electron-builder-binaries/'

  const version = applyVersionRequest()
  const cargoAvailable = ensureToolchainPaths()
  ensureSidecar(cargoAvailable)

  if (!skipBuild) {
    console.log('\n=== building third-party notices + all workspaces ===')
    run('npm run notices -w @genoffice/shell')
    run('npm run build:all')
  } else {
    console.log('\n[skip] build:all (existing out/ dirs are used as-is)')
  }

  if (!nonEmpty(join(SHELL, 'out', 'main', 'index.js'))) {
    console.error('apps/shell/out is missing — run without --skip-build first.')
    process.exit(1)
  }

  console.log('\n=== electron-builder pass 1 (pack + NSIS) ===')
  run('npx electron-builder --win', { cwd: SHELL })

  const asarPath = join(UNPACKED, 'resources', 'app.asar')
  if (!existsSync(asarPath)) {
    console.error('release/win-unpacked/resources/app.asar was not produced.')
    process.exit(1)
  }

  if (asarIsComplete(asarPath)) {
    console.log('[asar] packed app.asar is complete')
  } else {
    console.log('[asar] truncation detected — repacking from apps/shell/out ...')
    repackAppAsar(asarPath)
    if (!asarIsComplete(asarPath)) {
      console.error('[asar] re-packed asar still incomplete — aborting.')
      process.exit(1)
    }
    console.log('[asar] fixed; rebuilding the installer from the repaired directory')
    run('npx electron-builder --win --prepackaged release/win-unpacked', { cwd: SHELL })
  }

  const shellPkg = JSON.parse(readFileSync(join(SHELL, 'package.json'), 'utf8'))
  const installer = join(RELEASE, `GenOffice Setup ${shellPkg.version}.exe`)
  if (!nonEmpty(installer)) {
    console.error(`installer not found: ${installer}`)
    process.exit(1)
  }

  if (!skipSmoke) {
    const ok = await smokeTest()
    if (!ok) {
      console.error('Smoke test failed — the installer above may be broken.')
      process.exit(1)
    }
  }

  console.log(
    `\n=== DONE ===\nVersion:   ${shellPkg.version}\nInstaller: ${installer}\nUnpacked:  ${UNPACKED}`,
  )
}

main()
