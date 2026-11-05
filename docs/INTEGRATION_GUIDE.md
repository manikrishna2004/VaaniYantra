# VaaniYantra — Integration Guide

For developers connecting an existing clinic, hospital or practice-management
system to VaaniYantra.

You do **not** have to move off your current system. VaaniYantra can either be
your system of record, or sit on top of the one you already run — the AI phone
agent and the patient chatbot behave identically either way.

---

## Table of contents

1. [Choosing an integration mode](#1-choosing-an-integration-mode)
2. [Authentication](#2-authentication)
3. [Pushing patients](#3-pushing-patients)
4. [Pushing consultations](#4-pushing-consultations)
5. [Receiving events from us](#5-receiving-events-from-us)
6. [The patient chatbot link](#6-the-patient-chatbot-link)
7. [Errors, limits and idempotency](#7-errors-limits-and-idempotency)
8. [Going live](#8-going-live)

---

## 1. Choosing an integration mode

Your organization is set to one mode by our team. It decides where clinical
records live; everything else about the product is the same.

| Mode | Who owns records | You build | Best for |
|---|---|---|---|
| `native` | VaaniYantra | Nothing | Clinics with no existing software |
| `push` | **You** | One or two POST calls | **Most integrations — start here** |
| `rest` | You | A read API we call | You cannot push, but can expose reads |
| `fhir` | You | FHIR R4 endpoints | Hospitals with a standards-compliant HIS |

**We recommend `push`.** It is the least work for you, it needs no inbound
access to your network, we hold no credentials of yours, and — importantly —
your server being slow or offline never stops a patient reading their
prescription in the chatbot.

> `rest` and `fhir` are on the roadmap; talk to us before designing against
> them. `native` and `push` are live today.

### What changes in `push` mode

- Our staff UI stops offering "Record a consultation" — your system is
  authoritative, and an edit on our side would be overwritten by your next sync.
- Records you push are marked as owned by your system and cannot be deleted in
  our UI.
- Appointments stay with us (they are driven by the connected calendar). You
  receive them as [events](#5-receiving-events-from-us).

---

## 2. Authentication

Create an API key in **Settings → API keys**. Send it as a bearer token:

```
Authorization: Bearer vk_live_xxxxxxxxxxxxxxxx
```

Keys are organization-scoped. The plaintext is shown once at creation — store
it in your secret manager, not in source control.

Base URL: `https://vaaniyantra.com`

---

## 3. Pushing patients

Create or update a patient. **Idempotent on `externalId`** — send the same
patient twice and the second call updates the first.

```http
POST /api/v1/patients
Authorization: Bearer vk_live_...
Content-Type: application/json

{
  "externalId": "PMS-4471",
  "name": "Ravi Kumar",
  "phone": "+919876543210",
  "email": "ravi@example.com"
}
```

```json
{
  "id": "cm5x...",
  "externalId": "PMS-4471",
  "uhid": "SCD-000147",
  "name": "Ravi Kumar",
  "phone": "+919876543210",
  "portalUrl": "https://vaaniyantra.com/c/smile-care-dental",
  "created": true
}
```

- `phone` is required and must be reachable by SMS — it identifies the patient
  across bookings, it is where their chatbot link is sent, **and it is what they
  sign in to the chatbot with**. Indian 10-digit numbers are accepted and
  normalised to `+91…`.
- `externalId` is your patient id. Strongly recommended: without it we match on
  phone number alone, and two family members sharing a number will collide.
- `uhid` is *our* patient number, assigned automatically and shown on our
  screens and exports. Yours stays `externalId`; the two are independent.
- `portalUrl` is your clinic's chatbot address — see
  [section 6](#6-the-patient-chatbot-link).

**Look a patient up:**

```http
GET /api/v1/patients?externalId=PMS-4471
GET /api/v1/patients?phone=+919876543210
```

---

## 4. Pushing consultations

After a consultation, push what was prescribed. This is what the patient's
chatbot answers from.

`{id}` accepts **either** our patient id **or** your `externalId`, so you never
have to store our identifiers.

```http
POST /api/v1/patients/PMS-4471/visits
Authorization: Bearer vk_live_...
Content-Type: application/json

{
  "externalId": "PMS-VISIT-88",
  "visitedAt": "2026-07-29T10:30:00+05:30",
  "expertName": "Dr. Rao",
  "service": "Root canal — follow-up",
  "diagnosis": "Irreversible pulpitis, 36",
  "prescription": "Amoxicillin 500mg — 1-0-1 after food, 5 days\nIbuprofen 400mg — as needed for pain, max 3/day",
  "advice": "Warm salt-water rinse twice daily. Avoid chewing on that side for 3 days.",
  "followUpAt": "2026-08-12",
  "internalNotes": "Patient anxious about needles — allow extra time.",
  "sharedWithContact": true,
  "attachments": [
    { "name": "prescription.pdf", "mimeType": "application/pdf", "contentBase64": "JVBERi0xLjcK..." }
  ]
}
```

At least one of `prescription`, `diagnosis`, `advice` or `attachments` is
required.

### Field notes that matter

- **`prescription` should be real text, not "see attachment".** The chatbot
  answers dosage questions from this string. A patient asking *"how many times a
  day do I take the antibiotic?"* gets a useful answer from typed text and a
  useless one from a scan alone.
- **`internalNotes` is never shown to the patient** and is never given to the
  chatbot. Use it freely for staff-only context.
- **`sharedWithContact`** defaults to `true`. Set `false` to file a record the
  patient should not see yet; release it later by re-pushing with `true`.
- **`attachments`** are base64 in the same request. PDF/JPEG/PNG/WebP/HEIC, max
  5 MB each, 6 per visit. They are encrypted at rest. On an update, attachments
  are **replaced**, so a corrected push does not leave the old scan behind.
- **`externalId`** makes replays safe. Without it, re-sending creates a
  duplicate consultation.

**Read back what we hold:**

```http
GET /api/v1/patients/PMS-4471/visits
```

---

## 5. Receiving events from us

The most common ask: *"when your AI books someone, put it in our system."*

Add an endpoint in **Settings → Webhooks** and subscribe to events. We POST
signed JSON.

| Event | Fires when |
|---|---|
| `appointment.created` | An agent booked on a call, or a patient booked in the chatbot |
| `appointment.cancelled` | A booking was cancelled — free the slot on your side |
| `appointment.rescheduled` | A booking moved; includes `previousStartAt` |
| `visit.recorded` | A consultation record was filed |
| `call.completed` | A call finished, with summary, sentiment and captured fields |
| `call.failed` | A call ended without connecting |

```json
{
  "event": "appointment.created",
  "timestamp": "2026-07-29T09:15:04.000Z",
  "data": {
    "id": "cm5y...",
    "customerName": "Ravi Kumar",
    "customerNumber": "+919876543210",
    "service": "Dental check-up",
    "expertName": "Dr. Rao",
    "startAt": "2026-07-30T10:00:00.000Z",
    "endAt": "2026-07-30T10:30:00.000Z",
    "timezone": "Asia/Kolkata",
    "status": "CONFIRMED",
    "bookedBy": "agent"
  }
}
```

`bookedBy` is `agent` (booked on a phone call) or `portal` (the patient booked
themselves in the chatbot).

### Verifying the signature

Every non-Slack delivery carries:

```
X-VaaniYantra-Event: appointment.created
X-VaaniYantra-Signature: sha256=<hex>
```

The signature is `HMAC-SHA256(secret, raw_request_body)`. Compute it over the
**raw body bytes**, before any JSON parsing, and compare in constant time.

```js
const expected =
  'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

Reject anything that fails. Respond `2xx` quickly and do your work
asynchronously — we time out after 6 seconds and count the delivery as failed.

Use **Send test** on the webhook to get a sample payload for each event without
waiting for a real booking.

---

## 6. The patient chatbot link

Your clinic's chatbot lives at one public address:

```
https://vaaniyantra.com/c/<your-clinic>
```

We send it automatically with every appointment confirmation. `POST
/api/v1/patients` also returns it as `portalUrl`, so you can include it in your
own SMS, discharge summary or printed slip instead.

**It carries no secret.** Opening it asks the patient for their mobile number
and texts them a one-time code; only after that do they reach any records, and
only their own. So the link is safe to print, put on your website, or send to a
group — which is exactly why it replaced the older `?k=<key>` form, where
forwarding an appointment SMS forwarded the patient's medical history.

Two consequences for an integration:

- The number you push in `POST /api/v1/patients` is what the patient signs in
  with. If it is wrong, they cannot get in. Keep it in sync.
- Old `?k=` links still open the chatbot; the key is ignored and stripped, and
  the patient is asked to sign in. Nothing 404s.

Staff can block a patient's access from the patient's page — that signs them
out immediately and stops them signing in again until it is restored.

---

## 7. Errors, limits and idempotency

| Status | Meaning |
|---|---|
| `400` | Malformed body or a missing/invalid required field — the message says which |
| `401` | Missing, revoked or unknown API key |
| `404` | Patient not found in your organization |
| `409` | Write refused because your system owns this data (see mode) |
| `429` | Rate limited — back off and retry after `Retry-After` |

Rate limits: **120 requests/minute per API key**, 240/minute per source IP.
`X-RateLimit-Remaining` and `X-RateLimit-Reset` are on throttled responses.

**Idempotency:** always send `externalId` on both patients and visits. Every
write endpoint is safe to replay with it — which is what makes a nightly
catch-up job after an outage a non-event rather than a cleanup task.

---

## 8. Going live

1. Ask us to set your organization to `push` mode (and tell us your system's
   name — it appears in your staff screens).
2. Create an API key in **Settings → API keys**.
3. Push one patient and one visit. Confirm they appear under **Patients**.
4. Open that patient's chatbot link and ask *"what did the doctor prescribe?"*
   — the answer should come back from what you pushed.
5. Register a webhook, hit **Send test**, and verify your signature check.
6. Backfill active patients, then switch on your live sync.

Step 4 is the real acceptance test. If the chatbot answers correctly from your
data, the integration works.
