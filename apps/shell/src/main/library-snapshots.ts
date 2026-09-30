import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseFileToText } from '@genoffice/file-parse'
import { pathKey } from './library'
import type { LibrarySnapshotDiffRow } from '../shared/home-api'

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

// ---- snapshot diff (git-style, side-by-side) --------------------------------

const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'md', 'markdown', 'html', 'htm', 'txt', 'json', 'svg', 'xml'])
const DIFF_MAX_BYTES = 2 * 1024 * 1024
const DIFF_MAX_ROWS = 400
const DOC_EXTS = new Set(['docx', 'doc', 'ppt', 'pptx', 'pdf', 'xlsx', 'xlsm'])
const LCS_CAP = 1500

export type SnapshotDiffCell = {
  /** 1-based line number on its own side */
  n: number
  text: string
} | null

export interface SnapshotDiffRow {
  /** old-version cell (null when the line is new) */
  left: SnapshotDiffCell
  /** current-version cell (null when the line was added) */
  right: SnapshotDiffCell
}

export type SnapshotDiffHunk =
  | { kind: 'fold'; count: number }
  | { kind: 'rows'; count: number; items: Array<{ row: LibrarySnapshotDiffRow; changed: boolean }> }

export interface SnapshotDiff {
  kind: 'text' | 'binary'
  /** true when rows are document paragraphs (long text, wrapped) */
  paragraphs?: boolean
  /** side-by-side aligned rows: old left, current right */
  rows?: SnapshotDiffRow[]
  adds?: number
  dels?: number
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

interface RawOp {
  kind: 'same' | 'del' | 'add'
  text: string
}

/** classic LCS producing raw ops; capped so huge inputs fall back to coarse output */
function lcsOps(a: string[], b: string[]): { ops: RawOp[]; truncated: boolean } {
  const n = a.length
  const m = b.length
  if (n > LCS_CAP || m > LCS_CAP) {
    const setA = new Set(a)
    const ops: RawOp[] = []
    for (const line of a) if (!setBHas(setA, line)) ops.push({ kind: 'del', text: line })
    for (const line of b) if (!setA.has(line)) ops.push({ kind: 'add', text: line })
    return { ops, truncated: true }
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: RawOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i] })
      i++
    } else {
      ops.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i] })
    i++
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j] })
    j++
  }
  return { ops, truncated: false }
}

function setBHas(set: Set<string>, line: string): boolean {
  return set.has(line)
}

/** pair del/add runs into aligned side-by-side rows */
/** oversized documents: del+add everything without LCS alignment */
function coarseOps(a: string[], b: string[]): RawOp[] {
  const ops: RawOp[] = a.map((text) => ({ kind: 'del' as const, text }))
  ops.push(...b.map((text) => ({ kind: 'add' as const, text })))
  return ops
}
function alignRows(ops: RawOp[]): SnapshotDiffRow[] {
  const rows: SnapshotDiffRow[] = []
  let leftN = 0
  let rightN = 0
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op.kind === 'same') {
      leftN++
      rightN++
      rows.push({
        left: { n: leftN, text: op.text },
        right: { n: rightN, text: op.text },
      })
      i++
      continue
    }
    if (op.kind === 'del') {
      const dels: string[] = []
      while (i < ops.length && ops[i].kind === 'del') {
        dels.push(ops[i].text)
        i++
      }
      const adds: string[] = []
      while (i < ops.length && ops[i].kind === 'add') {
        adds.push(ops[i].text)
        i++
      }
      const pairs = Math.max(dels.length, adds.length)
      for (let k = 0; k < pairs; k++) {
        const leftText = dels[k]
        const rightText = adds[k]
        if (leftText !== undefined) leftN++
        if (rightText !== undefined) rightN++
        rows.push({
          left: leftText !== undefined ? { n: leftN, text: leftText } : null,
          right: rightText !== undefined ? { n: rightN, text: rightText } : null,
        })
      }
      continue
    }
    rightN++
    rows.push({ left: null, right: { n: rightN, text: op.text } })
    i++
  }
  return rows
}

/**
 * Compare a snapshot against the current copy. Text documents get a
 * side-by-side line diff; binary formats get a size + hash comparison.
 */
export async function diffLibrarySnapshot(
  snapshotsRoot: string,
  entry: { originalPath: string; libPath: string },
  timestamp: number,
): Promise<SnapshotDiff | null> {
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

  // Office/PDF documents: paragraph-level content diff via the text extractor
  if (DOC_EXTS.has(ext)) {
    try {
      const snapPath: string = snapshotPath
      const curPath: string = entry.libPath
      const snapshotParsed = await parseFileToText(snapPath)
      const currentParsed = await parseFileToText(curPath)
      if (snapshotParsed.ok && currentParsed.ok) {
        const paragraphs = (text: string) =>
          text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l, idx, all) => l !== '' || (idx > 0 && all[idx - 1] !== ''))
        const a = paragraphs(snapshotParsed.text ?? '')
        const b = paragraphs(currentParsed.text ?? '')
        const { ops, truncated } =
          a.length <= LCS_CAP && b.length <= LCS_CAP
            ? lcsOps(a, b)
            : { ops: coarseOps(a, b), truncated: true }
        const rows = alignRows(ops)
        let adds = 0
        let dels = 0
        for (const op of ops) {
          if (op.kind === 'add') adds++
          if (op.kind === 'del') dels++
        }
        const shown = rows.length > DIFF_MAX_ROWS ? rows.slice(0, DIFF_MAX_ROWS) : rows
        return {
          kind: 'text',
          rows: shown,
          adds,
          dels,
          truncated: truncated || rows.length > DIFF_MAX_ROWS,
          paragraphs: true,
        }
      }
    } catch {
      // extractor failed on one side: fall through to the binary compare
    }
  }
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
    const { ops, truncated } = lcsOps(a, b)
    const rows = alignRows(ops)
    let adds = 0
    let dels = 0
    for (const op of ops) {
      if (op.kind === 'add') adds++
      if (op.kind === 'del') dels++
    }
    const shown = rows.length > DIFF_MAX_ROWS ? rows.slice(0, DIFF_MAX_ROWS) : rows
    return { kind: 'text', rows: shown, adds, dels, truncated: truncated || rows.length > DIFF_MAX_ROWS }
  } catch {
    return null
  }
}
