# Vaani AI — AI Voice Calling Platform

Create and manage AI phone agents that handle **inbound and outbound calls** in
English and Indian languages (Hindi, Telugu, Tamil, Malayalam). Define an
agent's behavior with a prompt, pick a voice and language, attach knowledge-base
documents, connect a phone number, and place or receive calls. During a call the
agent listens, retrieves relevant knowledge, and responds in real time.

A production platform with a modern dashboard and a scalable, provider-agnostic
architecture — it runs **fully offline with mock providers** (no paid API keys
required) and goes live by dropping in real keys. It began as the MVP the notes
further down describe; the guides above are the current reference.

> Brain: **Google Gemini 2.5 Flash** · Speech: **Google Cloud STT/TTS** ·
> Telephony: **Twilio, Plivo & Exotel** · Stack: **Next.js (App Router) + Postgres/Prisma**

---

## 📚 Documentation

- **[User Guide](./docs/USER_GUIDE.md)** — using the platform (agents, numbers,
  connectors, appointments, billing).
- **[Developer Guide](./docs/DEVELOPER_GUIDE.md)** — REST API, webhooks,
  architecture, local dev, and deployment.

> Note: the sections below are the original MVP notes and are partly superseded
> by the guides above (the platform now has Firebase auth, 6-tier billing, team
> management, HubSpot CRM, Plivo + Exotel telephony, a public API, and webhooks).

---

## Features

- **Agent management** — create/edit/delete agents; behavior prompt, greeting,
  language, voice, direction (inbound/outbound/both), creativity, call limits.
- **Multilingual** — English (India), Hindi, Telugu, Tamil, Malayalam, each with
  multiple voices.
- **Knowledge base (RAG)** — upload documents; they're chunked, embedded, and
  retrieved per turn so agents answer from your content.
- **Calls** — place outbound calls and receive inbound calls; live status.
- **Transcripts & recordings** — full turn-by-turn transcript timeline and a
  recording player on each call.
- **Analytics** — total calls, talk time, completion rate, inbound/outbound
  split, and a 14-day volume chart.
- **Realtime pipeline** — STT → Gemini (streamed) → TTS, wired for Twilio Media
  Streams, Plivo audio streams and the Exotel Voicebot applet; a built-in
  simulator exercises the whole loop with no telephony.

Out of scope in the original MVP brief but **since built**: billing (6 tiers,
Cashfree, metered overage), team management (RBAC + invites), and CRM
integrations (HubSpot). Still **not built**: a visual workflow builder — agents
are steered by their prompt, and only `Call.collectedData` (values captured
during the call) is populated; the `Call.workflowReached` column is reserved and
currently unused.

---

## Architecture

```
                         ┌──────────────────────────────┐
   Browser ── HTTP ─────▶│  Next.js App (App Router)     │
                         │  • Dashboard UI               │
                         │  • REST API routes            │
                         │  • Prisma / Postgres          │
                         └───────────────┬───────────────┘
                                         │
              ┌──────────────────────────┼───────────────────────────┐
              ▼                          ▼                            ▼
      Telephony adapter          Speech adapter                LLM adapter
  (Twilio|Plivo|Exotel|mock)     (Google STT/TTS | mock)       (Gemini | mock)
              │
              ▼  Media Stream (production)
   ┌────────────────────────┐   caller audio ─▶ STT ─▶ Gemini ─▶ TTS ─▶ caller
   │  voice-server (ws)     │   + RAG retrieval from the knowledge base
   └────────────────────────┘
```

Every external dependency sits behind an adapter interface with a **mock** and a
**real** implementation, chosen by env flags (`USE_MOCK_*`). The same
conversation logic (`src/lib/voice/conversation.ts`) powers both the realtime
`voice-server` and the offline `simulator`.

### Key directories

```
prisma/                  Prisma schema + seed
src/app/                 Pages (dashboard, agents, calls, knowledge, numbers)
src/app/api/             REST endpoints (agents, calls, knowledge, numbers, analytics, telephony webhooks)
src/components/          UI kit + feature components
src/lib/adapters/llm/    Gemini + mock LLM
src/lib/adapters/speech/ Google Cloud STT/TTS + mock
src/lib/adapters/telephony/ Twilio + Plivo + Exotel + mock
src/lib/rag/             Chunking, embeddings, retrieval
src/lib/voice/           Conversation turn logic + mock-call simulator
voice-server/            Standalone realtime media WebSocket service
```

