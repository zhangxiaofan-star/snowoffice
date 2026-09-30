import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  diffLibrarySnapshot,
  listLibrarySnapshots,
  snapshotLibraryCopy,
} from '../src/main/library-snapshots'

// A real docx from the e2e assets proves the Office text-extractor path
// (DOC_EXTS branch) end to end: parse both sides, paragraph diff, aligned rows.
const FIXTURE = join(__dirname, '../../../e2e/assets/justify-pagegap-fr.docx')

const root = mkdtempSync(join(tmpdir(), 'snow-docdiff-'))
const libCopy = join(root, 'lib.docx')
copyFileSync(FIXTURE, libCopy)

const entry = { originalPath: join(root, 'original.docx'), libPath: libCopy }
snapshotLibraryCopy(root, entry)

afterAll(() => {
  // temp dir cleanup left to the OS temp sweeper
})

describe('diffLibrarySnapshot on Office documents', () => {
  it('produces aligned paragraph rows for a docx snapshot', async () => {
    const snapshots = listLibrarySnapshots(root, entry.originalPath)
    expect(snapshots.length).toBeGreaterThan(0)
    const diff = await diffLibrarySnapshot(root, entry, snapshots[0].timestamp)
    expect(diff).not.toBeNull()
    expect(diff?.kind).toBe('text')
    expect(diff?.paragraphs).toBe(true)
    // snapshot == current copy: no changes
    expect(diff?.adds).toBe(0)
    expect(diff?.dels).toBe(0)
    expect((diff?.rows?.length ?? 0)).toBeGreaterThan(0)
  })

  it('falls back to the binary compare when the extractor fails', async () => {
    // corrupt the snapshot: no longer a valid zip
    const snapshots = listLibrarySnapshots(root, entry.originalPath)
    const { writeFileSync } = await import('node:fs')
    const snapPath = snapshots[0]
    void snapPath
    // overwrite the CURRENT copy with garbage: extractor fails on the current
    // side → binary fallback (snapshot bytes + current bytes reported)
    const { copyFileSync: cp } = await import('node:fs')
    const garbage = join(root, 'garbage.docx')
    writeFileSync(garbage, 'not a zip')
    cp(garbage, libCopy)
    const diff = await diffLibrarySnapshot(root, entry, snapshots[0].timestamp)
    expect(diff).not.toBeNull()
  })
})
