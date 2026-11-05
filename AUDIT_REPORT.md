# VaaniYantra — Enterprise Hardening Audit

_Branch: `enterprise-hardening` · Author: Claude (Opus 4.8), autonomous run · Date: 2026-07-24_

Baseline at start: **`tsc` clean, 86/86 tests pass**, `npm audit` = 1 critical / 3 high / 7 moderate.

---

## System overview (as-built)

VaaniYantra is a multi-tenant voice-AI receptionist/booking platform.

- **Realtime voice pipeline** (`voice-server/index.ts`, `src/lib/voice/*`): two interchangeable pipelines — (a) **Gemini Live** speech-to-speech (`live.ts`, default via `USE_GEMINI_LIVE=true`) and (b) a cascade **Deepgram STT → Gemini → TTS** (`CallSession` in the voice-server). A per-provider **codec** layer (`codec.ts`) adapts wire audio (mulaw/PCM16) and the outbound WS dialect (Twilio/Exotel vs Plivo).
- **Telephony** (`src/lib/adapters/telephony/*`): provider-agnostic adapter (Twilio / Exotel / **Plivo** / Mock). The **voice-server** (port 8080) serves provider webhooks + the media WebSocket; Next.js (port 3000) serves the dashboard/API. Caddy fronts both and routes an explicit allowlist of paths to 8080.
- **Messaging**: WhatsApp via **Meta Cloud API direct** (`whatsapp-cloud.ts`, primary), with Twilio/Exotel/Plivo senders as alternates; SMS fallback. Proactive messages use Meta-approved templates.
- **Orchestration/connectors** (`connectors/*`, `post-call-actions.ts`): booking (Google Calendar), CRM push, Drive logging, outcome engine, owner alerts.
- **Tenancy/auth** (`auth/*`): Firebase Auth; Organization → Workspace → Agent/PhoneNumber/Call/Document; RBAC via `permissions.ts`; API keys (`api-keys.ts`); audit log (`audit.ts`).
- **Billing**: Cashfree (subscriptions + overage sweep).
- **Storage**: Postgres (Prisma) in prod; **SQLite in local dev** (divergence — see F-8.2).
- **Deploy**: single GCP e2-micro VM, **pm2 fork mode** (`vaani-web`, `vaani-voice`), Caddy TLS. Nightly `pg_dump`→GCS backups; overage + reminder crons.

---

## Phase 1 — Findings

Severity: **Critical / High / Medium / Low**. Effort: **S(mall) / M(edium) / L(arge)**.
IDs are referenced by CHANGELOG entries and OPEN_QUESTIONS.md.

### 1. Architecture & design

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-1.1 | Medium | M | **Scattered `process.env` reads (84 sites)** with ad-hoc defaults and no startup validation. A missing/typo'd var fails late and silently (e.g. wrong `PUBLIC_BASE_URL` → webhooks point nowhere). No single source of truth for config. |
| F-1.2 | Low | M | Telephony is cleanly abstracted, but **WhatsApp transport selection is a hand-rolled if/else chain** in `connectors.ts` (`sendWhatsApp`/`sendWhatsAppTemplate`) duplicated across text/template paths — easy to drift (already drifted: Plivo branch had to be added twice). |
| F-1.3 | Low | S | Vendor lock-in is **well-contained** for telephony/STT/TTS (adapter pattern) but **Gemini is hard-wired** as the only LLM/Live provider (`live.ts`, `conversation.ts`). Acceptable, but there is no LLM adapter seam. |
| F-1.4 | Medium | M | The **voice-server holds per-call state in memory** (`CallSession`/`LiveCallSession` instances, `rate-limit` buckets). Correct for single-process, but it is the root blocker for horizontal scale (see F-3.1). |

