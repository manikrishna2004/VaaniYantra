# TODO — prioritized from AUDIT.md (2026-07-13)

> **API-contract flags:** none of the items below break the public `/api/v1/*`
> contracts or the stored `agent_config` (Agent/bookingConfig/outcomeConfig)
> schema. The WhatsApp migration (Phase 2) keeps `channel`/`messagingChannel`
> accepted in all schemas — WhatsApp values are *accepted* either way, and are
> routed to SMS only while `WHATSAPP_ENABLED=false`.

> ⚠ **WhatsApp is LIVE in production (since 2026-08-21).** `WHATSAPP_ENABLED=true`
> is set on the VM, so P0-1 below describes the flag mechanism, not the current
> state — messaging goes out over WhatsApp, not SMS. The repo default
> (`.env.example`) stays `false` so a fresh checkout does not try to reach Meta.
> See `SUMMARY.md` for the deployment note. Anything that reads this file to
> answer "does it do WhatsApp?" should answer **yes**.

## P0 — broken / dangerous

- [x] **P0-1** Feature-flag WhatsApp off (`WHATSAPP_ENABLED=false`); route all messaging through SMS; hide WhatsApp everywhere in the UI. — Done (commit e823c8c): flags.ts + transport reroute + UI/API gating; schemas still accept 'whatsapp' values (delivered as SMS).
- [x] **P0-2** Validate Twilio webhook signatures (`X-Twilio-Signature`) on voice-server `/voice` + `/status` and Next `/api/whatsapp/twilio-inbound`; reject spoofed posts. — Done: `src/lib/telephony-signature.ts` (HMAC-SHA1 per Twilio spec, tries platform + BYO-account tokens, opt-out via TWILIO_VALIDATE_SIGNATURE=false); wired into voice-server + Next twilio voice/status + twilio-inbound; 7 tests incl. reference vector.
- [x] **P0-3** `crypto.ts`: refuse to boot in production without `SECRET_ENC_KEY` (no silent default key). — Done: hard throw at module load when NODE_ENV=production and key missing; 3 tests. ⚠ Deploy note: prod VM must have SECRET_ENC_KEY set (it should already) or the app will refuse to start by design.
- [x] **P0-4** Remove the demo-user (`demo@vaani.ai`) fallback from voice-server inbound routing — unknown numbers get a polite reject, never another tenant's agent. — Done: fallback removed from voice-server + Next twilio voice route (also fixed its `userId: ''` FK bug + missing workspaceId); getCurrentUser/DEMO_USER_EMAIL deleted from db.ts; unrouted inbound now logs a call with endedReason `no_agent` and speaks a polite reject.
- [x] **P0-5** `sendSms`: per-org sender first, platform env From only as last resort; never mix org creds with platform From. — Done: coherent (creds, From) pairing — org creds ⇒ org From, platform creds ⇒ platform From (or creds-less paste-in sender); 4 tests with stubbed Twilio API.
- [x] **P0-6** Wrap `req.json()` in API routes (400 on malformed JSON, not 500). — Done: `readJson()` helper in validation.ts; applied to the 3 unguarded routes (agents POST/PATCH, calls/outbound); every other route already used `.catch(() => ({}))`.
- [x] **P0-7** Add a test framework (vitest) + first tests covering messaging routing (flag on/off), toE164, and webhook signature validation. — Done: vitest + `npm test`; 13 tests over flag routing, channel resolution, prompt clause, toE164. (Signature tests land with P0-2.)

## P1 — confusing UX / correctness

