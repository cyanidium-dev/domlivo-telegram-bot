import {log} from '../log.js'

/**
 * Which listings a chat may change:
 * - `agents`: listings of these agent documents only (the Cactus group);
 * - `general`: listings whose agent has no lead group of their own — the
 *   ones whose leads land in the main chat (the Grinchenko channel);
 * - `all`: any listing.
 */
export type ChatScope = {kind: 'all'} | {kind: 'general'} | {kind: 'agents'; agentIds: string[]}

/**
 * One chat the commander works in, and the only people whose commands it
 * accepts there. Owner decision 2026-11-14: Grinchenko channel = Fedir and
 * Viktor, Cactus group = Ales and Pavel, nobody else anywhere.
 */
export type ChatRule = {
  chatId: number
  label: string
  users: number[]
  scope: ChatScope
}

type RawRule = {chat?: unknown; label?: unknown; users?: unknown; scope?: unknown}

function parseScope(raw: unknown): ChatScope | null {
  if (raw === 'all') return {kind: 'all'}
  if (raw === 'general' || raw === undefined) return {kind: 'general'}
  if (Array.isArray(raw) && raw.length > 0 && raw.every((a) => typeof a === 'string' && a.trim())) {
    return {kind: 'agents', agentIds: raw.map((a: string) => a.trim())}
  }
  return null
}

/**
 * `COMMANDER_CHATS` — JSON array, e.g.
 * `[{"chat":-1001,"label":"Domlivo × Cactus","users":[11,22],"scope":["agent-cactus"]},
 *   {"chat":-1002,"label":"Domlivo × Grinchenko","users":[33,44],"scope":"general"}]`.
 * Lives in an env var, not Sanity: the dataset is over its attribute limit,
 * and Telegram ids are not secret. Bad entries are dropped and logged; an
 * unset or broken value means the commander answers nowhere.
 */
export function parseCommanderChats(raw: string | undefined): ChatRule[] {
  if (!raw?.trim()) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    log('error', 'commander_chats_invalid_json', {})
    return []
  }
  if (!Array.isArray(list)) {
    log('error', 'commander_chats_not_array', {})
    return []
  }
  const rules: ChatRule[] = []
  for (const [i, item] of (list as RawRule[]).entries()) {
    const chatId = Number(item?.chat)
    const users = Array.isArray(item?.users) ? item.users.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : []
    const scope = parseScope(item?.scope)
    if (!Number.isSafeInteger(chatId) || chatId === 0 || users.length === 0 || !scope) {
      log('error', 'commander_chat_rule_invalid', {index: i})
      continue
    }
    rules.push({chatId, users, scope, label: typeof item.label === 'string' ? item.label : String(chatId)})
  }
  return rules
}

export function ruleFor(rules: ChatRule[], chatId: number): ChatRule | null {
  return rules.find((r) => r.chatId === chatId) ?? null
}

export function isAllowedUser(rule: ChatRule, userId: number | null): boolean {
  return userId !== null && rule.users.includes(userId)
}

/**
 * A channel post has no author id: only the channel's admins can post, so a
 * post counts when every human admin is on the chat's list. One stranger made
 * admin and the channel stops being trusted until the list or the admins change.
 */
export function channelAdminsTrusted(rule: ChatRule, admins: Array<{id: number; isBot: boolean}>): boolean {
  const humans = admins.filter((a) => !a.isBot)
  return humans.length > 0 && humans.every((a) => rule.users.includes(a.id))
}
