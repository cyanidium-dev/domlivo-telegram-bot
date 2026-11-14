import {log, errInfo} from '../log.js'
import type {RedisLike} from '../assembly.js'
import type {SanityFetchLike} from '../resolveAgent.js'
import type {InlineButton} from '../telegram/api.js'
import type {ChatMessage, ChatCallback} from '../telegram/extract.js'
import {screenAnswer} from '../guard.js'
import {ruleFor, isAllowedUser, channelAdminsTrusted, type ChatRule} from './chats.js'
import {detectAddressing} from './addressing.js'
import {slugsFromText, cleanRef, type ChangeAction, type Intent} from './intent.js'
import {fetchListing, findByRef, fetchCandidates, rankListings, filtersEmpty, inScope, type ListingRow} from './find.js'
import {planChange, patchOps, undoOps, type ChangePlan} from './actions.js'
import {T, cardText, doneText, undoneText, listingLine, stateLine, ACTION_LOG} from './texts.js'
import {
  newToken,
  savePick,
  loadPick,
  savePending,
  loadPending,
  saveDone,
  loadDone,
  saveLastDone,
  loadLastDone,
  clearLastDone,
  claimOnce,
  appendJournal,
  readJournal,
} from './state.js'

export type SanityTx = {
  patch(id: string, ops: Record<string, unknown>): SanityTx
  commit(): Promise<{transactionId: string}>
}

export type CommanderDeps = {
  redis: RedisLike
  sanity: SanityFetchLike & {transaction(): SanityTx}
  telegram: {
    sendMessage(
      chatId: number,
      text: string,
      opts?: {inlineKeyboard?: InlineButton[][]; replyTo?: number},
    ): Promise<number | null>
    sendPhoto(
      chatId: number,
      photoUrl: string,
      caption: string,
      opts?: {inlineKeyboard?: InlineButton[][]; replyTo?: number},
    ): Promise<number | null>
    editMessageReplyMarkup(chatId: number, messageId: number, kb: InlineButton[][] | null): Promise<boolean>
    answerCallbackQuery(callbackId: string, opts?: {text?: string; showAlert?: boolean}): Promise<boolean>
    downloadFile(fileId: string): Promise<Buffer>
    getMe(): Promise<{id: number; username: string}>
    getChatAdministrators(chatId: number): Promise<Array<{id: number; isBot: boolean}>>
  }
  rules: ChatRule[]
  parseIntent: (command: string, repliedText: string | null) => Promise<Intent | null>
  /** null until a speech-to-text key is configured — voice then gets a polite "text only". */
  transcribe: ((audio: Buffer, mime: string) => Promise<string | null>) | null
  now: () => Date
}

const MAX_PICK = 5
const DEFAULT_SITE = 'https://www.domlivo.com'

// ── small helpers ────────────────────────────────────────────────────────

async function botIdentity(deps: CommanderDeps): Promise<{id: number; username: string}> {
  const cached = await deps.redis.get('cm:me')
  if (cached) {
    try {
      return JSON.parse(cached) as {id: number; username: string}
    } catch {
      /* refetch */
    }
  }
  const me = await deps.telegram.getMe()
  await deps.redis.set('cm:me', JSON.stringify(me), {ex: 86_400})
  return me
}

/** Channel admins, cached 10 minutes — an admin change takes effect within that. */
async function channelTrusted(deps: CommanderDeps, rule: ChatRule): Promise<boolean> {
  const k = `cm:admins:${rule.chatId}`
  let admins: Array<{id: number; isBot: boolean}> | null = null
  const cached = await deps.redis.get(k)
  if (cached) {
    try {
      admins = JSON.parse(cached) as Array<{id: number; isBot: boolean}>
    } catch {
      admins = null
    }
  }
  if (!admins) {
    try {
      admins = await deps.telegram.getChatAdministrators(rule.chatId)
      await deps.redis.set(k, JSON.stringify(admins), {ex: 600})
    } catch (e) {
      log('error', 'commander_admins_failed', {chatId: rule.chatId, ...errInfo(e)})
      return false
    }
  }
  const ok = channelAdminsTrusted(rule, admins)
  if (!ok) {
    log('warn', 'commander_channel_untrusted', {
      chatId: rule.chatId,
      strangers: admins.filter((a) => !a.isBot && !rule.users.includes(a.id)).map((a) => a.id),
    })
  }
  return ok
}

async function siteSettings(deps: CommanderDeps): Promise<{enabled: boolean; base: string}> {
  const s = (await deps.sanity.fetch(`*[_type == "siteSettings"][0]{botEnabled, siteBaseUrl}`)) as {
    botEnabled?: boolean
    siteBaseUrl?: string
  } | null
  return {
    enabled: s?.botEnabled === true,
    base: s?.siteBaseUrl?.trim().replace(/\/+$/, '') || DEFAULT_SITE,
  }
}

