# Compliance gaps — internal

**Not a public document.** Written 2026-08-03 alongside the rewrite of `/privacy`, `/terms`, `/dpa` and `/subprocessors`.

Those documents were written under one rule: **no claim without a code path.** Where the system could not support a claim, the wording was softened to the truth rather than the truth stretched to the wording. This file is the other half of that bargain — the list of things we chose to describe honestly instead of fixing, so they get fixed deliberately rather than forgotten.

Ranked by what would hurt most, soonest.

---

## P0 — fix before the next hospital contract

### 1. Clinical free text is not encrypted at rest
**Where:** `VisitRecord.diagnosis/prescription/advice/internalNotes`, `PrescriptionItem.*`, `Allergy.*`, `Contact.*` (incl. `dateOfBirth`), `TranscriptTurn.text`, `PortalChatTurn.text`, `WhatsappTurn.text`.

Only two things are encrypted at application level: provider credentials, and uploaded documents (`VisitDocument.data`, via `encryptBytes` in `src/lib/patients/native.ts:222`). Everything a doctor *types* is plaintext in Postgres. A stolen dump is readable medical records.

This is now stated plainly in `/privacy` and `/dpa` §5, which is defensible but will lose deals. The asymmetry is also just odd — a scanned prescription is encrypted, the same prescription typed in is not.

**Fix:** application-level encryption for the clinical columns, using the existing `encryptSecret`/`decryptSecret` seam. Note the real cost: encrypted columns cannot be searched or sorted in SQL, and patient search currently relies on that. Scope it before promising it.

### 2. ~~There is no way to delete a patient, or an organisation~~ — FIXED 2026-08-24

