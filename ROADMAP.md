# VaaniYantra — Build Roadmap & Progress

> **Naming, settled 2026-08-21: the company and product are VaaniYantra**, matching
> the domain. "Callsera" survives only as the internal GCP project id, and "Vaani
> AI" only as this repo's folder name — nothing public should say either. Older
> entries below predate the rename and still use them.
>
> AI Voice Calling Platform. This document tracks the
> phased build of the SaaS platform around the existing voice engine.
>
> **Last updated:** 2026-06-27 · **Current status:** Phases 0–7 complete ✅ · **V2 product pivot COMPLETE** (all 11 items) ✅ · Phase 8 (enterprise) / 9 (marketing) next
>
> ⚠️ **Read [§0. V2 product pivot](#0-v2-product-pivot-2026-06-27--complete) first.** It supersedes parts of the
> phase history below — most importantly **Workflows were removed entirely** and the
> separate **Integrations** settings tab was removed. Sections 5b/5c (Workflow Builder)
> and the Slack/HubSpot connector batches describe code that is now dormant or deleted.

---

## 1. The big picture

We are turning a working **voice-calling MVP** into a full **multi-tenant SaaS
platform**. The voice engine (STT → Gemini → TTS over Twilio) already works and
stays running throughout. We build the platform *around* it, one phase at a
time, deploying and verifying each phase live before moving on.

**Live app:** https://vaaniyantra.com
**Live demo bot:** call **+1 662 439 4745**

---

## 0. V2 product pivot (2026-06-27) — ✅ COMPLETE

After the platform reached Phase 7, a full founder review produced an **11-item V2
list** that refocused the product on a tighter, self-serve core. All 11 are built,
deployed, and verified live.

| # | Item | What shipped |
|---|------|--------------|
| 1 | **Remove Workflows** | Workflow model / pages / API / builder all deleted; live pipeline reverted. (`Call.collectedData`/`workflowReached` columns kept dormant.) |
| 2 | **Connectors** | New **Connectors** page (Gmail, Google Drive, Calendar, WhatsApp). Connectors run **real post-call actions** — after a call an LLM decides whether to send a Gmail / WhatsApp follow-up (`src/lib/connectors.ts`, `post-call-actions.ts`). One "Connect Google" grants Calendar + Gmail + Drive. |
| 3 | **Agent create overhaul** | Describe the agent in **plain English** → LLM reframes it into a system prompt (`/api/agents/generate-prompt`). Removed voice-provider + greeting-voice pickers; Gemini Live is the default. Added **20 Gemini voices** (with notes), an **agent-type** selector (receptionist / sales / campaigning / support / general), an **auto-end-call instructions** field (registers a Live `end_call` tool), and more Indian languages (Kannada, Marathi, Bengali, Gujarati, Punjabi). |
| 4 | **Knowledge base fix + limits** | **Fixed "docs not chunked"** — root cause was Google embeddings 429-ing on the free tier and marking docs FAILED. Embeddings now default to a deterministic **local** model (Google opt-in via `USE_GOOGLE_EMBEDDINGS`). Limits: **5 docs, ≤10 MB each, ≤20 MB total.** |
| 5 | **Phone-number gating** | Agent-create fields are all visible, but you **can't create an agent without a connected phone number** (Twilio). UI banner + 400 on the API. |
| 6 | **Test / demo bot** | A `/demo` page + "Try Live Demo" nav item — call the demo number; it speaks the caller's local language by phone number. |
| 7 | **Logout** | Sign-out in the sidebar. |
| 8 | **Open sign-up** | Email **or** Google sign-in/up (Google buttons on both auth pages). |
| 9 | **Remove Integrations** | The separate Settings → Integrations tab was removed (superseded by Connectors). |
| 10 | **Env → Admin + editable system prompt** | Tunable runtime knobs (Gemini Live model / voice / silence ms, Gemini text model) and a **base system prompt** (prepended to every agent) are now edited in **Admin → System config** (`PlatformConfig`, DB > env, picked up within ~1 min, no redeploy). |
| 11 | **Pricing tiers** | Plans are now **Starter / Pro / Enterprise** (Enterprise = "talk to us", no price). Every value — price, agent / minute / workspace / campaign / doc limits — is editable in the Admin dashboard. |

**Net effect on the doc below:** Phase 5 (Workflow Builder) is **gone**; the Phase 6
Slack/HubSpot batches and the Settings → Integrations tab are **removed**; the "Free"
plan is replaced by **Starter** as the default. The voice engine, knowledge base, call
center, campaigns, billing, Stripe, and the founder Admin dashboard all remain.

---

## 2. The stack (all-Google, low-cost)

Everything runs inside Google Cloud — no external SaaS dependencies, minimal cost.

| Concern | Choice | Notes |
|---------|--------|-------|
| Hosting | **Compute Engine `e2-micro`** (us-east1) | Always-Free tier; ~$3/mo for the static IP |
| Web/TLS | **Caddy** reverse proxy | Auto HTTPS via Let's Encrypt on `vaaniyantra.com` (+ `34.138.86.231.sslip.io`) |
| App | **Next.js 14** (App Router) | Dashboard + REST API |
| Realtime | **voice-server** (Node WebSocket) | Twilio media streams; same VM |
| Database | **PostgreSQL 15** (self-hosted on the VM) | Migrated off SQLite |
| Auth | **Firebase Authentication** | Email/password + Google; same project as compute (`callsera`) |
| Process mgr | **pm2** | Auto-restart, boot persistence |
| AI | **Gemini** (brain), **Google Cloud / Deepgram** (speech) | Per-call usage cost |

**Cost summary:** ~$3/month infrastructure + variable AI/speech usage per call.

---

## 3. Phase overview

| Phase | Theme | Status |
|-------|-------|--------|
| **0** | **Foundation** — auth, multi-tenancy, roles, settings | ✅ **Done** |
| **1** | **Agent depth + Phone management** | ✅ **Done** |
| **2** | **Knowledge Base** (PDF/DOCX/crawl/FAQ/vector search) | ✅ **Done** |
| **3** | **Call Center + Analytics** (live calls, transcripts, sentiment, reports) | ✅ **Done** |
| **4** | **Outbound Campaigns** (contact lists, scheduling, retries) | ✅ **Done** (4A+4B+4C deployed) |
| ~~**5**~~ | ~~Workflow Builder~~ | ❌ **Removed in V2** (see §0) |
| **6** | **Connectors** (Gmail/Drive/Calendar/WhatsApp post-call actions) + webhooks | ✅ **Done** (webhooks + Connectors; Slack/HubSpot dormant) |
| **7** | **Billing & Subscriptions** + Founder Admin dashboard | ✅ **Done** (7A plans/usage + 7B Stripe + Admin) |
| **V2** | **Product pivot** (11-item refocus — see §0) | ✅ **Done** |
| **8** | **Enterprise** (audit polish, white-label, SSO, security) | ⬜ Planned |
| **9** | **Marketing website** (landing, pricing, docs, blog) | ⬜ Planned (parallel) |

---

## 4. Phase 0 — Foundation ✅ (complete)

The spine that every later module depends on. All built, deployed, and verified
live end-to-end.

### What was delivered

- **PostgreSQL migration** — moved from SQLite to self-hosted Postgres on the VM,
  without breaking the live bot.
- **Multi-tenancy** — `Organization → Workspace → data`. Every agent, number,
  document, and call is scoped to a workspace. A new sign-up gets its own
  organization + default workspace, fully isolated from others.
- **Authentication (Firebase)** — email/password sign up / sign in / sign out,
  password reset, session cookies, route protection.
- **Roles & permissions (RBAC)** — OWNER › ADMIN › MEMBER › VIEWER, enforced on
  every page, nav item, and API route.
- **Org / Workspace switcher** — sidebar dropdown to switch workspaces, switch
  between organizations you belong to, and create new workspaces.
- **Team & invitations** — members list, change roles, remove members
  (last-owner protected), and **shareable invite links** with an accept flow.
- **API key management** — generate `ck_live_…` keys (hashed at rest, shown once),
  revoke them, and a public REST API (`/api/v1/agents`) authenticated by key.
- **Account & Organization settings** — edit profile, reset password, rename the
  org, set a brand color (white-label groundwork).
- **Audit logging** — records key actions (agent/member/key/org changes) with
  actor, IP, and details; viewable by admins.

### How to use it (in the live app)

1. **Sign up / in** at `/sign-up` or `/sign-in`.
2. **Switch / create workspaces** from the dropdown at the top of the sidebar.
3. **Team** (sidebar → Team): invite teammates → copy the invite link → they join
   after signing in with that email.
4. **Settings** (sidebar → Settings) has tabs:
   - **Account** — name, email, password reset
   - **Organization** — name, brand color, member count
   - **API Keys** — create/revoke keys (Admin+)
   - **Audit Log** — recent activity (Admin+)

### Key files (for reference)

```
prisma/schema.prisma            Org, Workspace, Membership, Invitation, ApiKey, AuditLog
src/lib/auth/
  permissions.ts                Role → permission matrix (RBAC)
  context.ts                    requireWorkspace() — resolves user/org/workspace/role
  session.ts                    Firebase ID-token session cookies
  provision.ts                  First-login org + workspace creation
src/lib/audit.ts                audit() helper
src/lib/api-keys.ts             key generation + authenticateApiKey()
src/app/(auth)/                 sign-in, sign-up
src/app/(app)/                  authenticated dashboard (sidebar shell)
  team/                         team management
  settings/                     account / organization / api-keys / audit tabs
src/app/api/                    workspaces, members, invitations, keys, account,
                                organization, audit, v1 (public)
src/app/invite/[token]/         invitation accept page
src/middleware.ts               route protection
```

### Notes & current limitations

- **Invitations are shareable links** (you copy & send them). Automatic invite
  *emails* arrive in Phase 6 (Integrations) once an email provider is wired up.
- **Sessions** use Firebase ID tokens (~1h) refreshed automatically client-side.
- The seeded demo agents live in a separate "Demo Organization"; new users start
  with an empty workspace (correct SaaS behavior).

---

## 5. Phase 1 — Agent depth + Phone management (in progress)

### Delivered first (founder priorities) — 2026-06-25 ✅

These founder-requested features kicked off Phase 1. All per-agent, configurable
from the agent form, and wired through the live voice engine.

- **Multiple voice providers** — **Google Cloud TTS is built-in** (always
  available, all languages). **Deepgram, Gemini, and ElevenLabs** are
  *integrations* (selectable, but only active once their API key is configured).
  Chosen per-agent; any integration failure falls back to Google so a call never
  goes silent. (`src/lib/voice/tts.ts`)
- **Hybrid language (English + local mix)** — a "Language mode" option. When set
  to *Hybrid*, the agent code-switches naturally (e.g. Hinglish) instead of
  speaking one language. Implemented as a prompt-style instruction threaded
  through both the cascade and Gemini Live pipelines.
- **Location-based language picking** — *Auto* language mode resolves the spoken
  language from the **caller's phone number** (country/dialing code → language),
  falling back to the agent's configured language when unknown. The resolved
  language drives STT, the LLM, and TTS for that call, and is saved on the call
  record. (`languageForCaller()` in `src/lib/constants.ts`)

> A fourth founder request — an optional **typing sound** during the think gap —
> was built but **removed on 2026-06-25** at the founder's request. (It only ran
> on the cascade pipeline; the live bot uses Gemini Live, where there's no
> discrete think gap to fill.)

