import type {SanityFetchLike} from '../resolveAgent.js'
import type {ChatScope} from './chats.js'
import type {ListingFilters} from './intent.js'

/** What the commander needs to know about a listing: the card, the change, the undo. */
export type ListingRow = {
  _id: string
  _rev: string
  title: string | null
  slug: string | null
  slugRu: string | null
  price: number | null
  priceUnit: string | null
  priceHistory: Array<{_key?: string; date?: string; price?: number; priceUnit?: string}> | null
  area: number | null
  bedrooms: number | null
  rooms: number | null
  status: string | null
  isPublished: boolean | null
  lifecycleStatus: string | null
  propertyCode: string | null
  createdAt: string | null
  agentId: string | null
  agentName: string | null
  agentHasLeadChat: boolean
  cityNames: string[]
  districtNames: string[]
  city: string | null
  district: string | null
  photo: string | null
  hasDraft: boolean
}

const PROJECTION = `{
  _id, _rev,
  "title": coalesce(title.ru, title.en, title.uk, title.sq),
  "slug": slug.current,
  "slugRu": localizedSlug.ru,
  price, priceUnit, priceHistory, area, bedrooms, rooms, status, isPublished, lifecycleStatus, propertyCode,
  "createdAt": coalesce(createdAt, _createdAt),
  "agentId": agent._ref,
  "agentName": agent->name,
  "agentHasLeadChat": defined(agent->telegramLeadChatId) && agent->telegramLeadChatId != "",
  "cityNames": [city->title.en, city->title.ru, city->title.uk, city->title.sq, city->title.it, city->slug.current],
  "districtNames": [district->title.en, district->title.ru, district->title.uk, district->title.sq, district->title.it, district->slug.current],
  "city": coalesce(city->title.ru, city->title.en),
  "district": coalesce(district->title.ru, district->title.en),
  "photo": gallery[0].asset->url,
  "hasDraft": defined(*[_id == "drafts." + ^._id][0]._id)
}`

const PUBLISHED = `_type == "property" && !(_id in path("drafts.**"))`

/** Whether this chat may touch this listing. */
export function inScope(row: Pick<ListingRow, 'agentId' | 'agentHasLeadChat'>, scope: ChatScope): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'general') return !row.agentHasLeadChat
  return row.agentId !== null && scope.agentIds.includes(row.agentId)
}

function scopeFilter(scope: ChatScope): string {
  if (scope.kind === 'all') return ''
  if (scope.kind === 'general') return ' && !(defined(agent->telegramLeadChatId) && agent->telegramLeadChatId != "")'
  return ' && agent._ref in $agentIds'
}

function clean(row: ListingRow): ListingRow {
  return {
    ...row,
    cityNames: (row.cityNames ?? []).filter((n): n is string => typeof n === 'string' && n.length > 0),
    districtNames: (row.districtNames ?? []).filter((n): n is string => typeof n === 'string' && n.length > 0),
    agentHasLeadChat: row.agentHasLeadChat === true,
    hasDraft: row.hasDraft === true,
  }
}

/** One listing by id — fresh state for the confirm and undo steps. Ignores scope; callers check it. */
export async function fetchListing(sanity: SanityFetchLike, id: string): Promise<ListingRow | null> {
  const row = (await sanity.fetch(`*[${PUBLISHED} && _id == $id][0]${PROJECTION}`, {id})) as ListingRow | null
  return row ? clean(row) : null
}

/**
 * A listing named outright: slug in any language, listing code or document
 * id. Searched across ALL listings, so a listing outside the chat's scope is
 * reported as someone else's rather than as missing.
 */
export async function findByRef(sanity: SanityFetchLike, ref: string): Promise<ListingRow[]> {
  const rows = (await sanity.fetch(
    `*[${PUBLISHED} && (
      slug.current == $ref || propertyCode == $ref || _id == $ref ||
      $ref in [localizedSlug.en, localizedSlug.ru, localizedSlug.uk, localizedSlug.sq, localizedSlug.it, localizedSlug.pl, localizedSlug.de]
    )][0...5]${PROJECTION}`,
    {ref},
  )) as ListingRow[]
  return rows.map(clean)
}

/** Every listing this chat may change, narrowed by the numbers the command gave. */
export async function fetchCandidates(
  sanity: SanityFetchLike,
  scope: ChatScope,
  filters: ListingFilters,
): Promise<ListingRow[]> {
  const parts: string[] = []
  const params: Record<string, unknown> = {}
  if (scope.kind === 'agents') params.agentIds = scope.agentIds
  if (filters.price !== null) {
    parts.push('price >= $pMin && price <= $pMax')
    params.pMin = filters.price * (1 - PRICE_TOLERANCE)
    params.pMax = filters.price * (1 + PRICE_TOLERANCE)
  }
  const extra = parts.length ? ` && ${parts.join(' && ')}` : ''
  const rows = (await sanity.fetch(
    `*[${PUBLISHED}${scopeFilter(scope)}${extra}][0...3000]${PROJECTION}`,
    params,
  )) as ListingRow[]
  return rows.map(clean)
}

const PRICE_TOLERANCE = 0.06
const AREA_TOLERANCE = 0.08

/** Lower-case, no diacritics, Cyrillic transliterated — "Дуррес" and "Durrës" meet at "durres". */
export function normName(s: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', є: 'e', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i',
    й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
    ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  }
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
    .replace(/rr/g, 'r')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function nameMatches(wanted: string, names: string[]): boolean {
  const w = normName(wanted)
  if (!w) return true
  return names.some((n) => {
    const x = normName(n)
    if (!x) return false
    if (x === w || x.includes(w) || w.includes(x)) return true
    // Speech and transliteration differ in endings: Durrës / Дурресе, Vlorë / Влёре.
    const k = Math.min(5, w.length, x.length)
    return k >= 4 && x.slice(0, k) === w.slice(0, k)
  })
}

/**
 * Listings that fit everything the command said. Every given filter must
 * hold; layouts match on bedrooms OR rooms because "двушка" and "2+1" count
 * differently. Closest price first.
 */
export function rankListings(rows: ListingRow[], f: ListingFilters): ListingRow[] {
  const hits = rows.filter((r) => {
    if (f.city && !nameMatches(f.city, [...r.cityNames, ...r.districtNames])) return false
    if (f.district && !nameMatches(f.district, r.districtNames)) return false
    if (f.bedrooms !== null && r.bedrooms !== f.bedrooms && r.rooms !== f.bedrooms + 1) return false
    if (f.rooms !== null && r.rooms !== f.rooms && r.bedrooms !== f.rooms - 1 && r.bedrooms !== f.rooms) return false
    if (f.price !== null) {
      if (r.price === null || Math.abs(r.price - f.price) > f.price * PRICE_TOLERANCE) return false
    }
    if (f.areaM2 !== null) {
      if (r.area === null || Math.abs(r.area - f.areaM2) > f.areaM2 * AREA_TOLERANCE) return false
    }
    if (f.dealType === 'sale' && r.status && r.status !== 'sale') return false
    if (f.dealType === 'rent' && r.status && r.status === 'sale') return false
    return true
  })
  const target = f.price
  if (target === null) return hits
  return hits.sort((a, b) => Math.abs((a.price ?? 0) - target) - Math.abs((b.price ?? 0) - target))
}

/** True when the command said nothing that could narrow a search. */
export function filtersEmpty(f: ListingFilters): boolean {
  return Object.values(f).every((v) => v === null)
}
