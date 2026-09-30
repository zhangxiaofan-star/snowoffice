import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffLibrarySnapshot, listLibrarySnapshots, snapshotLibraryCopy } from '../src/main/library-snapshots'

describe('inline word-level diff segments', () => {
  it('marks the changed words inside a paired modified line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snow-inline-'))
    const indexPath = join(root, 'library.json')
    const original = join(root, 'original.csv')
    const lib = join(root, 'lib.csv')
    writeFileSync(original, '夹具编号,部件名\nDM302-X,daogan.prt\n')
    writeFileSync(lib, '夹具编号,部件名\nDM302-X,daogan.prt\n')
    const entry = { originalPath: original, libPath: lib }
    snapshotLibraryCopy(root, entry)

    // the current copy changes one word on line 2
    writeFileSync(lib, '夹具编号,部件名\nDM302-X,kazhua1.prt\n')

    const snapshots = listLibrarySnapshots(root, entry.originalPath)
    expect(snapshots.length).toBeGreaterThan(0)
    const diff = await diffLibrarySnapshot(root, entry, snapshots[0].timestamp)
    expect(diff?.kind).toBe('text')
    const changedRow = diff?.rows?.find((r) => isChangedRowTexts(r))
    expect(changedRow).toBeDefined()
    expect(changedRow?.leftSegs).toBeDefined()
    expect(changedRow?.rightSegs).toBeDefined()
    // the del segments carry the old fragment, adds the new one
    const leftDel = changedRow?.leftSegs?.filter((s) => s.t === 'del').map((s) => s.text).join('')
    const rightAdd = changedRow?.rightSegs?.filter((s) => s.t === 'add').map((s) => s.text).join('')
    expect(leftDel).toContain('daogan')
    expect(rightAdd).toContain('kazhua1')
  })
})

function isChangedRowTexts(row: {
  left: { text: string } | null
  right: { text: string } | null
}): boolean {
  if (row.left === null || row.right === null) return true
  return row.left.text !== row.right.text
}
