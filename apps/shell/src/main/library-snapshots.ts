import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { pathKey } from './library'

/**
 * Version history for library copies: every snapshot is a plain file copied
 * into `userData/library-snapshots/<entryKey>/`, named by timestamp. The most
 * recent 20 are kept per document.
 */

export const SNAPSHOTS_KEEP = 20

export interface LibrarySnapshotInfo {
  /** snapshot file mtime — also the sort/display key */
  timestamp: number
  name: string
  sizeBytes: number
}

/** per-entry storage directory: pathKey of the ORIGINAL, hex-safe */
function entryDir(snapshotsRoot: string, originalPath: string): string {
  return join(snapshotsRoot, Buffer.from(pathKey(originalPath)).toString('hex'))
}

export function snapshotLibraryCopy(
  snapshotsRoot: string,
  entry: { originalPath: string; libPath: string },
): boolean {
  if (!existsSync(entry.libPath)) return false
  const dir = entryDir(snapshotsRoot, entry.originalPath)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${stamp}-${basename(entry.libPath)}`
  copyFileSync(entry.libPath, join(dir, name))
  pruneSnapshots(dir)
  return true
}

export function listLibrarySnapshots(
  snapshotsRoot: string,
  originalPath: string,
): LibrarySnapshotInfo[] {
  const dir = entryDir(snapshotsRoot, originalPath)
  if (!existsSync(dir)) return []
  const snapshots: LibrarySnapshotInfo[] = []
  for (const name of readdirSync(dir)) {
    try {
      const st = statSync(join(dir, name))
      snapshots.push({ timestamp: st.mtimeMs, name, sizeBytes: st.size })
    } catch {
      // raced with a prune: skip
    }
  }
  return snapshots.sort((a, b) => b.timestamp - a.timestamp)
}

/**
 * Copy a snapshot back over the library copy. Returns false when the snapshot
 * is gone (pruned between listing and restore).
 */
export function restoreLibrarySnapshot(
  snapshotsRoot: string,
  entry: { originalPath: string; libPath: string },
  timestamp: number,
): boolean {
  const dir = entryDir(snapshotsRoot, entry.originalPath)
  if (!existsSync(dir)) return false
  for (const name of readdirSync(dir)) {
    try {
      if (statSync(join(dir, name)).mtimeMs !== timestamp) continue
      copyFileSync(join(dir, name), entry.libPath)
      return true
    } catch {
      return false
    }
  }
  return false
}

function pruneSnapshots(dir: string): void {
  const files = readdirSync(dir)
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((f): f is { name: string; mtimeMs: number } => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const stale of files.slice(SNAPSHOTS_KEEP)) {
    try {
      rmSync(join(dir, stale.name))
    } catch {
      // best effort prune
    }
  }
}

const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'md', 'markdown', 'html', 'htm', 'txt', 'json', 'svg', 'xml'])
const DIFF_MAX_BYTES = 2 * 1024 * 1024
const DIFF_MAX_LINES = 400

export interface SnapshotDiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
}

export interface SnapshotDiff {
  kind: 'text' | 'binary'
  adds?: number
  dels?: number
  lines?: SnapshotDiffLine[]
  truncated?: boolean
  snapshotBytes?: number
  currentBytes?: number
  identical?: boolean
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** classic LCS line diff; capped so huge files fall back to coarse counts */
function lcsDiff(a: string[], b: string[]): { lines: SnapshotDiffLine[]; adds: number; dels: number; truncated: boolean } {
  const n = a.length
  const m = b.length
  const cap = 1500
  if (n > cap || m > cap) {
    const setA = new Set(a)
    const added = b.filter((l) => !setA.has(l)).length
    return { lines: [], adds: added, dels: n - (m - added), truncated: true }
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: SnapshotDiffLine[] = []
  let adds = 0
  let dels = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i] })
      dels++
      i++
    } else {
      lines.push({ type: 'add', text: b[j] })
      adds++
      j++
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: a[i] })
    dels++
    i++
  }
  while (j < m) {
    lines.push({ type: 'add', text: b[j] })
    adds++
    j++
  }
  const truncated = lines.length > DIFF_MAX_LINES
  const shown = truncated ? lines.slice(0, DIFF_MAX_LINES) : lines
  return { lines: shown, adds, dels, truncated }
}

/**
 * Compare a snapshot against the current copy. Text documents get a git-style
 * line diff; binary formats get a size + hash comparison instead.
 */
export function diffLibrarySnapshot(
  snapshotsRoot: string,
  entry: { originalPath: string; libPath: string },
  timestamp: number,
): SnapshotDiff | null {
  const dir = entryDir(snapshotsRoot, entry.originalPath)
  if (!existsSync(dir)) return null
  let snapshotPath: string | null = null
  let snapshotBytes = 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (st.mtimeMs === timestamp) {
        snapshotPath = full
        snapshotBytes = st.size
        break
      }
    } catch {
      // raced with a prune: keep looking
    }
  }
  if (!snapshotPath || !existsSync(entry.libPath)) return null

  const ext = extensionOf(entry.libPath)
  const currentBytes = statSync(entry.libPath).size

  if (!TEXT_EXTENSIONS.has(ext) || snapshotBytes > DIFF_MAX_BYTES || currentBytes > DIFF_MAX_BYTES) {
    const snapHash = hashFile(snapshotPath)
    const curHash = hashFile(entry.libPath)
    return {
      kind: 'binary',
      snapshotBytes,
      currentBytes,
      identical: snapHash !== null && snapHash === curHash,
    }
  }

  try {
    const normalize = (text: string) => text.replace(/\r\n/g, '\n')
    const a = normalize(readFileSync(snapshotPath, 'utf8')).split('\n')
    const b = normalize(readFileSync(entry.libPath, 'utf8')).split('\n')
    const diff = lcsDiff(a, b)
    return { kind: 'text', ...diff }
  } catch {
    return null
  }
}
