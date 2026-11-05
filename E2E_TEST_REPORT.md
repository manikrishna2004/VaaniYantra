# End-to-end test pass — findings

**Date:** 2026-08-02, voice tripwire added 2026-08-03 · **Branch:** `enterprise-hardening`
**Baseline:** 495 tests / 45 files, `tsc --noEmit` clean
**After:** **613 tests / 54 files, `tsc --noEmit` clean.** 9 new test files, 118 new tests, no regressions.

> **Status corrected 2026-08-24.** This header used to read "Nothing here is
> committed or deployed", and that has been false for some time — the D1/D2
> cross-tenant fixes are in the tree: `ownsAll()` lives in
> `src/lib/auth/tenant.ts` and is wired into `src/app/api/agents/route.ts`,
> `src/app/api/agents/[id]/route.ts` and `src/app/api/numbers/[id]/route.ts`.
> The test counts above are also historical; the suite is at **700 tests / 62
> files** as of this correction. Verify against the tree, not against this line.

**One change requires `prisma db push` before deploy — see "Deploy order" at the bottom.**

---

## 1. Why this pass found things a normal review would not

The existing suite was good but narrow: **4 of ~106 API route files** had route-level coverage. Everything else was unit-tested underneath the route, where the auth check, the tenant scope and the request body never appear. Every defect below lives in exactly that gap.

`OPEN_QUESTIONS.md` Q5 already conceded the root cause: multi-tenant isolation is "a convention, not an enforced invariant" — no Prisma middleware, no RLS, ~106 hand-written `where` clauses. `src/lib/auth/tenant.ts` was written to address it and was imported by **zero** production files. It is now used by three.

---

## 2. Defects found and fixed

### D1 — Cross-tenant knowledge-base exfiltration · HIGH
**Where:** `src/lib/validation.ts:48`, `src/app/api/agents/route.ts`, `src/app/api/agents/[id]/route.ts`

`documentIds` was `z.array(z.string())` with no ownership check anywhere. Any authenticated MEMBER could link **another clinic's `Document`** to their own agent; `retrieveForAgent` then reads that document's chunks into the agent's prompt on every call and chat.

**Repro:** `POST /api/agents` with `documentIds: ["<a document id from another org>"]` → 201, linked, and its contents answer your calls.

**Fix:** new `ownsAll()` primitive in `src/lib/auth/tenant.ts`, applied before linking. Reuses the shape already correct at `src/app/api/portals/[id]/route.ts:31-37`.

**Also fixed:** the PATCH path deleted every existing link *before* validating, so a rejected request destroyed the customer's whole knowledge configuration. Ownership is now proved first.

### D2 — Cross-tenant agent hijack · HIGH
**Where:** `src/app/api/numbers/[id]/route.ts:28`

The phone number was workspace-scoped; the body's `agentId` was written straight through. A tenant could point their own number at **another clinic's agent**. `telephony/twilio/voice` then builds the call with `workspaceId: number.workspaceId` but `agentId: number.agentId` — so the victim's persona, prompt and knowledge answer the attacker's callers, and the transcript lands in the attacker's workspace.

**Repro:** `PATCH /api/numbers/<mine>` with `{"agentId": "<another org's agent>"}` → 200.

**Fix:** same ownership check.

### D3 — Cashfree return-URL replay → unlimited free months · HIGH (money)
**Where:** `src/app/api/billing/cashfree/return/route.ts`, `src/lib/cashfree-sync.ts:43`

The return handler is unauthenticated (necessarily — it is a cross-site redirect) and takes `order_id` from the query string. Its comment argued this is safe because it re-reads the order from Cashfree. But **a paid order proves payment once, and nothing enforced once.** Idempotency compared the incoming order against `Organization.cashfreeOrderId`, which holds only the *most recent* order.

**Repro:**
1. Pay order A → `cashfreeOrderId = A`, `paidUntil = +1 month`.
2. Start a new checkout and abandon it → `cashfreeOrderId = B` (`INITIALIZED`).
3. Re-hit `GET /api/billing/cashfree/return?order_id=A`. Cashfree still reports A as PAID; the guard compares A against B and misses → **another month**, plan re-applied, promo redemption burned again.
4. Repeat 2–3 indefinitely. The customer already holds their `order_id` — it was in their URL bar.

**Measured:** the regression test runs 12 abandon-replay cycles and `paidUntil` moved forward by exactly **365 days from a single payment**.

**Fix:** new `PaymentApplication` model with `@@unique([orderId])`. The insert *is* the claim, written in the same transaction as the org update, so a replay loses to the constraint rather than to a comparison that can be manoeuvred aside. A failed apply rolls the claim back, so a genuine retry still works (tested).