Key files: `prisma/schema.prisma` (Agent: `languageMode`, `voiceProvider`),
`src/lib/constants.ts`, `src/lib/voice/{tts,conversation,live}.ts`,
`voice-server/index.ts`, `src/components/AgentForm.tsx`, `src/lib/validation.ts`.

### Delivered next (agent behavior) — 2026-06-25 ✅

A second batch of per-agent settings, deployed live. Configurable in the agent
form; wired through both the cascade and Gemini Live pipelines.

- **Business hours + after-hours** — per-agent weekly schedule with a timezone.
  Inbound calls outside hours hear an after-hours message and hang up (handled at
  the Twilio answer webhook, before the voice engine connects).
  (`isWithinBusinessHours()` in `src/lib/agent-behavior.ts`)
- **Fallback responses** — a message the agent uses when unsure / can't help,
  injected into the system prompt (`fallbackInstruction()`).
- **Custom variables** — per-agent `{{key}}` values templated into the system
  prompt and greeting at call time (`applyVariables()`).
- **Call transfer to a human** — when the caller asks for a person (configurable
  trigger phrases), the live Twilio call is redirected to `<Say>` + `<Dial>` a
  number. New `redirectCall()` on the telephony adapter.

Key files: `src/lib/agent-behavior.ts`, `src/lib/adapters/telephony/*`
(`redirectCall`), `voice-server/index.ts`, `src/lib/voice/{conversation,live}.ts`,
`AgentForm.tsx`, agent API + validation. Agent cols added: `businessHours`,
`afterHoursMessage`, `fallbackMessage`, `transferEnabled`, `transferNumber`,
`transferMessage`, `transferTriggers`, `variables`.

