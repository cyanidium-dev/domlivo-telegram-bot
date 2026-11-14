import {log} from '../log.js'

/**
 * Speech-to-text for voice commands. Claude does not take audio, so this is a
 * separate service. Provider choice is the owner's (pending, 2026-11-14);
 * ElevenLabs Scribe is wired because it covers Albanian best of the options
 * compared. No key -> null -> the bot answers voice with "text only".
 */
export type Transcriber = (audio: Buffer, mime: string) => Promise<string | null>

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text'

export function elevenLabsTranscriber(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Transcriber {
  return async (audio, mime) => {
    const form = new FormData()
    form.append('model_id', model)
    form.append('tag_audio_events', 'false')
    form.append('file', new Blob([new Uint8Array(audio)], {type: mime}), mime.includes('mp4') ? 'voice.mp4' : 'voice.ogg')
    const res = await fetchImpl(ELEVENLABS_URL, {method: 'POST', headers: {'xi-api-key': apiKey}, body: form})
    if (!res.ok) {
      log('error', 'stt_failed', {provider: 'elevenlabs', status: res.status, body: (await res.text()).slice(0, 500)})
      return null
    }
    const data = (await res.json()) as {text?: string; language_code?: string}
    log('info', 'stt_done', {provider: 'elevenlabs', language: data.language_code ?? null, chars: data.text?.length ?? 0})
    return data.text?.trim() || null
  }
}

export function makeTranscriber(env: Record<string, string | undefined>): Transcriber | null {
  const key = env.ELEVENLABS_API_KEY?.trim()
  if (key) return elevenLabsTranscriber(key, env.ELEVENLABS_STT_MODEL?.trim() || 'scribe_v2')
  return null
}
