import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { writeJsonAtomic } from '@genoffice/electron-utils'

/**
 * The document library: files opened through the shell are copied into
 * userData/library and every later open/edit/save works on that copy, so the
 * original on disk is never rewritten. One JSON index (userData/library.json)
 * maps each original path to its library copy; the mapping is keyed by a
 * case-folded absolute path on Windows, where the filesystem is
 * case-insensitive and the same file can arrive with different casing.
 */

export interface LibraryEntry {
  originalPath: string
  libPath: string
  importedAt: number
  lastOpenedAt: number
  /** original file's mtime as of the last import/re-open; a different value
      now means the original changed on disk since the copy was last seen */
  lastOriginalMtimeMs?: number
}

interface LibraryFile {
  version: 1
  entries: LibraryEntry[]
}

/** stable identity for a path: absolute, and case-folded where the FS is */
function pathKey(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function readLibraryEntries(indexPath: string): LibraryEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (raw && typeof raw === 'object' && Array.isArray((raw as LibraryFile).entries)) {
      return (raw as LibraryFile).entries.filter(
        (e) => typeof e.originalPath === 'string' && typeof e.libPath === 'string',
      )
    }
  } catch {
    // missing or corrupt index: treat as an empty library
  }
  return []
}

function writeEntries(indexPath: string, entries: LibraryEntry[]): void {
  const file: LibraryFile = { version: 1, entries }
  writeJsonAtomic(indexPath, file)
}

/** true when the path already lives inside the library directory */
export function isLibraryPath(path: string, libraryDir: string): boolean {
  const key = pathKey(path)
  const dirKey = pathKey(
    libraryDir.endsWith('\\') || libraryDir.endsWith('/') ? libraryDir : libraryDir + '\\',
  )
  return key.startsWith(dirKey)
}