function listingUrl(base: string, r: ListingRow): string | null {
  const slug = r.slugRu ?? r.slug
  return slug ? `${base}/ru/property/${slug}` : null
}

const today = (deps: CommanderDeps) => deps.now().toISOString().slice(0, 10)

// ── messages ─────────────────────────────────────────────────────────────

/**
 * One group/channel message. Silent unless the message is addressed to the
 * bot AND comes from someone on the chat's list; everything else is ignored
 * (logged when addressed, so ids can be collected for the list).
 */
export async function handleChatMessage(msg: ChatMessage, deps: CommanderDeps): Promise<void> {
  const me = await botIdentity(deps)
  const replyToBot = msg.replyTo?.fromId === me.id
  const rule = ruleFor(deps.rules, msg.chatId)

  // Onboarding helper, answered for anyone: it changes nothing.
  if (msg.text && msg.command?.split('@')[0] === '/id' && detectAddressing(msg.text, {botUsername: me.username, replyToBot}).addressed) {
    await deps.telegram.sendMessage(msg.chatId, T.ids(msg.chatId, msg.senderId), {replyTo: msg.messageId})
    return
  }

  const typed = msg.text ? detectAddressing(msg.text, {botUsername: me.username, replyToBot}) : null
  const who = {chatId: msg.chatId, chatType: msg.chatType, senderId: msg.senderId, username: msg.username}

  if (!rule) {
    if (typed?.addressed) log('info', 'commander_chat_unconfigured', who)
    return
  }
  const authorized =
    msg.chatType === 'channel' ? await channelTrusted(deps, rule) : isAllowedUser(rule, msg.senderId)
  if (!authorized) {
    if (typed?.addressed) log('info', 'commander_ignored_sender', who)
    return
  }

  let text = typed?.addressed ? typed.text : null
  let heard: string | null = null
  if (!msg.text && msg.voiceFileId) {
    if (!deps.transcribe) {
      if (replyToBot) await deps.telegram.sendMessage(msg.chatId, T.voiceUnavailable, {replyTo: msg.messageId})
      return
    }
    let transcript: string | null = null
    try {
      const audio = await deps.telegram.downloadFile(msg.voiceFileId)
      transcript = await deps.transcribe(audio, msg.voiceMime ?? 'audio/ogg')
    } catch (e) {
      log('error', 'commander_transcribe_failed', {chatId: msg.chatId, ...errInfo(e)})
    }
    if (!transcript?.trim()) {
      if (replyToBot) await deps.telegram.sendMessage(msg.chatId, T.voiceFailed, {replyTo: msg.messageId})
      return
    }
    const spoken = detectAddressing(transcript, {botUsername: me.username, replyToBot})
    if (!spoken.addressed) return
    heard = transcript.trim()
    text = spoken.text
  }
  if (text === null) return

  const settings = await siteSettings(deps)
  const say = (body: string, opts?: {inlineKeyboard?: InlineButton[][]}) =>
    deps.telegram.sendMessage(msg.chatId, heard ? `${T.heard(heard)}\n\n${body}` : body, {
      ...opts,
      replyTo: msg.messageId,
    })
  if (!settings.enabled) {
    await say(T.disabled)
    return
  }
  if (!text.trim() || !screenAnswer(text).ok) {
    await say(T.notUnderstood)
    return
  }

  const cmd = text.trim().split(/\s/)[0]!.toLowerCase()
  if (cmd === '/help' || cmd === '/start') return void (await say(T.help))
  if (cmd === '/log') return void (await say(await journalText(deps, rule)))

  const repliedText = msg.replyTo ? [msg.replyTo.text, ...msg.replyTo.urls].filter(Boolean).join('\n') : null
  const intent = await deps.parseIntent(text, repliedText)
  if (!intent) return void (await say(T.failed))
  log('info', 'commander_intent', {chatId: msg.chatId, senderId: msg.senderId, action: intent.action})

  switch (intent.action) {
    case 'help':
      return void (await say(T.help))
    case 'log':
      return void (await say(await journalText(deps, rule)))
    case 'add':
      return void (await say(T.addInDm, {
        inlineKeyboard: [[{text: T.openDm, data: 'cm:noop', url: `https://t.me/${me.username}?start=add`}]],
      }))
    case 'undo':
      return void (await offerUndo(deps, msg.chatId, say))
    case 'none':
      return void (await say(T.notUnderstood))
  }

  // find or a change: work out which listing.
  const ref = slugsFromText(text, repliedText)[0] ?? cleanRef(intent.listingRef)
  let rows: ListingRow[]
  if (ref) {
    const named = await findByRef(deps.sanity, ref)
    const mine = named.filter((r) => inScope(r, rule.scope))
    if (named.length > 0 && mine.length === 0) return void (await say(T.notYours(named[0]!.agentName)))
    rows = mine
    if (rows.length === 0 && !filtersEmpty(intent.filters)) {
      rows = rankListings(await fetchCandidates(deps.sanity, rule.scope, intent.filters), intent.filters)
    }
  } else if (filtersEmpty(intent.filters)) {
    return void (await say(T.noTarget))
  } else {
    rows = rankListings(await fetchCandidates(deps.sanity, rule.scope, intent.filters), intent.filters)
  }

  if (rows.length === 0) return void (await say(T.notFound))
  if (rows.length > MAX_PICK) return void (await say(T.tooMany(rows.length)))

  if (intent.action === 'find') {
    const lines = rows.map((r, i) => `${i + 1}. ${r.title ?? r.slug}\n${listingLine(r)} · ${stateLine(r)}\n${listingUrl(settings.base, r) ?? ''}`)
    return void (await say(lines.join('\n\n')))
  }

  const action = intent.action as ChangeAction
  if (rows.length === 1) {
    await showCard(deps, {chatId: msg.chatId, replyTo: msg.messageId, heard}, rows[0]!, action, intent.newPrice, settings.base)
    return
  }
  const tok = newToken()
  await savePick(deps.redis, tok, {chatId: msg.chatId, action, newPrice: intent.newPrice, ids: rows.map((r) => r._id)})
  await say(T.pick(rows.length), {
    inlineKeyboard: [
      ...rows.map((r, i) => [{text: `${i + 1} · ${listingLine(r)}`.slice(0, 60), data: `cm:k:${tok}:${i}`}]),
      [{text: T.noneOfThese, data: `cm:x:${tok}`}],
    ],
  })
}

