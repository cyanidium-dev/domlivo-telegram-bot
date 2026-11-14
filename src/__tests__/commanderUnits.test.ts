import {describe, it, expect} from 'vitest'
import {parseCommanderChats, ruleFor, isAllowedUser, channelAdminsTrusted} from '../commander/chats.js'
import {detectAddressing} from '../commander/addressing.js'
import {slugsFromText, cleanRef, normalizePrice, parseIntent} from '../commander/intent.js'
import {rankListings, normName, inScope, filtersEmpty} from '../commander/find.js'
import {row} from './fixtures/listing.js'
import {planChange, patchOps, undoOps} from '../commander/actions.js'
import {extractChatMessage, extractChatCallback, extractIncoming} from '../telegram/extract.js'


const noFilters = {city: null, district: null, bedrooms: null, rooms: null, price: null, areaM2: null, dealType: null}

describe('parseCommanderChats', () => {
  it('reads chats, people and scopes', () => {
    const rules = parseCommanderChats(
      JSON.stringify([
        {chat: -1001, label: 'Cactus', users: [11, '22'], scope: ['agent-cactus']},
        {chat: '-1002', label: 'Grinchenko', users: [33, 44], scope: 'general'},
      ]),
    )
    expect(rules).toEqual([
      {chatId: -1001, label: 'Cactus', users: [11, 22], scope: {kind: 'agents', agentIds: ['agent-cactus']}},
      {chatId: -1002, label: 'Grinchenko', users: [33, 44], scope: {kind: 'general'}},
    ])
    expect(ruleFor(rules, -1002)?.label).toBe('Grinchenko')
    expect(ruleFor(rules, -9)).toBeNull()
  })

  it('drops broken entries and broken JSON instead of opening up', () => {
    expect(parseCommanderChats(undefined)).toEqual([])
    expect(parseCommanderChats('{nope')).toEqual([])
    expect(parseCommanderChats(JSON.stringify([{chat: -1, users: []}, {chat: -2, users: [1], scope: 42}]))).toEqual([])
  })

  it('lets only listed people command', () => {
    const [r] = parseCommanderChats(JSON.stringify([{chat: -1, users: [5]}]))
    expect(isAllowedUser(r!, 5)).toBe(true)
    expect(isAllowedUser(r!, 6)).toBe(false)
    expect(isAllowedUser(r!, null)).toBe(false)
  })

  it('trusts a channel only while every human admin is listed', () => {
    const [r] = parseCommanderChats(JSON.stringify([{chat: -1, users: [1, 2]}]))
    expect(channelAdminsTrusted(r!, [{id: 1, isBot: false}, {id: 2, isBot: false}, {id: 99, isBot: true}])).toBe(true)
    expect(channelAdminsTrusted(r!, [{id: 1, isBot: false}, {id: 3, isBot: false}])).toBe(false)
    expect(channelAdminsTrusted(r!, [{id: 99, isBot: true}])).toBe(false)
  })
})

describe('detectAddressing', () => {
  const o = {botUsername: 'domlivo_intake_bot', replyToBot: false}
  it('answers to a call word, a mention or a command', () => {
    expect(detectAddressing('бот, продано', o)).toEqual({addressed: true, text: 'продано'})
    expect(detectAddressing('Домливо скрой 2+1 в Плаже', o)).toEqual({addressed: true, text: 'скрой 2+1 в Плаже'})
    expect(detectAddressing('@domlivo_intake_bot продано', o)).toEqual({addressed: true, text: 'продано'})
    expect(detectAddressing('/help@domlivo_intake_bot', o)).toEqual({addressed: true, text: '/help'})
  })
  it('stays out of the partners’ own conversation', () => {
    expect(detectAddressing('продано, клиент доволен', o).addressed).toBe(false)
    expect(detectAddressing('работаем, ботинки забыл', o).addressed).toBe(false)
    expect(detectAddressing('/status@DomlivoAlbaniaBot', o).addressed).toBe(false)
  })
  it('a reply to the bot is addressed without a call word', () => {
    expect(detectAddressing('да, цена 79', {...o, replyToBot: true})).toEqual({addressed: true, text: 'да, цена 79'})
  })
})