### Delivered next (phone-number management) — 2026-06-25 ✅

The phone-number half of Phase 1, deployed live.

- **Connect / manage numbers** — add manually, auto-provision, or **import an
  existing number from the Twilio account** ("Find numbers in my Twilio account").
- **Point webhook to platform** — one click sets a Twilio number's inbound voice
  webhook to our server so calls actually reach the agent
  (`configureNumberWebhook`); a badge shows whether it's configured.
- **Assign to agents + caller-ID** — assign an agent per number; set a caller-ID
  friendly name.
- **Inbound routing + forwarding** — toggle inbound on/off per number, and
  optionally **forward inbound calls straight to another number** (a human / call
  centre) via `<Dial>`, bypassing the AI. Honored in the voice-server webhook.
- **Per-number analytics** — total calls, completed, avg duration, last-call date
  on each number (Prisma `groupBy`).

Key files: `src/lib/adapters/telephony/*` (`listAccountNumbers`,
`configureNumberWebhook`), `src/app/api/numbers/*` (+`available`, `[id]/configure`),
`voice-server/index.ts` (routing/forwarding), `src/components/NumbersManager.tsx`.
PhoneNumber cols added: `callerIdName`, `forwardTo`, `inboundEnabled`,
`webhookConfigured`.

### Delivered last (multi-voice + integration credentials) — 2026-06-25 ✅

The closing two items of Phase 1, deployed live. **Phase 1 is now complete.**

- **Multi-voice agents** — assign a different voice to the **greeting** and
  **closing** stages of a call; the main body uses the agent's primary voice.
  Closing lines are auto-detected (sign-off phrasing). Configured with two
  optional selects in the agent form; applies on the cascade pipeline.
  (`voiceForStage()` / `isClosingSentence()` in `src/lib/agent-behavior.ts`,
  `Agent.voiceStages` JSON, voice-server stage resolution.)
- **Per-workspace integration credentials** — customers add their **own** provider
  API keys (Deepgram / ElevenLabs / Gemini / Google Cloud) under
  **Settings → Integrations**, instead of relying on server env vars. Keys are
  **encrypted at rest (AES-256-GCM)**, shown only as a masked `…1234` after
  saving, and can be enabled/disabled or removed. They're resolved per-org at
  call time and used by the voice/speech pipelines, with a clean fallback to
  the built-in Google voice. (`Integration` table, `src/lib/crypto.ts`,
  `getOrgCredentials()` in `src/lib/integrations.ts`, `/api/integrations`,
  `IntegrationsManager.tsx`. RBAC: `integration:read` / `integration:manage`.)

> Note: multi-voice and customer Gemini keys apply on the **cascade** pipeline.
> The live demo bot runs Gemini Live (one native-audio voice per call).

**Carried into Phase 2:** richer knowledge-base connections for agents.

---

## 5b. Phase 2 — Knowledge Base ✅ (complete)

Built on the existing RAG MVP (chunk → **Google `text-embedding-004`** →
cosine retrieval, injected into both voice pipelines per agent). Shipped in
three deployed batches on 2026-06-25.

- **Document parsing (2A)** — upload **PDF** (`pdf-parse`/pdfjs) and **Word
  `.docx`** (`mammoth`) in addition to text files; parsers are dynamically
  imported and kept out of the route bundle. Documents now carry a
  `sourceType` (File / Website / FAQ / Text) shown as a badge.
- **Website crawl (2B)** — **Add from URL**: we fetch a public page, strip
  boilerplate (cheerio) to readable text, and ingest it; URL docs show the
  source link and a **Re-crawl** button to refresh. **SSRF-guarded** — the
  crawler resolves the host and refuses localhost, private ranges, and the
  cloud metadata IP (`169.254.169.254`), so it can't be turned against the VM.