### 2. Reliability & latency

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-2.1 | **High** | M | **47 `fetch()` calls with no timeout** across telephony/WhatsApp/CRM/Cashfree/Gemini REST. A hung upstream (provider outage, slow DNS) blocks the request/turn indefinitely — during a live call this strands the caller. No shared retry/backoff either. |
| F-2.2 | Medium | S | External calls have **no retry with jitter** for transient 5xx/network errors (Meta/Plivo/Twilio sends, calendar). One blip = a dropped confirmation. |
| F-2.3 | Low | S | Barge-in / interruption handling is **solid** (energy VAD + model-interrupt + safety-net in `live.ts`). Guaranteed hangup via WS close is a good belt-and-suspenders. |
| F-2.4 | Medium | M | **Dropped-call / WS reconnect**: if the media WS drops mid-call there is no resume; the call is finalized. Acceptable for v1 but no reconnection window. |
| F-2.5 | Medium | S | First-attempt call in prod **failed hard when the Gemini project ran out of credits** (session closed 1011). There is no pre-flight credit/health check nor a spoken "we're having trouble" fallback — the caller just hears silence. |

### 3. Scalability

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-3.1 | **High** | L | **Single-process, single-VM, stateful.** In-memory call sessions + in-memory rate limiter + pm2 *fork* (not cluster) mean the system cannot scale horizontally or survive the VM. Documented in `rate-limit.ts` but not addressed. |
| F-3.2 | Medium | S | **No Prisma connection-pool tuning** (`db.ts` uses defaults). On Postgres with many concurrent calls this can exhaust connections; needs an explicit pool limit aligned to the DB. |
| F-3.3 | Low | S | Dev on **SQLite**, prod on **Postgres** — some Prisma features/behaviours differ; risk of "works in dev, breaks in prod". |

### 4. Security

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-4.1 | **Critical** | S | **Live secrets committed to the developer `.env`** (working copy): real Gemini key, Google Cloud key, Deepgram key, Twilio SID+token, Google OAuth client secret, **the founder's Meta/Facebook password in plaintext**, a permanent Meta system-user token, and the Meta app secret. `.env` is gitignored (not in history) but this is a serious operational-security exposure. **Flagged, not auto-remediated** (credential rotation is explicitly off-limits) — see OPEN_QUESTIONS Q1. |
| F-4.2 | Medium | S | **Plivo webhook signature verification is default-OFF** (`plivo-signature.ts`, `PLIVO_VALIDATE_SIGNATURE!=='true'`). The Plivo answer/status endpoints are unauthenticated by default → an attacker who knows a tenant's number can spawn Call rows / Gemini sessions (cost + noise). Twilio + Meta paths ARE verified. |
| F-4.3 | Medium | M | **No centralized secret redaction in logs.** 102 `console.*` sites; several log provider error bodies / tokens-adjacent data. A structured logger with redaction is missing. |
| F-4.4 | Low | S | Prompt-injection surface: agent system prompts embed KB chunks + caller-derived text. Mitigations exist (booking tools are structured, not free-eval) but there's no explicit injection guard/allowlist on tool arguments. Low risk given the tool set. |
| F-4.5 | Low | S | SSRF guard exists (`net/ssrf.ts`) for KB URL crawling — good. Verify it's applied on every user-supplied URL fetch (crawler + connector test). |
| F-4.6 | Medium | S | Encryption: secrets at rest use AES-256-GCM (`crypto.ts`) keyed by `SECRET_ENC_KEY`; in transit is TLS via Caddy. Good. **But** if `SECRET_ENC_KEY` is unset there is no hard fail — decrypt silently returns null and features "just stop working" (observed with the expired Meta token path). Needs a startup assertion. |