async function showCard(
  deps: CommanderDeps,
  where: {chatId: number; replyTo: number; heard: string | null},
  row: ListingRow,
  action: ChangeAction,
  newPrice: number | null,
  base: string,
): Promise<void> {
  const prefix = where.heard ? `${T.heard(where.heard)}\n\n` : ''
  const res = planChange(action, row, {newPrice, today: today(deps)})
  if (!res.ok) {
    const why = res.reason === 'already' ? T.already[action] : res.reason === 'same_price' ? T.already.price : T.askPrice
    await deps.telegram.sendMessage(where.chatId, `${prefix}${row.title ?? row.slug}\n${why}`, {replyTo: where.replyTo})
    return
  }
  const tok = newToken()
  await savePending(deps.redis, tok, {chatId: where.chatId, action, newPrice, listingId: row._id})
  const caption = prefix + cardText(res.plan, row, listingUrl(base, row))
  const kb: InlineButton[][] = [[{text: T.yes[action], data: `cm:y:${tok}`}, {text: T.no, data: `cm:n:${tok}`}]]
  if (row.photo) {
    await deps.telegram.sendPhoto(where.chatId, `${row.photo}?w=900&fit=max`, caption, {inlineKeyboard: kb, replyTo: where.replyTo})
  } else {
    await deps.telegram.sendMessage(where.chatId, caption, {inlineKeyboard: kb, replyTo: where.replyTo})
  }
}

async function offerUndo(
  deps: CommanderDeps,
  chatId: number,
  say: (body: string, opts?: {inlineKeyboard?: InlineButton[][]}) => Promise<number | null>,
): Promise<void> {
  const tok = await loadLastDone(deps.redis, chatId)
  const done = tok ? await loadDone(deps.redis, tok) : null
  if (!tok || !done || done.chatId !== chatId) return void (await say(T.nothingToUndo))
  const what = done.plan.action === 'price' ? `${ACTION_LOG.price} ${done.plan.set.price}` : ACTION_LOG[done.plan.action]
  await say(`Последнее изменение: ${done.title} — ${what} (${done.by}). Отменить?`, {
    inlineKeyboard: [[{text: T.undo, data: `cm:u:${tok}`}]],
  })
}

