import {randomUUID} from 'node:crypto'
import type {RedisLike} from '../assembly.js'
import type {ChangeAction} from './intent.js'
import type {ChangePlan} from './actions.js'

/**
 * Commander state lives in the bot's Redis, never in Sanity (the dataset is
 * over its attribute limit). Three short-lived records keyed by a random
 * token carried in callback_data, plus the journal.
 */

const HOUR = 3600
const DAY = 86_400

/** A list of candidate listings waiting for a pick. */
export type PickState = {chatId: number; action: ChangeAction; newPrice: number | null; ids: string[]}
/** A confirmation card waiting for Yes / No. */
export type PendingState = {chatId: number; action: ChangeAction; newPrice: number | null; listingId: string}
/** A change that was made — what the undo button needs. */
export type DoneState = {
  chatId: number
  listingId: string
  title: string
  plan: ChangePlan
  /** _rev right after the change; undo refuses if the listing moved on since. */
  afterRev: string
  draftTouched: boolean
  by: string
  at: string
}

export function newToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10)
}

async function put(redis: RedisLike, key: string, value: unknown, ttl: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), {ex: ttl})
}

async function take<T>(redis: RedisLike, key: string): Promise<T | null> {
  const raw = await redis.get(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const savePick = (r: RedisLike, tok: string, s: PickState) => put(r, `cm:pick:${tok}`, s, HOUR)
export const loadPick = (r: RedisLike, tok: string) => take<PickState>(r, `cm:pick:${tok}`)
export const savePending = (r: RedisLike, tok: string, s: PendingState) => put(r, `cm:pend:${tok}`, s, HOUR)
export const loadPending = (r: RedisLike, tok: string) => take<PendingState>(r, `cm:pend:${tok}`)
export const saveDone = (r: RedisLike, tok: string, s: DoneState) => put(r, `cm:done:${tok}`, s, 7 * DAY)
export const loadDone = (r: RedisLike, tok: string) => take<DoneState>(r, `cm:done:${tok}`)

/** The newest change made in a chat, for a typed "отмени". */
export const saveLastDone = (r: RedisLike, chatId: number, tok: string) => r.set(`cm:last:${chatId}`, tok, {ex: 7 * DAY})
export const loadLastDone = (r: RedisLike, chatId: number) => r.get(`cm:last:${chatId}`)
export const clearLastDone = (r: RedisLike, chatId: number) => r.del(`cm:last:${chatId}`)

/** One press wins: a double tap or a second person pressing the same Yes does nothing. */
export async function claimOnce(redis: RedisLike, what: string): Promise<boolean> {
  return (await redis.set(`cm:once:${what}`, '1', {nx: true, ex: 7 * DAY})) !== null
}

// ── journal ──────────────────────────────────────────────────────────────

/** Who did what to which listing, when. Kept 400 days, one Redis list per UTC day. */
export type JournalEntry = {
  at: string
  chatId: number
  chatLabel: string
  by: string
  byId: number | null
  action: ChangeAction | 'undo'
  undoOf?: ChangeAction
  listingId: string
  title: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

const JOURNAL_TTL = 400 * DAY
const dayKey = (iso: string) => `cm:journal:${iso.slice(0, 10)}`

export async function appendJournal(redis: RedisLike, e: JournalEntry): Promise<void> {
  const k = dayKey(e.at)
  await redis.rpush(k, JSON.stringify(e))
  await redis.expire(k, JOURNAL_TTL)
}

/** The newest `limit` entries for a chat across the last `days` days, newest first. */
export async function readJournal(
  redis: RedisLike,
  chatId: number,
  opts: {now: Date; days?: number; limit?: number},
): Promise<JournalEntry[]> {
  const out: JournalEntry[] = []
  const days = opts.days ?? 30
  const limit = opts.limit ?? 15
  for (let i = 0; i < days && out.length < limit; i++) {
    const d = new Date(opts.now.getTime() - i * DAY * 1000).toISOString()
    const raw = await redis.lrange(dayKey(d), 0, -1)
    const entries = raw
      .map((r) => {
        try {
          return JSON.parse(r) as JournalEntry
        } catch {
          return null
        }
      })
      .filter((e): e is JournalEntry => e !== null && e.chatId === chatId)
      .reverse()
    out.push(...entries)
  }
  return out.slice(0, limit)
}
