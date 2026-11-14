import {describe, it, expect, beforeEach} from 'vitest'
import {handleChatMessage, handleChatCallback, type CommanderDeps, type SanityTx} from '../commander/handle.js'
import {parseCommanderChats} from '../commander/chats.js'
import type {Intent} from '../commander/intent.js'
import type {ListingRow} from '../commander/find.js'
import type {RedisLike} from '../assembly.js'
import type {ChatMessage, ChatCallback} from '../telegram/extract.js'
import {row} from './fixtures/listing.js'

const BOT = {id: 555, username: 'domlivo_intake_bot'}
const CACTUS = -1001
const GRIN = -1002
const PAVEL = 11
const ALES = 12
const FEDIR = 21
const VIKTOR = 22
const STRANGER = 99

function fakeRedis(): RedisLike & {store: Map<string, string>; lists: Map<string, string[]>} {
  const store = new Map<string, string>()
  const lists = new Map<string, string[]>()
  return {
    store,
    lists,
    set: async (k, v, o) => {
      if (o?.nx && store.has(k)) return null
      store.set(k, v)
      return 'OK'
    },
    get: async (k) => store.get(k) ?? null,
    rpush: async (k, v) => {
      const l = lists.get(k) ?? []
      l.push(v)
      lists.set(k, l)
      return l.length
    },
    lrange: async (k) => lists.get(k) ?? [],
    expire: async () => 1,
    del: async (k) => (store.delete(k) ? 1 : 0),
  }
}

type Sent = {chatId: number; text: string; kb?: Array<Array<{text: string; data: string; url?: string}>>; photo?: string}

function setup(opts: {listings?: ListingRow[]; intent?: Partial<Intent>; admins?: number[]; transcript?: string | null; enabled?: boolean} = {}) {
  const redis = fakeRedis()
  const sent: Sent[] = []
  const answers: Array<{text?: string}> = []
  const patches: Array<{id: string; ops: Record<string, unknown>}> = []
  const db = new Map((opts.listings ?? [row()]).map((r) => [r._id, {...r}]))
  let rev = 1
  const intent: Intent = {
    action: 'hide',
    newPrice: null,
    listingRef: null,
    filters: {city: null, district: null, bedrooms: null, rooms: null, price: null, areaM2: null, dealType: null},
    ...opts.intent,
  }

  const sanity: CommanderDeps['sanity'] = {
    fetch: async (q: string, params?: Record<string, unknown>) => {
      if (q.includes('siteSettings')) return {botEnabled: opts.enabled ?? true, siteBaseUrl: 'https://www.domlivo.com'}
      if (q.includes('_id == $id][0]')) return db.get(params!.id as string) ?? null
      if (q.includes('$ref')) {
        const ref = params!.ref as string
        return [...db.values()].filter((r) => r.slug === ref || r.slugRu === ref || r._id === ref)
      }
      const agentIds = params?.agentIds as string[] | undefined
      return [...db.values()].filter((r) => (agentIds ? agentIds.includes(r.agentId ?? '') : !r.agentHasLeadChat))
    },
    transaction: () => {
      const ops: Array<{id: string; ops: Record<string, unknown>}> = []
      const tx: SanityTx = {
        patch(id, o) {
          ops.push({id, ops: o})
          return tx
        },
        async commit() {
          for (const p of ops) {
            const doc = db.get(p.id)
            if (doc && p.ops.ifRevisionID && p.ops.ifRevisionID !== doc._rev) {
              throw Object.assign(new Error('Document has unexpected revision'), {statusCode: 409})
            }
          }
          rev++
          for (const p of ops) {
            patches.push(p)
            const doc = db.get(p.id)
            if (!doc) continue
            Object.assign(doc, p.ops.set ?? {})
            for (const f of (p.ops.unset as string[] | undefined) ?? []) if (!f.includes('[')) (doc as Record<string, unknown>)[f] = null
            doc._rev = `rev${rev}`
          }
          return {transactionId: `rev${rev}`}
        },
      }
      return tx
    },
  }

  const deps: CommanderDeps = {
    redis,
    sanity,
    telegram: {
      sendMessage: async (chatId, text, o) => (sent.push({chatId, text, kb: o?.inlineKeyboard}), sent.length),
      sendPhoto: async (chatId, photo, text, o) => (sent.push({chatId, text, kb: o?.inlineKeyboard, photo}), sent.length),
      editMessageReplyMarkup: async () => true,
      answerCallbackQuery: async (_id, o) => (answers.push({text: o?.text}), true),
      downloadFile: async () => Buffer.from('ogg'),
      getMe: async () => BOT,
      getChatAdministrators: async () => (opts.admins ?? [FEDIR, VIKTOR]).map((id) => ({id, isBot: false})),
    },
    rules: parseCommanderChats(
      JSON.stringify([
        {chat: CACTUS, label: 'Cactus', users: [PAVEL, ALES], scope: ['agent-cactus']},
        {chat: GRIN, label: 'Grinchenko', users: [FEDIR, VIKTOR], scope: 'general'},
      ]),
    ),
    parseIntent: async () => intent,
    transcribe: opts.transcript === undefined ? null : async () => opts.transcript ?? null,
    now: () => new Date('2026-11-14T13:03:00Z'),
  }
  return {deps, sent, answers, patches, db, redis}
}

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    updateId: 1,
    chatId: CACTUS,
    chatType: 'supergroup',
    messageId: 50,
    senderId: PAVEL,
    senderName: 'Павел',
    username: 'paul',
    authorSignature: null,
    text: 'бот, скрой 2+1 в Плаже за 85',
    voiceFileId: null,
    voiceMime: null,
    command: null,
    replyTo: null,
    ...over,
  }
}