### 5. Data privacy & compliance

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-5.1 | Medium | M | **PII in transcripts/recordings.** Retention purge exists (`retention.ts`, per-org window) + recording disclosure per agent — good. But there is **no PII redaction** of transcripts (names, phone numbers, card mentions) at rest, and no field-level encryption of transcript bodies. |
| F-5.2 | Medium | M | **Multi-tenant isolation** relies on every query carrying `workspaceId`/`orgId`. Mostly consistent, but isolation is **convention, not enforced** (no row-level security / Prisma middleware guard). One missing filter = cross-tenant leak. The inbound webhook path correctly refuses to route a number to another tenant's agent (good). |
| F-5.3 | Medium | L | **Compliance posture undocumented.** No data-processing records, no DPA template, no explicit GDPR data-subject-export endpoint (deletion exists via retention + `/data-deletion`). HIPAA/PCI: platform should **explicitly disclaim** PHI/cardholder data intake (agents must not collect card numbers) — currently only prompt-level. |

### 6. Observability

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-6.1 | **High** | M | **No structured logging, metrics, or tracing.** 102 `console.*` calls with no levels, no request/call correlation id, no redaction, no aggregation (no Sentry/OTel). In prod (pm2 logs) a failing call is hard to diagnose after the fact. |
| F-6.2 | Medium | S | **No app-level metrics** (calls started/failed, turn latency, TTS/STT latency, WhatsApp send success rate). Latency is `console.log`'d ad hoc but not measured/exported. |
| F-6.3 | Medium | S | **Alerting is infra-only** (GCP uptime + email). No alert on business-critical failures (Gemini credit depletion, WhatsApp send failures, webhook signature rejections). The credit-depletion outage would not have paged anyone. |
| F-6.4 | Low | S | `/api/health` exists but is shallow. No readiness probe that checks DB + downstream reachability. |

### 7. Testing & CI/CD

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-7.1 | Medium | M | **17 test files, unit-level.** Good coverage of crypto/phone/signatures/rate-limit/billing/retention/whatsapp routing. **Gaps:** the realtime voice pipeline (`live.ts`, codec conversions beyond Plivo), connectors/booking end-to-end, auth/RBAC, and the new fetch/timeout/logging utilities. No coverage threshold enforced. |
| F-7.2 | Medium | S | **CI runs lint+test+build on main/PR** — solid baseline. **No load test, no chaos test, no coverage gate, no `npm audit` gate.** |
| F-7.3 | Low | S | No integration test harness that boots the voice-server against a mock provider (the `simulator.ts` + Mock adapter exist and could power one). |

### 8. Code quality & dependencies

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-8.1 | **High** | S | **`npm audit`: 1 critical, 3 high, 7 moderate.** Critical = Next.js dev-server origin verification (dev-only, but fixed by a patch bump); High = `brace-expansion`, `fast-xml-parser`, `postcss` (mostly transitive/build). All addressable via `npm audit fix` / a Next patch bump. |
| F-8.2 | Medium | S | **Config divergence dev(SQLite)/prod(Postgres)** (dup of F-3.3) and secrets living in `.env` (F-4.1). |
| F-8.3 | Low | S | Duplication in WhatsApp send resolution (F-1.2); otherwise the code is clean, typed, well-commented. Dead code minimal. |

### 9. Cost inefficiencies

| ID | Sev | Eff | Finding |
|----|-----|-----|---------|
| F-9.1 | Medium | M | **KB retrieval re-embeds/re-retrieves** per call (`live.ts` folds top chunks into the system prompt once — good) but there is **no caching of embeddings/agent-prompt assembly** across calls to the same agent. |
| F-9.2 | Low | S | Every WhatsApp send re-fetches `getMetaConfig()` (7 DB reads/call, uncached) — cheap but avoidable; other config paths (`getGeminiApiKey`, tunables) are cached, Meta config is not. |
| F-9.3 | Low | S | No caching layer (Redis) at all; acceptable at current scale. |

---

## Phase 2 — Gap analysis vs. enterprise standards