**Patient deletion.** `DELETE /api/patients/[id]`, gated on a new `patient:delete`
permission that sits with **ADMIN**, not MEMBER — this destroys a clinical record and
is not just a stronger write. The logic is `src/lib/patients/erase.ts`, and it is
deliberately *not* a cascade, because two schema decisions already say it must not be:
`Appointment.contactId` is SetNull ("deleting a patient record must never quietly
delete their appointment history") and `Contact.guardian` is SetNull ("deleting a
guardian must not delete a child's medical record").

So it erases the person and leaves the clinic's operational history standing with the
identity scrubbed out:

- **Deleted** (by cascade): visit records, prescription items, visit documents,
  allergies, portal logins, portal chat turns.
- **Anonymised, not deleted**: appointments keep their date, service and doctor;
  `customerName` becomes "Deleted patient", and `customerNumber`, `patientNo` and
  `contactId` are cleared. `patientNo` matters — a denormalised UHID left behind would
  both point at a deleted record and re-identify the person across exports.
- **Deleted only when the number is theirs alone**: `WhatsappTurn` and `PortalOtp` key
  on phone with no contact id, and families share one handset constantly. If another
  patient in the org holds that number, these are kept — deleting them would take a
  live patient's data with them.
- **Refused**: erasing a household primary who still has dependents. The FK would
  SetNull their `guardianContactId` and leave a child with `dependentKey` set and no
  guardian — a state `household.ts` says cannot exist. Staff move or delete the
  dependents first; the 409 says so in those words.
- **Not touched**: `Call`. It has no link to a Contact at all — calls are matched to
  people by phone string — so there is nothing to erase *by patient*. Call content is
  governed by the org retention window instead (gap #4). Worth stating plainly rather
  than implying an erasure covers more than it does.

**Organisation deletion.** `src/lib/org-delete.ts` plus `scripts/delete-org.ts`
(dry run by default; `--apply` also demands `--confirm` matching the org's exact name,
and the run prints which database it is pointed at). A super-admin-only
`GET`/`DELETE /api/admin/organizations/[id]` is the same routine over HTTP, with no
cron-secret path — a bearer token that deletes a whole customer is not a credential to
leave in a shell history.

The five tables that survived a plain `organization.delete` are now swept explicitly,
in an order that matters: **`Call` goes first**, while `workspaceId` still resolves.
`Call` carries no `orgId`, so once the workspace cascade fires there is nothing left to
attribute those rows by and their transcripts are orphaned permanently. Then
`Appointment`, `Outcome`, `WhatsappTurn`, `PortalOtp` by `orgId`, then the
`Organization` row last so its cascades run against an already-clean database. One
transaction, 120s timeout — a busy hospital does not delete inside the default 5s
budget, and a timeout there would roll back a long job.

The deletion summary is **printed, not audited**: `AuditLog` cascades away with the
org, so a row written there would be destroyed by the operation recording it. Keep the
stdout — it is the only surviving record.

**Runbook and documents brought in line 2026-08-24.** `docs/DATA_DELETION_RUNBOOK.md`
is the operational procedure — routing a request, the dry run, `--confirm`, and keeping
the printed record — and it replaces the hand-written checklist `/dpa` §8 implied.

Three public statements had become false and were corrected, in the direction of the
code rather than away from it:

- `/dpa` §6 and `/data-deletion` said deleting a single patient was done "by our team
  rather than a button in the dashboard". It is a button now. Both now say so, and both
  still say the *complete export* of one person's data remains manual (gap #7).
- `/dpa` said "reads of a patient record are not individually audited". They are, along
  with patient searches and CSV exports (gap #5).

`LEGAL_REVIEW_PACKET.md` mirrors all three and was updated with them — sending counsel a
stale gap list would be worse than sending none.

The customer-facing promise itself ("within 30 days, by our team", invoices excepted) is
unchanged, and is now one the software can actually keep.

### 3. Children's data is unhandled
**Where:** `src/lib/patients/household.ts`, `src/lib/patients/age.ts`, `src/app/api/patients/route.ts` (`asFamilyMember`).

We store `dateOfBirth`, compute age (`age.ts` handles infants — "under one month in DAYS"), and **feed that age into the chatbot prompt**. Dependants are registered against a guardian's phone. There is no age check, no parental-consent record, no age gate on a child's own portal session, and no restriction on sentiment/topic profiling for minors.

DPDP s.9 requires verifiable parental consent for under-18s and restricts tracking and behavioural monitoring of children. `/privacy` now discloses that we do not verify age and that consent is the clinic's responsibility. That is a defensible processor position, not a complete answer.

**Fix (minimum):** flag contacts whose DOB implies under-18; record a guardian-consent artefact at registration; suppress sentiment/topic profiling for them.

---

## P1 — fix soon

### 4. ~~Retention is off by default and depends on one process~~ — FIXED 2026-08-24
`Organization.dataRetentionDays` still defaults to `null` = keep forever (that part is a product decision, not a defect). The single-process dependency is resolved:

- `POST /api/admin/retention` runs the same `tickRetention()` from a super-admin session or a `RETENTION_CRON_SECRET` bearer token, mirroring the overage sweep.
- `scripts/retention-sweep.sh` calls it daily from cron. The in-process `setInterval` is kept — `tickRetention()` guards re-entry — so the two are belt-and-braces rather than a swap.
- `scripts/check-retention-freshness.sh` gives it the same Cloud Logging alert treatment as `check-backup-freshness.sh`, checking the **outcome**: every completed run stamps `PlatformConfig['retention.lastSweepAt']`, and the check alerts when that marker goes stale (>48h). A sweeper that starts, throws halfway and exits 0 never advances the marker.

⚠ **Needs VM install to be live:** set `RETENTION_CRON_SECRET` in `.env` and add both crontab entries, or this ships inert.

### 5. ~~Reading a patient record is not audited~~ — FIXED 2026-08-24
Three events now cover the read paths, using the existing `audit()` helper:

- `patient.read` on `GET /api/patients/[id]`, written after the workspace scope check (a probe for another tenant's id 404s and leaves no row — that is a tenancy event, not a record access).
- `patient.searched` on the patient list route, recording the query and the result count but not the ids.
- `report.exported` on every CSV download, recording type, range, row count and whether the `ROW_CAP` was hit.

**A privilege bug was found while fixing this, and also fixed.** The export route gated all four types on `call:read`, which quietly defeated the split `permissions.ts` draws on purpose: `patient:read` is withheld from VIEWER so a read-only seat sees call history and no medical records — but VIEWER *has* `call:read`, so `?type=patients` handed them the whole patient list with dates of birth. `EXPORT_PERMISSION` in `src/lib/reports.ts` now maps `patients`/`appointments` → `patient:read`, the route enforces it, and `ExportMenu` offers a seat only what it can actually download.

### 6. ~~Audit logs are kept forever~~ — FIXED 2026-08-24
`tickRetention()` now purges `AuditLog` past `AUDIT_RETENTION_DAYS` (400 days — a full year of lookback plus room for an investigation that starts late). Deliberately a platform constant, **not** an org setting: a tenant must not be able to shorten the record of what its own staff did to patient data. The purge is wrapped so a failure there cannot abort the call-content sweep.

⚠ **Still outstanding:** state the audit retention period in `/privacy`. The code is done; the disclosure is not.

### 7. No subject-access export
No endpoint produces everything held about one person. The staff CSV excludes all clinical content. `/dpa` §6 admits this is manual. **Fix:** a proper per-patient export (records, visits, documents, chat turns, appointments) — this also makes P0-2 easier.

---

## P2 — known, accepted for now

- **Single-region US hosting.** GCP `us-east1` for app, database and backups; Gemini/Twilio/Meta on global endpoints. Disclosed in `/privacy` and `/subprocessors`. Blocks any customer with a localisation requirement. India-resident hosting is a large piece of work.
- **No third-party certification.** No ISO 27001, no SOC 2. `/dpa` §11 says so rather than implying otherwise.
- **No SSO/SAML, no customer-managed keys, no MFA enforcement.** Standard hospital procurement asks.
- **Recording disclosure is a prompt instruction**, not a deterministic pre-roll, and nothing records that it was spoken. It also says nothing about *transcription*, which happens on 100% of calls regardless. `/security` now says treat it as an aid, not a guarantee.
- **Slack webhooks** — *entry rewritten 2026-08-24; the original prescription was wrong.* It said to HMAC-sign Slack deliveries "like other webhook types". That would accomplish nothing: a Slack Incoming Webhook is authenticated by the secrecy of its URL and Slack will never verify an `X-VaaniYantra-Signature`. Adding the header is decoration, and shipping it would have closed this item without changing the exposure.

  The real question is payload, and it splits in two:
  - **Fixed.** The caller's phone number is now masked to last-4 in `formatSlackMessage()`. It was incidental to the card's purpose, and whoever holds the URL — a leaked config, a former employee's export, anyone in the channel — was getting a patient phone directory alongside the notifications.
  - **Accepted, and it is a disclosure not a defect.** The AI summary and the collected fields still go to Slack unmasked. That is what a clinic connects Slack *for*; a card reading "a call happened" is not worth having. What this needs is a line in the user docs saying what a connected Slack channel receives, not a code change.
- **`Cashfree_APIKey.csv` / `Cashfree_Production_APIKey.csv`** sit in the repo root. They are gitignored (`.gitignore:24 *apikey*`) and untracked — re-verified 2026-08-24 — but they are live merchant credentials in plaintext on disk. Move them to a password manager. **Founder action; not something code can fix.**
- **`.env` holds live secrets** including a plaintext third-party account password (`OPEN_QUESTIONS.md` Q1). Rotation is still outstanding. As of 2026-08-24 a tripwire exists: `validateConfig()` reports `META_PASSWORD` as an **error-level** problem in every environment, so a boot with it set says so loudly in the logs. Nothing in the codebase has ever read that variable — deleting the line is safe and breaks nothing.

  Note the tripwire *reports*; it does not hard-exit. `reportConfig()` deliberately logs rather than killing the voice-server so an in-progress call is not dropped over a config complaint, and taking production down over an unused env var would be worse than the disease. The rotation itself is still a founder action.

---

## Cross-references

- `/privacy` — §"Security", §"How long we keep it", §"Your rights", §"Children's data" all describe P0-1, P0-2, P0-3 and P1-4 as they stand today.
- `/dpa` §5 lists the security limits; §6 admits manual DSR handling; §11 admits no audit report.
- `/subprocessors` — the residency disclosure for P2.
- `E2E_TEST_REPORT.md` — the security defects found and fixed on 2026-08-02/03.
- `OPEN_QUESTIONS.md` — Q1 (secrets), Q4 (no PII redaction, transcripts unencrypted) overlap with P0-1.

**A note on sequencing.** P0-1 and P0-2 are the two a hospital's IT security review will find in the first hour. Neither is small, and both are cheaper now than after a customer's auditor writes them up.
