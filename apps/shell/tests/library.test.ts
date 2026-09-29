import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findLibraryEntryByLibPath,
  migrateLibraryDir,
  isLibraryPath,
  readLibraryEntries,
  removeLibraryEntry,
  resolveLibraryPath,
  reimportLibraryEntry,
} from '../src/main/library'

let root: string
let libraryDir: string
let indexPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-library-'))
  libraryDir = join(root, 'library')
  indexPath = join(root, 'library.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeOriginal(name: string, content: string): string {
  const path = join(root, name)
  writeFileSync(path, content)
  return path
}

describe('resolveLibraryPath', () => {
  it('imports a first-seen file into the library and returns the copy', () => {
    const original = makeOriginal('report.docx', 'v1')
    const result = resolveLibraryPath(original, libraryDir, indexPath)
    expect(result.status).toBe('imported')
    expect(result.entry).toBeDefined()
    expect(result.path).not.toBe(original)
    expect(result.path.startsWith(libraryDir)).toBe(true)
    expect(result.path.endsWith('report.docx')).toBe(true)
    expect(readFileSync(result.path, 'utf8')).toBe('v1')
    expect(existsSync(original)).toBe(true)
    expect(readLibraryEntries(indexPath)).toHaveLength(1)
  })

  it('reuses the same copy when the original is opened again', () => {
    const original = makeOriginal('report.docx', 'v1')
    const first = resolveLibraryPath(original, libraryDir, indexPath)
    const second = resolveLibraryPath(original, libraryDir, indexPath, first.entry!.importedAt + 5)
    expect(second.status).toBe('reused')
    expect(second.path).toBe(first.path)
    expect(readLibraryEntries(indexPath)).toHaveLength(1)
  })

  it('reuses the copy regardless of path casing on Windows', () => {
    const original = makeOriginal('report.docx', 'v1')
    const first = resolveLibraryPath(original, libraryDir, indexPath)
    const upper = original.toUpperCase()
    if (upper === original) return // nothing to prove on a case-sensitive FS
    const second = resolveLibraryPath(upper, libraryDir, indexPath)
    expect(second.status).toBe('reused')
    expect(second.path).toBe(first.path)
  })

  it('gives the second same-named original a numbered copy name', () => {
    const a = join(root, 'a', 'report.docx')
    const b = join(root, 'b', 'report.docx')
    mkdirSync(join(root, 'a'), { recursive: true })
    mkdirSync(join(root, 'b'), { recursive: true })
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    const ra = resolveLibraryPath(a, libraryDir, indexPath)
    const rb = resolveLibraryPath(b, libraryDir, indexPath)
    expect(ra.path.endsWith('report.docx')).toBe(true)
    expect(rb.path.endsWith('report (2).docx')).toBe(true)
    expect(readFileSync(rb.path, 'utf8')).toBe('B')
  })

  it('restores the copy from the original when the library file was deleted', () => {
    const original = makeOriginal('report.docx', 'v1')
    const first = resolveLibraryPath(original, libraryDir, indexPath)
    rmSync(first.path)
    const second = resolveLibraryPath(original, libraryDir, indexPath)
    expect(second.status).toBe('restored')
    expect(second.path).toBe(first.path)
    expect(readFileSync(first.path, 'utf8')).toBe('v1')
  })

  it('passes through a path already inside the library directory', () => {
    mkdirSync(libraryDir, { recursive: true })
    const inside = join(libraryDir, 'report.docx')
    writeFileSync(inside, 'already ours')
    const result = resolveLibraryPath(inside, libraryDir, indexPath)
    expect(result.status).toBe('in-library')
    expect(result.path).toBe(inside)
    expect(readLibraryEntries(indexPath)).toHaveLength(0)
  })

  it('passes through a missing original without recording anything', () => {
    const result = resolveLibraryPath(join(root, 'gone.docx'), libraryDir, indexPath)
    expect(result.status).toBe('passthrough')
    expect(result.path).toBe(join(root, 'gone.docx'))
    expect(readLibraryEntries(indexPath)).toHaveLength(0)
  })

  it('falls back to the original when the library cannot be written', () => {
    // a directory cannot be created under a file, so the import must fail
    const blocker = join(root, 'blocker.txt')
    writeFileSync(blocker, 'not a directory')
    const original = makeOriginal('report.docx', 'v1')
    const result = resolveLibraryPath(
      original,
      join(blocker, 'library'),
      join(blocker, 'library.json'),
    )
    expect(result.status).toBe('passthrough')
    expect(result.path).toBe(original)
  })
})

