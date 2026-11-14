import {randomUUID} from 'node:crypto'
import type {ChangeAction} from './intent.js'
import type {ListingRow} from './find.js'

/**
 * Every change the commander can make, as plain field values on fields that
 * already exist on `property` — no new attributes (the dataset is over its
 * limit). Nothing here deletes a document, ever.
 *
 * - sold / rented: lifecycleStatus, page stays up with a label (same as
 *   domlivo-admin/scripts/markPropertiesSold.ts);
 * - hide: isPublished false — off the site, kept in Sanity;
 * - unhide: isPublished true + lifecycleStatus active;
 * - price: price, plus a priceHistory row so the page shows the change.
 */

export type ScalarField = 'lifecycleStatus' | 'isPublished' | 'price'
type Scalar = string | number | boolean | null

export type PriceHistoryEntry = {
  _key: string
  _type: 'priceHistoryEntry'
  date: string
  price: number
  priceUnit: string
}

export type ChangePlan = {
  action: ChangeAction
  set: Partial<Record<ScalarField, Scalar>>
  /** Values before the change; null = the field was unset. Undo restores exactly these. */
  before: Partial<Record<ScalarField, Scalar>>
  /** priceHistory rows this change appends (undo removes them by _key). */
  historyAppend: PriceHistoryEntry[]
  /** Whole history array to write when the listing had none (no anchor to insert after). */
  historyReplace: PriceHistoryEntry[] | null
}

export type PlanResult = {ok: true; plan: ChangePlan} | {ok: false; reason: 'already' | 'no_price' | 'same_price'}

function key(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function isLive(row: ListingRow): boolean {
  return row.isPublished !== false && (row.lifecycleStatus === null || row.lifecycleStatus === 'active')
}

export function planChange(
  action: ChangeAction,
  row: ListingRow,
  opts: {newPrice?: number | null; today: string},
): PlanResult {
  const before = (fields: ScalarField[]): ChangePlan['before'] =>
    Object.fromEntries(fields.map((f) => [f, (row[f] ?? null) as Scalar]))
  const base = {historyAppend: [], historyReplace: null}

  switch (action) {
    case 'sold':
    case 'rented': {
      if (row.lifecycleStatus === action && row.isPublished !== false) return {ok: false, reason: 'already'}
      return {
        ok: true,
        plan: {action, set: {lifecycleStatus: action, isPublished: true}, before: before(['lifecycleStatus', 'isPublished']), ...base},
      }
    }
    case 'hide': {
      if (row.isPublished === false) return {ok: false, reason: 'already'}
      return {ok: true, plan: {action, set: {isPublished: false}, before: before(['isPublished']), ...base}}
    }
    case 'unhide': {
      if (isLive(row)) return {ok: false, reason: 'already'}
      return {
        ok: true,
        plan: {action, set: {isPublished: true, lifecycleStatus: 'active'}, before: before(['isPublished', 'lifecycleStatus']), ...base},
      }
    }
    case 'price': {
      const p = opts.newPrice
      if (!p || p <= 0) return {ok: false, reason: 'no_price'}
      if (row.price === p) return {ok: false, reason: 'same_price'}
      const unit = row.priceUnit ?? 'total'
      const entry: PriceHistoryEntry = {_key: key(), _type: 'priceHistoryEntry', date: opts.today, price: p, priceUnit: unit}
      const history = row.priceHistory ?? []
      const plan: ChangePlan = {
        action,
        set: {price: p},
        before: before(['price']),
        historyAppend: [entry],
        historyReplace: null,
      }
      if (history.length === 0) {
        // A history of one row would read "listed today at the new price".
        // Seed it with the old price on the listing's creation date.
        const seed: PriceHistoryEntry[] =
          row.price !== null
            ? [{_key: key(), _type: 'priceHistoryEntry', date: (row.createdAt ?? opts.today).slice(0, 10), price: row.price, priceUnit: unit}]
            : []
        plan.historyAppend = [...seed, entry]
        plan.historyReplace = [...seed, entry]
      }
      return {ok: true, plan}
    }
  }
}

/** Sanity patch operations (the client's PatchOperations shape) for a plan. */
export function patchOps(plan: ChangePlan, ifRevisionID?: string): Record<string, unknown> {
  const set: Record<string, unknown> = {...plan.set}
  if (plan.historyReplace) set.priceHistory = plan.historyReplace
  return {
    set,
    ...(!plan.historyReplace && plan.historyAppend.length
      ? {insert: {after: 'priceHistory[-1]', items: plan.historyAppend}}
      : {}),
    ...(ifRevisionID ? {ifRevisionID} : {}),
  }
}

/** Patch operations that put back what a plan changed. */
export function undoOps(plan: ChangePlan, ifRevisionID?: string): Record<string, unknown> {
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const [f, v] of Object.entries(plan.before)) {
    if (v === null || v === undefined) unset.push(f)
    else set[f] = v
  }
  for (const e of plan.historyAppend) unset.push(`priceHistory[_key=="${e._key}"]`)
  return {
    ...(Object.keys(set).length ? {set} : {}),
    ...(unset.length ? {unset} : {}),
    ...(ifRevisionID ? {ifRevisionID} : {}),
  }
}