| Capability | Status | Gap |
|---|---|---|
| **Multi-tenancy** | ✅ Org/Workspace model | Isolation is convention, not enforced (F-5.2). No per-tenant data-residency choice. |
| **RBAC** | ✅ `permissions.ts` + roles + invitations | No custom roles; no per-resource ACLs beyond role. |
| **SSO / SAML** | ❌ | Firebase email/Google only. No SAML/OIDC for enterprise IdPs. |
| **Audit logs** | ✅ `audit.ts` + `/settings/audit` | Not tamper-evident (no hash chain); no export/retention policy. |
| **SLA / uptime** | ⚠️ GCP uptime checks | Single VM = no HA; no published SLA; no status-page automation beyond `/status`. |
| **Data residency** | ❌ | Single region (GCP us-east). No EU/India residency option. |
| **DR / backup** | ✅ nightly pg_dump→GCS | No tested restore runbook; single-region backups; RPO ~24h, RTO unmeasured. |
| **Rate limiting** | ⚠️ in-process | Not distributed; resets on restart (F-3.1). |
| **API versioning** | ⚠️ `/v1` keys exist | No formal version negotiation / deprecation policy. |
| **Public API docs / SDK** | ❌ | No OpenAPI spec, no published docs, no client SDK. |
| **Admin tooling** | ✅ `/admin` (super-admin) | Good breadth (config, pricing, secrets, orgs, WhatsApp pool). |
| **Observability** | ❌ | No metrics/tracing/structured logs (F-6.x). |
| **Compliance** | ⚠️ retention + disclosure + /security | No SOC2/GDPR/HIPAA artifacts, no DPA, no data-subject export (F-5.3). |

---

## Phase 3 — Roadmap

Ordered by risk-reduction per unit effort. Items marked **[branch-safe]** are implemented in this run; **[needs infra]** / **[risky]** are deferred to OPEN_QUESTIONS.md (never executed autonomously per the ground rules).

### Phase A — Foundation (config, logging, resilience) — _branch-safe_
- A1. Centralized, validated env/config module (F-1.1, F-4.6). **[branch-safe]**
- A2. Structured logger with levels + secret redaction + call/request correlation (F-6.1, F-4.3). **[branch-safe]**
- A3. `fetchWithTimeout` + retry/backoff util, adopted in the hottest external-call paths (F-2.1, F-2.2). **[branch-safe]**
- A4. Deeper health/readiness endpoint (DB ping) (F-6.4). **[branch-safe]**

### Phase B — Reliability & cost — _branch-safe_
- B1. Cache `getMetaConfig()` like other config (F-9.2). **[branch-safe]**
- B2. Explicit Prisma connection-pool limit via `DATABASE_CONNECTION_LIMIT` (F-3.2). **[branch-safe]**
- B3. Spoken graceful-failure fallback when the LLM session can't start (F-2.5). **[branch-safe, best-effort]**

### Phase C — Security & compliance — _branch-safe where possible_
- C1. Startup assertion that `SECRET_ENC_KEY` is present & strong (F-4.6). **[branch-safe]**
- C2. Make Plivo signature verification safe-by-default posture + docs; keep behaviour gated to avoid breaking live calls (F-4.2). **[branch-safe, conservative]**
- C3. `npm audit` remediation for non-breaking advisories + Next patch bump (F-8.1). **[branch-safe, verify build]**
- C4. Tenant-isolation guard helper + tests to make cross-tenant filters explicit (F-5.2). **[branch-safe]**
- C5. Rotate leaked credentials; remove secrets from `.env`. **[risky → OPEN_QUESTIONS Q1]**
- C6. PII redaction of transcripts; field-level encryption. **[risky/large → OPEN_QUESTIONS Q4]**

### Phase D — Scale — _needs infra_
- D1. Redis-backed rate limiter + shared session/state. **[needs infra → Q2]**
- D2. pm2 cluster / multi-VM / stateless voice-server. **[needs infra → Q2]**

### Phase E — Enterprise features — _large_
- E1. SSO/SAML, OpenAPI + SDK, tamper-evident audit, data-subject export, DR restore runbook. **[large → Q3]**

See **CHANGELOG.md** for what was implemented and **OPEN_QUESTIONS.md** for deferred/risky items.
