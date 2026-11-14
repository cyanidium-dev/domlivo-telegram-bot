import {describe, it, expect} from 'vitest'
import {elevenLabsTranscriber, makeTranscriber} from '../commander/stt.js'

describe('speech to text', () => {
  it('is off without a key', () => {
    expect(makeTranscriber({})).toBeNull()
    expect(makeTranscriber({ELEVENLABS_API_KEY: 'k'})).not.toBeNull()
  })

  it('posts the voice note to ElevenLabs and returns the text', async () => {
    let seen: {url: string; init: RequestInit} | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = {url, init}
      return new Response(JSON.stringify({text: ' бот, продано ', language_code: 'rus'}), {status: 200})
    }) as unknown as typeof fetch
    const t = elevenLabsTranscriber('key-1', 'scribe_v2', fake)
    expect(await t(Buffer.from('ogg'), 'audio/ogg')).toBe('бот, продано')
    expect(seen!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect((seen!.init.headers as Record<string, string>)['xi-api-key']).toBe('key-1')
    expect((seen!.init.body as FormData).get('model_id')).toBe('scribe_v2')
  })

  it('returns null on an API error', async () => {
    const fake = (async () => new Response('bad', {status: 401})) as unknown as typeof fetch
    expect(await elevenLabsTranscriber('k', 'scribe_v2', fake)(Buffer.from('x'), 'audio/ogg')).toBeNull()
  })
})
