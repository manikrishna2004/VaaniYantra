# SUMMARY — audit, WhatsApp→SMS migration, fix loop, simplification (2026-07-13)

Everything below is committed to `main`, one commit per TODO item. Verification
at every step: `tsc --noEmit`, `next lint`, `vitest` (50 tests, all passing),
and a full `next build` at the end — all green.

## Phase 1 — Audit
- **AUDIT.md** — full-codebase critique: per-screen UX ratings, security holes,
  correctness bugs, architecture smells, and concrete redesigns.
- **TODO.md** — the audit as a prioritized checklist (P0/P1/P2) with per-item
  completion notes. **No open P0 or P1 items remain.**

## Phase 2 — WhatsApp → SMS (feature-flagged, not deleted)
- New `WHATSAPP_ENABLED` env flag (default **off**), read via `src/lib/flags.ts`.
- **Transport**: `sendWhatsApp()` reroutes to `sendSms()`; `sendConfirmation()`
  forces the SMS channel; booking/outcome config readers resolve any stored
  `whatsapp` channel value to `sms` at read time. **The messaging interfaces
  are unchanged** — agents, tools, and stored configs keep working; only the
  wire channel changes.
- **Prompt**: the composer's MESSAGING clause now says "SMS text message" only
  (WhatsApp wording returns automatically when the flag is on).
- **API**: every WhatsApp management/webhook route 404s or no-ops while off
  (Meta webhook still ACKs so the subscription isn't dropped). The WhatsApp
  chat add-on can't be enabled and is **never billed** while off.
- **UI**: WhatsApp is gone from Connectors, the agent wizard (channel picker +
  owner-alert checkbox), Numbers (toggle + badge), Billing (add-on card), and
  the founder /admin panels. Copy de-WhatsApp'd everywhere user-facing.
- **Contract note**: `agent_config` schemas still *accept* `whatsapp` values —
  flagged at the top of TODO.md; nothing breaks on re-enable.

## Phase 3 — Fixes (all P0/P1 closed)
Security:
- **Twilio webhook signature validation** (new `src/lib/telephony-signature.ts`)
  on voice-server voice/status and the Next.js twilio + whatsapp-inbound routes;
  tries platform + BYO account tokens; `TWILIO_VALIDATE_SIGNATURE=false` opt-out.
- **SECRET_ENC_KEY is mandatory in production** — first secret use hard-fails
  instead of silently encrypting with the public dev key.
- **Cross-tenant demo fallback removed**: inbound calls to a number with no
  agent get a polite reject (logged `no_agent`), never another tenant's agent;
  `getCurrentUser`/`DEMO_USER_EMAIL` deleted (also fixed an empty-string FK).
- **sendSms account/From pairing**: org creds always send from the org's own
  sender (mixed pairs used to fail Twilio 21606 silently).

Correctness:
- **Booking TOCTOU race fixed**: `claimSlot()` re-counts + creates under a
  per-(org, slot) Postgres advisory lock; reschedule guarded the same way with
  calendar rollback.
- **Empty calls bill nothing**: shared `finalizeCallRecord()` marks
  zero-transcript calls FAILED / 0s / `no_conversation` (fires `call.failed`).
- **Status webhooks**: unknown Twilio statuses ignored; non-terminal updates
  can no longer resurrect ended calls.
- **WhatsApp follow-up chat** answers from the messaged number's assigned agent.
- **Malformed JSON** returns 400 (not 500) everywhere.
- **Owner alert numbers** validated + normalized to E.164 (schema + inline UI).

Infrastructure:
- **vitest** added (`npm test`): 12 files / 50 tests covering flag routing,
  channel resolution, Twilio HMAC (reference vector), sendSms pairing, slot
  claiming, finalize, status webhook, owner numbers, overage math, crypto.

## Phase 4 — Simplification
- **Create-agent flow: 5 required steps → 1.** The Create/Save button is on
  every step; verticals pre-fill everything else; footer says the rest is
  optional. Steps renamed plainly ("Bookings", "Messages & Alerts") and marked
  optional in their descriptions.
- **No phone number needed to create an agent** — number required only to go
  live; wizard + agent page guide the user to test first, connect later.
- **Plain-language copy pass**: every user-facing "E.164" is now "with country
  code, e.g. +91 98765 43210"; "Behavior prompt (system prompt)" → "What should
  the agent say and do?"; hints rewritten for non-technical owners.
- **Overage visibility**: dashboard banner with extra minutes, ₹ so far, rate,
  and a billing link.
- **DLT (India SMS)**: documented in the user guide (sender + template
  registration steps) with an inline note + link where message texts are edited.
- **Setup-guide links** on the Twilio/Exotel connect forms.

## Not done, and why
- **P2-1** (indexed WhatsApp lookup column), **P2-2** (pgvector): deferred —
  the WhatsApp path is dormant behind the flag and embeddings are fine at
  current scale; both are schema changes better made deliberately.
- **P2-3** (`prisma migrate` adoption): an operational/workflow change for the
  founder to schedule — switching mid-flight on a live DB needs a baseline.
- **P2-6** (automated overage sweep): left manual on purpose — the founder
  explicitly chose the /admin button flow when building overage billing.
- **P2-4/P2-5**: partially done (dead demo-user code removed, finalize logic
  unified); dormant columns and the cascade pipeline intentionally kept.
- **Exotel webhooks are still unauthenticated** — Exotel has no
  Twilio-style signature scheme; mitigations (IP allowlist at Caddy) are a
  deploy-side task, noted here rather than half-done in code.

## ⚠ Deploy notes (read before deploying)
1. **SECRET_ENC_KEY must be set in prod** (it already is on the VM if secrets
   ever decrypted there) — otherwise any secret access now fails loudly by
   design.
2. **Twilio signature validation is ON by default.** The VM sits behind Caddy,
   which preserves Host and sets X-Forwarded-Proto, so real Twilio traffic
   should pass. If calls 403 after deploy, set `TWILIO_VALIDATE_SIGNATURE=false`
   temporarily and check the logged URL vs. the URL configured in Twilio.
3. `WHATSAPP_ENABLED` is unset ⇒ off. Set `WHATSAPP_ENABLED=true` to restore
   the entire WhatsApp stack when Meta approval lands.
   **Update 2026-08-21: this happened.** `WHATSAPP_ENABLED=true` is set on the
   production VM and confirmations go out over WhatsApp on the shared sender.
   The flag still defaults to `false`, and the working-copy `.env` still does
   not set it — so the code and this file both read as if WhatsApp were off.
   The VM environment is the authority; do not infer the live state from here.
4. The Phase 2 commit also picked up the pre-existing untracked
   `privacy/`, `terms/`, and `data-deletion/` pages that were in the working
   tree before this session (they were swept in by `git add -A`).
5. No DB schema changes were made — `prisma db push` is NOT needed.