---

## Quick start (mock mode — no keys)

Requires **Node 18+** and a **Postgres** database.

```bash
# 1. Install
npm install

# 2. Configure env
cp .env.example .env
#   Edit DATABASE_URL to point at your Postgres instance.
#   Leave USE_MOCK_* = true to run with zero external keys.

# 3. Create the schema and seed demo data
npm run db:push
npm run db:seed

# 4. Run the app
npm run dev
# open http://localhost:3000
```

Then:

1. Go to **Agents** — two seeded agents are there. Open one.
2. Use **“Place a test call”**, enter any number like `+14155551234`, and click
   **Call now**. A simulated conversation runs through the full STT→LLM→TTS
   pipeline.
3. Watch it appear in **Call History**; open it to see the live transcript,
   summary, and recording.
4. Upload a document in **Knowledge Base**, attach it to an agent, and place
   another call — the agent now answers from your content.

No Postgres handy? Point `DATABASE_URL` at a free [Neon](https://neon.tech) or
[Supabase](https://supabase.com) database, or run one with Docker:

```bash
docker run --name vaani-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vaani -p 5432:5432 -d postgres:16
```

---

## Going live (real providers)

Flip the toggles in `.env` and provide keys. You can enable them independently.

| Capability | Env | What to set |
|---|---|---|
| **Gemini brain** | `USE_MOCK_LLM=false` | `GEMINI_API_KEY` (from Google AI Studio), optionally `GEMINI_MODEL` |
| **Speech (STT/TTS)** | `USE_MOCK_SPEECH=false` | `GOOGLE_CLOUD_API_KEY` (Cloud Speech-to-Text + Text-to-Speech APIs enabled) |
| **Telephony** | `USE_MOCK_TELEPHONY=false` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_CALLER_ID` — platform fallback only. Plivo and Exotel are bring-your-own: connect credentials per workspace in **Numbers → Add a number**, no env vars. |

For **real calls** you also run the realtime media service and expose both the
app and the WebSocket publicly (e.g. with `ngrok`):

```bash
npm run voice-server          # ws://localhost:8080
# set APP_BASE_URL and VOICE_WS_URL to your public URLs
```

- **Inbound (Twilio / Plivo):** importing a number points its Voice webhook at
  `${APP_BASE_URL}/api/telephony/{twilio,plivo}/voice` automatically. The app
  returns TwiML (or Plivo answer XML) bridging the call to the voice-server,
  which runs the STT→Gemini→TTS loop.
- **Inbound (Exotel):** ExoPhones have no per-call webhook, so this is the one
  manual step — add a **Voicebot applet** to the number's flow in the Exotel
  dashboard and paste the `wss://…/exotel` URL the number's Settings panel shows.
- **Outbound:** placing a call from the UI calls the number's own provider,
  which connects audio to the voice-server the same way.

The realtime path includes simple energy-based endpointing (turn detection) in
`voice-server/index.ts`. For production-grade latency, switch the speech adapter
to Google's gRPC **streaming** recognizer and chunk TTS sentence-by-sentence —
the adapter interface is already shaped for it.

---

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run db:push` | Apply Prisma schema to the database |
| `npm run db:seed` | Seed demo user, agents, and a number |
| `npm run db:studio` | Prisma Studio (browse the DB) |
| `npm run voice-server` | Run the realtime media WebSocket service |

---

## Notes & next steps

- **Auth** is intentionally omitted; everything is scoped to a seeded demo user
  (`src/lib/db.ts` → `getCurrentUser`). Swap in real auth in one place.
- **Embeddings/RAG** use a deterministic local embedding in mock mode and
  Google's `text-embedding-004` when `USE_MOCK_LLM=false`. Similarity is
  computed in-process; move to `pgvector` for scale.
- **Document parsing** handles text-like files in the MVP; add a PDF/DOCX parser
  in `src/lib/rag/ingest.ts` → `extractText` to support more formats.
- **Recordings** are silent WAV placeholders in mock mode; real calls store the
  provider's recording URL.
