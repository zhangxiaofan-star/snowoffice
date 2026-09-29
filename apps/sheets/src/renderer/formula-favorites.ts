/**
 * Formula favorites: a small local list of saved formulas, persisted in
 * localStorage (no main-process involvement). Insert re-uses the stored
 * formula text verbatim at the active cell.
 */

export interface FormulaFavorite {
  id: string
  /** the formula text including the leading '=' */
  formula: string
  /** free note; defaults to '' (the formula itself is shown in the list) */
  note: string
  createdAt: number
}

const KEY = 'ai-sheets-formula-favorites'

export function listFormulaFavorites(): FormulaFavorite[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (Array.isArray(raw)) {
      return raw.filter(
        (f): f is FormulaFavorite =>
          !!f &&
          typeof (f as FormulaFavorite).id === 'string' &&
          typeof (f as FormulaFavorite).formula === 'string',
      )
    }
  } catch {
    // corrupt store: start over
  }
  return []
}

export function saveFormulaFavorite(formula: string, note: string = ''): FormulaFavorite {
  const favorites = listFormulaFavorites().filter((f) => f.formula !== formula)
  const favorite: FormulaFavorite = {
    id: `ff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    formula,
    note,
    createdAt: Date.now(),
  }
  favorites.unshift(favorite)
  localStorage.setItem(KEY, JSON.stringify(favorites.slice(0, 100)))
  return favorite
}

export function removeFormulaFavorite(id: string): void {
  const favorites = listFormulaFavorites().filter((f) => f.id !== id)
  localStorage.setItem(KEY, JSON.stringify(favorites))
}

export function findFormulaFavorite(id: string): FormulaFavorite | undefined {
  return listFormulaFavorites().find((f) => f.id === id)
}