### D4 — WhatsApp webhook accepted forged requests · HIGH
**Where:** `src/app/api/whatsapp/webhook/route.ts:32`

`if (meta.appSecret && !verifyMetaSignature(...))` — with no app secret configured, the signature check was skipped and **every POST was processed**. Not inert: that path resolves an org, spends model tokens and sends a WhatsApp message out.

**Fix:** fails closed. If authenticity cannot be proved, the request is refused and the reason logged. The HMAC itself was correct and is now covered by 5 real-signature tests (wrong secret, tampered body, missing header, flag-off).

### D5 — Read-only accounts could read full medical records · MEDIUM (privacy)
**Where:** all `patients/*` routes; `src/lib/auth/permissions.ts`

Every patient route gated on `call:read` / `call:write`, which **VIEWER holds**. A read-only seat could pull a patient's full record including `internalNotes` (the clinician's private notes) and attached documents. There was no `patient:*` permission at all.

**Fix (your call — least privilege):** added `patient:read` / `patient:write`, granted from MEMBER up, VIEWER excluded. Re-gated all 10 route handlers, the `/patients` page (`notFound()`), and hid the sidebar item so a VIEWER is not led to a door that refuses them.

### D6 — Unknown role defaulted to write access · MEDIUM
**Where:** `src/lib/auth/permissions.ts:107`, applied at `src/lib/auth/context.ts:54`

`toRole()` mapped any unrecognised role string to **MEMBER**, and it runs on `Membership.role` straight from the database. A legacy, mistyped or hand-edited value silently granted agent/number/knowledge/patient writes.

**Fix (your call):** defaults to `VIEWER`. Fails closed.

### D7 — Emergency tripwire guarded only one of three channels · HIGH (patient safety)
**Where:** `src/lib/whatsapp-chat.ts`

`detectRedFlag` was wired into exactly one call site: the patient portal (`src/lib/portal/chat.ts:110`). The **paid WhatsApp follow-up chat went straight to the model.** Verified before fixing: "I have bad chest pain and my left arm hurts" was answered by the model with clinic opening hours.

**Fix:** same guarantee as the portal — detect, reply from the table (108/112), skip the model entirely, and alert the clinic. `alertEmergency` was generalized from a `Portal`/`Contact` pair to plain ids so WhatsApp (which has neither) raises the same alert on the same throttle.

**Also fixed — truncation:** both channels cap inbound text at 1000 chars *before* handling, so a symptom mentioned after a long preamble was silently dropped. Detection now runs on the whole message; only the stored/model copy is capped.

### D8 — IPv6 literals bypassed the SSRF address check · LOW
**Where:** `src/lib/net/ssrf.ts`

`URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`), which `net.isIP` rejects — so `http://[::1]/` fell through to the DNS branch and was blocked only because the lookup happened to fail. Blocked by accident, not by design.

**Fix:** strip brackets so IPv6 literals are classified by the same rules as IPv4. The guard had **no tests at all** despite standing in front of webhook delivery and URL knowledge ingest; it now has 18, including the GCP metadata address (`169.254.169.254`), the `172.16/12` boundaries, IPv4-mapped IPv6, and the DNS-rebinding shape where a public hostname resolves to a private address.

### D9 — The phone had no emergency tripwire at all · HIGH (patient safety)
**Where:** `src/lib/voice/live.ts`, `voice-server/index.ts`, new `src/lib/voice/emergency.ts`

`detectRedFlag` appeared nowhere in `src/lib/voice/*` or `voice-server/`. A caller who said "chest pain" to the **phone** agent — the product's primary channel — was protected only by a sentence in the system prompt, which is advisory, competes with everything else in a long prompt, and fails precisely when the model has decided to be reassuring.

**The two pipelines get different guarantees, and the difference is real:**

| Pipeline | Guarantee | Why |
|---|---|---|
| **Cascade** (Deepgram STT → Gemini → TTS), `CallSession.processTurn` | **Pre-empt** — identical to chat | The utterance is fully transcribed before any model call, so we answer it ourselves and return. The model never sees it. Placed ahead of the human-transfer check: an ambulance beats a receptionist. |
| **Gemini Live** (realtime speech-to-speech) | **Interrupt** | Audio streams continuously; the model may already be replying by the time we see the transcript of those words. There is no point at which we hold the text. So detection runs on the **partial** transcript and cuts the model's audio mid-word. The caller may hear a syllable or two first. |

Pretending the Live path is a pre-empt would have been the dangerous kind of tidy, so it is documented as an interrupt in the code and tested as one.

