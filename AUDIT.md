# VaaniYantra — Brutal Product Audit (2026-07-13)

Scope: full codebase read — Next.js app (`src/`), realtime voice server (`voice-server/`),
Prisma schema, billing, messaging, telephony webhooks, UI components. No code was
changed for this audit. Verified: ESLint passes; **there is no test suite at all**.

---

## 0. The one-paragraph verdict

The voice pipeline is genuinely good — Gemini Live bridging, barge-in, codec
abstraction, booking tools are solid engineering. Everything around it is built
for the founder, not for a customer. A non-technical shop owner cannot get from
sign-up to a working agent without a Twilio account, an E.164 tutorial, a Google
OAuth consent screen stuck in Testing mode, and a five-step wizard full of words
like "system prompt", "captures", and "lookahead days". Meanwhile the platform's
webhooks are unauthenticated, secrets fall back to a hard-coded encryption key,
and SMS to India ignores DLT — the market the product is aimed at. WhatsApp is
half-integrated across three different transports (Meta Cloud, Twilio, Exotel),
none of which reliably delivers, which is why confirmations silently vanish.

---

## 1. UX / flow problems (per screen, rated for simplicity 1–5; 5 = simple)

### Sign-up → first agent (rating: 2/5)
- **Hard gate: you cannot create an agent without a phone number.**
  `POST /api/agents` 400s with "Connect a phone number (Twilio) before creating
  an agent." A brand-new user's very first task is BYO-Twilio credential entry —
  the single most technical step in the product — before they've seen any value.
  The `/demo` test bot exists, but the empty-state funnel doesn't lead with it.
- **Redesign:** let anyone create an agent and test it in the browser/demo line
  immediately; require a number only at "go live" (assign number step). Flip the
  funnel: Create → Test (web) → Connect number → Live.

### Agent creation wizard (rating: 2/5)
Five steps (Basics / Voice & Language / Booking & Experts / Outcomes & Alerts /
Advanced), ~40 inputs. Problems:
- **Jargon everywhere**: "System prompt", "Temperature", "E.164 format,
  e.g. +919876543210", "captures", "outcome", "lookahead days", "slot capacity",
  "calendar ID". A salon owner does not know any of these words.
- "Outcomes & Alerts" is a whole step of template editing ({{name}}, {{time}})
  that the vertical preset already fills in correctly — 95% of users should
  never see it.
- Owner alert numbers are a free-text comma/newline field with **no phone
  validation in the UI** (validation.ts caps at `max(20)` chars, but accepts any
  string — a typo means the owner silently never gets alerts).
- The SMS/WhatsApp channel selector forces a choice the user can't evaluate
  ("WhatsApp uses the number connected under Connectors…" — circular reference
  to another page).
- **Redesign:** 3 steps max — (1) "What's your business + what should the agent
  do" (vertical + plain-language description → everything auto-seeded),
  (2) Voice & language with preview, (3) Done/Test. Everything else lives behind
  one "Advanced settings" area on the agent page. Copy in plain words:
  "Behavior prompt" → "What should the agent say and do?", drop "E.164" for
  "phone number with country code, e.g. +91 98765 43210".

### Numbers page (rating: 2/5)
- BYO Twilio/Exotel requires Account SID / auth token / subdomain / "Voicebot
  applet" — pure developer vocabulary, with the webhook-configure step exposed
  as a separate button that can be forgotten (`webhookConfigured` flag exists
  because it fails often enough to need a badge).
- The WhatsApp toggle on a number requires that "the number must be
  WhatsApp-enabled at the provider" — a Meta/Twilio-console step the product
  cannot do and barely explains. This is a support-ticket generator.
- **Redesign:** one "Connect your Twilio" flow that verifies creds, imports
  numbers, and configures webhooks in one click (code for each part already
  exists); WhatsApp toggle removed (Phase 2 of this work).

### Connectors page (rating: 3/5)
- Three different WhatsApp paths on one page (own-brand Meta Embedded Signup,
  platform pool number, legacy Twilio paste-in) plus Google plus HubSpot. The
  user has no way to know which WhatsApp option applies to them; even the
  founder memos note Meta approval is still pending, so all three are dead ends
  today. Removed/hidden in Phase 2.