function press(data: string, over: Partial<ChatCallback> = {}): ChatCallback {
  return {updateId: 2, callbackId: 'cb', data, chatId: CACTUS, messageId: 60, senderId: ALES, senderName: 'Алес', ...over}
}

const dataOf = (s: Sent | undefined, i = 0, j = 0) => s?.kb?.[i]?.[j]?.data ?? ''

describe('commander: hide with confirmation and undo', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup({intent: {action: 'hide', filters: {city: 'Durrës', district: 'Plazh', bedrooms: 2, rooms: null, price: 85000, areaM2: null, dealType: null}}})
  })

  it('shows a photo card, changes nothing until Yes', async () => {
    await handleChatMessage(msg(), t.deps)
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]!.photo).toContain('cdn.sanity.io')
    expect(t.sent[0]!.text).toContain('Скрыть с сайта?')
    expect(t.sent[0]!.text).toContain('https://www.domlivo.com/ru/property/kvartira-2-1-plazh-durres-78m2')
    expect(t.patches).toHaveLength(0)
  })

  it('Yes hides it, journals it, offers undo; undo puts it back', async () => {
    await handleChatMessage(msg(), t.deps)
    await handleChatCallback(press(dataOf(t.sent[0])), t.deps)
    expect(t.patches[0]).toMatchObject({id: 'property-1', ops: {set: {isPublished: false}, ifRevisionID: 'rev1'}})
    expect(t.db.get('property-1')!.isPublished).toBe(false)
    const done = t.sent.at(-1)!
    expect(done.text).toContain('Скрыт с сайта')
    expect(done.text).toContain('Изменил: Алес')
    const journal = [...t.redis.lists.values()].flat().map((e) => JSON.parse(e))
    expect(journal[0]).toMatchObject({by: 'Алес', byId: ALES, action: 'hide', before: {isPublished: true}, after: {isPublished: false}})

    await handleChatCallback(press(dataOf(done), {senderId: PAVEL, senderName: 'Павел'}), t.deps)
    expect(t.db.get('property-1')!.isPublished).toBe(true)
    expect(t.sent.at(-1)!.text).toContain('Отменил: Павел')
  })

  it('a second press on Yes does nothing', async () => {
    await handleChatMessage(msg(), t.deps)
    const yes = dataOf(t.sent[0])
    await handleChatCallback(press(yes), t.deps)
    await handleChatCallback(press(yes, {senderId: PAVEL}), t.deps)
    expect(t.patches).toHaveLength(1)
  })

  it('No changes nothing', async () => {
    await handleChatMessage(msg(), t.deps)
    await handleChatCallback(press(dataOf(t.sent[0], 0, 1)), t.deps)
    expect(t.patches).toHaveLength(0)
    expect(t.sent.at(-1)!.text).toContain('Отменено')
  })

  it('undo refuses when the listing changed after the command', async () => {
    await handleChatMessage(msg(), t.deps)
    await handleChatCallback(press(dataOf(t.sent[0])), t.deps)
    t.db.get('property-1')!._rev = 'someone-else'
    await handleChatCallback(press(dataOf(t.sent.at(-1))), t.deps)
    expect(t.db.get('property-1')!.isPublished).toBe(false)
    expect(t.sent.at(-1)!.text).toContain('уже меняли')
  })
})