/** first free "name.ext" / "name (2).ext" / ... inside the library directory */
function uniqueLibPath(libraryDir: string, originalPath: string): string {
  const ext = extname(originalPath)
  const stem = basename(originalPath).slice(0, -ext.length || undefined)
  for (let n = 1; ; n++) {
    const candidate = join(libraryDir, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
}

/** record the original file's mtime on an entry (best effort) */
function stampOriginalMtime(entry: LibraryEntry, originalPath: string): void {
  try {
    entry.lastOriginalMtimeMs = statSync(originalPath).mtimeMs
  } catch {
    // original vanished mid-open: leave the previous stamp untouched
  }
}

export type LibraryImportStatus = 'imported' | 'reused' | 'restored' | 'in-library' | 'passthrough'

export interface LibraryImportResult {
  status: LibraryImportStatus
  /** the path the shell should open (the library copy, or the original) */
  path: string
  entry?: LibraryEntry
}

/**
 * Resolve an original file path to the path the editor should open. Copies the
 * file into the library on first sight, reuses the existing copy afterwards,
 * and falls back to the original path on any failure so opening a document
 * never breaks because the library could not be written.
 */
export function resolveLibraryPath(
  originalPath: string,
  libraryDir: string,
  indexPath: string,
  now: number = Date.now(),
): LibraryImportResult {
  if (!existsSync(originalPath)) return { status: 'passthrough', path: originalPath }
  if (isLibraryPath(originalPath, libraryDir)) {
    return { status: 'in-library', path: originalPath }
  }
  try {
    const entries = readLibraryEntries(indexPath)
    const key = pathKey(originalPath)
    const existing = entries.find((e) => pathKey(e.originalPath) === key)
    if (existing) {
      if (!existsSync(existing.libPath)) {
        mkdirSync(libraryDir, { recursive: true })
        copyFileSync(originalPath, existing.libPath)
        existing.importedAt = now
        existing.lastOpenedAt = now
        stampOriginalMtime(existing, originalPath)
        writeEntries(indexPath, entries)
        return { status: 'restored', path: existing.libPath, entry: existing }
      }
      existing.lastOpenedAt = now
      stampOriginalMtime(existing, originalPath)
      writeEntries(indexPath, entries)
      return { status: 'reused', path: existing.libPath, entry: existing }
    }
    mkdirSync(libraryDir, { recursive: true })
    const libPath = uniqueLibPath(libraryDir, originalPath)
    copyFileSync(originalPath, libPath)
    const entry: LibraryEntry = {
      originalPath,
      libPath,
      importedAt: now,
      lastOpenedAt: now,
    }
    stampOriginalMtime(entry, originalPath)
    entries.unshift(entry)
    writeEntries(indexPath, entries)
    return { status: 'imported', path: libPath, entry }
  } catch (err) {
    // locked source, unwritable userData, full disk: open in place rather
    // than fail the open
    console.warn(
      '[library] import failed, opening original:',
      err instanceof Error ? err.message : err,
    )
    return { status: 'passthrough', path: originalPath }
  }
}

/** remove the library record for a copy; the copy file itself stays on disk */
export function removeLibraryEntry(indexPath: string, libPath: string): LibraryEntry[] {
  const entries = readLibraryEntries(indexPath).filter(
    (e) => pathKey(e.libPath) !== pathKey(libPath),
  )
  writeEntries(indexPath, entries)
  return entries
}

export function findLibraryEntryByLibPath(
  indexPath: string,
  libPath: string,
): LibraryEntry | undefined {
  return readLibraryEntries(indexPath).find((e) => pathKey(e.libPath) === pathKey(libPath))
}

/**
 * Overwrite a library copy with the current content of its original file.
 * Returns null when the entry is unknown or the original is gone.
 */
export function reimportLibraryEntry(
  indexPath: string,
  libraryDir: string,
  libPath: string,
  now: number = Date.now(),
): LibraryEntry | null {
  const entries = readLibraryEntries(indexPath)
  const entry = entries.find((e) => pathKey(e.libPath) === pathKey(libPath))
  if (!entry || !existsSync(entry.originalPath)) return null
  try {
    mkdirSync(libraryDir, { recursive: true })
    copyFileSync(entry.originalPath, entry.libPath)
    entry.importedAt = now
    entry.lastOpenedAt = now
    stampOriginalMtime(entry, entry.originalPath)
    writeEntries(indexPath, entries)
    return entry
  } catch (err) {
    console.warn('[library] reimport failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** file size + mtime for the home-screen library list; missing copies still list */
export function statLibraryEntry(entry: LibraryEntry): {
  sizeBytes: number
  mtimeMs: number
  missing: boolean
} {
  try {
    const st = statSync(entry.libPath)
    return { sizeBytes: st.size, mtimeMs: st.mtimeMs, missing: false }
  } catch {
    return { sizeBytes: 0, mtimeMs: 0, missing: true }
  }
}

export interface LibraryDirMigration {
  moved: number
  failed: number
}

/**
 * Move every library copy that lives under `fromDir` into `toDir`, rewriting
 * the recorded libPaths. Copies whose file is already missing stay missing;
 * entries pointing outside `fromDir` (a previous custom location) are left
 * alone. The source directory is removed when the move leaves it empty.
 */
export function migrateLibraryDir(
  indexPath: string,
  fromDir: string,
  toDir: string,
  now: number = Date.now(),
): LibraryDirMigration {
  mkdirSync(toDir, { recursive: true })
  const entries = readLibraryEntries(indexPath)
  let moved = 0
  let failed = 0
  for (const entry of entries) {
    if (!isLibraryPath(entry.libPath, fromDir)) continue
    if (!existsSync(entry.libPath)) continue
    const target = uniqueLibPath(toDir, entry.libPath)
    try {
      try {
        renameSync(entry.libPath, target)
      } catch {
        // cross-device move: rename fails, copy + delete works
        copyFileSync(entry.libPath, target)
        rmSync(entry.libPath)
      }
      entry.libPath = target
      entry.lastOpenedAt = now
      moved++
    } catch (err) {
      console.warn(
        '[library] migrate failed for',
        entry.libPath,
        err instanceof Error ? err.message : err,
      )
      failed++
    }
  }
  if (moved + failed > 0) writeEntries(indexPath, entries)
  try {
    // rmdirSync only succeeds when empty: leftover files keep the directory
    rmdirSync(fromDir)
  } catch {
    // still has files (failed moves or unrelated content): leave it alone
  }
  return { moved, failed }
}
