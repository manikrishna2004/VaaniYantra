# Data deletion runbook — internal

**Not a public document.** The customer-facing promises live in `/dpa` §6 and §8 and
on `/data-deletion`: acknowledge within **7 days**, complete within **30 days**, then
confirm what was removed. This file is how that actually gets done.

It replaces the hand-written checklist that `/dpa` §8 used to imply. That checklist was
incomplete in a way nobody could see: deleting an organisation row left five tables
standing, still holding patient names, phone numbers and full call transcripts, and the
operator saw the tenant disappear from the dashboard and reasonably believed the data
was gone. Do not delete tenant data by hand. Use the script.

---

## 1. Which request is this?

| Request | Who does it | Path |
|---|---|---|
| Delete one patient | **The clinic, themselves** | Dashboard → patient → Delete patient (§2) |
| Everything held about one person, as a file | Us, manually | §3 — still manual, no endpoint exists |
| Close the account / erase the organisation | Us | §4 — `scripts/delete-org.ts` |

Route the request before you start. Most "delete a patient" emails no longer need us at
all, and answering them with a two-line reply is faster than doing it for them.

---

## 2. One patient — the clinic does this themselves

Since 2026-08-24 this is a button, for **Admin and Owner** roles: the patient's page →
**Delete patient**. Reply to the requester with that, and with what it does, because
the second half is what they actually want to know:

> Their record, consultations, prescriptions, allergies and attachments are removed
> permanently, along with their chatbot access. Your appointment history stays, with
> their name, number and patient number taken off it, so your day sheets and revenue
> still reconcile.

Two things to warn them about, both of which the UI also says:

- **Family members on one number.** If the patient is the main contact for others on
  the same mobile, the delete is refused with a 409. They move or delete the dependents
  first. This is deliberate — the alternative leaves a child's medical record with no
  adult attached to it.
- **Call logs are not covered.** A `Call` has no link to a patient (calls are matched
  to people by phone string), so deleting a patient does not touch call recordings,
  transcripts or summaries. Those are governed by the org's **data retention** window.
  If the requester wants call content gone too, they need a retention window set — say
  so plainly rather than letting them assume it was included.

The action writes a `patient.deleted` audit row carrying the name and UHID. That row is
the only remaining trace of who was erased, which is the point: "Contact `abc123` was
deleted" is not an answerable question afterwards.

---

## 3. Everything held about one person — still manual

There is no subject-access export endpoint (`COMPLIANCE_GAPS.md` #7). Assemble it by
hand:

1. **Reports → Export CSV** in the clinic's dashboard covers calls, appointments,
   patients and updates — but **not** clinical content.
2. Visit records, prescriptions, diagnoses, advice and attachments come from the API,
   or from the database directly.
3. Portal chat turns (`PortalChatTurn`) and WhatsApp turns (`WhatsappTurn`) are not in
   any export path at all.

Budget real time for this. It is the slowest thing in this file, and it is the reason
`/dpa` §6 still says exports are manual. When #7 lands, rewrite this section.

---

## 4. Erase an organisation

Operator-only, on purpose: there is no customer-facing button, so a tenant cannot
destroy their own data by accident, and reaching this needs VM access.

### Before you touch anything

1. **Confirm the requester** is on the account, from the email address on file. This is
   irreversible and there is no backup-restore path that recovers one tenant without
   recovering everything.
2. **Offer the export first** (§3, or Reports → Export CSV). Once this runs, nothing is
   recoverable except from a whole-database backup, which restores every other tenant
   with it.
3. **Check for a live subscription.** Cancel it, or you will bill a customer whose data
   you have deleted.

### Dry run — always first

```bash
# On the VM, in the app directory
npx tsx scripts/delete-org.ts <orgId>
```

It prints the organisation's name, **which database it is pointed at**, and the exact
row counts it would remove. Read the database line every time — the script takes its
`DATABASE_URL` from `.env` like everything else, so a copy of prod credentials in a
local checkout would aim it at live customer data from your laptop.

Sanity-check the counts against the tenant you think you are deleting. A clinic with
4,000 calls and 900 patients is not the test org you created last week.

### Apply

```bash
npx tsx scripts/delete-org.ts <orgId> --apply --confirm="Exact Org Name"
```

`--confirm` must match the organisation's name exactly. An id is easy to paste from the
wrong tab; a name is not something you get right by accident.

It runs as **one transaction**, so a failure part-way leaves the tenant whole rather
than half-erased. If it fails, nothing was deleted — read the error and run it again.

### Keep the output

The final line is a structured `[delete-org] DELETED {...}` record with the org name,
timestamps and counts. **Save it into the ticket.** It is the only surviving record of
the deletion: `AuditLog` cascades away with the organisation, so an audit row would be
destroyed by the very operation it documents.

That output is also what you use to write the "confirm what was removed" reply the
public page promises.

### The alternative path

`DELETE /api/admin/organizations/[id]` does the same thing over HTTP, super-admin
session only, with `{"confirm": "Exact Org Name"}` in the body. `GET` on the same URL
is the dry run. There is deliberately no cron-secret path — a bearer token that erases
an entire customer is not a credential to leave in a shell history.

---

## 5. What deletion does not cover

Say these out loud in the confirmation reply rather than letting a customer discover
them later:

- **Invoices and payment records** are kept for the statutory period, as `/dpa` §8
  says. This is the only exception the public documents claim, so it must stay the only
  one in practice.
- **Database backups** still contain the deleted data until they age out. Nightly dumps
  to GCS with lifecycle expiry — check `scripts/gcs-backup-lifecycle.json` for the
  current window and quote it accurately if asked.
- **Sub-processor copies.** Deleting from our database does not reach into the
  carrier's own logs — Twilio, Plivo or Exotel, depending on the number — or
  Meta's. `/subprocessors` names who holds what.

---

## 6. Related

- `src/lib/org-delete.ts` — the sweep, and comments on why the order matters.
- `src/lib/patients/erase.ts` — what patient erasure keeps and why.
- `COMPLIANCE_GAPS.md` #2 (fixed), #7 (subject-access export, still open).
- `docs/DISASTER_RECOVERY.md` — restores, if a deletion turns out to have been a mistake.
