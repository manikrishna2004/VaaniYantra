# Enterprise Hardening — Changelog

Running log of changes made on the `enterprise-hardening` branch. Newest first.
Each entry references a finding ID from AUDIT_REPORT.md.

## Unreleased (enterprise-hardening)

- **feat(growth)**: "Book a call with our team" — a dismissible dashboard prompt that
  books a 30-minute onboarding call against VaaniYantra's own calendar, and puts it on
  the customer's calendar too.
  - **Reuses the patient-booking machinery unchanged.** `freeBusy()`,
    `computeOpenSlots()` and `createEvent()` were built for patients booking with
    doctors; the only thing they lacked was attendee support.
  - **`createEvent` now takes `attendees` / `notifyAttendees` / `addMeet`.** Adding the
    customer as an attendee is the *entire* mechanism by which the meeting reaches
    their calendar — we never touch it and never ask for access. Note `sendUpdates` and
    `conferenceDataVersion` are **query** parameters: put them in the body and Google
    still returns 200, the event exists, nobody is ever notified and there is no Meet
    link. `tests/calendar-event-invite.test.ts` pins that, because the failure is silent.
  - **`src/lib/team-call.ts`** holds the platform calendar in `PlatformConfig`,
    encrypted, **not** in the `Integration` table — every row there is tenant data
    scoped to an orgId, and this connection belongs to no tenant.
  - **New OAuth target `platform`**, gated on `isSuperAdmin` in *both* the connect and
    callback routes. The callback re-checks rather than trusting `state`, which
    round-trips through Google and is attacker-controllable in principle.
  - **Booking re-checks free/busy inside the request** rather than trusting the slot the
    browser posts back, and returns a 409 the banner recovers from by refreshing its
    list. Past times and times beyond the advertised window are refused.
  - **Fails invisible.** No calendar connected, a revoked grant, an unreachable Google,
    or a config that will not decrypt all yield zero slots and no banner — never an
    exception on a dashboard someone opened for another reason. The banner also sits
    *outside* `DashboardView`'s `alerts`: those are problems wanting attention, and
    mixing an offer in teaches people to skim the row that reports real failures.
  - **No schema change.** "Has this org already booked?" reads the `team_call.booked`
    audit row, which has to exist anyway; a bespoke table for a dismissible banner is
    not worth a migration.
  - Admin card at `/admin` to connect, reconnect or disconnect, reporting how many slots
    are actually being offered — "connected" alone does not tell you the prompt is
    working, since a revoked grant and a fully-booked week look identical.
  - **Setup required:** connect the calendar once at `/admin` → *Team call calendar*.
    Until then the prompt does not render at all.
  - Suite **712 → 730 tests**; `tsc --noEmit` clean; routes verified returning 401 (not
    404, not 500) against a clean dev server.

- **feat(seo)**: brand findability. The site is **not indexed at all** —
  `site:vaaniyantra.com` returns nothing — so this is a discovery problem, not a
  markup one. On-page SEO was already good: correct title, description, canonical,
  `robots: index/follow`, a real sitemap, nothing blocking in headers or robots.txt.
  The decisive fix is a Google Search Console submission, which is a founder action;
  these are the code parts that support it.
  - **`Organization.sameAs` + `alternateName`** (`src/components/Landing.tsx`). This
    is the actual lever for the brand-name problem: "vaaniyantra" currently returns
    Vedic Vaani's yantra catalogue because Google parses the coined word as
    "vaani" + "yantra" with no entity to bind it to. `alternateName` covers the
    spacing variants; `SOCIAL_PROFILES` is **deliberately empty** and filtered out
    when unset — an unverifiable `sameAs` is a claim without a code path.
    ⚠ Fill it in with real, live profile URLs that link back here.
  - **Fixed a structured-data drift bug**: `JSON_LD` was a module-scope const reading
    `PLAN_CATALOGUE`, so a price overridden in `/admin` changed the visible page and
    left the schema quoting the old figure — reintroducing exactly the bug the
    pricing section had already fixed, and the drift the file's own FAQ comment
    warns about. Now `buildJsonLd(pricingPlans)`, built from the same plans the page
    renders. Verified: all 10 plans match the visible pricing grid.
  - **`GOOGLE_SITE_VERIFICATION`** env hook in `layout.tsx` + `.env.example`. Unset =
    no tag emitted. DNS TXT verification is preferred and noted as such.
  - **Three marketing pages** — `/ai-receptionist-for-clinics`, `/for-dental-clinics`,
    `/languages` — added to `sitemap.ts` above the docs. The domain previously had
    exactly one page answering a question anyone types into a search engine; 8 of its
    14 sitemap URLs were legal boilerplate. Copy is drawn from `LAUNCH_COPY.md` and
    `OUTREACH.md` and obeys the §7 rules (no HIPAA, no SOC 2, no "fully encrypted",
    transcripts not recordings, no customer claims). `/languages` renders its list
    from `constants.ts` rather than hand-typing it — constants.ts:640 carries the scar
    from marketing copy that outran the configured locales.
  - **Correction:** an earlier draft of this work added a `public/og.png` and declared
    `openGraph.images`. That was wrong — `src/app/opengraph-image.tsx` already
    generates a proper branded 1200×630 card via the Next file convention, which is
    live and working. The redundant file and metadata were removed and a comment left
    in `layout.tsx` so nobody re-adds them.
  - Suite unchanged at **712 tests / 64 files**; `tsc --noEmit` clean; all three pages
    verified rendering 200 and the JSON-LD verified parsing against a dev server.

