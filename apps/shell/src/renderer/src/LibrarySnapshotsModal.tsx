import { useEffect, useState } from 'react'
import { useI18n } from './locale'
import type { I18n } from './locale'
import type {
  LibraryEntryInfo,
  LibrarySnapshotCell,
  LibrarySnapshotDiff,
  LibrarySnapshotInfo,
  LibrarySnapshotDiffRow,
  LibrarySnapshotRun,
  LibrarySnapshotSeg,
} from '../../shared/home-api'

export type SnapshotDiffView =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; diff: LibrarySnapshotDiff }

/** OOXML w:highlight names → css colors */
const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgreen: '#006400',
  darkmagenta: '#8b008b',
  darkred: '#8b0000',
  darkyellow: '#808000',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  black: '#000000',
  white: '#ffffff',
}

function runStyle(run: LibrarySnapshotRun): React.CSSProperties {
  const style: React.CSSProperties = {}
  if (run.bold) style.fontWeight = 700
  if (run.italic) style.fontStyle = 'italic'
  const deco = [run.underline ? 'underline' : '', run.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  if (deco) style.textDecoration = deco
  if (run.color) style.color = `#${run.color}`
  if (run.sizeHalfPoints) style.fontSize = `${run.sizeHalfPoints / 2}pt`
  if (run.font) style.fontFamily = `"${run.font}", "Microsoft YaHei", sans-serif`
  if (run.highlight) {
    style.backgroundColor = HIGHLIGHT_HEX[run.highlight.toLowerCase()] ?? `#${run.highlight}`
  }
  return style
}

/**
 * One diff column: docx rows carry styled runs — render each run with its real
 * formatting (color/font/size/…), split at the inline word-segment boundaries
 * so deletions/additions stay highlighted inside the styled text. Plain rows
 * keep the previous segment-or-text rendering.
 */
function DiffSide({
  cell,
  runs,
  segs,
  segClass,
}: {
  readonly cell: LibrarySnapshotCell
  readonly runs?: LibrarySnapshotRun[]
  readonly segs?: LibrarySnapshotSeg[]
  readonly segClass?: 'snap-seg-del' | 'snap-seg-add'
}): React.JSX.Element {
  let content: React.ReactNode = cell?.text
  if (runs && runs.length > 0) {
    const pieces: Array<{ text: string; run: LibrarySnapshotRun; seg?: string }> = []
    if (segs && segs.length > 0) {
      let ri = 0
      let off = 0
      for (const seg of segs) {
        let need = seg.text.length
        while (need > 0) {
          const run = runs[ri]
          if (!run) break
          const take = Math.min(run.text.length - off, need)
          if (take > 0) {
            pieces.push({
              text: run.text.slice(off, off + take),
              run,
              seg: seg.t !== 'same' ? segClass : undefined,
            })
            off += take
            need -= take
          }
          if (off >= run.text.length) {
            ri++
            off = 0
          }
        }
      }
      while (ri < runs.length) {
        pieces.push({ text: runs[ri].text.slice(off), run: runs[ri] })
        ri++
        off = 0
      }
    } else {
      for (const run of runs) pieces.push({ text: run.text, run })
    }
    content = pieces.map((piece, pi) => (
      <span key={pi} className={piece.seg} style={runStyle(piece.run)}>
        {piece.text}
      </span>
    ))
  } else if (segs && segs.length > 0) {
    content = segs.map((seg, si) => (
      <span key={si} className={seg.t !== 'same' ? segClass : undefined}>
        {seg.text}
      </span>
    ))
  }
  return <span className="snap-diff-text">{content}</span>
}

function formatModified(mtimeMs: number, i18n: I18n): string {
  const date = new Date(mtimeMs)
  const now = new Date()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
  if (days <= 0) {
    return `${i18n.t('today')} · ${date.toLocaleTimeString(i18n.dateLocale, { hour: '2-digit', minute: '2-digit' })}`
  }
  if (days === 1) return i18n.t('yesterday')
  return date.toLocaleDateString(i18n.dateLocale, { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Version-history modal: wide two-pane layout — version timeline on the left,
 * side-by-side git-style diff against the current copy on the right.
 */
export function LibrarySnapshotsModal({
  entry,
  snapshots,
  diff,
  onDiff,
  onClose,
  onRestore,
}: {
  readonly entry: LibraryEntryInfo
  readonly snapshots: LibrarySnapshotInfo[] | null
  readonly diff: SnapshotDiffView | null
  readonly onDiff: (entry: LibraryEntryInfo, timestamp: number) => void
  readonly onClose: () => void
  readonly onRestore: (timestamp: number) => void
}): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  // newest version is selected when the modal opens
  const [selected, setSelected] = useState<number | null>(null)

  const newest = snapshots && snapshots.length > 0 ? snapshots[0].timestamp : null
  const active = selected ?? newest

  useEffect(() => {
    if (active !== null) onDiff(entry, active)
    // re-run when the selection changes
  }, [active])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal library-snapshots-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('librarySnapshots')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="library-snapshots-layout">
          <aside className="library-snapshots-side">
            <h3>{t('librarySnapshots')}</h3>
            <p className="library-snapshots-name" title={entry.name}>
              {entry.name}
            </p>
            <ul className="library-snapshots-list">
              {(snapshots ?? []).map((snapshot, index) => (
                <li key={snapshot.timestamp}>
                  <button
                    className={`library-snapshots-choice${snapshot.timestamp === active ? ' active' : ''}`}
                    onClick={() => setSelected(snapshot.timestamp)}
                  >
                    <span className="library-snapshots-choice-t">
                      {formatModified(snapshot.timestamp, i18n)}
                      {index === 0 && (
                        <span className="library-snapshots-latest">
                          {t('librarySnapshotLatest')}
                        </span>
                      )}
                    </span>
                    <span className="library-snapshots-choice-s">
                      {formatSize(snapshot.sizeBytes)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <section className="library-snapshots-diffpane">
            <div className="library-snapshots-diffhead">
              <span>{t('librarySnapshotCompareWith')}</span>
              <button
                className="btn primary"
                disabled={active === null}
                onClick={() => active !== null && onRestore(active)}
              >
                {t('librarySnapshotRestore')}
              </button>
            </div>
            <div className="library-snapshots-diffscroll">
              {diff === null || diff.state === 'loading' ? (
                <p className="empty-hint">…</p>
              ) : diff.state === 'error' ? (
                <p className="empty-hint">{t('librarySnapshotDiffError')}</p>
              ) : diff.diff.kind === 'binary' ? (
                <p className="empty-hint">
                  {t('librarySnapshotBinary', {
                    snap: formatSize(diff.diff.snapshotBytes ?? 0),
                    cur: formatSize(diff.diff.currentBytes ?? 0),
                  })}
                  {diff.diff.identical
                    ? ' — ' + t('librarySnapshotSame')
                    : ' — ' + t('librarySnapshotDiffers')}
                </p>
              ) : (
                <div className="snap-diff-table">
                  <div className="snap-diff-header">
                    <span className="snap-diff-side">{t('librarySnapshotOldCol')}</span>
                    <span className="snap-diff-side">{t('librarySnapshotNewCol')}</span>
                  </div>
                  <div className="snap-diff-body">
                    {diff.diff.rows?.map((row, i) => {
                      const changed =
                        row.left === null ||
                        row.right === null ||
                        row.left.text !== row.right.text
                      const leftClass = row.left === null
                        ? ' snap-diff-empty'
                        : changed
                          ? ' snap-diff-del'
                          : ''
                      const rightClass = row.right === null
                        ? ' snap-diff-empty'
                        : changed
                          ? ' snap-diff-add'
                          : ''
                      return (
                        <div key={i} className={`snap-diff-grid${changed ? ' snap-diff-changed' : ''}`}>
                          <div className={`snap-diff-side${leftClass}`}>
                            <span className="snap-diff-n">{row.left?.n ?? ''}</span>
                            <DiffSide
                              cell={row.left}
                              runs={row.leftRuns}
                              segs={row.leftSegs}
                              segClass="snap-seg-del"
                            />
                          </div>
                          <div className={`snap-diff-side${rightClass}`}>
                            <span className="snap-diff-n">{row.right?.n ?? ''}</span>
                            <DiffSide
                              cell={row.right}
                              runs={row.rightRuns}
                              segs={row.rightSegs}
                              segClass="snap-seg-add"
                            />
                          </div>
                        </div>
                      )
                    })}
                    {diff.diff.truncated && (
                      <div className="snap-diff-fold">{t('librarySnapshotMore')}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
        <div className="modal-buttons">
          <button onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  )
}