describe('library records', () => {
  it('removes the record but keeps the copy file', () => {
    const original = makeOriginal('report.docx', 'v1')
    const { path } = resolveLibraryPath(original, libraryDir, indexPath)
    removeLibraryEntry(indexPath, path)
    expect(readLibraryEntries(indexPath)).toHaveLength(0)
    expect(existsSync(path)).toBe(true)
  })

  it('re-imports the original content over the copy', () => {
    const original = makeOriginal('report.docx', 'v1')
    const { path } = resolveLibraryPath(original, libraryDir, indexPath)
    writeFileSync(original, 'v2')
    const entry = reimportLibraryEntry(indexPath, libraryDir, path)
    expect(entry).not.toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('v2')
  })

  it('refuses to re-import when the original is gone', () => {
    const original = makeOriginal('report.docx', 'v1')
    const { path } = resolveLibraryPath(original, libraryDir, indexPath)
    rmSync(original)
    expect(reimportLibraryEntry(indexPath, libraryDir, path)).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('v1')
  })

  it('finds an entry by its library path', () => {
    const original = makeOriginal('report.docx', 'v1')
    const { entry, path } = resolveLibraryPath(original, libraryDir, indexPath)
    expect(findLibraryEntryByLibPath(indexPath, path)?.originalPath).toBe(entry!.originalPath)
    expect(findLibraryEntryByLibPath(indexPath, join(libraryDir, 'nope.docx'))).toBeUndefined()
  })
})

describe('isLibraryPath', () => {
  it('recognizes paths inside the library directory', () => {
    expect(isLibraryPath(join(libraryDir, 'a.docx'), libraryDir)).toBe(true)
    expect(isLibraryPath(join(root, 'elsewhere', 'a.docx'), libraryDir)).toBe(false)
  })

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    // "library-2" starts with "library" but is not the library itself
    expect(isLibraryPath(join(root, 'library-2', 'a.docx'), libraryDir)).toBe(false)
  })
})

describe('migrateLibraryDir', () => {
  it('moves copies into the new directory and rewrites the recorded paths', () => {
    mkdirSync(join(root, 'old'), { recursive: true })
    const oldDir = join(root, 'old')
    const a = makeOriginal('a.docx', 'A')
    const b = makeOriginal('b.docx', 'B')
    resolveLibraryPath(a, oldDir, indexPath)
    resolveLibraryPath(b, oldDir, indexPath)
    const result = migrateLibraryDir(indexPath, oldDir, libraryDir)
    expect(result.moved).toBe(2)
    expect(result.failed).toBe(0)
    const entries = readLibraryEntries(indexPath)
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.libPath.startsWith(libraryDir)).toBe(true)
      expect(existsSync(entry.libPath)).toBe(true)
    }
    // the old directory is gone once emptied
    expect(existsSync(oldDir)).toBe(false)
  })

  it('keeps entries that point outside the old directory untouched', () => {
    const original = makeOriginal('keep.docx', 'K')
    const outside = resolveLibraryPath(original, libraryDir, indexPath)
    const oldDir = join(root, 'old')
    mkdirSync(oldDir, { recursive: true })
    const other = makeOriginal('other.docx', 'O')
    resolveLibraryPath(other, oldDir, indexPath)
    migrateLibraryDir(indexPath, oldDir, join(root, 'new'))
    const entry = findLibraryEntryByLibPath(indexPath, outside.path)
    expect(entry?.libPath).toBe(outside.path)
    expect(existsSync(outside.path)).toBe(true)
  })

  it('skips copies whose file is already missing without failing', () => {
    const original = makeOriginal('gone.docx', 'G')
    const oldDir = join(root, 'old')
        const first = resolveLibraryPath(original, oldDir, indexPath)
    rmSync(first.path)
    const result = migrateLibraryDir(indexPath, oldDir, libraryDir)
    expect(result.moved).toBe(0)
    expect(result.failed).toBe(0)
    const entry = findLibraryEntryByLibPath(indexPath, first.path)
    expect(entry).toBeDefined()
  })
})