describe('intent helpers', () => {
  it('takes slugs from domlivo links in any language', () => {
    expect(
      slugsFromText(
        'Объект: https://www.domlivo.com/de/property/1-1-mali-i-robit-51-2-sq-m-190926-2 и ещё',
        'domlivo.com/property/villa-x',
      ),
    ).toEqual(['1-1-mali-i-robit-51-2-sq-m-190926-2', 'villa-x'])
  })
  it('cleans a ref', () => {
    expect(cleanRef('https://domlivo.com/ru/property/abc-1')).toBe('abc-1')
    expect(cleanRef('DL-4415')).toBe('DL-4415')
    expect(cleanRef('двушка в дурресе')).toBeNull()
  })
  it('reads spoken prices as thousands', () => {
    expect(normalizePrice(85)).toBe(85000)
    expect(normalizePrice(79.5)).toBe(79500)
    expect(normalizePrice(1_200_000)).toBe(1_200_000)
    expect(normalizePrice(0)).toBeNull()
  })
  it('parseIntent forces the schema and normalizes prices', async () => {
    let params: Record<string, unknown> | null = null
    const client = {
      messages: {
        create: async (p: Record<string, unknown>) => {
          params = p
          return {
            content: [
              {
                type: 'tool_use',
                input: {action: 'price', newPrice: 79, listingRef: null, filters: {...noFilters, rooms: 2, price: 85}},
              },
            ],
          }
        },
      },
    }
    const intent = await parseIntent(client, 'цена на двушку за 85 теперь 79', null)
    expect(intent?.newPrice).toBe(79000)
    expect(intent?.filters.price).toBe(85000)
    expect((params as unknown as {tool_choice: unknown}).tool_choice).toEqual({type: 'tool', name: 'record_command'})
  })
  it('parseIntent returns null on API failure', async () => {
    const client = {messages: {create: async () => Promise.reject(new Error('boom'))}}
    expect(await parseIntent(client, 'продано', null)).toBeNull()
  })
})

describe('finding listings', () => {
  it('normalizes names across scripts and diacritics', () => {
    expect(normName('Durrës')).toBe('dures')
    expect(normName('Дуррес')).toBe('dures')
  })
  it('ranks by the given filters', () => {
    const rows = [
      row({_id: 'a', price: 85000}),
      row({_id: 'b', price: 84000, districtNames: ['Shkëmbi i Kavajës']}),
      row({_id: 'c', price: 120000}),
      row({_id: 'd', price: 85000, bedrooms: 1, rooms: 2}),
    ]
    const hits = rankListings(rows, {...noFilters, city: 'Дурресе', bedrooms: 2, price: 85000})
    expect(hits.map((r) => r._id)).toEqual(['a', 'b'])
    expect(rankListings(rows, {...noFilters, district: 'Plazh', bedrooms: 2}).map((r) => r._id)).toEqual(['a', 'c'])
    // "двушка" = 2 rooms: a 1+1 and, as people say in Albania, a 2+1.
    expect(rankListings(rows, {...noFilters, rooms: 2, price: 85000}).map((r) => r._id)).toEqual(['a', 'd', 'b'])
  })
  it('scopes listings to the chat', () => {
    expect(inScope(row(), {kind: 'agents', agentIds: ['agent-cactus']})).toBe(true)
    expect(inScope(row(), {kind: 'general'})).toBe(false)
    expect(inScope(row({agentId: 'agent-g', agentHasLeadChat: false}), {kind: 'general'})).toBe(true)
    expect(inScope(row(), {kind: 'all'})).toBe(true)
  })
  it('knows when nothing narrows a search', () => {
    expect(filtersEmpty(noFilters)).toBe(true)
    expect(filtersEmpty({...noFilters, city: 'Durrës'})).toBe(false)
  })
})

