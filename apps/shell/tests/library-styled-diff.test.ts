import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type Run } from '@genoffice/docx-engine'
import {
  diffLibrarySnapshot,
  listLibrarySnapshots,
  snapshotLibraryCopy,
} from '../src/main/library-snapshots'

// A real docx from the e2e assets drives the styled paragraph pipeline end to
// end: parse → per-run style keys → aligned rows carrying renderable runs.
const FIXTURE = join(__dirname, '../../../e2e/assets/justify-pagegap-fr.docx')

describe('styled docx snapshot diff', () => {
  it('carries renderable runs and detects a style-only edit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snow-stylediff-'))
    const bytes = new Uint8Array(readFileSync(FIXTURE))
    const parsed = await parseDocx(bytes)

    // one plain text paragraph to restyle, text untouched
    const target = parsed.blocks.find(
      (b) =>
        !b.hidden &&
        b.type === 'paragraph' &&
        b.runs &&
        b.runs.some((r) => r.text.trim() !== '') &&
        !b.runs.some((r) => r.image),
    )
    expect(target).toBeDefined()
    const plainText = (target?.runs ?? []).map((r) => r.text).join('').trimEnd()

    const styledRuns: Run[] = (target?.runs ?? []).map((r, idx) => ({
      ...r,
      rawRPr: undefined,
      ...(idx === 0 ? { bold: true, color: '123456', sizeHalfPoints: 36, font: '黑体' } : {}),
    }))
    const saveBlocks = parsed.blocks
      .filter((b) => !b.hidden)
      .map((b) =>
        b === target
          ? ({ kind: 'generated', block: { type: 'paragraph', runs: styledRuns } } as const)
          : ({ kind: 'original', docxIndex: b.docxIndex } as const),
      )
    const current = await saveDocx(parsed, [...saveBlocks])

    const originalPath = join(root, 'original.docx')
    const lib = join(root, 'lib.docx')
    const entry = { originalPath, libPath: lib }
    writeFileSync(lib, Buffer.from(bytes))
    expect(snapshotLibraryCopy(root, entry)).toBe(true)
    writeFileSync(lib, Buffer.from(current))

    const snapshots = listLibrarySnapshots(root, originalPath)
    expect(snapshots.length).toBe(1)
    const diff = await diffLibrarySnapshot(root, entry, snapshots[0].timestamp)

    expect(diff?.kind).toBe('text')
    // only the restyled paragraph: one del/add pair at the op level
    expect(diff?.adds).toBe(1)
    expect(diff?.dels).toBe(1)

    // cell text stays the marker key (style-only changes must diff)…
    const pair = diff?.rows?.find(
      (r) => r.left !== null && r.right !== null && r.left.text !== r.right.text,
    )
    expect(pair).toBeDefined()
    expect(pair?.right?.text).toContain('<b,c123456,z36,f黑体>')
    // …but the renderer shows runs: plain text without markers, real formatting
    const display = (pair?.rightRuns ?? []).map((r) => r.text).join('')
    expect(display).toBe(plainText)
    const styled = pair?.rightRuns?.find((r) => r.color === '123456')
    expect(styled?.bold).toBe(true)
    expect(styled?.sizeHalfPoints).toBe(36)
    expect(styled?.font).toBe('黑体')

    // unchanged rows carry runs too, so the whole diff renders styled
    const same = diff?.rows?.find(
      (r) => r.left !== null && r.right !== null && r.left.text === r.right.text,
    )
    expect(same?.leftRuns).toBeDefined()
    expect(same?.rightRuns).toBeDefined()
  })
})
