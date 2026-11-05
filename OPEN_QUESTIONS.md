# Open Questions — items deliberately NOT auto-executed

Per the autonomous ground rules, anything data-destructive, credential-rotating,
infra-dependent, or touching live billing/auth is logged here instead of being
done. Each needs a human decision.

---

## Q1 — Live secrets in the developer `.env` (Security, Critical) — F-4.1
**What:** The working-copy `.env` contains real, live credentials: Gemini API key,
Google Cloud key, Deepgram key, Twilio SID+auth-token, Google OAuth client secret,
a permanent Meta system-user token, the Meta app secret — **and the founder's
Facebook account password in plaintext** (`META_PASSWORD`).
**Why not auto-done:** Rotating/revoking live credentials is explicitly off-limits
(could break the running prod app + your Meta/Google integrations), and I must not
touch your accounts.

**Update 2026-08-24 — still open, now alarmed.** Re-verified: `META_PASSWORD` is
still present in `.env`, and both Cashfree merchant CSVs are still in the repo
root (gitignored and untracked, but cleartext on disk). Nothing in the codebase
reads `META_PASSWORD` — grep confirms zero references outside this file — so
deleting the line breaks nothing and is safe to do before rotating. A tripwire
now reports it as an error-level config problem at boot (`validateConfig`), but
that only makes the exposure visible; it does not remove it. **Steps 1–4 below
remain founder actions and are the highest-severity item still outstanding
anywhere in these records.**
**Recommended (you do this):**
1. **Delete `META_PASSWORD` immediately** and change that Facebook password (it has
   been written to disk in cleartext).
2. Move all secrets out of `.env` into the platform's own encrypted config / a
   secret manager; keep `.env` for non-secret pointers only.
3. Rotate the Twilio auth token, Deepgram key, Google OAuth secret, and Meta app
   secret since they've been in a plaintext file. (`.env` is gitignored, so not in
   git history — verified — but still exposed on disk/backups.)
4. Confirm the old leaked Gemini/Google keys from `.env.example` (noted in prior
   memory) are revoked in their consoles.

## Q2 — Horizontal scale / statelessness (Scale, High) — F-3.1, F-3.2, D1/D2
**What:** In-memory call sessions + in-memory rate limiter + pm2 *fork* on one
e2-micro. Cannot scale out or survive VM loss.
**Why not auto-done:** Requires infra you must provision (Redis/managed cache, a
load balancer, ≥2 app instances, sticky WS routing) and a deployment change.
**Recommended:** (a) move rate-limit + any shared counters to Redis; (b) run
`vaani-web` in pm2 *cluster* mode behind the existing Caddy; (c) keep the
voice-server sticky per-call (WS affinity) and scale it as its own pool; (d) size
the DB pool (see B2, which I did wire a knob for). I built the code seams (config,
logger, pooled fetch) to make this easier but did not change the deployment.

## Q3 — Enterprise features: SSO/SAML, OpenAPI+SDK, DR runbook, data-subject export (Enterprise, Large) — E1
**Why not auto-done:** Each is a multi-day feature with product/security decisions
(which IdP protocol, API surface to freeze, legal DPA text). Not safe to
autonomously design end-to-end.
**Recommended sequencing:** OpenAPI spec (from existing routes) → data-subject
export endpoint (reuses retention/deletion) → SAML via a provider (WorkOS/Auth0) →
tamper-evident audit (hash-chain the `AuditLog`) → tested DR restore runbook.

## Q4 — PII redaction & field-level transcript encryption (Compliance, Medium/Large) — F-5.1, C6
**Why not auto-done:** Changing how transcripts are stored is a **schema + data
migration** over existing call data (data-loss risk if done wrong) and needs a
redaction policy decision (what to redact, reversibility for support).
**Recommended:** add a redaction pass at write-time behind an org flag first
(non-destructive, forward-only), then a backfill migration reviewed by you.

## Q5 — Multi-tenant isolation enforcement (Security/Privacy, Medium) — F-5.2
**Partially addressed:** I added an explicit `assertTenantScope` helper + tests
(C4) to make cross-tenant filters intentional. **Full** enforcement (Prisma
middleware that injects `workspaceId`, or Postgres RLS) is a larger, riskier change
that can silently break queries — deferred for your review.

## Q7 — Remaining dependency vulnerabilities require breaking upgrades (Code quality, Medium) — F-8.1
**What:** `npm audit fix` (non-breaking) was applied — only `package-lock.json`
changed and all tests still pass. The remaining advisories (11: 1 critical, 4
high, 6 moderate) need **major-version bumps** (`npm audit fix --force`) that
`--force` would apply to `firebase-admin` and `next`, which can break the app.
**Assessment:** The **critical** (`next` dev-server origin verification) is
**dev-only** — prod runs `next start`, not `next dev`, so there is **no prod
exposure**. The `high`/`moderate` ones are transitive (`firebase-admin` →
`@google-cloud/storage` → `teeny-request`/`gaxios`/`uuid`; `postcss`,
`fast-xml-parser`, `brace-expansion`) and are build/SDK-side, not request-path.
**Recommended (you decide):** schedule a controlled upgrade — bump `next` to the
latest 14.2.x patch (clears the critical without a major), and `firebase-admin`
to its current major behind a smoke test. Not done autonomously (breaking).

## Q8 — Graceful spoken fallback when the LLM session can't start (Reliability, Medium) — F-2.5, roadmap B3
**What:** When Gemini Live fails to open (the observed credit-depletion `1011`),
the caller hears silence. A pre-recorded "sorry, we're having trouble, please try
again shortly" clip should play before hangup.
**Why not auto-done:** It touches the deployed critical call path (`live.ts`) and
needs a recorded audio asset + careful testing against a live provider; the ground
rules say pause items that risk the core call path. Low-risk to add later behind a
flag, with the Mock/simulator harness covering it.

## Q6 — Deploying these changes to prod
**Why not auto-done:** The ground rules said branch + commit; they did **not**
authorize a prod deploy, and deploying restarts the live voice-server (drops
in-progress calls) + runs against live data. All work here is on the
`enterprise-hardening` branch only.
**Recommended:** review the branch, run CI, then deploy during a quiet window using
the existing tarball→VM→`npm run build`→`pm2 restart` flow. No schema migration is
required by this branch (no model changes were made).