**Design points that matter:**
- **The model is silenced before anything that can block.** `sendClear()` runs before the TTS round trip, the alert and the DB write — talking over a reassuring answer cannot wait on a network call. A test asserts this ordering directly.
- **The spoken line comes from a fixed table**, synthesized by our own TTS (`synthesizeTelephony`, which always falls back to Google Cloud TTS). The model is never asked, so it cannot decline, soften or reword the number.
- **Written for a phone, not a chat window** — no line breaks (TTS reads them as nothing), leads with the action, and says "hang up now and call 108" rather than "call 108", because the caller is already holding a phone.
- **Fires once per call.** Repeating it would talk over someone trying to act on it.
- **The clinic is alerted** on the same throttle as the chat channels, and the spoken line is written into the transcript so a reviewer sees it rather than an unexplained gap.
- **Every failure degrades safely:** TTS failure, no org context (demo calls), a closing session, and a failed alert all still leave the caller having heard the number, or fall back to a direct instruction to the model.

**Coverage:** 20 tests in `tests/voice-emergency.test.ts`.

---

## 3. Behaviours that look wrong and are not (now pinned)

Worth recording, because each is the kind of thing a later "tidy-up" breaks.

- **Diagnosis-hold defaults are asymmetric on purpose.** The in-app form holds a diagnosis (doctor opts in to release); the v1 push API releases by default (integrator opts out). Defaulting the push API to withheld would, on ship day, silently retract the diagnosis from every patient of every integrated clinic. The comment at `v1/patients/[id]/visits/route.ts:103-107` explains it; 6 tests now pin both directions.
- **The v1 API-key surface was already correct** — hashing, revocation, expiry, prefix rejection without a DB round trip, per-IP and per-key rate limits. It simply had no tests. It now has 15.
- **Invite emails degrade gracefully.** With no mailer configured, the button reads "Create invite" instead of "Send invite" and the copy explains the user must send the link. Not a friction bug.
- **`org.name` never reaches patients** — checked across the booking, portal and voice paths. The auto-generated name (below) is internal-facing only.

---

## 4. User friction

### Fixed

| Finding | Where |
|---|---|
| **Practice type silently destroyed typed work.** `applyVertical` overwrote `greeting` and `systemPrompt` unconditionally — losing a prompt someone had just written, or one they had been running for months on the edit form. (The function already avoided clobbering `industryLabel` and owner numbers, so the concern was known; it just missed the two biggest fields.) Now preserves the user's own text, still re-seeds anything that is still a template default, and says so with an explicit "Use this practice type's wording instead" action so the control doesn't look broken. | `src/components/AgentForm.tsx` |
| **Emailed invoice links stranded signed-out users.** `/invoices` was missing from `PROTECTED_PREFIXES`, so the `?next=` was dropped and the user landed on `/dashboard` after signing in, with no way back to the invoice they clicked. | `src/middleware.ts` |
| **Three spellings of one validation error** — "behaviour" / "behavior" / no full stop, depending on which check fired. | `AgentForm.tsx`, `validation.ts` |

### Found, not fixed (needs your judgement)

1. **There is no organization-naming step.** `src/lib/auth/provision.ts:55` silently creates `"<name>'s Organization"`. A hospital signing up is called *"Manikanta's Organization"* until someone finds `/settings/organization`. **The user guide never mentions naming it either** — confirmed by fetching the live `/docs/user-guide`. Cheapest fix: ask for the clinic name on first dashboard load, or add it to the guide.
2. **Sign-up sets no expectations.** The live `/sign-up` page has no link back to the homepage, and says nothing about what happens next, whether a card is needed, or what the free plan includes. It is the highest-intent page in the funnel.
3. **A DB failure at first sign-in looks like a broken login.** `requireWorkspace()` redirects to `/sign-in`, whose "Continue as you" button returns to `/dashboard`, which redirects again. The user sees a bounce with no explanation.
4. **Going live is a four-condition AND across two screens** (`NumbersManager.tsx:495`: agent assigned · inbound enabled · webhook pointed · provider-dependent). The card does list the remaining steps, which is good — but the state is only discoverable after you get there.

---

## 5. What this pass could **not** cover

Stated plainly so the gaps aren't mistaken for clean results.

