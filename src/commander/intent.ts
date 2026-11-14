import {log, errInfo} from '../log.js'
import {MODEL, type AnthropicLike} from '../parseListing.js'

export type CommandAction =
  | 'sold'
  | 'rented'
  | 'hide'
  | 'unhide'
  | 'price'
  | 'add'
  | 'find'
  | 'undo'
  | 'log'
  | 'help'
  | 'none'

/** Mutating actions — the ones that need a listing and a confirmation card. */
export const CHANGE_ACTIONS = ['sold', 'rented', 'hide', 'unhide', 'price'] as const
export type ChangeAction = (typeof CHANGE_ACTIONS)[number]

export function isChangeAction(a: CommandAction): a is ChangeAction {
  return (CHANGE_ACTIONS as readonly string[]).includes(a)
}

export type ListingFilters = {
  city: string | null
  district: string | null
  bedrooms: number | null
  rooms: number | null
  price: number | null
  areaM2: number | null
  dealType: 'sale' | 'rent' | null
}

export type Intent = {
  action: CommandAction
  /** New asking price in EUR, for `price`. */
  newPrice: number | null
  /** A URL, slug, listing code or id the message names verbatim. */
  listingRef: string | null
  filters: ListingFilters
}

const FILTERS_SCHEMA = {
  type: 'object',
  properties: {
    city: {type: ['string', 'null']},
    district: {type: ['string', 'null']},
    bedrooms: {type: ['integer', 'null']},
    rooms: {type: ['integer', 'null']},
    price: {type: ['number', 'null']},
    areaM2: {type: ['number', 'null']},
    dealType: {enum: ['sale', 'rent', null]},
  },
  required: ['city', 'district', 'bedrooms', 'rooms', 'price', 'areaM2', 'dealType'],
  additionalProperties: false,
}

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    action: {enum: ['sold', 'rented', 'hide', 'unhide', 'price', 'add', 'find', 'undo', 'log', 'help', 'none']},
    newPrice: {type: ['number', 'null']},
    listingRef: {type: ['string', 'null']},
    filters: FILTERS_SCHEMA,
  },
  required: ['action', 'newPrice', 'listingRef', 'filters'],
  additionalProperties: false,
}

const SYSTEM = `You turn a short chat command from a real-estate agent into a structured action for DomLivo, an Albanian property site. Commands come in Russian, Ukrainian, English or Albanian, typed or transcribed from voice (expect transcription slips).

Actions:
- sold: the property is sold ("продано", "продали", "sold", "u shit").
- rented: the property is rented out ("сдано", "сдали", "rented", "u dha me qira").
- hide: take it off the site ("скрой", "сними", "убери с сайта", "hide", "unpublish").
- unhide: put it back on the site / back on sale ("верни", "опубликуй снова", "снова в продаже").
- price: change the asking price ("цена теперь 79", "снизь до 85 000").
- add: they want to add a NEW property.
- find: they only want to find or look at a property, no change.
- undo: cancel the bot's last change ("отмени", "верни как было").
- log: show the history of changes ("журнал", "что меняли").
- help: what can the bot do.
- none: not a command for the bot (chit-chat, a question about a client, unclear).

Fields:
- newPrice: for price only. EUR. "79" or "79 тысяч" or "79k" in a price context means 79000; "1,2 млн" means 1200000. null otherwise.
- listingRef: copy verbatim any URL, slug, listing code or document id that identifies the property. null if none.
- filters: what the message says about the property, to search for it. null for everything not said.
  - city/district: Latin-script Albanian names (Durrës, Tiranë, Vlorë, Sarandë, Golem, Plazh, Shkëmbi i Kavajës, Mali i Robit...).
  - Albanian layout "2+1" means bedrooms 2. Russian "двушка" / "двухкомнатная" means rooms 2; "однушка" rooms 1; "трёшка" rooms 3; "студия" rooms 1.
  - price: the CURRENT price used to identify the property ("двушка за 85" -> 85000). Not the new price.
  - dealType: sale or rent if said.
The message may come with the text of a message it replies to (often a lead notification with a property link): use it only to find listingRef and filters, never as the command itself.`

/** Bare price numbers are thousands in speech ("за 85" = 85 000 €). */
export function normalizePrice(n: number | null): number | null {
  if (n === null || !Number.isFinite(n) || n <= 0) return null
  return n < 10_000 ? Math.round(n * 1000) : Math.round(n)
}

/** One Claude call with a strict schema. null on failure (logged). */
export async function parseIntent(
  client: AnthropicLike,
  command: string,
  repliedText: string | null,
): Promise<Intent | null> {
  try {
    const content = repliedText
      ? `Command:\n${command}\n\nIt replies to this message (context only):\n${repliedText.slice(0, 2000)}`
      : `Command:\n${command}`
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM,
      messages: [{role: 'user', content}],
      tools: [{name: 'record_command', description: 'Record the command.', input_schema: INTENT_SCHEMA}],
      tool_choice: {type: 'tool', name: 'record_command'},
    })
    const tool = msg.content.find((b) => b.type === 'tool_use')
    if (!tool) {
      log('error', 'commander_intent_no_tool_use', {contentTypes: msg.content.map((b) => b.type)})
      return null
    }
    const raw = tool.input as Intent
    return {
      ...raw,
      newPrice: normalizePrice(raw.newPrice),
      filters: {...raw.filters, price: normalizePrice(raw.filters.price)},
    }
  } catch (e) {
    log('error', 'commander_intent_failed', {commandLength: command.length, ...errInfo(e)})
    return null
  }
}

/**
 * Listing slugs straight from domlivo.com links — no model needed, and the
 * most reliable way to name a listing (a lead notification carries one).
 */
export function slugsFromText(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = []
  const re = /domlivo\.com\/(?:[a-z]{2}\/)?property\/([a-z0-9]+(?:-[a-z0-9]+)*)/gi
  for (const t of texts) {
    if (!t) continue
    for (const m of t.matchAll(re)) {
      const slug = m[1]!.toLowerCase()
      if (!out.includes(slug)) out.push(slug)
    }
  }
  return out
}

/** A slug-like or code-like token from `listingRef` (a bare URL gives its slug). */
export function cleanRef(ref: string | null): string | null {
  if (!ref) return null
  const fromUrl = slugsFromText(ref)[0]
  if (fromUrl) return fromUrl
  const t = ref.trim()
  return t.length >= 2 && t.length <= 120 && !/\s/.test(t) ? t : null
}
