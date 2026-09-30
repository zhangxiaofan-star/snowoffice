import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseFileToText } from '@genoffice/file-parse'
import { parseDocx, type Block, type Run } from '@genoffice/docx-engine'
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

export interface SnapshotSeg {
  t: 'same' | 'del' | 'add'
  text: string
}

/** serializable formatting of one docx run, for styled rendering in the diff */
export interface SnapshotRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** hex without '#' */
  color?: string
  sizeHalfPoints?: number
  font?: string
  highlight?: string
}

/** one diffable paragraph: `key` carries style markers so style-only changes
 * diff, `display` is the plain text, `runs` carries the real formatting */
export interface SnapshotPara {
  key: string
  display: string
  runs?: SnapshotRun[]
}

export interface SnapshotDiffRow {
  /** old-version cell (null when the line is new) */
  left: SnapshotDiffCell
  /** current-version cell (null when the line was added) */
  right: SnapshotDiffCell
  /** inline word-level segments when both sides exist and differ */
  leftSegs?: SnapshotSeg[]
  rightSegs?: SnapshotSeg[]
  /** styled runs of a docx row: the renderer shows these instead of cell text */
  leftRuns?: SnapshotRun[]
  rightRuns?: SnapshotRun[]
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

/** pair del/add runs into aligned side-by-side rows, carrying each side's runs */
function alignRows(
  ops: RawOp[],
  aParas: readonly SnapshotPara[],
  bParas: readonly SnapshotPara[],
): SnapshotDiffRow[] {
  const rows: SnapshotDiffRow[] = []
  let leftN = 0
  let rightN = 0
  let ai = 0
  let bi = 0
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op.kind === 'same') {
      leftN++
      rightN++
      rows.push({
        left: { n: leftN, text: op.text },
        right: { n: rightN, text: op.text },
        leftRuns: aParas[ai]?.runs,
        rightRuns: bParas[bi]?.runs,
      })
      ai++
      bi++
      i++
      continue
    }
    if (op.kind === 'del') {
      const delIdx: number[] = []
      while (i < ops.length && ops[i].kind === 'del') {
        delIdx.push(ai++)
        i++
      }
      const addIdx: number[] = []
      while (i < ops.length && ops[i].kind === 'add') {
        addIdx.push(bi++)
        i++
      }
      const pairs = Math.max(delIdx.length, addIdx.length)
      for (let k = 0; k < pairs; k++) {
        const leftPara = delIdx[k] !== undefined ? aParas[delIdx[k]] : undefined
        const rightPara = addIdx[k] !== undefined ? bParas[addIdx[k]] : undefined
        const leftText = leftPara?.display
        const rightText = rightPara?.display
        if (leftText !== undefined) leftN++
        if (rightText !== undefined) rightN++
        const inline =
          leftText !== undefined &&
          rightText !== undefined &&
          leftText !== rightText &&
          leftText.length <= INLINE_CAP &&
          rightText.length <= INLINE_CAP
            ? inlineSegs(leftText, rightText)
            : undefined
        rows.push({
          left: leftPara !== undefined ? { n: leftN, text: leftPara.key } : null,
          right: rightPara !== undefined ? { n: rightN, text: rightPara.key } : null,
          leftSegs: inline?.leftSegs,
          rightSegs: inline?.rightSegs,
          leftRuns: leftPara?.runs,
          rightRuns: rightPara?.runs,
        })
      }
      continue
    }
    rightN++
    rows.push({
      left: null,
      right: { n: rightN, text: op.text },
      rightRuns: bParas[bi]?.runs,
    })
    bi++
    i++
  }
  return rows
}

/** tokenize: latin/digit runs stay whole, CJK and punctuation split per char */
function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9]+|\s+|[^A-Za-z0-9\s]/gu) ?? []
}

function pushSeg(list: SnapshotSeg[], t: SnapshotSeg['t'], text: string): void {
  const last = list[list.length - 1]
  if (last && last.t === t) last.text += text
  else list.push({ t, text })
}