- **FAQ builder (2C)** — author structured **Q&A** entries in-app (add/edit/
  remove rows); each pair is embedded as its own chunk for precise retrieval,
  and the FAQ stays editable (`Document.faqItems`).

All sources land in the same `Document`/`DocumentChunk` store and are linked to
agents exactly as before, so retrieval "just works" across files, sites, and
FAQs. **Deferred:** pgvector (in-memory cosine is fine at current volume) and
moving large-file ingestion to a background queue (currently synchronous).

Key files: `src/lib/rag/{ingest,web,embeddings,retrieve}.ts`,
`src/app/api/knowledge/{route,[id]/route,faq/route}.ts`,
`src/components/{KnowledgeManager,FaqEditor}.tsx`. New `Document` columns:
`sourceType`, `sourceUrl`, `faqItems`. New deps: `pdf-parse`, `mammoth`,
`cheerio` (installed on the VM).

---

## 5c. Phase 3 — Call Center + Analytics ✅ (complete)

Built on the existing dashboard / call history / call detail (summary +
transcript + recording + live auto-refresh). Shipped in three deployed batches
on 2026-06-25.

- **Sentiment + topics (3A)** — at call end, a single LLM pass now returns the
  summary **plus** the caller's sentiment (Positive / Neutral / Negative + a
  −1..1 score) and key topics. Shown as a badge on the call detail and history
  list, topic chips on the detail, and a sentiment breakdown on the dashboard.
  (`analyzeCall()` in `src/lib/voice/conversation.ts`; new `Call` columns
  `sentiment`, `sentimentScore`, `topics`.)
- **Live call center (3B)** — a new **Live Calls** page monitors every
  in-progress call in the workspace (direction, status, agent, caller, a
  ticking elapsed timer, and the latest transcript lines), auto-refreshing
  every 3s. (`src/app/(app)/live/page.tsx`, `LiveElapsed.tsx`.)
- **Reports & analytics (3C)** — a **Reports** page with a date-range selector
  (7 / 30 / 90 days / all), headline stats, a **caller-sentiment distribution**,
  a **call-outcome** breakdown, and a **per-agent table** (calls, completed,
  avg duration, sentiment). **CSV export** of all calls in the range. Call
  History also gained **agent / status / direction filters**.
  (`src/app/(app)/reports/page.tsx`, `src/app/api/reports/export/route.ts`,
  `src/lib/reports.ts`.)

Sentiment is generated by the same LLM provider used for summaries, so it works
on both the cascade and Gemini Live pipelines (analysis runs at call end over
the stored transcript). **Deferred:** real-time websocket push for Live Calls
(currently 3s polling) and scheduled/emailed reports.

---

## 5d. Phase 4 — Outbound Campaigns 🚧 (in progress)

Turns the existing one-off outbound-call path (`/api/calls/outbound` → telephony
adapter → voice-server) into managed **campaigns**: import a contact list, dial
it with an agent on a schedule, paced and retried. Shipping in three batches.

### Batch 4A — Contact lists & campaign CRUD ✅ (deployed)