describe('commander: who may command', () => {
  it('ignores anyone not on the chat list, even when they address the bot', async () => {
    const t = setup()
    await handleChatMessage(msg({senderId: STRANGER}), t.deps)
    await handleChatMessage(msg({chatId: GRIN, senderId: PAVEL}), t.deps)
    expect(t.sent).toHaveLength(0)
  })

  it('refuses button presses from people off the list', async () => {
    const t = setup({intent: {action: 'hide', listingRef: 'apartment-2-1-plazh-durres-78m2'}})
    await handleChatMessage(msg(), t.deps)
    await handleChatCallback(press(dataOf(t.sent[0]), {senderId: STRANGER}), t.deps)
    expect(t.patches).toHaveLength(0)
    expect(t.answers.at(-1)!.text).toContain('не для вас')
  })

  it('stays silent on chit-chat from allowed people', async () => {
    const t = setup()
    await handleChatMessage(msg({text: 'продано, клиент доволен'}), t.deps)
    expect(t.sent).toHaveLength(0)
  })

  it('takes channel posts only while the admins are exactly the listed people', async () => {
    const grin = row({_id: 'property-g', agentId: 'agent-grinchenko', agentHasLeadChat: false, slug: 'villa-vlore'})
    const ok = setup({listings: [grin], intent: {action: 'sold', listingRef: 'villa-vlore'}})
    await handleChatMessage(msg({chatId: GRIN, chatType: 'channel', senderId: null, text: 'бот, продано villa-vlore'}), ok.deps)
    expect(ok.sent[0]!.text).toContain('Отметить «Продано»?')
    await handleChatCallback(press(dataOf(ok.sent[0]), {chatId: GRIN, senderId: VIKTOR, senderName: 'Виктор'}), ok.deps)
    expect(ok.db.get('property-g')).toMatchObject({lifecycleStatus: 'sold', isPublished: true})

    const bad = setup({listings: [grin], admins: [FEDIR, VIKTOR, STRANGER], intent: {action: 'sold', listingRef: 'villa-vlore'}})
    await handleChatMessage(msg({chatId: GRIN, chatType: 'channel', senderId: null, text: 'бот, продано villa-vlore'}), bad.deps)
    expect(bad.sent).toHaveLength(0)
  })

  it('a chat cannot touch another partner’s listing', async () => {
    const t = setup({listings: [row()], intent: {action: 'hide', listingRef: 'apartment-2-1-plazh-durres-78m2'}})
    await handleChatMessage(msg({chatId: GRIN, chatType: 'supergroup', senderId: FEDIR}), t.deps)
    expect(t.sent[0]!.text).toContain('другой партнёр (Cactus Real Estate)')
    expect(t.patches).toHaveLength(0)
  })

  it('/id answers anyone, changes nothing', async () => {
    const t = setup()
    await handleChatMessage(msg({senderId: STRANGER, text: '/id@domlivo_intake_bot', command: '/id@domlivo_intake_bot'}), t.deps)
    expect(t.sent[0]!.text).toContain(`ваш Telegram id: ${STRANGER}`)
  })

  it('the Studio kill switch silences changes', async () => {
    const t = setup({enabled: false})
    await handleChatMessage(msg(), t.deps)
    expect(t.sent[0]!.text).toContain('выключен')
  })
})

