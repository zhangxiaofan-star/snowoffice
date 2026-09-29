import { useMemo, useState } from 'react'
import { useI18n } from './i18n/locale'
import { useModalDialog } from './modal-dialog'

/**
 * Advanced find & replace across every worksheet: scope the search to
 * formulas, values or both, preview each hit (before → after), then replace
 * all in one undoable pass. Formula hits are rewritten through setFormula;
 * value hits only touch cells that are not formulas (a formula's display
 * value comes back after any recalc, so rewriting it would be lost).
 */

interface RangeLike {
  getValues(): unknown[][]
  getFormulas(): (string | null)[][]
  setValues(values: unknown[][]): void
  setFormula(formula: string): void
}

interface SheetLike {
  getSheetId(): string
  getName(): string
  getMaxRows(): number
  getMaxColumns(): number
  getRange(row: number, column: number, rows: number, cols: number): RangeLike
}

interface WorkbookLike {
  getSheets(): SheetLike[]
}

type Scope = 'all' | 'formulas' | 'values'

interface Hit {
  sheetId: string
  sheetName: string
  row: number
  column: number
  /** formula text when the match is in the formula, else the display value */
  before: string
  after: string
  /** true when the replacement must land as a formula */
  isFormula: boolean
}

function addressOf(row: number, column: number): string {
  let text = ''
  let c = column
  while (c >= 0) {
    text = String.fromCharCode(65 + (c % 26)) + text
    c = Math.floor(c / 26) - 1
  }
  return `${text}${row + 1}`
}

function replaceAll(text: string, find: string, replace: string): { text: string; count: number } {
  let count = 0
  let out = text
  let cursor = 0
  if (find === '') return { text, count: 0 }
  for (;;) {
    const at = out.indexOf(find, cursor)
    if (at === -1) break
    out = out.slice(0, at) + replace + out.slice(at + find.length)
    cursor = at + replace.length
    count++
  }
  return { text: out, count }
}

export function FindReplaceProDialog({
  univerRef,
  onClose,
}: {
  readonly univerRef: { readonly current: unknown }
  readonly onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const modal = useModalDialog(onClose)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const workbook = useMemo(() => {
    // the shell hands us its live Univer runtime; pull the facade workbook
    const runtime = univerRef.current as {
      univerAPI?: { getActiveWorkbook?: () => unknown }
    } | null
    return (runtime?.univerAPI?.getActiveWorkbook?.() ?? null) as WorkbookLike | null
  }, [univerRef])

  const scan = (): Hit[] => {
    if (!workbook || find === '') return []
    const found: Hit[] = []
    for (const sheet of workbook.getSheets()) {
      const rows = sheet.getMaxRows()
      const cols = sheet.getMaxColumns()
      if (rows <= 0 || cols <= 0) continue
      const range = sheet.getRange(0, 0, rows, cols)
      const values = range.getValues()
      const formulas = range.getFormulas()
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < cols; column++) {
          const formula = formulas[row]?.[column] ?? null
          const raw = values[row]?.[column]
          const display = raw === null || raw === undefined ? '' : String(raw)
          if (scope !== 'values' && formula && formula.includes(find)) {
            found.push({
              sheetId: sheet.getSheetId(),
              sheetName: sheet.getName(),
              row,
              column,
              before: formula,
              after: replaceAll(formula, find, replace).text,
              isFormula: true,
            })
          } else if (scope !== 'formulas' && !formula && display.includes(find)) {
            found.push({
              sheetId: sheet.getSheetId(),
              sheetName: sheet.getName(),
              row,
              column,
              before: display,
              after: replaceAll(display, find, replace).text,
              isFormula: false,
            })
          }
        }
      }
    }
    return found
  }

  const doPreview = () => {
    if (find === '') return
    setBusy(true)
    try {
      const found = scan()
      setHits(found)
      setMessage(found.length === 0 ? t('frproNoMatches') : '')
    } finally {
      setBusy(false)
    }
  }

  const doReplaceAll = () => {
    if (!workbook) return
    setBusy(true)
    try {
      const found = hits ?? scan()
      let done = 0
      for (const hit of found) {
        const sheet = workbook.getSheets().find((s) => s.getSheetId() === hit.sheetId)
        if (!sheet) continue
        const cell = sheet.getRange(hit.row, hit.column, 1, 1)
        try {
          if (hit.isFormula) cell.setFormula(hit.after)
          else cell.setValues([[hit.after]])
          done++
        } catch {
          // one stubborn cell must not stop the rest
        }
      }
      setHits(null)
      setMessage(t('frproDone', { count: done }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="format-cells-dialog frpro-dialog"
        role="dialog"
        {...modal}
        aria-label={t('frproTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <header>{t('frproTitle')}</header>
        <div className="dialog-body">
          <label className="sort-header-check frpro-row">
            <span>{t('frproFind')}</span>
            <input value={find} onChange={(event) => setFind(event.target.value)} />
          </label>
          <label className="sort-header-check frpro-row">
            <span>{t('frproReplace')}</span>
            <input value={replace} onChange={(event) => setReplace(event.target.value)} />
          </label>
          <div className="frpro-scope" role="radiogroup" aria-label={t('frproScopeLabel')}>
            {(
              [
                ['all', t('frproScopeAll')],
                ['formulas', t('frproScopeFormulas')],
                ['values', t('frproScopeValues')],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="sort-header-check">
                <input
                  type="radio"
                  name="frpro-scope"
                  checked={scope === value}
                  onChange={() => setScope(value)}
                />
                {label}
              </label>
            ))}
          </div>
          {message && <p className="dialog-note">{message}</p>}
          {hits !== null && hits.length > 0 && (
            <ul className="frpro-hits">
              {hits.slice(0, 200).map((hit, index) => (
                <li key={`${hit.sheetId}-${hit.row}-${hit.column}-${index}`}>
                  <span className="frpro-hit-where">
                    {hit.sheetName}!{addressOf(hit.row, hit.column)}
                  </span>
                  <span className="frpro-hit-before">{hit.before}</span>
                  <span className="frpro-hit-after">{hit.after}</span>
                </li>
              ))}
              {hits.length > 200 && (
                <li className="frpro-more">{t('frproMore', { count: hits.length - 200 })}</li>
              )}
            </ul>
          )}
        </div>
        <footer className="dialog-actions">
          <button disabled={busy || find === ''} onClick={doPreview}>
            {t('frproPreview')}
          </button>
          <button
            className="primary"
            disabled={busy || find === '' || hits === null}
            onClick={doReplaceAll}
          >
            {t('frproReplaceAll')}
          </button>
          <button onClick={onClose}>{t('appCancel')}</button>
        </footer>
      </div>
    </div>
  )
}
