export type TgUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
}

export type TgMessage = {
  message_id: number
  from?: TgUser
  /** Channel posts carry the channel here instead of a person in `from`. */
  sender_chat?: {id: number; type: string; title?: string}
  /** Channel posts: the posting admin's name, only when the channel signs messages. */
  author_signature?: string
  chat?: {id: number; type: string; title?: string}
  media_group_id?: string
  text?: string
  caption?: string
  entities?: Array<{type: string; url?: string}>
  caption_entities?: Array<{type: string; url?: string}>
  photo?: Array<{file_id: string; width: number; height: number; file_size?: number}>
  document?: {file_id: string; mime_type?: string; file_name?: string}
  voice?: {file_id: string; duration?: number; mime_type?: string}
  audio?: {file_id: string; duration?: number; mime_type?: string}
  video_note?: {file_id: string; duration?: number}
  reply_to_message?: TgMessage
}

export type TgUpdate = {
  update_id: number
  message?: TgMessage
  channel_post?: TgMessage
  callback_query?: {
    id: string
    from?: TgUser
    message?: {message_id: number; chat?: {id: number; type: string}}
    data?: string
  }
}

/** An inline-button press, with enough context to answer and edit the message. */
export type IncomingCallback = {
  updateId: number
  callbackId: string
  data: string
  chatId: number
  senderId: number
  messageId: number
  languageCode: string | null
}

export function extractCallback(update: TgUpdate): IncomingCallback | null {
  const cb = update.callback_query
  if (!cb || !cb.from || cb.from.is_bot || !cb.data) return null
  const msg = cb.message
  if (!msg || !msg.chat || msg.chat.type !== 'private') return null
  return {
    updateId: update.update_id,
    callbackId: cb.id,
    data: cb.data,
    chatId: msg.chat.id,
    senderId: cb.from.id,
    messageId: msg.message_id,
    languageCode: cb.from.language_code ?? null,
  }
}

export type Incoming = {
  updateId: number
  chatId: number
  senderId: number
  /** Telegram @username if the account has one — used for onboarding only, never for auth. */
  username: string | null
  firstName: string | null
  /** Telegram client language ("uk", "ru-RU", ...) — used to localize bot replies. */
  languageCode: string | null
  mediaGroupId: string | null
  /** caption (media) or text (plain message) */
  text: string | null
  /** Largest photo size, or an image sent as a document. */
  photoFileId: string | null
  command: string | null
}

export function extractIncoming(update: TgUpdate): Incoming | null {
  const m = update.message
  if (!m || !m.from || m.from.is_bot || !m.chat || m.chat.type !== 'private') return null

  const text = m.caption ?? m.text ?? null
  const command = text?.startsWith('/') ? (text.split(/\s/)[0] ?? null) : null

  let photoFileId: string | null = null
  if (m.photo && m.photo.length > 0) {
    // Telegram sends PhotoSize[] sorted ascending; the last entry is the largest.
    photoFileId = m.photo[m.photo.length - 1]!.file_id
  } else if (m.document && (m.document.mime_type ?? '').startsWith('image/')) {
    photoFileId = m.document.file_id
  }

  return {
    updateId: update.update_id,
    chatId: m.chat.id,
    senderId: m.from.id,
    username: m.from.username ?? null,
    firstName: m.from.first_name ?? null,
    languageCode: m.from.language_code ?? null,
    mediaGroupId: m.media_group_id ?? null,
    text,
    photoFileId,
    command,
  }
}

/** Chat kinds the commander listens in. Private chats stay with the intake flow. */
export type SharedChatType = 'group' | 'supergroup' | 'channel'

/** The message someone replied to: who wrote it and any links it carried. */
export type RepliedMessage = {
  messageId: number
  fromId: number | null
  fromIsBot: boolean
  text: string | null
  /** Links hidden behind text (text_link entities); plain URLs stay in `text`. */
  urls: string[]
}

/** A message in a group, supergroup or channel — the commander's input. */
export type ChatMessage = {
  updateId: number
  chatId: number
  chatType: SharedChatType
  messageId: number
  /** null for channel posts: Telegram signs them with the channel, not a person. */
  senderId: number | null
  senderName: string | null
  username: string | null
  authorSignature: string | null
  text: string | null
  /** Voice, audio or round video note — anything worth transcribing. */
  voiceFileId: string | null
  voiceMime: string | null
  command: string | null
  replyTo: RepliedMessage | null
}

function displayName(u: TgUser | undefined): string | null {
  if (!u) return null
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name || (u.username ? `@${u.username}` : null)
}

function linkUrls(m: TgMessage): string[] {
  return [...(m.entities ?? []), ...(m.caption_entities ?? [])]
    .filter((e) => e.type === 'text_link' && typeof e.url === 'string')
    .map((e) => e.url!)
}

function isShared(type: string | undefined): type is SharedChatType {
  return type === 'group' || type === 'supergroup' || type === 'channel'
}

export function extractChatMessage(update: TgUpdate): ChatMessage | null {
  const m = update.message ?? update.channel_post
  if (!m || !m.chat || !isShared(m.chat.type)) return null
  // Other bots (the lead bot included) never give commands.
  if (m.from?.is_bot) return null

  const text = m.caption ?? m.text ?? null
  const command = text?.startsWith('/') ? (text.split(/\s/)[0]?.toLowerCase() ?? null) : null
  const media = m.voice ?? m.audio ?? m.video_note ?? null
  const r = m.reply_to_message
  const replyTo: RepliedMessage | null = r
    ? {
        messageId: r.message_id,
        fromId: r.from?.id ?? null,
        fromIsBot: r.from?.is_bot === true,
        text: r.caption ?? r.text ?? null,
        urls: linkUrls(r),
      }
    : null

  return {
    updateId: update.update_id,
    chatId: m.chat.id,
    chatType: m.chat.type as SharedChatType,
    messageId: m.message_id,
    senderId: m.from?.id ?? null,
    senderName: displayName(m.from),
    username: m.from?.username ?? null,
    authorSignature: m.author_signature ?? null,
    text,
    voiceFileId: media?.file_id ?? null,
    voiceMime: m.voice?.mime_type ?? m.audio?.mime_type ?? (m.video_note ? 'video/mp4' : media ? 'audio/ogg' : null),
    command,
    replyTo,
  }
}

/** A press on a commander button (callback_data `cm:…`) in a group or channel. */
export type ChatCallback = {
  updateId: number
  callbackId: string
  data: string
  chatId: number
  messageId: number
  senderId: number
  senderName: string | null
}

export function extractChatCallback(update: TgUpdate): ChatCallback | null {
  const cb = update.callback_query
  if (!cb || !cb.from || cb.from.is_bot || !cb.data?.startsWith('cm:')) return null
  const msg = cb.message
  if (!msg || !msg.chat || !isShared(msg.chat.type)) return null
  return {
    updateId: update.update_id,
    callbackId: cb.id,
    data: cb.data,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    senderId: cb.from.id,
    senderName: displayName(cb.from),
  }
}