- Google OAuth consent screen is in **Testing** mode — anyone who isn't a
  whitelisted test user hits a scary Google error mid-flow. Nothing in the UI
  warns about this.

### Billing (rating: 3/5)
- Rate-led plans are clear, but "overage up to 2× included" appears only in a
  403 error message after calls stop. The dashboard shows minutes but not
  "you're now in overage, this month will cost ₹X extra".

### Admin (/admin) (rating: n/a — founder-only)
- Fine for its audience, but it is the only place Cashfree/Meta/pricing config
  lives, and the overage sweep is a **manual button** — forget it and revenue
  is silently lost (or charged very late).

### Docs (rating: 3/5)
- `/docs` exists but the app never links contextually to the page that would
  unblock the user (e.g. from the Twilio connect form to the Twilio doc).

---

## 2. Bugs, errors, security issues

### Security — serious
- **S1. No signature validation on any telephony webhook.**
  `voice-server` `/api/telephony/twilio/voice` + `/status`, Next.js
  `/api/telephony/twilio/*`, `/api/telephony/exotel/*`, and
  `/api/whatsapp/twilio-inbound` accept unauthenticated POSTs. Anyone who knows
  the URL can: create phantom IN_PROGRESS calls (pollutes metering/billing),
  flip real calls' statuses via `?callId=` (the callId in the query is trusted
  and written straight to the DB), and fire `call.failed` webhooks to customer
  endpoints. Twilio signs every request (`X-Twilio-Signature`); nothing checks it.
  (By contrast, the Meta webhook *does* verify HMAC, and Cashfree verifies —
  so the team knows how; telephony was just skipped.)
- **S2. Hard-coded fallback encryption key.** `src/lib/crypto.ts` derives the
  AES key from `SECRET_ENC_KEY || 'callsera-default-dev-secret-change-me'`.
  If the env var is ever missing in prod, every BYO Twilio token, Exotel token,
  Google refresh token and WhatsApp credential is encrypted with a key that is
  public on GitHub — silently. Should refuse to start in production instead.
- **S3. Demo-user fallback in inbound routing.** `voice-server` falls back to
  `getCurrentUser()` (the seeded `demo@vaani.ai` MVP user) when a dialed number
  has no agent, and routes the live call to *that user's first active agent* —
  a cross-tenant leftover from the single-user MVP. Wrong tenant answers the
  phone. Dead code that is live.
- **S4. SMS `From` priority leaks across tenants.** `sendSms()` prefers
  `process.env.TWILIO_SMS_FROM` over the org's own configured sender, so every
  org's confirmations are sent from the platform's number using whichever
  Twilio account matched — mixing tenant identity and billing.

### Compliance
- **S5. No DLT handling for Indian SMS.** All SMS bodies are free-form
  (`renderConfirmation`, reminders, owner alerts). India (the home market)
  requires DLT-registered sender IDs + pre-approved templates; free-form
  transactional SMS via Twilio to Indian numbers is largely filtered by
  carriers. There is no DLT template ID, no sender ID config, no mention in
  docs. Confirmations "work" in dev and die in production.

### Correctness bugs
- **B1. Booking races (TOCTOU).** `book_appointment` checks capacity/free-busy,
  then creates the event — two concurrent calls can double-book the same slot
  (both for single-capacity freeBusy and the multi-slot `bookingsAtSlot` count).
  Needs a unique-ish guard (e.g. re-count inside a transaction, or a
  `@@unique([orgId, startAt, ...])`-style constraint with capacity check).
- **B2. `finalize()` marks every ended WS call COMPLETED**, even when the socket
  dropped due to an error mid-greeting; `durationSec` is wall-clock of the WS,
  not talk time, and `max(1, …)` bills a minimum even for instant failures.
- **B3. WhatsApp follow-up chat answers from the wrong agent.** It picks the
  org's *most recently updated* active agent — editing agent B changes which
  brain answers agent A's callers.
