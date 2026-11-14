/**
 * Whether a chat message is meant for the bot. Partners talk to each other in
 * the same chat, so the bot acts only when called: @mention, a call word at
 * the start ("бот, …", "Домливо …"), or a reply to one of its own messages.
 * Privacy mode is off in the group so voice notes reach it at all; this is
 * what keeps it from butting into every conversation.
 */

const CALL_WORDS = ['бот', 'бота', 'боте', 'ботик', 'bot', 'домливо', 'домліво', 'domlivo']

export type Addressing = {addressed: boolean; text: string}

function stripMention(text: string, username: string): {found: boolean; text: string} {
  if (!username) return {found: false, text}
  const re = new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
  if (!re.test(text)) return {found: false, text}
  return {found: true, text: text.replace(re, ' ').replace(/\s+/g, ' ').trim()}
}

function stripCallWord(text: string): {found: boolean; text: string} {
  const m = /^\s*([\p{L}]+)[\s,:;!.\-—]+/u.exec(text)
  if (!m || !CALL_WORDS.includes(m[1]!.toLowerCase())) return {found: false, text}
  return {found: true, text: text.slice(m[0].length).trim()}
}

/**
 * `/cmd@thisbot rest` and `/cmd rest` keep the command word; only a
 * `@otherbot` suffix means the command belongs to someone else.
 */
function commandTarget(text: string, username: string): 'mine' | 'other' | 'none' {
  const m = /^\/[a-zа-яё_]+(?:@([A-Za-z0-9_]+))?/iu.exec(text.trim())
  if (!m) return 'none'
  if (!m[1]) return 'mine'
  return m[1].toLowerCase() === username.toLowerCase() ? 'mine' : 'other'
}

export function detectAddressing(
  text: string,
  opts: {botUsername: string; replyToBot: boolean},
): Addressing {
  const cmd = commandTarget(text, opts.botUsername)
  if (cmd === 'other') return {addressed: false, text}
  if (cmd === 'mine') {
    return {addressed: true, text: text.trim().replace(/^(\/[^\s@]+)@[A-Za-z0-9_]+/, '$1')}
  }
  const mention = stripMention(text, opts.botUsername)
  if (mention.found) return {addressed: true, text: stripCallWord(mention.text).text}
  const call = stripCallWord(text)
  if (call.found) return {addressed: true, text: call.text}
  return {addressed: opts.replyToBot, text: text.trim()}
}