- [x] **P1-1** Allow creating an agent with **no phone number**; require a number only to go live. Update empty states to lead with web-test/demo. — Done: API gate removed; wizard banner is now informational (create+test first, connect number later); agent page shows a "ready to test / connect a number to go live" hint; 3 route tests.
- [x] **P1-2** Booking races: re-check capacity/free-busy under a serialized guard (transaction/advisory lock) before create. — Done: `claimSlot()` — pg advisory xact lock on (org, slot) + in-tx recount + create; calendar event created after the claim (row released on failure); reschedule guarded the same way; 4 tests.
- [x] **P1-3** WhatsApp follow-up chat picks "most recently updated agent" — resolve the agent from the number the caller messaged instead. — Done: handleInboundWhatsApp takes `toNumber`, digit-matches the org's numbers and uses that number's assigned agent (fallback to old behavior only when unresolvable); 2 tests. (Path is dormant while WhatsApp is off, but correct when re-enabled.)
- [x] **P1-4** `statusWebhook`: unknown Twilio status must not resurrect calls (no-op on unknowns, don't overwrite terminal states). — Done in both voice-server and the Next route: unknown → ignore; non-terminal updates filtered with `status notIn terminal` (updateMany); 4 tests.
- [x] **P1-5** Finalize: don't mark WS-error calls COMPLETED with a billed minimum; FAILED + zero duration when no conversation happened. — Done: shared `finalizeCallRecord()` (src/lib/voice/finalize.ts) used by both pipelines; zero-transcript calls → FAILED/0s/`no_conversation` + call.failed webhook; 2 tests. Also de-duplicates the finalize logic (part of P2-5).
- [x] **P1-6** Owner alert numbers: validate as phone numbers server-side (must pass toE164) with inline UI hint. — Done: zod refine+transform to E.164 in agentInputSchema; wizard rejects bad entries inline with a plain-language message; 4 tests.
- [x] **P1-7** Plain-language copy pass on agent wizard labels/hints/errors (drop "E.164", soften "system prompt"/jargon). — Done (Phase 4): every user-facing "E.164" replaced with "with country code, e.g. +91 98765 43210"; "Behavior prompt/system prompt" → "What should the agent say and do?"; step names/descriptions rewritten plain, optional steps say so; agent can now be created from ANY step (later steps are pre-filled by the vertical), footer says the rest is optional.
- [x] **P1-8** Overage visibility: dashboard banner when `inOverage`, with ₹ so far. — Done: amber banner on /dashboard (server-computed via overageFor) with minutes, ₹ so far, rate, and a billing link; 4 tests on overageFor.
- [x] **P1-9** DLT reality: document DLT requirement for Indian SMS (sender ID + registered template text) in user docs + inline note where confirmation messages are edited. — Done: DLT section in docs/USER_GUIDE.md (Connectors → SMS) with the 3 registration steps; inline note + doc link on the wizard's messages card.

## P2 — nice-to-have

- [ ] **P2-1** Indexed lookup column for WhatsApp/Cloud phone-number ids (kill O(n) decrypt scans).
- [ ] **P2-2** pgvector for embeddings.
- [ ] **P2-3** Adopt `prisma migrate` instead of `db push`.
- [~] **P2-4** Delete dead code. — Partially done: `DEMO_USER_EMAIL`/`getCurrentUser` removed (with P0-4); `voiceStages`/`voiceProvider`/`workflowReached` columns + the cascade pipeline left in place (additive-harmless; cascade is still the documented non-Live fallback).
- [~] **P2-5** Unify template rendering. — Partially done: finalize logic de-duplicated into `finalizeCallRecord()` (with P1-5); confirmation/outcome template engines left separate (behavior-preserving refactor, low value right now).
- [x] **P2-6** Automate the monthly overage sweep. — Done: sweep extracted to `src/lib/overage-sweep.ts`; `/api/admin/overage` now also accepts `Authorization: Bearer $OVERAGE_CRON_SECRET` (timing-safe, disabled when unset); `scripts/overage-sweep.sh` + crontab (2nd & 5th monthly, idempotent). Needs VM install: set OVERAGE_CRON_SECRET in .env + crontab entry.
- [x] **P2-7** Contextual doc links from Twilio/Exotel connect forms. — Done: "Setup guide" link to /docs/user-guide on both connect forms.