async function journalText(deps: CommanderDeps, rule: ChatRule): Promise<string> {
  const entries = await readJournal(deps.redis, rule.chatId, {now: deps.now()})
  if (entries.length === 0) return T.journalEmpty
  const fmt = (iso: string) => {
    const d = new Date(iso)
    const p = (n: number) => String(n).padStart(2, '0')
    // Tirana is UTC+1 in winter, +2 in summer; the label is close enough for a log.
    const t = new Date(d.getTime() + 60 * 60 * 1000)
    return `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
  }
  const line = (e: (typeof entries)[number]) => {
    const what =
      e.action === 'undo'
        ? `отменил «${ACTION_LOG[e.undoOf ?? 'hide']}»`
        : e.action === 'price'
          ? `цена ${e.before.price ?? '—'} → ${e.after.price}`
          : ACTION_LOG[e.action]
    return `${fmt(e.at)} · ${e.by} · ${what} · ${e.title}`
  }
  return ['Последние изменения:', ...entries.map(line)].join('\n')
}

// ── buttons ──────────────────────────────────────────────────────────────

function parseData(data: string): {op: string; tok: string; index: number | null} | null {
  const m = /^cm:([kxynu]):([a-f0-9]{6,32})(?::(\d{1,2}))?$/.exec(data)
  if (!m) return null
  return {op: m[1]!, tok: m[2]!, index: m[3] !== undefined ? Number(m[3]) : null}
}

function isRevisionConflict(e: unknown): boolean {
  const err = e as {statusCode?: number; message?: string}
  return err?.statusCode === 409 || /revision/i.test(err?.message ?? '')
}

/**
 * One commander button press. Only people on the chat's list may press —
 * in a channel too, where Telegram does tell the bot who pressed.
 */
export async function handleChatCallback(cb: ChatCallback, deps: CommanderDeps): Promise<void> {
  const rule = ruleFor(deps.rules, cb.chatId)
  if (!rule || !isAllowedUser(rule, cb.senderId)) {
    log('info', 'commander_press_refused', {chatId: cb.chatId, senderId: cb.senderId})
    await deps.telegram.answerCallbackQuery(cb.callbackId, {text: T.notAllowed, showAlert: true})
    return
  }
  const p = parseData(cb.data)
  if (!p) {
    await deps.telegram.answerCallbackQuery(cb.callbackId)
    return
  }
  const by = cb.senderName ?? String(cb.senderId)
  const settings = await siteSettings(deps)
  const expired = async () => {
    await deps.telegram.answerCallbackQuery(cb.callbackId, {text: T.expired, showAlert: true})
    await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)
  }
  if (!settings.enabled && p.op !== 'n' && p.op !== 'x') {
    await deps.telegram.answerCallbackQuery(cb.callbackId, {text: T.disabled, showAlert: true})
    return
  }

  switch (p.op) {
    case 'k': {
      const st = await loadPick(deps.redis, p.tok)
      const id = p.index !== null ? st?.ids[p.index] : undefined
      if (!st || st.chatId !== cb.chatId || !id) return expired()
      await deps.telegram.answerCallbackQuery(cb.callbackId)
      const row = await fetchListing(deps.sanity, id)
      if (!row || !inScope(row, rule.scope)) return void (await deps.telegram.sendMessage(cb.chatId, T.notFound))
      await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)
      await showCard(deps, {chatId: cb.chatId, replyTo: cb.messageId, heard: null}, row, st.action, st.newPrice, settings.base)
      return
    }
    case 'x': {
      await deps.telegram.answerCallbackQuery(cb.callbackId)
      await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)
      await deps.telegram.sendMessage(cb.chatId, T.noTarget, {replyTo: cb.messageId})
      return
    }
    case 'n': {
      const st = await loadPending(deps.redis, p.tok)
      if (!st || st.chatId !== cb.chatId) return expired()
      if (!(await claimOnce(deps.redis, `card:${p.tok}`))) return void (await deps.telegram.answerCallbackQuery(cb.callbackId))
      await deps.telegram.answerCallbackQuery(cb.callbackId)
      await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)
      await deps.telegram.sendMessage(cb.chatId, `${T.cancelled} (${by})`, {replyTo: cb.messageId})
      return
    }
    case 'y':
      return confirm(deps, cb, rule, p.tok, by, settings.base)
    case 'u':
      return undo(deps, cb, rule, p.tok, by)
  }
}

async function confirm(
  deps: CommanderDeps,
  cb: ChatCallback,
  rule: ChatRule,
  tok: string,
  by: string,
  base: string,
): Promise<void> {
  const st = await loadPending(deps.redis, tok)
  if (!st || st.chatId !== cb.chatId) {
    await deps.telegram.answerCallbackQuery(cb.callbackId, {text: T.expired, showAlert: true})
    await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)
    return
  }
  if (!(await claimOnce(deps.redis, `card:${tok}`))) {
    await deps.telegram.answerCallbackQuery(cb.callbackId)
    return
  }
  await deps.telegram.answerCallbackQuery(cb.callbackId)
  await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)

  // Fresh state: the card may be an hour old. The plan is rebuilt on it.
  const row = await fetchListing(deps.sanity, st.listingId)
  if (!row || !inScope(row, rule.scope)) {
    await deps.telegram.sendMessage(cb.chatId, T.notFound, {replyTo: cb.messageId})
    return
  }
  const res = planChange(st.action, row, {newPrice: st.newPrice, today: today(deps)})
  if (!res.ok) {
    await deps.telegram.sendMessage(cb.chatId, `${row.title ?? row.slug}\n${T.already[st.action]}`, {replyTo: cb.messageId})
    return
  }
  const plan = res.plan

  let afterRev: string
  try {
    const tx = deps.sanity.transaction().patch(row._id, patchOps(plan, row._rev))
    // An unpublished Studio draft would put the old values back on its next
    // Publish; it gets the same scalar change.
    if (row.hasDraft) tx.patch(`drafts.${row._id}`, {set: plan.set})
    afterRev = (await tx.commit()).transactionId
  } catch (e) {
    log('error', 'commander_apply_failed', {listingId: row._id, action: plan.action, ...errInfo(e)})
    await deps.telegram.sendMessage(cb.chatId, isRevisionConflict(e) ? T.changedSince : T.failed, {replyTo: cb.messageId})
    return
  }

  const at = deps.now().toISOString()
  const title = row.title ?? row.slug ?? row._id
  const doneTok = newToken()
  await saveDone(deps.redis, doneTok, {
    chatId: cb.chatId,
    listingId: row._id,
    title,
    plan,
    afterRev,
    draftTouched: row.hasDraft,
    by,
    at,
  })
  await saveLastDone(deps.redis, cb.chatId, doneTok)
  await appendJournal(deps.redis, {
    at,
    chatId: cb.chatId,
    chatLabel: rule.label,
    by,
    byId: cb.senderId,
    action: plan.action,
    listingId: row._id,
    title,
    before: plan.before,
    after: plan.set,
  })
  log('info', 'commander_applied', {listingId: row._id, action: plan.action, chatId: cb.chatId, byId: cb.senderId, afterRev})

  await deps.telegram.sendMessage(cb.chatId, doneText(plan, row, by, listingUrl(base, row)), {
    replyTo: cb.messageId,
    inlineKeyboard: [[{text: T.undo, data: `cm:u:${doneTok}`}]],
  })
}

async function undo(deps: CommanderDeps, cb: ChatCallback, rule: ChatRule, tok: string, by: string): Promise<void> {
  const done = await loadDone(deps.redis, tok)
  if (!done || done.chatId !== cb.chatId) {
    await deps.telegram.answerCallbackQuery(cb.callbackId, {text: T.expired, showAlert: true})
    await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)
    return
  }
  if (!(await claimOnce(deps.redis, `undo:${tok}`))) {
    await deps.telegram.answerCallbackQuery(cb.callbackId)
    return
  }
  await deps.telegram.answerCallbackQuery(cb.callbackId)
  await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId, null)

  const row = await fetchListing(deps.sanity, done.listingId)
  if (!row || row._rev !== done.afterRev) {
    await deps.telegram.sendMessage(cb.chatId, T.undoChangedSince, {replyTo: cb.messageId})
    return
  }
  const plan: ChangePlan = done.plan
  try {
    const tx = deps.sanity.transaction().patch(row._id, undoOps(plan, row._rev))
    if (done.draftTouched && row.hasDraft) tx.patch(`drafts.${row._id}`, undoOps({...plan, historyAppend: []}))
    await tx.commit()
  } catch (e) {
    log('error', 'commander_undo_failed', {listingId: row._id, action: plan.action, ...errInfo(e)})
    await deps.telegram.sendMessage(cb.chatId, isRevisionConflict(e) ? T.undoChangedSince : T.failed, {replyTo: cb.messageId})
    return
  }

  if ((await loadLastDone(deps.redis, cb.chatId)) === tok) await clearLastDone(deps.redis, cb.chatId)
  await appendJournal(deps.redis, {
    at: deps.now().toISOString(),
    chatId: cb.chatId,
    chatLabel: rule.label,
    by,
    byId: cb.senderId,
    action: 'undo',
    undoOf: plan.action,
    listingId: row._id,
    title: done.title,
    before: plan.set,
    after: plan.before,
  })
  log('info', 'commander_undone', {listingId: row._id, action: plan.action, chatId: cb.chatId, byId: cb.senderId})
  await deps.telegram.sendMessage(cb.chatId, undoneText(plan, row, by), {replyTo: cb.messageId})
}

