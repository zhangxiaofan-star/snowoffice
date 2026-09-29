import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
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
