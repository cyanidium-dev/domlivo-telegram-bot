const FIELDS = ['title', 'shortDescription', 'description'] as const

export type EditorialField = (typeof FIELDS)[number]

export type LocaleText = Record<string, string>

export type EditorialText = Record<EditorialField, LocaleText>

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isCompleteLocaleMap(value: unknown, locales: readonly string[]): boolean {
  const src = asRecord(value)
  if (!src) return false
  return locales.every((locale) => typeof src[locale] === 'string')
}

function completeLocaleMap(value: unknown, locales: readonly string[]): LocaleText {
  const src = asRecord(value) ?? {}
  const out: LocaleText = {}
  for (const locale of locales) {
    const v = src[locale]
    out[locale] = typeof v === 'string' ? v : ''
  }
  return out
}

/** Intake: every editorial field is present. A missing locale is an empty string. */
export function completeEditorial(
  editorial: unknown,
  locales: readonly string[],
): {editorial: EditorialText; incomplete: EditorialField[]} {
  const src = asRecord(editorial) ?? {}
  const incomplete: EditorialField[] = []
  const editorialOut = {} as EditorialText
  for (const field of FIELDS) {
    if (!isCompleteLocaleMap(src[field], locales)) incomplete.push(field)
    editorialOut[field] = completeLocaleMap(src[field], locales)
  }
  return {editorial: editorialOut, incomplete}
}

/**
 * Update: keep only fields the model actually sent. A blank or unreadable
 * field is dropped so it cannot replace the current title with nothing.
 */
export function completeUpdateEditorial(
  editorial: unknown,
  locales: readonly string[],
): {editorial: Partial<EditorialText> | null; incomplete: EditorialField[]} {
  if (editorial == null) return {editorial: null, incomplete: []}
  const src = asRecord(editorial)
  if (!src) return {editorial: null, incomplete: []}
  const out: Partial<EditorialText> = {}
  const incomplete: EditorialField[] = []
  for (const field of FIELDS) {
    if (!(field in src) || src[field] == null) continue
    const map = completeLocaleMap(src[field], locales)
    const usable = Object.values(map).some((text) => text.trim() !== '')
    if (!isCompleteLocaleMap(src[field], locales) || !usable) incomplete.push(field)
    if (!usable) continue
    out[field] = map
  }
  return {editorial: Object.keys(out).length > 0 ? out : null, incomplete}
}
