import { useState } from 'react'
import { useI18n } from './i18n/locale'
import { useModalDialog } from './modal-dialog'
import { listFormulaFavorites, removeFormulaFavorite, type FormulaFavorite } from './formula-favorites'

/**
 * Formula favorites manager: pick a saved formula to insert it at the active
 * cell (the insert command carries the favorite id), or delete entries.
 */
export function FormulaFavoritesDialog({
  onCommand,
  onClose,
}: {
  readonly onCommand: (command: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [favorites, setFavorites] = useState<FormulaFavorite[]>(() => listFormulaFavorites())
  const modal = useModalDialog(onClose)
  const remove = (id: string) => {
    removeFormulaFavorite(id)
    setFavorites(listFormulaFavorites())
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="format-cells-dialog"
        role="dialog"
        {...modal}
        aria-label={t('appFormulaFavorites')}
        onClick={(event) => event.stopPropagation()}
      >
        <header>{t('appFormulaFavorites')}</header>
        <div className="dialog-body">
          {favorites.length === 0 ? (
            <p className="dialog-note">{t('appFormulaNoFavorites')}</p>
          ) : (
            <ul className="formula-favorites-list">
              {favorites.map((favorite) => (
                <li key={favorite.id} className="formula-favorites-row">
                  <code className="formula-favorites-formula" title={favorite.formula}>
                    {favorite.formula}
                  </code>
                  <button
                    className="dialog-mini-btn"
                    onClick={() => {
                      onCommand(`formula-favorites-insert:${favorite.id}`)
                      onClose()
                    }}
                  >
                    {t('appFormulaInsert')}
                  </button>
                  <button
                    className="dialog-mini-btn danger"
                    aria-label={t('appFormulaRemove')}
                    onClick={() => remove(favorite.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="dialog-actions">
          <button onClick={onClose}>{t('appCancel')}</button>
        </footer>
      </div>
    </div>
  )
}