describe('commander: finding the listing', () => {
  it('a reply to a lead with a link goes straight to the card', async () => {
    const t = setup({intent: {action: 'sold'}})
    await handleChatMessage(
      msg({
        text: 'бот, продано',
        replyTo: {messageId: 40, fromId: 777, fromIsBot: true, text: 'Объект: https://www.domlivo.com/de/property/apartment-2-1-plazh-durres-78m2', urls: []},
      }),
      t.deps,
    )
    expect(t.sent[0]!.text).toContain('Отметить «Продано»?')
  })

  it('several matches become buttons; a pick opens the card', async () => {
    const t = setup({
      listings: [row({_id: 'a', price: 85000}), row({_id: 'b', price: 84000, slug: 'b', slugRu: 'b'})],
      intent: {action: 'hide', filters: {city: 'Durrës', district: null, bedrooms: 2, rooms: null, price: 85000, areaM2: null, dealType: null}},
    })
    await handleChatMessage(msg(), t.deps)
    expect(t.sent[0]!.text).toContain('Нашёл 2')
    expect(t.sent[0]!.kb).toHaveLength(3)
    await handleChatCallback(press(dataOf(t.sent[0], 1)), t.deps)
    expect(t.sent.at(-1)!.text).toContain('Скрыть с сайта?')
    await handleChatCallback(press(dataOf(t.sent.at(-1))), t.deps)
    expect(t.db.get('b')!.isPublished).toBe(false)
    expect(t.db.get('a')!.isPublished).toBe(true)
  })

  it('asks what to change when nothing names a listing', async () => {
    const t = setup({intent: {action: 'hide'}})
    await handleChatMessage(msg({text: 'бот, скрой'}), t.deps)
    expect(t.sent[0]!.text).toContain('Какой объект?')
  })

  it('price change seeds history and undo removes it', async () => {
    const t = setup({intent: {action: 'price', newPrice: 79000, listingRef: 'apartment-2-1-plazh-durres-78m2'}})
    await handleChatMessage(msg({text: 'бот, цена 79 000 apartment-2-1-plazh-durres-78m2'}), t.deps)
    expect(t.sent[0]!.text).toContain('85 000 € → 79 000 €')
    await handleChatCallback(press(dataOf(t.sent[0])), t.deps)
    const ops = t.patches[0]!.ops as {set: {price: number; priceHistory: Array<{price: number}>}}
    expect(ops.set.price).toBe(79000)
    expect(ops.set.priceHistory.map((e) => e.price)).toEqual([85000, 79000])
    await handleChatCallback(press(dataOf(t.sent.at(-1))), t.deps)
    const undo = t.patches.at(-1)!.ops as {set: {price: number}; unset: string[]}
    expect(undo.set.price).toBe(85000)
    expect(undo.unset).toHaveLength(2)
  })

  it('a typed "отмени" offers the last change', async () => {
    const t = setup({intent: {action: 'hide', listingRef: 'apartment-2-1-plazh-durres-78m2'}})
    await handleChatMessage(msg(), t.deps)
    await handleChatCallback(press(dataOf(t.sent[0])), t.deps)
    t.deps.parseIntent = async () => ({action: 'undo', newPrice: null, listingRef: null, filters: {city: null, district: null, bedrooms: null, rooms: null, price: null, areaM2: null, dealType: null}})
    await handleChatMessage(msg({text: 'бот, отмени'}), t.deps)
    expect(t.sent.at(-1)!.text).toContain('Последнее изменение')
    await handleChatCallback(press(dataOf(t.sent.at(-1))), t.deps)
    expect(t.db.get('property-1')!.isPublished).toBe(true)
  })
})

describe('commander: voice', () => {
  it('transcribes, needs the call word, echoes what it heard', async () => {
    const t = setup({transcript: 'Бот, скрой двушку в Дурресе за восемьдесят пять', intent: {action: 'hide', listingRef: 'apartment-2-1-plazh-durres-78m2'}})
    await handleChatMessage(msg({text: null, voiceFileId: 'v1', voiceMime: 'audio/ogg'}), t.deps)
    expect(t.sent[0]!.text).toContain('🎙 «Бот, скрой двушку')
    expect(t.sent[0]!.text).toContain('Скрыть с сайта?')
  })

  it('ignores voice that is not for the bot', async () => {
    const t = setup({transcript: 'Паша, перезвони клиенту'})
    await handleChatMessage(msg({text: null, voiceFileId: 'v1'}), t.deps)
    expect(t.sent).toHaveLength(0)
  })

  it('without a speech key, a voice reply to the bot gets "text only"', async () => {
    const t = setup()
    await handleChatMessage(msg({text: null, voiceFileId: 'v1', replyTo: {messageId: 1, fromId: BOT.id, fromIsBot: true, text: 'x', urls: []}}), t.deps)
    expect(t.sent[0]!.text).toContain('Голосовые пока не понимаю')
  })
})