/** word/char-level segments: old side marks dels, new side marks adds */
function inlineSegs(
  leftText: string,
  rightText: string,
): { leftSegs: SnapshotSeg[]; rightSegs: SnapshotSeg[] } | undefined {
  const a = tokenize(leftText)
  const b = tokenize(rightText)
  if (a.length > 400 || b.length > 400) return undefined
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const leftSegs: SnapshotSeg[] = []
  const rightSegs: SnapshotSeg[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushSeg(leftSegs, 'same', a[i])
      pushSeg(rightSegs, 'same', b[j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg(leftSegs, 'del', a[i])
      i++
    } else {
      pushSeg(rightSegs, 'add', b[j])
      j++
    }
  }
  while (i < a.length) {
    pushSeg(leftSegs, 'del', a[i])
    i++
  }
  while (j < b.length) {
    pushSeg(rightSegs, 'add', b[j])
    j++
  }
  return { leftSegs, rightSegs }
}

/** oversized documents: del+add everything without LCS alignment */
function coarseOps(a: string[], b: string[]): RawOp[] {
  const ops: RawOp[] = a.map((text) => ({ kind: 'del' as const, text }))
  ops.push(...b.map((text) => ({ kind: 'add' as const, text })))
  return ops
}
const INLINE_CAP = 1200

/**
 * Compare a snapshot against the current copy. Text documents get a
 * side-by-side line diff; binary formats get a size + hash comparison.
 */
/**
 * Styled paragraphs of a docx. The diff key carries a <...> marker per run
 * listing its non-default formatting (b=bold, i=italic, u=underline, s=strike,
 * cRRGGBB=color, zNN=size in half-points, hNAME=highlight, fFONT=font) so
 * style-only changes diff too, while `runs` keeps the real formatting for the
 * renderer and `display` the plain text the inline segments align with.
 */
async function styledDocxParas(bytes: Uint8Array): Promise<SnapshotPara[]> {
  const parsed = await parseDocx(bytes)
  const paras: SnapshotPara[] = []
  for (const block of parsed.blocks) {
    if (block.hidden) continue
    const runs: Run[] | undefined = block.runs
    if (!runs || runs.length === 0) {
      const text = block.previewText ?? block.label ?? `[${block.type}]`
      paras.push({ key: text, display: text })
      continue
    }
    let key = ''
    let display = ''
    const out: SnapshotRun[] = []
    for (const run of runs) {
      const sig: string[] = []
      if (run.bold) sig.push('b')
      if (run.italic) sig.push('i')
      if (run.underline) sig.push('u')
      if (run.strike) sig.push('s')
      if (run.color && run.color !== 'auto') sig.push(`c${run.color}`)
      if (run.sizeHalfPoints) sig.push(`z${run.sizeHalfPoints}`)
      if (run.highlight) sig.push(`h${run.highlight}`)
      if (run.font) sig.push(`f${run.font}`)
      key += sig.length > 0 ? `<${sig.join(',')}>${run.text}` : run.text
      display += run.text
      out.push({
        text: run.text,
        bold: run.bold,
        italic: run.italic,
        underline: run.underline,
        strike: run.strike,
        color: run.color && run.color !== 'auto' ? run.color : undefined,
        sizeHalfPoints: run.sizeHalfPoints,
        font: run.font,
        highlight: run.highlight,
      })
    }
    paras.push({ key, display, runs: out })
  }
  return paras
}

/** trim trailing whitespace like the old line-based pipeline did, keeping blanks collapsed */
function trimParas(list: SnapshotPara[]): SnapshotPara[] {
  const trimmed = list.map((p) => ({ ...p, key: p.key.trimEnd(), display: p.display.trimEnd() }))
  return trimmed.filter((p, idx) => p.display !== '' || (idx > 0 && trimmed[idx - 1].display !== ''))
}
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

  // Office/PDF documents: paragraph-level content diff via the text extractor.
  // For .docx the text carries <formatting> markers so style-only changes diff too.
  if (DOC_EXTS.has(ext)) {
    try {
      const snapPath: string = snapshotPath
      const curPath: string = entry.libPath
      let aParas: SnapshotPara[] | null = null
      let bParas: SnapshotPara[] | null = null
      if (ext === 'docx') {
        try {
          aParas = trimParas(await styledDocxParas(await readFile(snapPath)))
          bParas = trimParas(await styledDocxParas(await readFile(curPath)))
        } catch {
          // malformed docx: fall through to the plain extractor
        }
      }
      if (aParas === null || bParas === null) {
        const [snapshotParsed, currentParsed] = await Promise.all([
          parseFileToText(snapPath),
          parseFileToText(curPath),
        ])
        if (!snapshotParsed.ok || !currentParsed.ok) throw new Error('extract failed')
        const toParas = (text: string) =>
          trimParas(
            text
              .replace(/\r\n/g, '\n')
              .split('\n')
              .map((line) => ({ key: line, display: line })),
          )
        aParas = toParas(snapshotParsed.text ?? '')
        bParas = toParas(currentParsed.text ?? '')
      }
      const aKeys = aParas.map((p) => p.key)
      const bKeys = bParas.map((p) => p.key)
      const { ops, truncated } =
        aKeys.length <= LCS_CAP && bKeys.length <= LCS_CAP
          ? lcsOps(aKeys, bKeys)
          : { ops: coarseOps(aKeys, bKeys), truncated: true }
      const rows = alignRows(ops, aParas, bParas)
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
    const toParas = (text: string) =>
      text.split('\n').map((line) => ({ key: line, display: line }))
    const aParas = toParas(normalize(readFileSync(snapshotPath, 'utf8')))
    const bParas = toParas(normalize(readFileSync(entry.libPath, 'utf8')))
    const { ops, truncated } = lcsOps(
      aParas.map((p) => p.key),
      bParas.map((p) => p.key),
    )
    const rows = alignRows(ops, aParas, bParas)
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