- **The authenticated UI was never driven.** The Chrome extension was not connected, so the browser half of the friction pass did not run. Everything in §4 is from code and from the live *public* pages. Signup → agent wizard → numbers → chatbot was not clicked through as a real user.
- **Real-database concurrency.** UHID allocation and `claimSlot` are enforced by Postgres constraints and advisory locks; `tests/uhid.test.ts:4-6` says so explicitly. There is no local Postgres (`.env` still points `DATABASE_URL` at `file:./dev.db` against a `postgresql` schema, and no Docker), so these need an integration environment.
- **Live telephony**, Cashfree checkout against the real gateway, and Google Calendar OAuth — all deliberately untouched on a production merchant account holding real patient data.
- **The cascade pipeline's tripwire has no integration test.** The shared logic is covered, and the wiring typechecks, but `CallSession` is not exported and `voice-server/index.ts` starts listeners (WS server, reminder dispatcher, retention sweeper) at import time, so it cannot be constructed in-process without extracting the class. Extracting it is a worthwhile refactor of an 1126-line file, but not one to do inside a safety change to the live call path. **The Gemini Live path — the one production actually runs (`USE_GEMINI_LIVE=true`) — is fully covered.**
- **No emergency tripwire has been exercised on a real call.** All 20 tests drive the session object directly. The end-to-end behaviour — that a caller genuinely hears the line, promptly, over a real carrier — needs one live test call per pipeline.
- **The emergency reply table has only English and Hindi** (`red-flags.ts`), for both the chat and spoken variants, against 29 advertised languages. Every other language falls back to English. The digits (108/112) survive, so it is safe, but it is not localized. Translations are a clinical-copy decision, not something to invent.

---

## 6. Deploy order — read before shipping

**STATUS 2026-08-03: FULLY DEPLOYED AND VERIFIED LIVE.** All six commits are on `origin/enterprise-hardening`, built, and serving in production. Verified by an externally-observable new behaviour rather than by trusting the deploy: `GET /invoices/inv_test` now returns `307 → /sign-in?next=%2Finvoices%2Finv_test`, which only the new middleware does. Landing page 200, `/api/health` `{"ok":true,"db":"up"}`, voice-server `/health` ok, both pm2 processes online. Route: stop → resize to `e2-medium` → build (41s) → `pm2 restart vaani-web vaani-voice` → resize back to `e2-micro`. Static IP survived both cycles; downtime was limited to the two stop/starts, since the site served the old build throughout the build itself.

**The schema push is DONE.** `PaymentApplication` exists on the production database, verified (UNIQUE on `orderId`, index on `orgId`, FK cascade to `Organization`). It went in with `--skip-generate` so the running app's Prisma client was untouched; `/api/health` uptime was unchanged across the operation, i.e. zero downtime. A fresh DB backup was taken first and is in GCS. **The ordering hazard below is therefore resolved — the code deploy is now routine.** The six commits are pushed to `origin/enterprise-hardening` but are NOT deployed; production still runs the old code.

⚠ **Unrelated production issue found and fixed during this:** the nightly `pg_dump` → GCS backup had been failing since **2026-08-01 13:48**, when the deploy stripped the execute bit off `scripts/backup-db.sh` (`-rw-r--r--`). Cron failed silently — its output goes to a log nobody reads — so the medical database went **two nights with no backup**. The bit is restored and a fresh dump taken. **This will recur on the next tarball deploy.** The durable fix is to invoke it via the interpreter in crontab, so the file mode stops mattering:

```
17 2 * * * GCS_BUCKET=gs://vaaniyantra-db-backups bash /home/balij/vaani/scripts/backup-db.sh >> /home/balij/db-backups/backup.log 2>&1
```

Worth adding a check that alerts when the newest object in the bucket is older than ~36 hours; a backup that fails silently is barely better than no backup.

---

*Original note, kept for the record:*

**`prisma db push` MUST run BEFORE this code is deployed.**

D3 adds the `PaymentApplication` model. If the code goes out first, `applyPaidOrder` will throw on a table that does not exist, and the return handler has no try/catch around it — **every payment would 500 at the moment of settlement.** Push the schema, confirm the table, then deploy.

The push adds one new table and one relation field on `Organization`. It drops nothing, so it should not ask for `--accept-data-loss`; if it does, stop and investigate rather than confirming.

---

## 7. Suggested next steps

1. `prisma db push`, then deploy (order above).
2. **Make one test call per pipeline and confirm the tripwire out loud** — say "I'm having chest pain" and check you hear the 108/112 line, how fast it arrives, and that the alert reaches the clinic. This is the one part of D9 that cannot be proved from a test bench.
3. Connect the Chrome extension and finish the browser friction pass — §4 is code-derived and the wizard has never been walked end to end.
4. Consider Prisma middleware or RLS for tenant scoping (`OPEN_QUESTIONS.md` Q5). D1 and D2 were the same bug twice in two days of code; `ownsAll()` makes the check easy but still voluntary.
5. Translate the emergency line beyond English and Hindi (§5) — a clinical-copy decision for you, not something to generate.
