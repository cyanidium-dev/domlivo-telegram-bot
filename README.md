# domlivo-telegram-bot

Production repo: **https://github.com/cyanidium-dev/domlivo-telegram-bot** (since 2026-09-05;
the earlier `kulakaa073/domlivo-bot` is frozen). Symlinked into `domlivo-workspace` as `bot/`.

Telegram property-intake bot for DomLivo. Agents DM the bot an album of photos
with the listing text as the caption; the bot parses it with one Claude call,
translates to en/uk/ru/sq/it, uploads the photos, and creates a **draft**
`property` in Sanity, replying with what it understood, what's missing, and a
Studio link.

After the draft, the bot sends a **preview** of the listing as the site would
render it, with inline buttons: **✏️ Update** asks for the missing fields,
reads the agent's next message (text and/or photos), patches the draft, and
re-previews; **🚀 Post** publishes the draft (code-side gate: title, price,
deal, type, city, ≥1 photo) and replies with the live site URL. Post only
appears when `botAllowPublish` is on in Studio settings. `🔄 Restart` (or
`/restart`) resets bot state from any point — it never deletes anything in
Studio.

Spec: `domlivo-workspace/docs/engineering/SPEC-telegram-bot-2026-08-15.md` and
`SPEC-bot-review-flow-2026-08-20.md` (preview/Update/Post/restart).
Plan: `domlivo-workspace/docs/engineering/PLAN-telegram-bot-2026-08-16.md`.
Deployed on Vercel as its own project; webhook at `/api/telegram`.

Failure policy: every failure logs a detailed structured line (visible in
Vercel logs) and the user gets only a bare "something went wrong" reply.
The webhook always returns 200 so Telegram never retry-storms.

## Environment variables

| Var | Required | Where to get it |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | @BotFather → `/newbot` |
| `TELEGRAM_WEBHOOK_SECRET` | yes | generate: `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | yes | console.anthropic.com → API keys |
| `SANITY_WRITE_TOKEN` | yes | sanity.io/manage → project `g4aqp6ex` → API → Tokens → new token, **Editor** role |
| `UPSTASH_REDIS_REST_URL` | yes | console.upstash.com → create free Redis DB → REST API |
| `UPSTASH_REDIS_REST_TOKEN` | yes | same Upstash page |
| `STUDIO_BASE_URL` | yes | the deployed Studio origin, no trailing slash (e.g. `https://domlivo-admin.vercel.app` — the project has no `studioHost`, so `*.sanity.studio` 404s) |
| `SANITY_PROJECT_ID` | no (default `g4aqp6ex`) | override only for a different project |
| `SANITY_DATASET` | no (default `production`) | override only for a test dataset |

| `COMMANDER_CHATS` | for the commander | JSON list of partner chats and the only Telegram ids allowed to command there, see below |
| `ELEVENLABS_API_KEY` | for voice commands | elevenlabs.io → Developers → API Keys (Speech to Text). Without it voice gets "text only" |
| `ELEVENLABS_STT_MODEL` | no (default `scribe_v2`) | override the Scribe model |

All secrets live on the Vercel project. Behavioral config (`botEnabled`
kill-switch, `botOwnerTelegramUserId`, `botDefaultAgent`, `siteBaseUrl`,
`botAllowPublish` publish kill-switch, per-agent `telegramUserId`) lives in
Sanity Site Settings / Agent documents.

The webhook must be registered with `allowed_updates: ['message', 'channel_post',
'callback_query']` (the set-webhook script does this) — inline buttons stay
dead until `npm run set-webhook` has been re-run after the review-flow deploy.

## Commander (partner chats)

In the partner lead chats the same bot changes existing listings on command,
typed or by voice: sold, rented, hide, back on the site, new price, find, undo,
journal. It acts only when addressed (`бот, …`, `@mention`, a reply to its own
message), only for the Telegram ids listed for that chat, and only on that
chat's listings; every change goes through a photo card with ✅ / ❌ and ends
with a ↩️ undo button. It never deletes: sold/rented set `lifecycleStatus`,
hide sets `isPublished: false`, price sets `price` and adds a `priceHistory`
row — all existing fields. Journal and undo snapshots live in Redis
(`cm:journal:<day>`, 400 days). Code: `src/commander/`.

```json
[
  {"chat": -100111, "label": "Domlivo × Cactus", "users": [ALES_ID, PAVEL_ID], "scope": ["agent-cactus"]},
  {"chat": -100222, "label": "Domlivo × Grinchenko", "users": [FEDIR_ID, VIKTOR_ID], "scope": "general"}
]
```

`scope`: a list of agent `_id`s, `"general"` (listings whose agent has no
`telegramLeadChatId`, i.e. whose leads land in the main chat) or `"all"`.
`/id@<bot>` in a chat prints the chat id and the sender's id.

Setup: @BotFather → `/setprivacy` → Disable (so voice notes reach the bot),
then remove and re-add the bot to the group. In a channel the bot must be an
admin; channel posts carry no author id, so a post counts only while every
human admin of the channel is on its `users` list, and button presses are
checked by the presser's id. Re-run `npm run set-webhook` once: the commander
needs `channel_post` updates.

## Deploy

The Vercel project (`domlivo-bot`) deploys `main` of this repo on push once its Git
integration points here. Manual fallback:

```
npx vercel --prod
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run set-webhook -- https://<project>.vercel.app
```
