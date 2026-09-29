/**
 * Build offline-kit/: a self-contained folder that carries every tool the
 * Windows packaging flow needs, so a fresh machine can be set up without
 * downloading anything.
 *
 * Usage (from the repo root, on a machine that already builds):
 *   node scripts/make-offline-kit.mjs
 *
 * What goes into the kit:
 *   rust\.rustup, rust\.cargo   the rustup toolchain + cargo home (copied as-is)
 *   mingw64\                    the WinLibs MinGW-w64 already installed via winget
 *   node-v*-win-x64.zip         portable Node.js, fetched once from npmmirror
 *   win-ocr.exe                 prebuilt OCR helper (avoids the Windows SDK)
 *   setup-dev.bat               the installer to run on the target machine
 *
 * npm dependencies are deliberately NOT bundled: the target machine still runs
 * `npm install` with network access. Copy the whole repo folder (kit included)
 * to the target machine, then run offline-kit\setup-dev.bat there.
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KIT = join(ROOT, 'offline-kit')
const HOME = process.env.USERPROFILE ?? process.env.HOME
const NODE_MAJOR = (readFileSync(join(ROOT, '.nvmrc'), 'utf8').match(/\d+/) ?? ['22'])[0]

console.log('=== building offline-kit ===')

/** robocopy a directory tree; exit codes 0-7 are success variants */
function copyTree(src, dest) {
  if (!existsSync(src)) {
    console.warn(`[skip] missing source: ${src}`)
    return false
  }
  console.log(`[copy] ${src} -> ${dest}`)
  const r = spawnSync('robocopy', [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], {
    stdio: 'ignore',
  })
  if (r.status >= 8) {
    console.error(`robocopy failed with exit ${r.status} for ${src}`)
    process.exit(1)
  }
  return true
}

/** recursive byte size, for the summary line */
function dirSize(path) {
  let total = 0
  let entries
  try {
    entries = readdirSync(path)
  } catch {
    return 0
  }
  for (const name of entries) {
    const p = join(path, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    total += st.isDirectory() ? dirSize(p) : st.size
  }
  return total
}

rmSync(KIT, { recursive: true, force: true })
mkdirSync(KIT, { recursive: true })

// 1. rust toolchain + cargo home
copyTree(join(HOME, '.rustup'), join(KIT, 'rust', '.rustup'))
copyTree(join(HOME, '.cargo'), join(KIT, 'rust', '.cargo'))

// 2. MinGW-w64 from the winget install
let mingwSrc = null
const wingetPkgs = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
for (const dir of readdirSync(wingetPkgs)) {
  if (/^BrechtSanders\.WinLibs/i.test(dir)) {
    const candidate = join(wingetPkgs, dir, 'mingw64')
    if (existsSync(join(candidate, 'bin', 'gcc.exe'))) {
      mingwSrc = candidate
      break
    }
  }
}
if (mingwSrc) copyTree(mingwSrc, join(KIT, 'mingw64'))
else console.warn('[warn] WinLibs MinGW not found — kit will not include it')

// 3. prebuilt Windows OCR helper (spares the target machine the Windows SDK)
const winOcr = join(ROOT, 'packages', 'pdf2docx', 'ocr-helper', 'win-ocr.exe')
if (existsSync(winOcr)) copyFileSync(winOcr, join(KIT, 'win-ocr.exe'))
else console.warn('[warn] win-ocr.exe not built yet — run a packaging first or install the Windows SDK')

// 4. portable Node.js zip from npmmirror
async function fetchNode() {
  console.log(`[node] looking up Node v${NODE_MAJOR}.x on npmmirror...`)
  const res = await fetch(`https://registry.npmmirror.com/-/binary/node/latest-v${NODE_MAJOR}.x/`)
  const entries = await res.json()
  // the listing is unsorted and mixes dirs in: pick the highest win-x64 zip
  const version = (e) => {
    const [maj, min, pat] = (e.name.match(/^node-v(\d+)\.(\d+)\.(\d+)-win-x64\.zip$/) ?? []).slice(1).map(Number)
    return Number.isNaN(pat) ? 0 : maj * 1e6 + min * 1e3 + pat
  }
  const zips = entries.filter((e) => version(e) > 0)
  if (zips.length === 0) {
    console.error('[node] no win-x64 zip found on the mirror')
    process.exit(1)
  }
  const entry = zips.reduce((a, b) => (version(b) > version(a) ? b : a))
  console.log(`[node] downloading ${entry.name} ...`)
  const zip = await fetch(entry.url)
  writeFileSync(join(KIT, entry.name), Buffer.from(await zip.arrayBuffer()))
  console.log(`[node] saved ${entry.name}`)
}
await fetchNode()

// 5. the installer the target machine runs
copyFileSync(join(ROOT, 'setup-dev.bat'), join(KIT, 'setup-dev.bat'))

writeFileSync(
  join(KIT, 'README.txt'),
  [
    'GenOffice 离线开发环境包',
    '========================',
    '',
    '用法：把整个仓库文件夹（offline-kit 在仓库根目录里，一起拷走）复制到新电脑，',
    '然后双击 offline-kit\\setup-dev.bat。它会：',
    '  1. 安装便携版 Node.js、Rust 工具链、MinGW-w64 到用户目录（不需要管理员）',
    '  2. 把 win-ocr.exe 复制到仓库里（免去安装 Windows SDK）',
    '  3. 把上面这些加入用户 PATH（对之后新开的终端生效）',
    '',
    '装完后：新开一个终端，进仓库目录执行',
    '    npm install        （这一步需要联网，npm 依赖不在离线包里）',
    '    npm run package:win',
    '',
    '注意：如果目标机器缺少某个组件，本脚本会跳过它并在最后提示。',
  ].join('\r\n'),
)

const sizeGb = (dirSize(KIT) / 1024 ** 3).toFixed(2)
console.log(`\n=== DONE ===\noffline-kit built at ${KIT} (${sizeGb} GB)`)
console.log('Copy the repo folder to the target machine and run offline-kit\\setup-dev.bat there.')
