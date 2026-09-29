import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from './locale'

/**
 * Ctrl+K command palette for the Home screen: fuzzy file search through the
 * local index (home:search-files) plus built-in navigation/new-document
 * commands. Arrow keys move, Enter runs, Escape closes.
 */

interface PaletteFileHit {
  path: string
  name: string
  ext: string
}

interface PaletteItem {
  key: string
  label: string
  hint?: string
  run: () => void
}

export function CommandPalette({
  onClose,
  onOpenSettings,
  onShowLibrary,
  onShowRecent,
  onShowStarred,
}: {
  readonly onClose: () => void
  readonly onOpenSettings: () => void
  readonly onShowLibrary: () => void
  readonly onShowRecent: () => void
  readonly onShowStarred: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<PaletteFileHit[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const commands: PaletteItem[] = useMemo(
    () => [
      { key: 'cmd-new-doc', label: t('newDoc'), run: () => void window.aiOffice.newDoc() },
      { key: 'cmd-new-sheet', label: t('newSheet'), run: () => void window.aiOffice.newSheet() },
      { key: 'cmd-new-slide', label: t('newSlide'), run: () => void window.aiOffice.newSlide() },
      {
        key: 'cmd-new-markdown',
        label: t('newMarkdown'),
        run: () => void window.aiOffice.newMarkdown(),
      },
      { key: 'cmd-new-html', label: t('newHtml'), run: () => void window.aiOffice.newHtml() },
      { key: 'cmd-new-pdf', label: t('newPdf'), run: () => void window.aiOffice.newPdf() },
      { key: 'cmd-open-local', label: t('openLocal'), run: () => void window.aiOffice.browse() },
      { key: 'cmd-settings', label: t('paletteSettings'), run: onOpenSettings },
      { key: 'cmd-library', label: t('navLibrary'), run: onShowLibrary },
      { key: 'cmd-recent', label: t('navRecent'), run: onShowRecent },
      { key: 'cmd-starred', label: t('navStarred'), run: onShowStarred },
    ],
    [t, onOpenSettings, onShowLibrary, onShowRecent, onShowStarred],
  )

  const trimmed = query.trim().toLowerCase()
  const matchedCommands = useMemo(
    () =>
      trimmed
        ? commands.filter((c) => c.label.toLowerCase().includes(trimmed))
        : commands,
    [commands, trimmed],
  )

  // file hits come from the local index whenever there is a query
  useEffect(() => {
    if (!trimmed) {
      setFiles([])
      return
    }
    let canceled = false
    void window.aiOffice
      .searchFiles({ q: trimmed, limit: 8 })
      .then((page) => {
        if (canceled) return
        setFiles(page.hits.map((hit) => ({ path: hit.path, name: hit.name, ext: hit.ext })))
      })
      .catch(() => {
        if (!canceled) setFiles([])
      })
    return () => {
      canceled = true
    }
  }, [trimmed])

  const fileItems: PaletteItem[] = useMemo(
    () =>
      files.map((hit) => ({
        key: `file-${hit.path}`,
        label: hit.name,
        hint: hit.ext,
        run: () => void window.aiOffice.openPath(hit.path),
      })),
    [files],
  )

  const allItems = useMemo(() => [...matchedCommands, ...fileItems], [matchedCommands, fileItems])

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, allItems.length - 1)))
  }, [allItems.length])

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((s) => Math.min(s + 1, allItems.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      runItem(allItems[selected])
    }
  }

  // keep the highlighted row visible while arrowing through the list
  useEffect(() => {
    listRef.current
      ?.querySelectorAll('li')
      [selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palettePlaceholder')}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          autoFocus
          value={query}
          placeholder={t('palettePlaceholder')}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={handleKeyDown}
        />
        <ul className="command-palette-list" ref={listRef}>
          {allItems.length === 0 && (
            <li className="command-palette-empty">{t('paletteNoResults')}</li>
          )}
          {allItems.map((item, index) => (
            <li
              key={item.key}
              className={`command-palette-item${index === selected ? ' active' : ''}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => runItem(item)}
            >
              <span className="command-palette-label">{item.label}</span>
              {item.hint && <span className="command-palette-hint">{item.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