- **docs(privacy)**: deletion runbook, and three public statements the delete work
  had made false.
  - **`docs/DATA_DELETION_RUNBOOK.md`** — the operational procedure behind the
    "within 30 days, by our team" promise: routing a request (most "delete a
    patient" emails no longer need us), the dry run, `--confirm`, and keeping the
    printed record because `AuditLog` cascades away with the org. Replaces the
    hand-written checklist `/dpa` §8 implied — the one that quietly left five
    tables standing.
  - **Public corrections, toward the code rather than away from it.** `/dpa` §6 and
    `/data-deletion` both said deleting a single patient was handled "by our team
    rather than a button in the dashboard". It is a button now. Both say so, and
    both still say the *complete export* of one person's data is manual (gap #7),
    which remains true. `/dpa` also said "reads of a patient record are not
    individually audited" — they are, along with patient searches and CSV exports.
  - `LEGAL_REVIEW_PACKET.md` mirrors all three claims plus the gap list, and was
    updated with them. It is a draft for external counsel; a stale gap list there
    is worse than none.
  - The customer-facing promise itself is unchanged, and is now one the software
    can actually keep.

- **feat(privacy)**: patient and organisation deletion — the second hardening pass.
  (COMPLIANCE_GAPS #2)
  - **`DELETE /api/patients/[id]`** behind a new **`patient:delete`** permission at
    ADMIN, not MEMBER: this destroys a clinical record, unlike the writes a front
    desk does all day. `src/lib/patients/erase.ts` holds the logic.
  - It is **not** a cascade, because the schema already decided it must not be —
    `Appointment.contactId` and `Contact.guardian` are both SetNull with comments
    saying why. So it erases the person and keeps the clinic's history with the
    identity scrubbed: appointments keep date/service/doctor, lose name, number
    and `patientNo`. Visit records, prescriptions, allergies, attachments, portal
    logins and chat turns go by cascade.
  - `WhatsappTurn` and `PortalOtp` key on phone with no contact id, so they are
    removed **only** when no other patient in the org shares that number —
    families share one handset constantly and deleting them blind would take a
    live patient's data. Erasing a household primary who still has dependents is
    refused with a 409 that says what to do first.
  - `Call` is deliberately untouched: it has no link to a Contact, so there is
    nothing to erase per-patient. Call content is governed by the retention
    window instead, and the docs say so rather than implying wider coverage.
  - **Org deletion**: `src/lib/org-delete.ts`, `scripts/delete-org.ts` (dry run by
    default; `--apply` demands `--confirm` matching the exact org name and prints
    which database it is aimed at), and a super-admin-only
    `GET`/`DELETE /api/admin/organizations/[id]` with no cron-secret path.
  - A plain `organization.delete` left five tables behind holding patient names,
    numbers and transcripts. They are now swept in an order that matters: **Call
    first**, while `workspaceId` still resolves — Call has no `orgId`, so after
    the workspace cascade there is nothing left to attribute it by — then
    Appointment, Outcome, WhatsappTurn, PortalOtp, then Organization last. One
    transaction, 120s timeout.
  - The deletion summary is printed rather than audited: `AuditLog` cascades away
    with the org, so an audit row would be destroyed by the operation recording it.
  - **Also fixed**: the patient screen's write gate read `call:write`; it now reads
    `patient:write`. Identical for all four roles today, but the same
    wrong-permission pattern as the export bug and worth correcting before the
    two ever diverge.
  - **Also fixed**: `tests/terms-acceptance.test.ts` registered `vi.mock('@/lib/db')`
    **twice** with competing factories; only the second defined
    `organization.update`. Which won was scheduling-dependent, and adding test
    files surfaced it as an intermittent failure. Merged into one mock.
  - Suite: **700 → 712 tests**, `tsc --noEmit` clean, verified stable over repeated runs.

- **fix(reliability/security)**: startup-grade hardening pass — the recorded
  problems that are ordinary defects rather than certification work. Public
  compliance documents are deliberately untouched: this pass changes engineering
  priorities, not a single claim. (COMPLIANCE_GAPS #4, #5, #6, P2; OPEN_QUESTIONS Q1)
  - **Retention no longer depends on one process.** It ran only as a 6h
    `setInterval` inside the voice-server, so if that process was down every
    org's retention window silently stopped being enforced. New
    `POST /api/admin/retention` (super-admin session or `RETENTION_CRON_SECRET`
    bearer) + `scripts/retention-sweep.sh` on a daily cron; the in-process tick
    stays, since `tickRetention()` already guards re-entry.
    `scripts/check-retention-freshness.sh` alerts to Cloud Logging when the
    `retention.lastSweepAt` marker goes stale, the same outcome-based check
    `check-backup-freshness.sh` uses.
  - **`AuditLog` now has a retention window** — `AUDIT_RETENTION_DAYS = 400`,
    a platform constant rather than an org setting so a tenant cannot shorten
    the record of what its own staff did. Purge failure cannot abort the
    call-content sweep.
  - **Read auditing**: `patient.read`, `patient.searched` and `report.exported`.
    Only writes were audited before, and read access is what an investigation
    actually needs.
  - **Privilege fix found while adding that audit**: `/api/reports/export` gated
    all four types on `call:read`, which VIEWER holds — so `?type=patients`
    handed a read-only seat the whole patient list with dates of birth, defeating
    the `patient:read` split `permissions.ts` draws on purpose. New
    `EXPORT_PERMISSION` map in `lib/reports.ts`; the route enforces it and
    `ExportMenu` offers only what a seat can download.
  - **Slack cards mask the caller's number** to last-4. Signing them (as
    COMPLIANCE_GAPS originally prescribed) would have been decoration — Slack
    authenticates by URL secrecy and never checks our HMAC. The summary still
    goes through: that is what a clinic connects Slack for, and it is now
    documented in the user guide as a disclosure.
  - **`META_PASSWORD` tripwire**: `validateConfig()` reports it error-level in
    every environment. No code has ever read it. Reports rather than hard-exits,
    so a config complaint cannot drop a live call.
  - **Shared `lib/cron-auth.ts`** — timing-safe bearer compare extracted from
    `overage-sweep.ts`, now used by both crons.
  - Records reconciled: `E2E_TEST_REPORT.md` claimed "nothing committed or
    deployed" while the D1/D2 fixes were in the tree; `TODO.md` and the user
    guide still said WhatsApp was off and confirmations went by SMS, though it
    has been live since 2026-08-21; `ROADMAP.md` was still titled Callsera.
  - Suite: **679 → 700 tests**, `tsc --noEmit` clean.
  - ⚠ **Deploy:** set `RETENTION_CRON_SECRET` in the VM `.env` and install both
    crontab entries, or the retention cron and its alert ship inert.

- **feat(billing)**: **Cashfree is the payment gateway** — PayU (and every other
  provider) removed. The merchant account is approved and live, but only the
  **Payment Gateway** product is active; **Subscriptions** is still awaiting
  activation, so billing supports both behind one interface:
  - `src/lib/cashfree.ts` — config, `cfFetch`, PG `createOrder`/`getOrder`,
    Subscriptions `createSubscription`/`cancel`/`chargeSubscription`, and
    raw-body HMAC `verifyWebhook`. Plans are created **inline** on each
    subscription (`plan_details` takes the full spec), so there are no Plan IDs
    to maintain in the Cashfree dashboard and pricing stays in `lib/billing.ts`.
  - `checkoutMode` picks the flow from one `/admin` switch: `order` (pay one
    month at a time, manual renewal — all the PG can do) or `subscription`
    (UPI Autopay / e-NACH / card mandate that Cashfree auto-debits).
  - Routes: `/api/billing/checkout` (mode-aware), `/api/billing/cashfree/webhook`,
    `/api/billing/cashfree/return` (re-reads the order from Cashfree so a payer
    never sees a stale plan when the webhook loses the redirect race),
    `/api/admin/cashfree`. `PATCH /api/billing` can no longer self-assign a paid
    plan once payments are configured.
  - **Deleted**: `lib/payu.ts`, `lib/payu-recurring.ts`, all `/api/billing/payu/*`
    routes, `/api/admin/payu`, and the daily pre-debit/debit cron — Cashfree owns
    the recurring schedule, so we no longer run a billing engine.
  - Overage sweep charges the mandate directly (`/subscriptions/pay`, scheduled
    3 days out); in PG-only mode every charge is `manual` by design.
  - Schema: `payuAuthId/payuTxnId/payuPhone/payuEmail/nextDebitAt/preDebitSentAt`
    → `cashfreeSubscriptionId`, `cashfreeOrderId`, `paidUntil`, `billingPhone`,
    `billingEmail` (needs `prisma db push` on deploy).
  - 142 tests green (`tests/cashfree.test.ts` replaces `tests/payu.test.ts`).
- **feat(billing)**: ~~**Razorpay Subscriptions** integration~~ (superseded by
  Cashfree above; Razorpay merchant KYC failed) — was: (replaces Cashfree,
  whose merchant KYC was slow). New `src/lib/razorpay.ts` (config, create/cancel
  subscription, overage addon, HMAC webhook + checkout signature verification,
  built on `fetchWithTimeout`); routes `/api/admin/razorpay`,
  `/api/billing/razorpay/checkout`, `/api/billing/razorpay/webhook`; cancel +
  overage-sweep made Razorpay-first (Cashfree kept for legacy mandates); billing
  page + admin dashboard now use Razorpay; `Organization.razorpaySubscriptionId`
  added (additive column — needs `prisma db push` on deploy). +11 tests.
- **feat(connectors)**: drop per-org WhatsApp + SMS connectors (WhatsApp is the
  platform default sender).
- **ci** [F-7.2]: CI now tests every branch (not just main) + runs an
  informational production dependency audit.
- **chore(deps)** [C3, F-8.1]: applied non-breaking `npm audit fix` (lockfile
  only; tests green). Remaining advisories need breaking major bumps — the
  critical is dev-server-only (no prod exposure); tracked in OPEN_QUESTIONS Q7.
- **feat(security)** [C4, F-5.2]: `src/lib/auth/tenant.ts` — tenant-isolation
  guards (`assertSameOrg/Workspace`, `orgScope/workspaceScope`) that make
  cross-tenant filters explicit and non-omittable (the tenant key can't be
  overridden by a caller `where`). +9 tests. Full RLS/middleware enforcement
  tracked in OPEN_QUESTIONS Q5.
- **perf(db)** [B2, F-3.2]: `db.ts` — tunable Prisma connection pool via
  `DATABASE_CONNECTION_LIMIT` (`buildDatasourceUrl`, SQLite-safe). +6 tests.
- **perf(whatsapp)** [B1, F-9.2]: `getMetaConfig` now caches (30s TTL,
  `invalidateMetaConfigCache`) instead of 8 DB reads per WhatsApp send.
- **feat(reliability)** [A3 adoption, F-2.1/F-2.2]: adopted `fetchWithTimeout`
  in the runtime-critical external calls — Meta WhatsApp sends
  (`whatsapp-cloud.ts` sendCloudText/sendCloudTemplate: 15s timeout + 2 retries),
  the Plivo adapter's central `api()` (covers place-call/webhook/number ops), and
  Twilio `placeCall`. A hung provider can no longer strand a call or drop a
  confirmation.
- **feat(config)** [A1 adoption]: voice-server validates + reports config at boot
  (`reportConfig`), surfacing prod-critical misconfig in pm2 logs immediately.
- **feat(config)** [A1/C1, F-1.1/F-4.6]: `src/lib/config/env.ts` — centralized,
  pure/testable config validation (`validateConfig`, `assertConfigOrThrow`,
  `reportConfig`) that fails loud+early on prod-critical misconfig (missing
  SECRET_ENC_KEY / DATABASE_URL / PUBLIC_BASE_URL, SQLite-in-prod). +8 tests.
- **feat(log)** [A2, F-6.1/F-4.3]: `src/lib/log.ts` — structured, level-filtered
  logger with automatic secret redaction (`redact` masks token/secret/password
  keys and token-shaped values) and child loggers for call/request correlation.
  +7 tests.
- **feat(net)** [A3, F-2.1/F-2.2]: `src/lib/net/fetch.ts` — `fetchWithTimeout`
  with AbortController deadline + bounded exponential-backoff-with-jitter retry
  on transient failures (429/5xx/network/timeout); 4xx pass through. +12 tests.
- **docs**: Added AUDIT_REPORT.md (Phase 1 audit + Phase 2 gap analysis + Phase 3
  roadmap), OPEN_QUESTIONS.md (risky/deferred items), and this CHANGELOG.