describe('planChange', () => {
  const today = '2026-11-14'
  it('sold keeps the page up with the label', () => {
    const r = planChange('sold', row(), {today})
    expect(r).toMatchObject({ok: true, plan: {set: {lifecycleStatus: 'sold', isPublished: true}, before: {lifecycleStatus: 'active', isPublished: true}}})
  })
  it('hide only flips isPublished', () => {
    const r = planChange('hide', row(), {today})
    expect(r.ok && r.plan.set).toEqual({isPublished: false})
    expect(planChange('hide', row({isPublished: false}), {today})).toEqual({ok: false, reason: 'already'})
  })
  it('unhide brings back a sold or hidden listing as active', () => {
    expect(planChange('unhide', row(), {today})).toEqual({ok: false, reason: 'already'})
    const r = planChange('unhide', row({lifecycleStatus: 'sold'}), {today})
    expect(r.ok && r.plan.set).toEqual({isPublished: true, lifecycleStatus: 'active'})
  })
  it('price seeds an empty history with the old price, then appends', () => {
    const r = planChange('price', row(), {newPrice: 79000, today})
    if (!r.ok) throw new Error('expected a plan')
    expect(r.plan.historyReplace?.map((e) => [e.date, e.price])).toEqual([
      ['2026-09-01', 85000],
      [today, 79000],
    ])
    const ops = patchOps(r.plan, 'rev1')
    expect(ops).toMatchObject({set: {price: 79000}, ifRevisionID: 'rev1'})
    expect((ops.set as {priceHistory: unknown[]}).priceHistory).toHaveLength(2)
  })
  it('price on an existing history inserts after the last row', () => {
    const r = planChange('price', row({priceHistory: [{_key: 'k0', date: '2026-09-25', price: 85000}]}), {newPrice: 79000, today})
    if (!r.ok) throw new Error('expected a plan')
    const ops = patchOps(r.plan)
    expect(ops.insert).toMatchObject({after: 'priceHistory[-1]'})
    expect(r.plan.historyReplace).toBeNull()
  })
  it('refuses a missing or unchanged price', () => {
    expect(planChange('price', row(), {today})).toEqual({ok: false, reason: 'no_price'})
    expect(planChange('price', row(), {newPrice: 85000, today})).toEqual({ok: false, reason: 'same_price'})
  })
  it('undo restores values, unsets what was unset, and drops added history rows', () => {
    const r = planChange('sold', row({lifecycleStatus: null}), {today})
    if (!r.ok) throw new Error('expected a plan')
    expect(undoOps(r.plan, 'rev2')).toEqual({set: {isPublished: true}, unset: ['lifecycleStatus'], ifRevisionID: 'rev2'})
    const p = planChange('price', row({priceHistory: [{_key: 'k0'}]}), {newPrice: 79000, today})
    if (!p.ok) throw new Error('expected a plan')
    const u = undoOps(p.plan)
    expect(u.set).toEqual({price: 85000})
    expect(u.unset).toEqual([`priceHistory[_key=="${p.plan.historyAppend[0]!._key}"]`])
  })
})

describe('extract for chats', () => {
  it('reads a group voice reply to a lead with a hidden link', () => {
    const m = extractChatMessage({
      update_id: 1,
      message: {
        message_id: 10,
        from: {id: 7, first_name: 'Павел', username: 'paul'},
        chat: {id: -100, type: 'supergroup'},
        voice: {file_id: 'v1', duration: 6, mime_type: 'audio/ogg'},
        reply_to_message: {
          message_id: 9,
          from: {id: 555, is_bot: true},
          text: 'Лид кликнул по WhatsApp',
          entities: [{type: 'text_link', url: 'https://www.domlivo.com/ru/property/x-1'}],
        },
      },
    })
    expect(m).toMatchObject({chatId: -100, senderId: 7, senderName: 'Павел', voiceFileId: 'v1', text: null})
    expect(m?.replyTo).toMatchObject({fromId: 555, fromIsBot: true, urls: ['https://www.domlivo.com/ru/property/x-1']})
  })
  it('reads a channel post without an author id', () => {
    const m = extractChatMessage({
      update_id: 2,
      channel_post: {message_id: 3, chat: {id: -200, type: 'channel'}, author_signature: 'Viktor', text: 'бот, продано'},
    })
    expect(m).toMatchObject({chatType: 'channel', senderId: null, authorSignature: 'Viktor'})
  })
  it('ignores bots and leaves private chats to intake', () => {
    expect(
      extractChatMessage({update_id: 3, message: {message_id: 1, from: {id: 1, is_bot: true}, chat: {id: -1, type: 'group'}, text: 'x'}}),
    ).toBeNull()
    const priv = {update_id: 4, message: {message_id: 1, from: {id: 1}, chat: {id: 1, type: 'private'}, text: 'x'}}
    expect(extractChatMessage(priv)).toBeNull()
    expect(extractIncoming(priv)).not.toBeNull()
  })
  it('takes only commander callbacks from shared chats', () => {
    const cb = (data: string, type: string) => ({
      update_id: 5,
      callback_query: {id: 'c', from: {id: 9, first_name: 'Алес'}, data, message: {message_id: 4, chat: {id: -1, type}}},
    })
    expect(extractChatCallback(cb('cm:y:abc123', 'supergroup'))).toMatchObject({senderId: 9, senderName: 'Алес', chatId: -1})
    expect(extractChatCallback(cb('rv:p:abc', 'supergroup'))).toBeNull()
    expect(extractChatCallback(cb('cm:y:abc123', 'private'))).toBeNull()
  })
})