The foundation: campaigns can be created, configured, and filled with contacts,
and their lifecycle managed. **No live dialing yet** (that's 4B).

- **Data model** — `Campaign` (agent, caller-ID number, status, `scheduledAt` +
  timezone-aware `callWindow`, pacing `maxConcurrent`/`callsPerMinute`, retry
  `maxAttempts`/`retryDelayMinutes`) and `CampaignContact` (phone, name,
  per-contact `{{variables}}`, status, attempts, `nextAttemptAt`, last outcome).
  `Call` gained `campaignId`/`campaignContactId` links.
- **Contact import** — paste a plain number list **or** CSV/TSV with headers;
  a `phone` column is required, `name` is recognized, and every other column
  becomes a per-contact `{{variable}}`. Parsed/de-duped client-side with a
  preview, normalized to E.164, then bulk-inserted (dupes skipped).
- **Lifecycle controls** — start / pause / resume / cancel with guarded state
  transitions (DRAFT → SCHEDULED/RUNNING → PAUSED → COMPLETED/CANCELLED).
- **UI** — a **Campaigns** nav item, list (status + progress bars), a create
  form (agent, caller-ID, schedule, calling window, pacing, retries), and a
  detail page (progress, controls, contact import, contacts table) that
  live-polls while running.
- **RBAC** — `campaign:read` (VIEWER+) / `campaign:write` (MEMBER+).

Key files: `prisma/schema.prisma` (`Campaign`, `CampaignContact`),
`src/lib/campaigns.ts` (CSV parse, phone normalize, call-window check, count
roll-up), `src/lib/validation.ts`, `src/lib/auth/permissions.ts`,
`src/app/api/campaigns/*` (`route`, `[id]/route`, `[id]/contacts/route`,
`[id]/control/route`), `src/app/(app)/campaigns/*`,
`src/components/{CampaignForm,CampaignDetail,ContactImport}.tsx`, `Sidebar.tsx`.
DB: additive `prisma db push` (two new tables + Call columns).

### Batch 4B — Dispatcher (scheduling + pacing + dialing + retries) ✅ (deployed)

A background tick inside the long-lived **voice-server** process
(`startCampaignDispatcher()`, every 15s, reentrancy-guarded). Each pass:

1. **Promotes** `SCHEDULED → RUNNING` once `scheduledAt` is reached.
2. **Reconciles** in-flight contacts from their linked `Call`'s status — the
   single source of truth that works for **both** real telephony (Twilio status
   webhook updates the Call) **and** mock mode (the simulator updates the Call
   directly), so no webhook changes were needed. Connected → `DONE`;
   `NO_ANSWER`/`BUSY`/`FAILED` → retry (re-queue `PENDING` with `nextAttemptAt`
   = now + `retryDelayMinutes`, while `attempts < maxAttempts`) else `FAILED`.
3. **Dispatches** new calls for RUNNING campaigns whose calling window is open,
   respecting `maxConcurrent` (in-flight CALLING count) and `callsPerMinute`
   (trailing-60s rate). Contacts are claimed `CALLING` *before* dialing so a
   slow/overlapping pass can't double-dial.
4. **Completes** a campaign once no contact is PENDING/CALLING (guarded to
   RUNNING so a user pause/cancel always wins).

Calls are placed through the same telephony path as `/api/calls/outbound`,
tagged with `campaignId`/`campaignContactId`. **Bonus:** outbound campaign calls
are **personalized** — the voice-server merges each contact's `{{variables}}`
(plus `{{name}}`) over the agent's defaults at call time, so the greeting and
prompt address the contact by name/company. (Retries — originally slated for 4C
— landed here since they share the reconciliation path.)

Key files: `src/lib/campaign-dispatcher.ts`, `voice-server/index.ts`
(`startCampaignDispatcher()` on listen; per-contact variable merge in
`loadAgent()`). Tunable: `CAMPAIGN_TICK_MS`. **Deployed & healthy** (db push OK,
dispatcher log confirmed) — but **not yet exercised with a real campaign run**;
recommended first smoke test is a small campaign (a couple of contacts) end to
end. No DB-backed local test harness exists in this repo.

### Batch 4C — Analytics & polish ✅ done

Per-campaign analytics (connect rate, total/avg attempts, last-outcome
breakdown) computed by `summarizeAnalytics()` in `src/lib/campaigns.ts`,
returned by `GET /api/campaigns/[id]` and rendered as an Analytics card on the
campaign detail page. A contacts **CSV export**
(`GET /api/campaigns/[id]/contacts/export`, with an "Export CSV" link in the
contacts table). Campaign calls are now **surfaced in Call History** — a
Campaign column linking back to the campaign, a campaign filter dropdown, and a
Campaign row on the call detail page. No schema or dependency changes; web-only
redeploy. Retry logic already shipped in 4B.

---

## 5b. Phase 5 — Workflow Builder 🚧 (5A deployed)

Design structured, drag-and-drop **call flows** ("conversation pathways") and
attach them to agents. A flow is a graph of nodes — **Start, Message, Collect,
Decision, Action, End** — drawn on a canvas. Edges are derived from each node's
`next`/`branches[].targetId`, so the node list is the single source of truth and
round-trips cleanly between the builder and the DB.

### Batch 5A — Core builder + compiler ✅ done

- **Data model:** `Workflow` (workspace-scoped, `nodes` JSON, DRAFT/ACTIVE) and
  `Agent.workflowId` (SetNull). `workflow:read`/`write` permissions.
- **Compiler:** `compileWorkflow()` in `src/lib/workflows.ts` walks the graph
  from Start and emits a numbered pathway appended to the agent's system
  instruction — so it drives **both** the cascade pipeline (`conversation.ts`)
  and **Gemini Live** (`live.ts`), with no audio-layer changes. `normalizeNodes()`
  safely coerces stored/posted JSON (drops malformed nodes).
- **API:** `/api/workflows` (+`[id]`) CRUD; `workflowId` wired into agent
  create/update.
- **Builder UI:** Sidebar "Workflows"; `/workflows` list; `/workflows/[id]`
  canvas (`WorkflowBuilder.tsx`) — draggable nodes, click-to-connect edges (SVG
  arrows), decision branch editor, node inspector, autosave, and a live
  "agent instructions preview". AgentForm gained a workflow selector.
- **Deploy:** additive `prisma db push`; web + voice-server restart.

### Batch 5B — Templates + collected data ✅ done

- **Workflow templates:** `WORKFLOW_TEMPLATES` in `src/lib/workflows.ts`
  (Appointment booking, Lead qualification, Support triage, Customer survey).
  The `/workflows` "New workflow" button (`WorkflowCreate.tsx`) now opens a
  picker — start blank or clone a prebuilt flow, then jump into the builder.
- **Collected data capture:** new `Call.collectedData` JSON. `collectFields()`
  pulls the `{variable, prompt}` of a workflow's `collect` steps; `analyzeCall()`
  extracts those values from the transcript in the *same* post-call LLM pass and
  `summarizeCall()` persists them. Surfaced as a "Collected information" card on
  the call detail page.
- **Deploy:** additive `prisma db push` (`collectedData`); web + voice restart
  (voice picks up the new `analyzeCall` via tsx).

### Batch 5C — Transfer wiring + per-node analytics ✅ done

- **Transfer action now actually transfers:** when a flow has a transfer Action
  node and the agent has a `transferNumber`, the Live session registers a
  `transfer_to_human` function tool; when the model calls it (on reaching the
  transfer step), `live.ts` redirects the call via the existing `redirectCall`
  telephony path. Guarded — only active for transfer-capable workflows; if the
  model never calls it, behavior is unchanged. (Gemini Live only, which is what
  prod runs.)
- **Per-node analytics:** new `Call.workflowReached` JSON. `analyzeCall()` infers
  which step IDs the conversation reached (validated against the flow's nodes) in
  the same post-call LLM pass; the workflow builder shows "N of M reached" on
  each node from the workflow's analyzed calls.
- **Deploy:** additive `prisma db push` (`workflowReached`); web + voice restart.

> Not yet exercised with a real transfer call — recommend a test call on a
> transfer-workflow agent (with a `transferNumber` set) to confirm the handoff. 

---

## 5c. Phase 6 — Integrations 🚧 (6A webhooks deployed)

Connect Callsera to external systems. Webhooks are the foundation (Slack, CRM,
Zapier/Make all consume them); later batches add first-class connectors.

### Batch 6A — Outbound webhooks ✅ done

- **Model:** `Webhook` (workspace-scoped: `url`, `events[]`, `secret`, `enabled`,
  last-delivery status). Reuses `integration:read`/`manage` RBAC (ADMIN+).
- **Dispatcher** `src/lib/webhooks.ts`: HMAC-SHA256 signing
  (`X-Callsera-Signature`), payload builder, `dispatchCallEvent()` with a 6s
  timeout and an **SSRF guard** (`src/lib/net/ssrf.ts`, extracted+shared — blocks
  localhost / private ranges / GCP metadata). Records last status / failure count.
- **Events:** `call.completed` (dispatched from both finalize paths — Live +
  cascade; rich payload with summary, sentiment, collected data, recording URL)
  and `call.failed` (from the Twilio status webhook on failed/busy/no-answer).
- **API:** `/api/webhooks` (+`[id]`, `[id]/test`). **UI:** Settings → Webhooks
  tab (`WebhooksManager.tsx`) — add/edit/enable, reveal signing secret, send a
  test delivery, see last-delivery status.
- **Deploy:** additive `prisma db push` (`Webhook`); web + voice restart.

### Batch 6B — Slack connector ✅ done

Reuses the 6A webhook infra via a `Webhook.type` (`generic` | `slack`). Slack
webhooks point at a **Slack Incoming Webhook URL** (no OAuth) and receive a
**Block Kit–formatted** message — header, agent/direction/number/duration,
sentiment emoji, summary, and collected data — instead of the raw signed JSON.
`deliver()` branches on type (Slack body, no HMAC). The Webhooks tab gained a
Generic/Slack destination toggle with Slack-specific help; the signing secret is
hidden for Slack. **Deploy:** additive `prisma db push` (`type`); web + voice
restart.

### Batch 6C — Google Calendar ✅ done

OAuth "Connect with Google" → auto-create a calendar event when a caller books
an appointment.

- **OAuth flow** (`src/lib/google-oauth.ts`, plain fetch — no SDK): connect →
  consent → callback exchanges the code, stores the **refresh token** encrypted
  in the `Integration` table (provider `googleCalendar`). CSRF-protected via a
  state cookie. Access tokens are minted on demand from the refresh token.
- **Calendar** (`src/lib/calendar.ts`): list writable calendars (picker),
  create events, and `maybeCreateCalendarAppointment()` — on a completed call
  (gated on a connected calendar, so no cost otherwise) a focused LLM pass
  extracts any booked appointment (resolving relative times against the call
  time) and creates the event.
- **API:** `/api/integrations/google/{connect,callback,calendars}` +
  status/PATCH/DELETE. **UI:** Settings → Calendar tab (`CalendarManager.tsx`) —
  Connect button, connection status, calendar picker, disconnect.
- **Setup required:** an admin registers a Google OAuth client (redirect URI
  `…/api/integrations/google/callback`, Calendar scope) and sets
  `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in the VM env. Until
  then the UI shows "not set up". No schema change (reuses `Integration`).
- **Setup status (2026-06-29):** ✅ OAuth client created, env vars set on the VM
  (`vaani-web` restarted + verified), required APIs enabled (Calendar, Gmail,
  Drive). The unified Google connector (Calendar **+ Gmail-send + Drive**) shares
  this one client; each workspace connects its own Google account (refresh token
  stored per-org). **The consent screen is in "Testing" mode** → only Google
  accounts added under *Test users* can connect (fine for founder + pilot users).
  ⚠️ **Before public launch:** publish the consent screen + pass **Google app
  verification** — required because the scopes are sensitive/restricted (Gmail/
  Calendar/Drive); it's the slow part (privacy policy, homepage, possible security
  assessment), so start it early. Until verified, arbitrary customers can't connect.

### Batch 6D — HubSpot CRM push ✅ done

On a completed call, if the workspace has a HubSpot **Private App token**
connected, `pushCallToCrm()` (`src/lib/crm.ts`) upserts the caller as a Contact
(by phone) — mapping collected name/email/company — and attaches a Note with the
call summary, sentiment, collected data, and recording link. **No LLM** (uses
already-captured data), so it works on the free-tier key. HubSpot is added to
`INTEGRATION_PROVIDERS`, so it appears in the existing **Settings → Integrations**
tab (paste the token, encrypted at rest). Wired into both finalize paths. No
schema change.

**Next (6E+ planned):** WhatsApp (Twilio post-call confirmations), Salesforce; a
`WebhookDelivery` log + retries.

---

## 5d. Phase 7 — Billing & Subscriptions 🚧 (7A deployed)

### Batch 7A — Plans, usage metering & limits ✅ done

- **Plans** are a code catalogue (`src/lib/billing.ts`): Free / Starter / Pro,
  each with limits (agents, workspaces, call-minutes/mo, campaigns, knowledge
  docs) + features. `Organization.plan` carries the key (default `free`).
- **Usage metering:** `getUsage(orgId)` computes current usage from existing data
  (no separate usage table) — agents, workspaces, call minutes this month,
  campaigns, docs.
- **Limit enforcement:** `checkCreateAllowed()` gates agent / workspace / campaign
  creation (403 with an upgrade message at the limit). Free limits are
  intentionally generous so building/testing isn't blocked.
- **UI:** Settings → Billing tab (`BillingManager.tsx`) — usage meters, plan
  cards, and an owner-only plan switch (`billing:manage`).
- **Deploy:** additive `prisma db push` (`Organization.plan`).

> **Payments are deliberately NOT here.** Actual money collection needs a payment
> processor (Stripe) — the one place the "all-Google, no external SaaS"
> constraint can't hold. 7A is the plan/usage/enforcement scaffold; the plan
> switch is self-service for now.

### Batch 7B — Stripe payments ✅ done

Real subscriptions via the **Stripe REST API** (plain `fetch`, no SDK — like the
Calendar/HubSpot integrations). Stripe keys live in the **admin dashboard**
(`PlatformConfig`): secret key + webhook secret (encrypted) + per-plan Price IDs.

- **Checkout:** `/api/billing/checkout` creates a Stripe Checkout Session
  (subscription mode) for the chosen plan; the Billing page "Upgrade" button
  redirects to it.
- **Webhook:** `/api/billing/stripe/webhook` (public, raw-body, HMAC-verified via
  node `crypto`) syncs `Organization.plan` on `checkout.session.completed` /
  `customer.subscription.updated|deleted` (+ `stripeCustomerId`/`subscriptionId`).
- **Portal:** `/api/billing/portal` opens the Stripe customer portal to
  manage/cancel.
- **Graceful degradation:** when Stripe isn't configured, the Billing page falls
  back to the 7A self-service plan switch.
- **Deploy:** additive `prisma db push` (Stripe cols); web-only restart.

> **Founder setup to activate:** create products/prices in Stripe, add an endpoint
> for `…/api/billing/stripe/webhook`, then paste the **secret key**, **webhook
> signing secret**, and **Price IDs** into Admin → Stripe payments.

**Next (7C, optional):** invoice history view; usage-based metered billing.

### Founder / Platform Admin dashboard ✅ done

A single super-admin (the founder, by `SUPERADMIN_EMAILS` env) gets a `/admin`
area — gated server-side, with a sidebar link shown only to them — for the
"needs action from me" things:

- **Platform Gemini key** — set/rotate the API key from the UI (stored encrypted
  in `PlatformConfig`); `getGeminiApiKey()` resolves *platform key > env* (cached
  60s, env fallback) and is wired into the LLM provider + Live pipeline, so a key
  swap takes effect on new calls within ~1 min **with no SSH/redeploy** (fixes
  the recurring rotation pain).
- **Plan pricing** — edit plan prices (and limits) live; stored as overrides in
  `PlatformConfig`, merged by `getEffectivePlan()`.
- **Organizations** — see all tenants + change any org's plan.
- **Platform stats** — orgs / users / workspaces / agents / calls + minutes this
  month.

Key files: `src/lib/platform.ts`, `src/app/(app)/admin/*`,
`src/components/AdminDashboard.tsx`, `/api/admin/*`. New model `PlatformConfig`
(key/value, encrypted for secrets). Set `SUPERADMIN_EMAILS` on the VM to grant
access.

---

## 5e. Post-v2 UX/feature batch ✅ done (deployed 2026-06-29)

Five fixes from a founder bug review. All shipped in one deploy (additive
`prisma db push` — `TwilioAccount` + `PhoneNumber.twilioAccountId`; both web and
voice restarted because the live pipeline changed).

### 1 — Connect Twilio (bring-your-own, multiple accounts)
Customers can now connect their **own** Twilio account(s) with their credentials
instead of relying on the platform's single env account. New `TwilioAccount`
model (per-workspace, multiple, `authToken` encrypted at rest, one `isDefault`)
and `PhoneNumber.twilioAccountId`. `src/lib/telephony-accounts.ts` centralises
CRUD + provider resolution (`providerForNumber` / `providerForNumberId` /
`resolveProvisioningAccount`); credentials are **verified against Twilio** before
saving. `TwilioProvider` ctor now takes optional creds (env fallback). UI: a
"Connect Twilio" card + account picker in `NumbersManager`. Provision, import,
"find numbers", webhook config, outbound calls, campaigns, and in-call transfers
are all account-aware. Numbers with no account fall back to the env Twilio.

### 2 — Voices: gender + audio preview
The 20 Gemini Live voices already carried Indian display names; added a **gender
chip** and a **▶ preview** button in the agent voice picker
(`src/components/VoicePreview.tsx`). New `/api/voices/preview?voice=<id>`
synthesizes a short WAV via the Gemini TTS model, cached in-process, with a
graceful 🔇 fallback when synthesis is rate-limited (free-tier 429).

### 3 — Upgrade in sidebar
Already in code (`Sidebar.tsx`, "⚡ Upgrade plan" → `/settings/billing`); the
founder was seeing an older build. Now live.

### 4 — Exact prompt & parameters in Admin
Prompt assembly extracted into a single shared composer
(`src/lib/voice/prompt.ts` · `composeSystemInstruction`) used by **both** the
live pipeline and a new `/api/admin/prompt-preview`, so the Admin "**Show exact
prompt & parameters**" button renders the literal `systemInstruction` text + the
full config object (model, voice, temperature, silence, sensitivities) — and
can't drift from what the model actually receives.

### 5 — Demo bot is now the platform's assistant
`src/lib/demo-agent.ts` builds a Callsera-knowledge persona ("Aanya") from live
billing/constants data (pricing, capabilities, supported languages). `live.ts`
swaps it in when the dialled number is the demo line (`isDemoNumber`, matches
`TWILIO_CALLER_ID`). The `/demo` page copy was updated to match.

> **Verify-live (needs a real call/login):** voice preview audio depends on a
> working Gemini TTS key (free tier may 🔇); call the demo number and ask about
> pricing/languages to confirm the new persona.

---

## 5f. "Sunrise Light" theme ✅ done (deployed 2026-06-29)

Flipped the whole app from the original cold near-black dark theme to a **warm
light theme** ("Sunrise Light"), chosen from three options for the most positive,
optimistic feel. Web-only deploy (no schema change → only `vaani-web` restarted,
no call blip). Verified live across Dashboard, Agents, Numbers, Billing, and
Admin (incl. the exact-prompt preview).

**Palette** (`tailwind.config.ts`): `bg #faf8f4` (warm cream) · `surface #fff` ·
`surface-2 #f3f0ea` · `border #e7e1d6` · `muted #8a8576` · **`ink #2c2a33`**
(primary text) · **`ink-soft #56535e`** (secondary) · `primary #ff6b53` (coral,
hover `#f5543d`, soft `#ffe7e1`) · `accent`/`success #10b981` (green) ·
`danger #e54860` · `warning #e8920c`.

**Conventions (important for future UI work):**
- Body text uses **`text-ink` / `text-ink-soft`, never `text-white`** — the dark
  theme's ~219 `text-white` usages were bulk-replaced. `text-white` is now
  reserved only for labels on **solid** colored buttons (`bg-primary`/`bg-accent`).
- Active nav = `bg-primary-soft text-primary` (coral on light-coral tint).
- Cards get `shadow-sm` (light themes need shadow for depth). The `Spinner` uses
  `border-current` so it's visible on both coral buttons and light surfaces.
- `globals.css` `:root` is `color-scheme: light`; body bg cream, text ink; light
  scrollbars. Tailwind-default status text (`text-red-300`/`green-300`) darkened
  to `-600`/`-700` for contrast on light backgrounds.

---

## 6. How deploys work (reference)

**Use `scripts/deploy.sh` on the VM.** It encodes every step and trap below,
health-gates both services and rolls back automatically on failure:

```bash
gcloud compute ssh vaani-vm --zone us-east1-b
bash ~/vaani/scripts/deploy.sh                 # deploy the current branch
bash ~/vaani/scripts/deploy.sh --ref my-branch # a specific ref
bash ~/vaani/scripts/deploy.sh --dry-run       # build + verify, don't swap
bash ~/vaani/scripts/deploy.sh --rollback      # restore the previous build
```

It also takes a pre-deploy database backup and refuses to continue if that
fails. The rest of this section is the reasoning the script implements — read it
before changing the script.

**Build on the VM.** A locally-built `.next` is NOT portable here, so the old
"build locally and ship `.next`" flow this section used to describe cannot work:
Turbopack bakes a content-hashed reference to the resolved Prisma client
(`@prisma/client-<hash>`) into the server chunks, and a dev machine generates
different Prisma engines than this Linux box. Ship a local build and every route
dies at startup with `Cannot find module '@prisma/client-<hash>'`. Verified the
hard way on 2026-08-09.

The `e2-micro` *can* compile Next.js alongside Postgres — it takes ~21 min on the
1 shared vCPU and leans on swap, but it completes. Build in a SEPARATE directory
so production keeps serving from its own `.next` throughout:

1. `tar` the source (exclude `node_modules`, `.next`, `.git`, `.env`, `*.csv`)
   and `gcloud compute scp` it up — the link is ~3 MB/s, so a couple of MB is
   seconds, not the "slow/flaky" this section used to warn about
2. Unpack to `~/vaani-build`; `cp -al ~/vaani/node_modules` to hardlink deps
   (a **symlink** fails — Turbopack rejects one pointing outside the project
   root); copy `.env` in, since `next build` inlines `NEXT_PUBLIC_*`
3. `NODE_OPTIONS="--max-old-space-size=700" npx next build` — the cap makes the
   OOM killer prefer the build over the live server. Use `next build`, not
   `npm run build`: the npm script runs `prisma generate` first, which rewrites
   the generated client the *running* build depends on, breaking rollback too
4. Verify the artifact (`BUILD_ID`, `server/app`, the routes you just added)
   **before** touching production
5. Refresh source in `~/vaani` (voice-server runs the TypeScript via `tsx`, so
   source matters at runtime), `prisma db push` only if the schema changed
6. Swap: `mv .next .next.prev && mv ~/vaani-build/.next .next`
7. `pm2 restart vaani-web vaani-voice`, then poll `/api/health` **and**
   `:8080/health` — roll back by restoring `.next.prev` if either fails

The voice bot stays up; only a brief restart blip during each deploy.

---

## 7. Quick reference

| Item | Value |
|------|-------|
| App URL | https://vaaniyantra.com (canonical; `www` 301s to apex) |
| Demo phone | +1 662 439 4745 |
| GCP project | `callsera` (project number `759068589507`) |
| VM | `vaani-vm` · `e2-micro` · `us-east1-b` · static IP `vaani-ip` = `34.138.86.231` |
| App path on VM | `/home/balij/vaani` (pm2 `vaani-web` :3000, `vaani-voice` :8080) |
| DB | PostgreSQL 15 on the VM (`vaani` database, role `vaani`) |
| Auth | Firebase Authentication (email/password + Google) · project `callsera` |
| Backups | nightly `pg_dump` 02:17 → `gs://vaaniyantra-db-backups` (60-day lifecycle) |
| Recovery | see [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md) |

---

*This file is updated as each phase completes. Next update: after Phase 8 (Enterprise).*
