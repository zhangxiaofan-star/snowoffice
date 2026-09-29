import { useState } from 'react'
import { useI18n } from './locale'
import type { I18n } from './locale'
import type { LibraryEntryInfo, LibrarySnapshotDiff, LibrarySnapshotInfo } from '../../shared/home-api'

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

/**
 * Version-history modal for one library copy. Each version can be expanded
 * into a git-style line diff against the current copy (text documents) or a
 * size/identity comparison (binary formats).
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
                    {t('librarySnapshotCompare')}
                  </button>
                  <button className="selection-action" onClick={() => onRestore(snapshot.timestamp)}>
                    {t('librarySnapshotRestore')}
                  </button>
                </div>
                {expanded === snapshot.timestamp && (
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
                        {diff.diff.identical ? ' — ' + t('librarySnapshotSame') : ''}
                      </p>
                    ) : (
                      <div>
                        <p className="snap-diff-summary">
                          <span className="snap-diff-adds">+{diff.diff.adds ?? 0}</span>{' '}
                          <span className="snap-diff-dels">−{diff.diff.dels ?? 0}</span>
                          {diff.diff.truncated && (
                            <span className="snap-diff-trunc">{t('librarySnapshotMore')}</span>
                          )}
                        </p>
                        <div className="snap-diff-lines">
                          {diff.diff.lines?.map((line, i) => (
                            <div key={i} className={`snap-diff-line snap-diff-${line.type}`}>
                              <span className="snap-diff-sign">
                                {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
                              </span>
                              <span>{line.text}</span>
                            </div>
                          ))}
                          {diff.diff.truncated && (
                            <p className="snap-diff-trunc">{t('librarySnapshotMore')}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
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
