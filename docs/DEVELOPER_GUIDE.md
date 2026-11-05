# VaaniYantra — Developer Guide

This guide covers building **on** VaaniYantra (the public REST API and webhooks)
and working **in** the codebase (architecture, local setup, deployment).

- End-user docs: **[User Guide](./USER_GUIDE.md)**
- Base URL: **`https://vaaniyantra.com`**

---

## Table of contents

**Integrating with the API**
1. [Authentication](#1-authentication)
2. [REST API reference](#2-rest-api-reference)
3. [Webhooks](#3-webhooks)

**Working on the codebase**
4. [Architecture overview](#4-architecture-overview)
5. [Tech stack](#5-tech-stack)
6. [Local development](#6-local-development)
7. [Project structure](#7-project-structure)
8. [Telephony & the voice pipeline](#8-telephony--the-voice-pipeline)
9. [Deployment](#9-deployment)
10. [Operations](#10-operations-health-backups-rate-limits-headers)
11. [Deployment modes — our cloud, and a client's](#11-deployment-modes--our-cloud-and-a-clients)
12. [Which pipeline runs a minute](#12-which-pipeline-runs-a-minute)

---

# Integrating with the API

## 1. Authentication

Create an API key in **Settings → API keys**. Keys look like `ck_live_…` and are
shown **once** — store it securely (it's hashed at rest, so it can't be
retrieved later).

Send it on every request as a Bearer token **or** an `x-api-key` header:

```bash
curl https://vaaniyantra.com/api/v1/agents \
  -H "Authorization: Bearer ck_live_xxxxxxxxxxxxxxxx"

# equivalently:
curl https://vaaniyantra.com/api/v1/agents \
  -H "x-api-key: ck_live_xxxxxxxxxxxxxxxx"
```

- All endpoints are **scoped to the organization** that owns the key.
- Missing/invalid/revoked/expired keys return **`401`**
  `{"error":"Invalid or missing API key"}`.
- Revoke a key anytime from Settings → API keys.

### Permissions (scopes)

Every key carries a list of scopes, and every endpoint requires one. Grant a key
only what the integration needs — in particular, `patients:*` reaches medical
records, so a key that only places calls should never hold it.

| Scope | Grants |
|-------|--------|
| `agents:read` | `GET /agents`, `GET /agents/:id` |
| `calls:read` | `GET /calls`, `GET /calls/:id` |
| `calls:write` | `POST /calls` (place an outbound call) |
| `numbers:read` | `GET /numbers` |
| `appointments:read` | `GET /appointments` |
| `patients:read` | `GET /patients`, `GET /patients/:id/visits` |
| `patients:write` | `POST /patients`, `POST /patients/:id/visits` |

You may also grant a whole resource with `calls:*`, which keeps working if we
add another action to that resource later.

A key that is **valid but lacks the scope** gets **`403`** — not `401` — naming
what was missing, so you can tell "wrong key" from "key needs widening":

```json
{ "error": "This API key is missing the \"patients:read\" scope", "required": ["patients:read"] }
```

> **Keys created before scopes existed** carry no scopes and currently work on
> every endpoint. They are shown as **Unrestricted** in Settings → API keys and
> will stop working when scope enforcement is switched to strict. Replace them
> with a scoped key at your convenience — we will give notice before the switch.

---

## 2. REST API reference

Base path: `https://vaaniyantra.com/api/v1`. All responses are JSON.
List endpoints accept `?limit=` (default 25, max 100) and `?offset=`.

**Rate limits:** 120 requests/minute per API key (plus a per-IP cap on
authentication attempts). Exceeding it returns `429` with a `Retry-After`
header — back off and retry after that many seconds.

**Scopes:** each endpoint below names the scope it requires (see §1).

### Agents

**`GET /api/v1/agents`** — list agents.
```json
{ "agents": [
  { "id": "…", "name": "Hindi Helpdesk", "language": "hi-IN",
    "voice": "Aoede", "status": "ACTIVE", "direction": "BOTH" }
]}
```

**`GET /api/v1/agents/:id`** — one agent (adds `greeting`, `createdAt`).
```json
{ "agent": { "id": "…", "name": "…", "language": "en-IN", "voice": "…",
  "status": "ACTIVE", "direction": "BOTH", "greeting": "Hello!…",
  "createdAt": "2026-07-10T…" } }
```

### Calls

**`GET /api/v1/calls`** — list calls.
Query filters: `direction` (`INBOUND`|`OUTBOUND`), `status`
(`COMPLETED`|`FAILED`|`NO_ANSWER`|…), `agentId`, plus `limit`/`offset`.
```json
{ "calls": [ { …call… } ], "total": 128, "limit": 25, "offset": 0 }
```

**`GET /api/v1/calls/:id`** — one call **with full transcript**.
```json
{ "call": {
  "id": "…", "direction": "INBOUND", "status": "COMPLETED",
  "fromNumber": "+9198…", "toNumber": "+9180…", "durationSec": 92,
  "language": "en-IN", "agent": { "id": "…", "name": "…" },
  "summary": "Caller asked about pricing and booked a follow-up.",
  "sentiment": "POSITIVE", "sentimentScore": 0.6,
  "topics": ["pricing","follow-up"],
  "collectedData": { "name": "Alex", "preferred_time": "Tomorrow 3pm" },
  "recordingUrl": "/api/calls/…/recording",
  "createdAt": "…", "startedAt": "…", "endedAt": "…",
  "transcript": [ { "role": "AGENT", "text": "Hello!…", "atMs": 300 },
                  { "role": "CALLER", "text": "Hi…", "atMs": 2100 } ]
}}
```

**`POST /api/v1/calls`** — place an outbound call.
```bash
curl -X POST https://vaaniyantra.com/api/v1/calls \
  -H "Authorization: Bearer ck_live_…" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "AGENT_ID", "to": "+919876543210", "fromNumberId": "NUMBER_ID" }'
```
| Field | Required | Notes |
|-------|----------|-------|
| `agentId` | yes | An agent in your org. |
| `to` | yes | Destination in E.164. |
| `fromNumberId` | no | Which of your numbers to call from (else a default caller ID). |

Returns `201` with the created call object. Errors: `400` (bad input),
`403` (monthly call-minute limit reached), `404` (agent not found),
`502` (provider failed). Outbound is subject to your account's monthly call-minute safety cap.

### Numbers

**`GET /api/v1/numbers`** — list your phone numbers.
```json
{ "numbers": [
  { "id": "…", "e164": "+916624394745", "label": "Main line",
    "provider": "twilio", "agentId": "…", "inboundEnabled": true,
    "webhookConfigured": true, "createdAt": "…" }
]}
```

### Appointments

**`GET /api/v1/appointments`** — list appointments.
Query filters: `status` (`CONFIRMED`|`CANCELLED`), `upcoming=true`, `limit`/`offset`.
```json
{ "appointments": [
  { "id": "…", "customerName": "Alex", "customerNumber": "+9198…",
    "service": "consultation", "expertName": "Dr. Rao",
    "startAt": "…", "endAt": "…", "timezone": "Asia/Kolkata",
    "status": "CONFIRMED", "channel": "whatsapp", "agentId": "…", "createdAt": "…" }
], "total": 12, "limit": 25, "offset": 0 }
```

---

## 3. Webhooks

Register endpoints in **Settings → Webhooks**. When a subscribed event fires,
we `POST` a JSON payload to your URL.

### Events
| Event | When |
|-------|------|
| `call.completed` | A call finished successfully (includes summary, sentiment, collected data). |
| `call.failed` | A call ended without connecting (failed, busy, no answer). |

### Delivery & headers
- Method: `POST`, `Content-Type: application/json`.
- `X-VaaniYantra-Event: call.completed`
- `X-VaaniYantra-Signature: sha256=<hex HMAC-SHA256 of the raw body>`
- Redirects are **not** followed, and endpoints must resolve to a **public**
  address (internal/loopback addresses are blocked). 6-second timeout.
- Each webhook has a signing **secret** (`whsec_…`) shown in the UI. Delivery
  outcome (last status, last error) is recorded on the webhook.
- **Slack** webhooks (type `slack`) receive a Block Kit message instead and are
  **not** HMAC-signed.

### Payload
```json
{
  "event": "call.completed",
  "timestamp": "2026-07-10T12:00:00.000Z",
  "data": {
    "id": "call_…", "direction": "INBOUND", "status": "COMPLETED",
    "fromNumber": "+9198…", "toNumber": "+9180…", "durationSec": 42,
    "language": "en-IN", "agent": { "id": "…", "name": "…" },
    "summary": "…", "sentiment": "POSITIVE", "sentimentScore": 0.6,
    "topics": ["pricing"], "collectedData": { "name": "Alex" },
    "recordingUrl": "https://vaaniyantra.com/api/calls/…/recording",
    "createdAt": "…", "endedAt": "…"
  }
}
```

### Verifying the signature (Node.js)
```js
import crypto from 'crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

// Express example — use the RAW body, not the parsed object:
app.post('/hook', express.raw({ type: 'application/json' }), (req, res) => {
  const ok = verify(req.body, req.get('X-VaaniYantra-Signature'), process.env.WEBHOOK_SECRET);
  if (!ok) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString());
  // … handle event …
  res.sendStatus(200);
});
```

Use the **"Send test"** button in the UI to deliver a sample payload and confirm
your endpoint verifies it.

---

# Working on the codebase

## 4. Architecture overview

Two Node processes back the platform:

- **`vaani-web`** — the **Next.js 14** app (App Router): dashboard UI + all
  `/api/*` routes. Port `3000`.
- **`vaani-voice`** — the **realtime media server** (`voice-server/index.ts`):
  the WebSocket endpoint telephony providers stream call audio to, bridged to the
  AI in real time. Port `8080`.

```
Caller ─▶ Twilio / Plivo / Exotel ─▶ (webhook/applet) ─▶ voice-server WS (:8080)
                                                   │  audio ⇄ Gemini Live
                                                   ▼
                                              PostgreSQL  ◀─▶  Next.js app (:3000)
```

- **Auth:** Firebase Authentication (client SDK + Admin SDK for session cookies).
- **Data:** PostgreSQL via Prisma.
- **Voice AI:** Gemini Live (native speech-to-speech) is the default realtime
  path; a cascade path (Deepgram STT → LLM → TTS) exists as a fallback.
- **Telephony:** provider-agnostic adapters (Twilio, Plivo, Exotel, mock).

## 5. Tech stack

| Area | Choice |
|------|--------|
| Framework | Next.js 14 (App Router), React 18, TypeScript |
| Styling | Tailwind CSS |
| DB / ORM | PostgreSQL + Prisma |
| Auth | Firebase Auth (`firebase`, `firebase-admin`) |
| Realtime voice | `@google/genai` (Gemini Live), `ws` |
| STT / TTS | Deepgram, Google Cloud Speech/TTS, ElevenLabs (optional) |
| Telephony | Twilio REST, Plivo REST, Exotel (Voicebot streaming) |
| Payments | Cashfree — PG orders + Subscriptions (REST; JS SDK for checkout only) |
| Validation | Zod |

## 6. Local development

**Prerequisites:** Node 20+, a PostgreSQL database.

```bash
# 1. Install
npm install

# 2. Configure env
cp .env.example .env       # then fill in real values (see below)

# 3. Set up the database
npm run db:push            # apply the Prisma schema
npm run db:seed            # optional: seed demo data

# 4. Run (two processes)
npm run dev                # Next.js app on :3000
npm run voice-server       # realtime voice server on :8080
```

**Mock mode:** with `USE_MOCK_TELEPHONY/SPEECH/LLM="true"` the app runs fully
offline with deterministic mock providers — no external keys needed. Flip them to
`"false"` and add real keys to go live.

**Key environment variables** (see `.env.example` for the full list):

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection string |
| `APP_BASE_URL` / `PUBLIC_BASE_URL` | Public URLs used to build webhook URLs |
| `VOICE_WS_URL` / `VOICE_WS_PORT` | Realtime voice-server WS URL / port |
| `GEMINI_API_KEY` | Gemini (LLM + Live voice) |
| `GOOGLE_CLOUD_API_KEY` | Google Speech-to-Text / Text-to-Speech |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_CALLER_ID` | Platform Twilio (fallback only) |
| `NEXT_PUBLIC_FIREBASE_*` | Firebase client config (public) |
| `FIREBASE_*` (admin) | Firebase Admin credentials (server) |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google Calendar connector |
| `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` | Optional STT/TTS providers |
| `SUPERADMIN_EMAILS` | Comma-separated founder emails for `/admin` |

There are deliberately **no Plivo or Exotel env vars**: those are bring-your-own
only. A workspace connects its own credentials in the UI and they are stored
encrypted per-account (`TwilioAccount` / `PlivoAccount` / `ExotelAccount`), which
is also the preferred path for Twilio — the env vars above are a platform-level
fallback for workspaces with no connected account.

> ⚠️ Never commit real secrets. `.env`, `Exotel.env`, `*.db`, and build output are
> git-ignored. `.env.example` must contain **placeholders only**.

Useful scripts: `npm run build`, `npm run start`, `npm run lint`,
`npm run db:studio` (Prisma Studio), `npm run db:generate`.

## 7. Project structure

```
src/
  app/                     Next.js App Router
    (app)/…                dashboard pages (agents, numbers, calls, settings…)
    (auth)/…               sign-in / sign-up
    api/                   REST endpoints
      v1/                  ← public API (agents, calls, numbers, appointments)
      telephony/           Twilio + Exotel webhooks / stream URL
                           (Plivo's are served by voice-server, not Next)
      webhooks/, keys/     outbound webhooks + API keys
      admin/               founder-only platform config
  components/              React UI (AgentForm, NumbersManager, RateCard, …)
  lib/
    billing/               everything that decides what someone is charged:
                           catalogue.ts (the rate + retired plans), rate-card.ts
                           (per-client pricing), prepaid.ts, credits.ts,
                           overage-sweep.ts, invoice.ts, tax.ts, promo.ts,
                           margin.ts
    usage/                 the ledger: ledger.ts, minutes.ts, period.ts,
                           omni-reconcile.ts — where a billable minute comes from
    deploy/                deployment.ts (which install is this), deploy-auth.ts
                           (the signed channel to a client-cloud box)
    api-keys.ts            API-key generation + authentication
    webhooks.ts            signing, delivery, dispatch, SSRF guard
    telephony-accounts.ts  BYO Twilio/Plivo/Exotel account resolution
    adapters/telephony/    TelephonyProvider: twilio.ts, plivo.ts, exotel.ts, mock.ts
    voice/                 codec.ts, live.ts (Gemini Live), deepgram.ts, tts.ts…
    calls/place-outbound.ts shared outbound-call placement
    connectors.ts, crm.ts  Google/WhatsApp/HubSpot integrations
    auth/                  Firebase session, workspace context, RBAC
prisma/schema.prisma       database schema
voice-server/index.ts      realtime media server (WS :8080)
```

## 8. Telephony & the voice pipeline

Providers implement the **`TelephonyProvider`** interface
(`src/lib/adapters/telephony/types.ts`): `provisionNumber`, `listAccountNumbers`,
`configureNumberWebhook`, `placeCall`, `buildAnswerDocument`, `redirectCall`, plus
capability flags (`canBuyNumbers`, `usesAnswerWebhook`).

- **Twilio** — mulaw/8kHz audio over Media Streams; per-call TwiML; webhooks set
  automatically via the REST API on import.
- **Plivo** — the same mulaw/8kHz audio as Twilio but a different WebSocket
  *dialect* (`playAudio`/`clearAudio` instead of `media`/`clear`, and `streamId`
  instead of `streamSid`); per-call answer XML; webhooks set automatically via
  the REST API on import.
- **Exotel** — raw PCM16/8kHz audio over the **Voicebot applet** (configured once
  in the Exotel dashboard, pointed at `wss://…/exotel`); no per-call document, so
  it is the one provider that needs a manual setup step.

Because the three differ in wire format *and* dialect, the voice pipeline is
parameterised by a **`TelephonyCodec`** (`src/lib/voice/codec.ts`):
`MULAW_CODEC` (Twilio), `PLIVO_CODEC` (Plivo) and `PCM16_CODEC` (Exotel), chosen
by `codecForProvider()`. The voice-server upgrades the `/twilio`, `/plivo` and
`/exotel` WebSocket paths and picks the codec per connection; `live.ts` (Gemini
Live) and the Deepgram/TTS cascade both consume the codec, so no provider
hard-codes an audio format. Exotel additionally requires outbound chunks to be a
multiple of 320 bytes, which is why its frame size is 3200 rather than 160.

## 9. Deployment

Production runs on a **GCP Compute Engine VM** behind **Caddy** (auto-HTTPS),
with **pm2** managing `vaani-web` and `vaani-voice`, and **self-hosted
PostgreSQL** on the box.

The deploy flow (no CI): build locally, `tar` the project (excluding
`node_modules`, `.next`, `.git`, `.env`, and secret files), `gcloud compute scp`
to the VM, extract, `prisma db push` if the schema changed, `npm run build`, then
`pm2 restart`. Caddy routes `/twilio`, `/plivo`, `/exotel`, `/health`, and the
Twilio and Plivo webhook paths to the voice-server (`:8080`); everything else to
Next.js (`:3000`).

`vaaniyantra.com` is the canonical host: a separate Caddy site block 301-redirects
`www.vaaniyantra.com` to the apex domain (path preserved) so search engines see a
single host. The previous config is kept at `/etc/caddy/Caddyfile.bak` on the VM.

> Note: pushing to GitHub does **not** auto-deploy — production deploys are
> deliberate (tar + scp + build + restart).

**A tarball deploy never deletes.** It extracts over the existing tree, so a
file removed or renamed in the repo stays on the VM. Usually harmless — nothing
imports it — but a *rename* can be dangerous, because Node resolves
`src/lib/foo.ts` before `src/lib/foo/index.ts`: a stale file would silently
shadow the directory that replaced it and production would keep running the old
module. That is why the billing modules moved to `billing/catalogue.ts` rather
than `billing/index.ts` — a distinct name makes any stale copy inert instead of
authoritative. After the deploy that ships that move, tidy up anyway:

```bash
rm -f ~/vaani/src/lib/{billing,prepaid,credits,overage-sweep,invoice,tax,promo,rate-card}.ts
```

## 10. Operations (health, backups, rate limits, headers)

**Health checks** — point an uptime monitor (UptimeRobot, GCP uptime check, …)
at both:

- `GET /api/health` (Next.js) — returns `{ ok, db, uptimeSec }`; **503** when
  Postgres is unreachable. Unauthenticated, no sensitive detail.
- `GET /health` (voice-server, routed by Caddy to `:8080`) — plain `ok`.

**The usage ledger (shadow mode)** — every billable minute is currently written
twice: as `Call.durationSec`, which the whole billing path still reads, and as a
`UsageEvent` row, which nothing reads yet. The second write is what will meter
minutes we did not run ourselves — a reseller's platform, or a deployment in a
client's own cloud, where our own calls table is not a record of what happened.

After the deploy that ships it, run the backfill once so the ledger also covers
the calls that predate it:

```bash
npx tsx scripts/backfill-usage-ledger.ts            # dry run first
npx tsx scripts/backfill-usage-ledger.ts --apply    # safe to re-run
```

Then check that both sources agree. This is the **gate**: no organisation may be
moved onto the ledger (`Organization.usageSource = 'ledger'`) until this reports
a zero delta for it across **two consecutive closed months**.

```bash
npx tsx scripts/usage-drift.ts --month=2026-08      # exits non-zero on drift
```

The same check runs every 15 minutes as part of `scripts/check-ops-health.sh`
(the `usageLedger` block of `/api/admin/ops-health`), so a dual write that stops
working alarms instead of waiting to be noticed. A non-zero delta usually means
a call ended down a path that does not sync yet, or the backfill has not run —
but `ledger > calls` can also be correct: it is what a correction that rolled
forward out of an already-settled month looks like. Check `originMonth` on the
rows before treating it as a bug.

**Reseller minutes (OmniDimension)** — for an org whose calls run on the
reseller platform, the pull *is* the billing record; our own calls table never
saw those minutes. `scripts/omni-reconcile.sh` runs it:

```bash
bash scripts/omni-reconcile.sh                    # incremental, every 15 min
bash scripts/omni-reconcile.sh --full-last-month  # 1st and 2nd of the month
```

**Both crontab lines are required.** Their `/calls/logs` takes no date filter
and a call record carries no updated-at field, so the incremental pull can never
see a duration the provider revised after we first read it. The full re-pull is
the only thing that finds one, and it has to run *before* the overage sweep
closes the month — which is why it fires on the 1st and 2nd while the sweep
fires on the 2nd and 5th.

The sweep enforces this rather than trusting it: an org whose sub-account is
failing to reconcile, or was last polled before the month ended, comes back as
`blocked_unreconciled` and is not billed at all that run. Billing half a month
is worse than billing it late — `OverageCharge` is unique per `(orgId, month)`,
so a shortfall there is permanent.

Two things to know about their data:

- **Timestamps are ambiguous.** `time_of_call` is a local string like
  `05/04/2026 14:46:15` with no offset — 5 April or 4 May, and those are
  different billing months. The adapter marks such a record *inexact* rather
  than guessing, and the reconcile response reports `inexactAccounts`. Treat a
  non-zero count as a reason not to close the month by hand.
- **`org_balance` is the real prepaid ceiling.** It is denominated in minutes
  and enforced by the provider, so unlike our own credit gate it survives a
  deployment running in a client's cloud. Top it up with the credit transfer to
  match what the client has prepaid.

**Moving an organisation onto the ledger** — once the drift above has been zero
for that org across **two consecutive closed months**:

```bash
# what every org is on, plus last closed month's drift
curl -s https://vaaniyantra.com/api/admin/usage-source -b "<session cookie>"

# takes effect from the first month that has not started yet
curl -s -X POST https://vaaniyantra.com/api/admin/usage-source \
  -b "<session cookie>" -H 'content-type: application/json' \
  -d '{"orgId":"org_...","source":"ledger"}'
```

Founder-only and session-authenticated — deliberately not reachable with a cron
secret, because it changes what a customer is billed from.

A flip **can only take effect from a future month**, and the endpoint rejects
anything else. Half a month counted from each source either double-counts the
overlap or loses it, and `OverageCharge` is unique per `(orgId, month)` — so the
wrong figure is billed once and cannot be corrected in place, only apologised
for. **Reverting is the same call with `"source":"calls"`**, which also clears
the effective date; that is what makes this reversible per organisation rather
than a one-way door.

Months *before* the effective date keep being metered from `Call.durationSec`,
so re-running an old sweep still produces the number that customer was actually
invoiced — the same reason `PlanChange` exists for plans.

**Per-client rate cards** — the plan catalogue answers "what does the product
cost"; a `RateCard` answers "what does *this* client pay". It is an **overlay**:
`PLANS` keeps its 16 keys, the org keeps holding one, and every charge is still
stamped with it. Only the numbers are overridden, and only for the org named.

**With no rows in the table nothing changes** — `rateFor()` returns exactly what
`getEffectivePlan()` returned before it existed. Precedence is
**RateCard → the /admin plan overrides → `PLANS`**.

```bash
npx tsx scripts/set-rate-card.ts --org=<id|slug> --show          # history
npx tsx scripts/set-rate-card.ts --org=acme --price=4.2     --cost=2.8 --retainer=25000 --from=2026-10-01 --note="3 automations"
#   ↑ dry run. Add --apply to write, --wallet to also move the org onto the
#     prepaid wallet.
```

⚠ **Writing the first card for a client is the one-way door in this phase.** It
is the moment a price becomes a price somebody was quoted; repricing a live org
after that is a commercial conversation, not a column update. Cards are
effective-dated and append-only for the same reason `PlanChange` is — a card
agreed in April must not reprice March, and the writer closes the standing card
rather than editing it.

What a card changes for the monthly sweep:

- **Every minute is billed at the card rate.** A card has no included allowance,
  so `pricePerMinute` overrides both the plan's rate *and* its overage rate.
- **`retainerInr` is added and `minimumInr` is a floor** — a client who commits
  to ₹20,000 and speaks ₹12,000 of minutes is billed the commitment, not the sum
  of the two.
- **The plan allowlist no longer decides whether the org is swept.** It could
  not: an org holding a legacy `free` or `chat_*` key that has since been sold a
  card is not in that list, so it was skipped and never invoiced — silently,
  every month. A carded org is billed if its card charges anything at all.

**`Organization.billingModel`** (`legacy` | `prepaid_wallet`) states outright
whether the credit gate applies, instead of inferring it from "is this a
usage-based plan". The inference was sound only while price and plan were the
same thing, and a legacy-plan org with a card breaks it. `legacy` is the default
and reproduces today's behaviour exactly; the platform-wide switch
(`credits_required`) still has the last word.

**Margin** — what a client pays against what their minutes cost us:

```bash
npx tsx scripts/margin-report.ts --month=2026-08   # exits non-zero below cost
```

Revenue for a closed month is the charge we *raised*, including the prepaid
minutes it drew down at the price they were **sold** at
(`OverageCharge.prepaidRateInr`, weighted FIFO across the top-ups that paid for
them) — counting only the invoiced tail would report a loss on every client
whose balance covered the month. Cost is `UsageEvent.costInr` (the reseller) plus
`Call.llmCostInr` (our own pipeline). Enter the supplier's bill as a
`SupplierInvoice` row and the report cross-checks our summed cost against it; a
gap there means the per-call cost we freeze at ingest is wrong, and every margin
below it is wrong too.

**Database backups** — `scripts/backup-db.sh` does a `pg_dump` (custom format)
to `~/db-backups/`, optionally uploads to a GCS bucket (`GCS_BUCKET` env), and
prunes local copies older than `KEEP_LOCAL_DAYS` (default 14). It reads
`DATABASE_URL` from the app's `.env` automatically. Install once on the VM:

```
chmod +x scripts/backup-db.sh
crontab -e    # add:
17 2 * * * /path/to/app/scripts/backup-db.sh >> $HOME/db-backups/backup.log 2>&1
```

For off-VM safety, create the bucket once and set a 60-day lifecycle:

```
gsutil mb -l us-east1 gs://vaaniyantra-db-backups
gsutil lifecycle set scripts/gcs-backup-lifecycle.json gs://vaaniyantra-db-backups
```

Restore with `pg_restore --clean --if-exists --dbname="$DATABASE_URL" <file>.dump`.
This path is verified — `scripts/restore-drill.sh` restores the newest GCS dump
into a throwaway database and row-counts it against production, without touching
the live database. **Recovery procedures, RPO/RTO and the known gaps live in
[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md); read §0 before you need it** —
`.env` (and so `SECRET_ENC_KEY`) is in no backup, and without it a perfect
database restore still leaves every encrypted secret unreadable.

**API rate limiting** — the public `/api/v1/*` routes are limited per key
(120/min) and per IP (240 auth attempts/min) by `src/lib/rate-limit.ts` via
`requireApiAuth()` in `src/lib/api/v1.ts`. The limiter is in-process (fine for
the single-VM pm2 deployment); if the app is ever scaled to multiple
processes/hosts, replace it with a shared store (Redis/Postgres).

**Security headers** — set globally in `next.config.js` (`headers()`): HSTS,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
and a Permissions-Policy disabling camera/mic/geolocation (the app uses none
of them in the browser). If a page ever needs to be embeddable or use the mic,
relax the relevant header there.

## 11. Deployment modes — our cloud, and a client's

The same code runs in two places, and the difference is **who has root**.

| | `DEPLOYMENT_MODE` unset (default) | `DEPLOYMENT_MODE=dedicated` |
|---|---|---|
| Where | our VM, `vaaniyantra.com` | a client's own cloud |
| Admin surface | full | **every `/api/admin/*` route answers 404** |
| Database | all organisations | asserted to hold exactly one |
| Ships as | `scripts/deploy.sh` (tar + build on the VM) | a Docker image + compose file |

The mode is read at **runtime**, never at build time. That is not a style
preference: a client image is built once in CI, and an Edge-inlined value would
carry `shared` onto every client box and turn the admin guard into decoration.
It is why `requireSharedDeployment()` is the first line of each admin handler
rather than one rule in middleware, and why `tests/deploy-auth.test.ts` fails
the build if a new admin route forgets it.

### Registering a deployment

```bash
npx tsx scripts/register-deployment.ts --list
npx tsx scripts/register-deployment.ts --id=dep_vaani_cloud \
    --label="Shared cloud" --mode=shared --issue-key --apply
```

**Register our own cloud first, and let it heartbeat to itself.** The signing,
the replay check and the entitlement path then run in production, against a real
deployment, before any client depends on them — which is the whole reason Phase
7 exists as a step of its own. On the VM:

```
*/5 * * * *  cd /home/balij/vaani && npx tsx scripts/deployment-heartbeat.ts >> $HOME/deployment-heartbeat.log 2>&1
```

The key is printed **once**. It is encrypted at rest rather than hashed — an
HMAC has to be recomputed on our side — so nothing reads it back out. `--rotate`
issues a *second* key without touching the first: both verify, the box is
updated at leisure, then `--revoke=<keyId>`. Revoking before the box is updated
is what turns a rotation into an outage.

### The channel

Four routes, all under deployment signature and **never** under an `ApiKey`, so
a leaked customer key can never speak as a deployment:

| Route | For |
|---|---|
| `POST /api/deploy/v1/heartbeat` | "I am up, running image X" |
| `GET /api/deploy/v1/entitlement` | a 1-hour signed token; the install refuses to dial without one |
| `GET /api/deploy/v1/config` | its org id, poll intervals, our clock |
| `POST /api/deploy/v1/telemetry` | what it says about its own usage |

Signed as `X-Vaani-Signature: v1=<hex HMAC-SHA256 over ts.nonce.METHOD.path.sha256(body)>`,
with the deployment id, timestamp and nonce in their own headers. The body is in
the signature *by hash*, so nothing on the path can rewrite telemetry and still
verify. Clock skew over 300s is refused. Replay protection is a
`DeploymentNonce` insert — **the insert is the check**, `P2002` means "seen
before", the same arbitration `PaymentApplication` and `UsageEvent` already use.

**The channel is strictly outbound from the client.** The install polls us; we
never dial into a client network. That keeps us off their inbound firewall and
keeps us from becoming a route into it. A hard rule, not an optimisation.

### The trust boundary, stated plainly

A dedicated install is **not trusted**, because the client's ops team has root
on it. Three consequences worth reading twice:

1. **`DeploymentKey` is an identity, not a secret.** It sits in a file on their
   machine. Everything else is designed around that being true.
2. **No billing-affecting write is ever accepted from a deployment.** Telemetry
   lands as `UsageEvent` with `source: 'client_cloud'` and the metric
   **`voice.minutes.reported`** — a *different metric string* from the
   `voice.minutes` billing sums. Not a flag on the row; a different name in a
   namespace the biller does not read. That is what makes "the reseller's pull
   is billing truth" unfalsifiable rather than a convention. A client who
   under-reports changes a discrepancy report, not an invoice.
3. **The entitlement token is evidence, not enforcement.** A rooted client can
   patch the check out. Its value is that calls placed after entitlement lapses
   become a provable breach instead of an argument about whose records are
   right. Never describe it internally as a security control.

A dedicated box also never gets the platform OmniDimension key, the Cashfree
credentials, `SUPERADMIN_EMAILS` or the cron secrets — see
`FORBIDDEN_IN_DEDICATED` in `src/lib/deploy/deployment.ts`, which the compose
template is written against. The reseller key can move credits between every
client's sub-account; one client with root would be reading every other client's
minutes.

### Building and installing a client image

Images are built **in CI, on a tag**, and only after the suite passes
(`needs: ci`). A client install is a one-way door; it does not get to be the
first place a red suite is noticed.

```bash
git tag v2026.09.03 && git push origin v2026.09.03
# -> ghcr.io/<owner>/vaaniyantra-runtime:2026.09.03-<sha>
#    ghcr.io/<owner>/vaaniyantra-voice:2026.09.03-<sha>
```

Immutable tags only — never `latest`. The tag is what the heartbeat reports, and
"latest" is not an answer to "what are you running". (Docker tags cannot contain
`+`, so build metadata is joined with `-`.)

On the client's box:

```bash
cp .env.client.example .env      # then fill it in
docker compose -f docker-compose.client.yml up -d
docker compose -f docker-compose.client.yml exec web npx prisma db push
```

**The shared VM is not dockerised, deliberately.** `scripts/deploy.sh` encodes a
list of real incidents and is the only thing between a bad push and the live
site; converting it in the same change that introduces a second mechanism is the
larger risk. Client installs first; the VM migrates later, if ever.

### Putting a new client on the reseller

```bash
npx tsx scripts/provision-omni-client.ts --list-sub-accounts
npx tsx scripts/provision-omni-client.ts --org=acme --sub-account=41207 \
    --price=4.5 --cost=2.9 --apply
```

Four things have to be true together — the sub-account link, `usageSource`,
a rate card and `billingModel` — because a half-provisioned client is a client
billed wrongly. The script refuses any org that already has calls or a closed
month: moving one of those is `/api/admin/usage-source`, which allows the flip
only from a future month and only after two clean drift months.

## 12. Which pipeline runs a minute

Both, on purpose.

- **Our own Gemini Live pipeline is kept.** It runs the healthcare orgs, the
  PARE bot and every demo agent. It works, and its cost is measured to the rupee
  per call (`Call.llmCostInr`) — exactly what you want behind something you put
  in front of a stranger.
- **New clients go on OmniDimension**, where the minute is bought and resold.

Nothing branches at runtime to arrange that. `UsageEvent.source` records which
pipeline produced a minute (`vaani_voice` vs `omnidimension`) and
`Organization.usageSource` decides which record bills it. There is no global
switch to throw and no "migrate everyone" step: the two coexist indefinitely,
per organisation.

### Demo agents

One per sellable vertical, in one account's workspace, so nothing has to be sold
off a slide:

```bash
npx tsx scripts/seed-demo-agents.ts --email=you@example.com            # dry run
npx tsx scripts/seed-demo-agents.ts --email=you@example.com --apply
npx tsx scripts/seed-demo-agents.ts --email=you@example.com --list
```

Restaurant, coaching centre, interior design and lead screening (real estate has
its own older script). Ordinary `Agent` rows from `VERTICAL_TEMPLATES`, each with
a sample knowledge document and grounding rules that name `knowledge_search` — a
demo agent told to "answer only from the knowledge above", with no knowledge
block above it, is an agent that invents a price. The screener books nothing:
booking off is what exposes `record_outcome` instead of the booking tools, the
same shape PARE runs in.

Re-running updates rather than duplicates, and an omitted flag keeps what is
there — `--owner-number` most of all, where a silent reset just stops the lead
alerts. They answer on the in-app test call; point a number at one from
`/numbers` to put it on the phone.

**The prospect demo line is never touched by this script.** It is a single agent
row on a real number, converted in place for whichever business is being pitched
— converted, not recreated, because `PhoneNumber.agentId` points at the id, so a
second agent would leave the line still answering as the old bot. Each pitch gets
its own script, and the newest one is the one that is live:

```bash
npx tsx scripts/seed-befach-demo.ts --email=you@example.com --agent-id=cmt…            # dry run
npx tsx scripts/seed-befach-demo.ts --email=you@example.com --agent-id=cmt… --apply
```

- `scripts/seed-befach-demo.ts` — **current**. Befach 4X: D'Cal water treatment,
  Befach Rice and imports. Qualifies on brand + B2B/B2C, captures the lead, and
  WhatsApps the caller and the sales team. Reuses the already-approved
  `enquiry_registered` and `owner_alert` templates, so it needs no Meta review.
- `scripts/seed-pare-demo.ts` — the previous occupant (PARÉ India, wall panels
  and flooring). Kept runnable so the line can be pointed back.

Both take `--agent-id` and both replace the agent's knowledge documents rather
than adding to them: a converted bot that still carries the last brand's
documents will answer a rice question with a wall-panel spec.

---

*Questions or issues? See the [User Guide](./USER_GUIDE.md) for product behavior,
or open an issue in the repository.*
