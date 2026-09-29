/**
 * Selection export helpers: turn the active range into Markdown / CSV / JSON
 * text, copy it to the clipboard, or save it through the workbook:export-text
 * channel (save dialog + atomic write in the main process).
 */
import { showToast } from './toast-bus'
import { t } from './i18n/locale'

type RuntimeRef =
  { univerAPI: { getActiveWorkbook: () => { getActiveRange: () => ActiveRange | null } | null } | null } | null

type CellValue = string | number | boolean | null

/** escape pipes/line breaks so a cell stays one table cell in Markdown */
function mdCell(value: CellValue): string {
  const text = value === null ? '' : String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function mdRow(values: CellValue[]): string {
  return `| ${values.map(mdCell).join(' | ')} |`
}

export function rangeToMarkdown(values: CellValue[][]): string {
  if (values.length === 0) return ''
  const width = values[0]?.length ?? 0
  const header = mdRow(values[0] ?? [])
  const rule = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  const body = values.slice(1).map(mdRow)
  return values.length > 1 ? [header, rule, ...body].join('\n') : header
}

function csvCell(value: CellValue): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function rangeToCsv(values: CellValue[][]): string {
  return values.map((row) => row.map(csvCell).join(',')).join('\r\n')
}

export function rangeToJson(values: CellValue[][]): string {
  return JSON.stringify(values, null, 2)
}

type ActiveRange = {
  getRow(): number
  getColumn(): number
  getHeight(): number
  getWidth(): number
  getValues(): CellValue[][]
}

/** sheet name kept filesystem-safe for the default file name */
function sanitize(text: string): string {
  return text.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)
}

function readActiveRange(
  runtime: RuntimeRef,
): { values: CellValue[][]; label: string } | null {
  const range = runtime?.univerAPI?.getActiveWorkbook()?.getActiveRange()
  if (!range) return null
  const values = range.getValues().map((row) =>
    row.map((cell) =>
      cell === null || cell === undefined ? null : (cell as CellValue),
    ),
  )
  const label = `selection-r${range.getRow() + 1}c${range.getColumn() + 1}-${range.getHeight()}x${range.getWidth()}`
  return { values, label }
}

/** copy the active range to the clipboard as a Markdown table */
export async function copySelectionAsMarkdown(
  runtime: RuntimeRef,
  report: (message: string) => void,
): Promise<void> {
  const read = readActiveRange(runtime)
  if (!read) {
    showToast(t('appSelectionEmpty'), 'error')
    report(t('appSelectionEmpty'))
    return
  }
  const markdown = rangeToMarkdown(read.values)
  await navigator.clipboard.writeText(markdown)
  const rows = read.values.length
  const cols = read.values[0]?.length ?? 0
  const message = t('appSelectionCopiedMd', { r: String(rows), c: String(cols) })
  showToast(message, 'success')
  report(message)
}

/** save the active range as .md / .csv / .json via the export-text channel */
export async function exportSelectionToFile(
  runtime: RuntimeRef,
  report: (message: string) => void,
): Promise<void> {
  const read = readActiveRange(runtime)
  if (!read) {
    showToast(t('appSelectionEmpty'), 'error')
    report(t('appSelectionEmpty'))
    return
  }
  const fileName = `${read.label}.md`
  const result = await window.desktopApi.exportText({ fileName, content: rangeToMarkdown(read.values) })
  if (!result.canceled) {
    const message = t('appExportTextDone')
    showToast(message, 'success')
    report(message)
  }
}