- **B4. Unhandled `req.json()`**: e.g. `POST /api/agents` (and sibling routes)
  crash to a 500 on malformed JSON instead of a 400.
- **B5. Unknown Twilio status maps to IN_PROGRESS** in `statusWebhook`'s map
  fallback (`?? 'IN_PROGRESS'`) — an unrecognized terminal status would
  resurrect a completed call.
- **B6. `reminder-dispatcher` runs only inside the voice server** — if the
  voice server is down at the reminder window, reminders are skipped forever
  (flags only guard duplicates, not misses); acceptable, but undocumented.
- **B7. Zero tests.** No test framework is even installed. The only safety nets
  are ESLint and `tsc` via `next build`.

### Dead / legacy code
- `voiceProvider` / `voiceStages` ("legacy/dormant" per schema comments), the
  entire cascade `CallSession` pipeline when `USE_GEMINI_LIVE=true` is the
  production configuration, `Call.workflowReached` (workflows were removed in
  v2), `getCurrentUser()`/`DEMO_USER_EMAIL`, `collectedData` "Phase 5B" naming.

---

## 3. Architecture smells

- **A1. Three WhatsApp transports** (Meta Cloud API, Twilio WA, Exotel WA) plus
  a "platform pool" plus a legacy paste-in config — five configuration surfaces
  for one feature that doesn't reliably deliver (Meta approval pending). Massive
  option-surface for zero working value. (Being feature-flagged off in Phase 2.)
- **A2. O(n)-decrypt reverse lookups.** `findOrgIdByCloudPhoneNumberId` and
  `findOrgIdByWhatsappFrom` decrypt every Integration row per inbound message.
  Fine at 10 orgs, dead at 10k. Needs an indexed plaintext column.
- **A3. Embeddings as JSON strings in `DocumentChunk.embedding`** with full-scan
  cosine in JS. The schema comment itself says "move to pgvector".
- **A4. No DB migrations** — `prisma db push` only. No migration history, no
  safe rollback; memory notes already record one "NEEDS db push" drift incident.
- **A5. Duplicated confirmation-rendering logic** — `renderConfirmation`
  (booking.ts) and `renderTemplate` (outcomes.ts) are two template engines with
  slightly different empty-value cleanup; reminders/cancel/reschedule build
  message strings by hand in three more places.
- **A6. Manual overage sweep** — revenue depends on the founder remembering to
  click a button monthly.
- **A7. Two servers, one Prisma schema, shared lib —** but the Next API also
  exposes `/api/telephony/*` routes that duplicate voice-server's HTTP handlers.
  Two code paths for the same webhooks = they will drift.

---

## 4. Redesign proposals (mapped to fixes)

| Problem | Proposal |
|---|---|
| Number-before-agent gate | Create agent freely; number required only to go live. Empty states lead with "Test it now" (demo/web test). |
| 5-step wizard | 3 steps: Business & goal → Voice → Test. Vertical preset fills everything; single "Advanced" area for the rest. |
| Jargon copy | Plain-language pass on every label/hint/error ("phone number with country code", "What should the agent do?", hide "temperature" entirely). |
| SMS/WhatsApp choice | Remove the choice (SMS only, Phase 2). One fewer decision + one fewer broken path. |
| Owner alert numbers | Validated phone-chips input; reject non-numbers at entry. |
| Twilio connect | One guided flow: paste SID+token → verify → import numbers → auto-configure webhooks; contextual doc link. |
| Overage visibility | Banner on dashboard + billing once `inOverage` is true, with the ₹ amount so far. |

---

## 5. What's genuinely good (credit where due)

- Gemini Live bridging with correct codec handling per provider, barge-in,
  playback-clock goodbye draining — hard problems handled well.
- Booking toolset (check/book/find/cancel/reschedule) with caller-scoped lookup.
- Encrypted secrets at rest, hashed API keys, HMAC'd outbound webhooks, SSRF
  re-validation lib, RBAC helpers — the *internal* security posture is far
  better than the *edge* (webhooks) one.
- Admin prompt preview = exact bytes the model gets. Nice.
