import { useState } from 'react'
import { useI18n } from './locale'
import type { I18n } from './locale'
import type {
  LibraryEntryInfo,
  LibrarySnapshotCell,
  LibrarySnapshotDiff,
  LibrarySnapshotInfo,
  LibrarySnapshotDiffRow,
} from '../../shared/home-api'

export type SnapshotDiffView =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; diff: LibrarySnapshotDiff }

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

/** a row differs when either side is missing or the texts disagree */
function isChanged(row: LibrarySnapshotDiffRow): boolean {
  if (row.left === null || row.right === null) return true
  return row.left.text !== row.right.text
}

interface Hunk {
  kind: 'fold' | 'rows'
  count: number
  items?: Array<{ row: LibrarySnapshotDiffRow; changed: boolean }>
}

/** group rows into hunks: changed rows plus 2 lines of context, unchanged runs folded */
function buildHunks(rows: LibrarySnapshotDiffRow[], context: number): Hunk[] {
  const changed = rows.map(isChanged)
  const keep = new Set<number>()
  changed.forEach((flag, i) => {
    if (!flag) return
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
      keep.add(k)
    }
  })
  const out: Hunk[] = []
  let current: Array<{ row: LibrarySnapshotDiffRow; changed: boolean }> = []
  let folds = 0
  for (let i = 0; i < rows.length; i++) {
    if (keep.has(i)) {
      current.push({ row: rows[i], changed: changed[i] })
    } else {
      if (current.length > 0) {
        out.push({ kind: 'rows', count: 0, items: current })
        current = []
      }
      folds++
    }
  }
  if (current.length > 0) out.push({ kind: 'rows', count: 0, items: current })
  if (folds > 0) out.push({ kind: 'fold', count: folds })
  return out
}

/** one aligned side-by-side row: red-tinted old cell, green-tinted new cell */
function DiffRow({ row, changed }: { readonly row: LibrarySnapshotDiffRow; readonly changed: boolean }): React.JSX.Element {
  const leftClass = row.left === null ? ' snap-diff-empty' : changed ? ' snap-diff-del' : ''
  const rightClass = row.right === null ? ' snap-diff-empty' : changed ? ' snap-diff-add' : ''
  return (
    <div className={`snap-diff-grid${changed ? ' snap-diff-changed' : ''}`}>
      <div className={`snap-diff-side${leftClass}`}>
        <span className="snap-diff-n">{row.left?.n ?? ''}</span>
        <span className="snap-diff-text">{row.left?.text ?? ''}</span>
      </div>
      <div className={`snap-diff-side${rightClass}`}>
        <span className="snap-diff-n">{row.right?.n ?? ''}</span>
        <span className="snap-diff-text">{row.right?.text ?? ''}</span>
      </div>
    </div>
  )
}

/**
 * Version-history modal for one library copy. Each version can be expanded
 * into a git-style side-by-side diff against the current copy (text
 * documents) or a size/identity comparison (binary formats). Unchanged
 * regions fold into separators so the changed lines stand out.
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
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal library-snapshots-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('librarySnapshots')}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{t('librarySnapshots')}</h3>
        <p className="library-snapshots-name">{entry.name}</p>
        {snapshots === null ? (
          <p className="empty-hint">…</p>
        ) : snapshots.length === 0 ? (
          <p className="empty-hint">{t('librarySnapshotEmpty')}</p>
        ) : (
          <ul className="library-snapshots-list">
            {snapshots.map((snapshot) => (
              <li key={snapshot.timestamp} className="library-snapshots-item">
                <div className="library-snapshots-row">
                  <span>{formatModified(snapshot.timestamp, i18n)}</span>
                  <span className="library-snapshots-size">{formatSize(snapshot.sizeBytes)}</span>
                  <button
                    className="selection-action"
                    onClick={() => {
                      setExpanded((cur) => (cur === snapshot.timestamp ? null : snapshot.timestamp))
                      onDiff(entry, snapshot.timestamp)
                    }}
                  >
                    {expanded === snapshot.timestamp
                      ? t('librarySnapshotHideCompare')
                      : t('librarySnapshotCompare')}
                  </button>
                  <button className="selection-action" onClick={() => onRestore(snapshot.timestamp)}>
                    {t('librarySnapshotRestore')}
                  </button>
                </div>
                {expanded === snapshot.timestamp && (
                  <SnapshotDiffPanel entry={entry} diff={diff} onRestore={onRestore} snapshot={snapshot} i18n={i18n} />
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="modal-buttons">
          <button onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  )
}

function SnapshotDiffPanel({
  entry,
  diff,
  snapshot,
  onRestore,
  i18n,
}: {
  readonly entry: LibraryEntryInfo
  readonly diff: SnapshotDiffView | null
  readonly snapshot: LibrarySnapshotInfo
  readonly onRestore: (timestamp: number) => void
  readonly i18n: I18n
}): React.JSX.Element {
  const { t } = i18n
  const textDiff = diff?.state === 'ready' && diff.diff.kind === 'text' ? diff.diff : null
  const hunks = textDiff?.rows === undefined ? null : buildHunks(textDiff.rows, 2)
  return (
    <div className="snap-diff">
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
          {diff.diff.identical ? ' — ' + t('librarySnapshotSame') : ' — ' + t('librarySnapshotDiffers')}
        </p>
      ) : (
        <div className="snap-diff-table">
          <div className="snap-diff-header">
            <span className="snap-diff-side">{t('librarySnapshotOldCol')}</span>
            <span className="snap-diff-side">{t('librarySnapshotNewCol')}</span>
          </div>
          <div className="snap-diff-body">
            {(hunks ?? []).map((hunk, hi) => (
              <div key={hi}>
                {hunk.kind === 'fold' ? (
                  <div className="snap-diff-fold">{t('librarySnapshotFolded', { count: hunk.count })}</div>
                ) : (
                  hunk.items?.map((item, ri) => (
                    <DiffRow key={ri} row={item.row} changed={item.changed} />
                  ))
                )}
              </div>
            ))}
            <p className="snap-diff-summary">
              <span className="snap-diff-adds">+{textDiff?.adds ?? 0}</span>{' '}
              <span className="snap-diff-dels">−{textDiff?.dels ?? 0}</span>
              {textDiff?.truncated && (
                <span className="snap-diff-trunc">{t('librarySnapshotMore')}</span>
              )}
            </p>
          </div>
        </div>
      )}
      <div className="modal-buttons">
        <button onClick={() => onRestore(snapshot.timestamp)}>{t('librarySnapshotRestore')}</button>
      </div>
    </div>
  )
}
