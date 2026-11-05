# VaaniYantra — Legal Review Packet

**Prepared for:** external counsel, India — data protection & digital health
**Prepared by:** [YOUR NAME], Founder, VaaniYantra
**Date:** [DATE OF SENDING]
**Status:** Confidential. Prepared for the purpose of obtaining legal advice.

---

## 0. Before you send this — fill these in

Delete this section before sending. These are the only blanks; everything else is complete.

- [ ] `[YOUR NAME]` above and in §1
- [ ] `[DATE OF SENDING]`
- [ ] §1 — registered entity name, CIN/LLPIN, state of registration, registered address
- [ ] §1 — whether you are currently live with paying clinics, and roughly how many patients' records are already in the database
- [ ] §1 — the nearest contract on the table, if any, and its deadline

---

## 1. Who we are and what we are asking for

**VaaniYantra** operates an AI receptionist for clinics and small hospitals in India. It answers the clinic's phone in Indian languages, books appointments, answers patients' WhatsApp messages, and gives each patient a chatbot where they can read their own prescriptions and visit history after a consultation.

- **Entity:** [REGISTERED ENTITY NAME], [CIN / LLPIN], registered in [STATE]
- **Registered address:** [ADDRESS]
- **Contact:** [YOUR NAME], Founder — info@vaaniyantra.com
- **Stage:** [live with N clinics / pre-launch]. Approximately [N] patient records currently held.
- **Immediate driver:** [e.g. "a hospital procurement review expected in September", or "none — doing this before we sign anyone"]

We have drafted six public legal documents ourselves, written against what the software actually does rather than against a template. **We are asking you to review them and tell us where we are wrong, exposed, or non-compliant.**

We have deliberately *not* dressed up our posture. §6 of this packet lists our known weaknesses in full. We would rather you saw them now than discovered them in a dispute.

### What we are asking for — three deliverables

1. **A redline** of each of the six documents in §7.
2. **A memo** answering the numbered questions in §2, with a risk rating on each.
3. **A product remediation list** — "you must change X in the software before this document is true." This is the deliverable we value most; it feeds directly into our engineering backlog.

Please quote **fixed-fee against this scope**, and tell us separately what a follow-up round of questions would cost.

---

## 2. The questions we need answered

These are ranked. If budget forces a cut, cut from the bottom.

### Q1. Does our two-role split actually hold?

We have written that **the clinic is the Data Fiduciary for patient data and we are merely the Data Processor**, with the clinic as Fiduciary for its own account data. Our entire compliance posture rests on this.

Please pressure-test it. Facts that may cut against us:

- We set the default retention behaviour, and the default is *keep forever* (§5).
- We run an LLM pass on every completed call that derives **sentiment, sentiment score and topics** — data the clinic never asked for and cannot switch off.
- We compute a patient's **age from their date of birth and inject it into the AI prompt** on the patient chatbot.
- We decide which sub-processors receive the data; the clinic gets a take-it-or-leave-it list.

If we are in fact a Data Fiduciary, or a joint fiduciary, what changes — consent architecture, notice obligations, breach duties, and the wording of the DPA?

### Q2. Children's data — DPDP s.9

This is the exposure that worries us most.

Clinics treat children. A clinic can register a child as a dependant against a guardian's mobile number. We store the child's `dateOfBirth`, compute their age (our code handles infants down to days), and **pass that age into the AI model's prompt**. We also run sentiment and topic analysis on conversations without regard to the subject's age.

We have **no age verification, no parental-consent record, and no age gate** on a child's portal session. Anyone who can receive an OTP on the guardian's mobile can read every household member's records.

Our documents currently say this is the clinic's responsibility as Fiduciary. **Is that a defensible processor position, or is it a live breach of s.9?** Specifically:

- Does age-in-prompt plus sentiment/topic analysis constitute "tracking or behavioural monitoring of children"?
- Is a contractual allocation of the consent obligation to the clinic sufficient, or must we build a verification mechanism ourselves?
- What is the minimum we must build before we can lawfully continue registering dependants?

### Q3. Cross-border processing

Our application servers, database and nightly backups are in **Google Cloud `us-east1` (United States)**. Google's Gemini models, Twilio, Plivo, Meta/WhatsApp, HubSpot, Deepgram and ElevenLabs are reached on **global endpoints**. Patient health data is therefore processed outside India as a matter of routine.

- What is the current status of DPDP s.16 and any restricted-country notification, and does it bite on us?
- Do the SPDI Rules impose anything additional on cross-border transfer of *medical records* specifically?
- Is our disclosure sufficient, or do we need a transfer mechanism, additional consent, or India-resident hosting?
- Does any sectoral rule (ABDM / Health Data Management Policy, if we later integrate; Clinical Establishments Act; any state rule) require localisation of clinical records?

### Q4. Is our honesty protective, or is it Exhibit A?

We took a deliberate position: **no claim without a code path.** Where the software could not support a claim, we changed the wording rather than the claim. As a result our published documents state, among other things, that clinical free text is not encrypted at application level, that erasure of a single patient is manual, and that we do not verify a patient's age.

Our instinct is that a privacy notice which overstates practice is itself a violation, and that disclosure is the safer path. **Is that right?** Or does publishing a precise list of our own weaknesses hand a plaintiff or a regulator a ready-made case? If the latter, how should the wording change without becoming untrue?

### Q5. Clinical liability and the Telemedicine Guidelines

The AI answers patients' calls and messages. On the patient chatbot it answers questions about their own prescriptions and visit history. It does not diagnose, and it is instructed not to give medical advice.

We run an **emergency keyword tripwire**: if a caller's words match certain patterns, the agent redirects them to emergency services. It is a keyword backstop, not triage, and our Terms say so.

- Does any of this engage the **Telemedicine Practice Guidelines 2020** or the NMC regulations? Are we, or the clinic, "practising medicine" through this channel?
- Does operating an emergency tripwire **create a duty of care** we would not otherwise have — i.e. are we better or worse off for having built it?
- Will our clinical disclaimers and limitation of liability survive the **Consumer Protection Act 2019** and Indian precedent on unfair contract terms, given the patient is not our contracting party?
- Where does liability sit if the AI mis-states a dosage from a record the clinic typed in?

### Q6. Grievance Officer — DPDP s.13 / SPDI Rule 5(9)

Our Privacy Policy currently names the founder as Grievance Officer at the general `info@vaaniyantra.com` address, with a 7-day acknowledgement and 30-day substantive response commitment.

Is that sufficient, or do we need a separately named individual, a dedicated monitored address, a published postal address, and a formal escalation path to the Data Protection Board? What must we be able to *evidence* about how grievances are handled?

### Q7. Will the DPA survive hospital procurement?

Our DPA (§7 of this packet, Appendix B) states plainly what security controls we lack: no application-level encryption of clinical free text, no customer-managed keys, no SSO/SAML, no ISO 27001 or SOC 2, no independent audit report.

- Are the obligations we *have* accepted (72-hour breach notification, 30-day deletion, annual questionnaire) ones we can actually meet given §5 and §6 of this packet?
- Which clauses would a hospital's legal team reject outright?
- Are we under-protected on indemnity, liability cap, or termination?

---

## 3. Data inventory

Every category of personal and health data the system holds. Compiled directly from the database schema; each row names the table and column so it can be verified.

**"App-encrypted"** means a second layer of AES-256-GCM encryption applied by our application, under a key held outside the database. Everything is on encrypted disk and in encrypted backups regardless; "No" below means a person with a database dump reads it in plaintext.

### Clinic staff and account data (we are Fiduciary)

| Data | Where | App-encrypted |
|---|---|---|
| Staff name, email, profile image | `User.name/email/imageUrl` | No |
| Sign-in identity | Google Firebase Authentication (we never hold passwords) | n/a |
| Organisation name, billing contact, GSTIN, address | `Organization.*` | No |
| Invoices, payment records | `Invoice`, `PaymentApplication`, `OverageCharge` | No |
| Audit log — actor email, IP address, action, metadata | `AuditLog.actorEmail/ip/metadata` | No |
| Telephony / integration credentials | `TwilioAccount`, `ExotelAccount`, `PlivoAccount`, `Integration` | **Yes** |

### Patient identity data (we are Processor)

| Data | Where | App-encrypted |
|---|---|---|
| Patient name | `Contact.name` | No |
| Mobile number (E.164) | `Contact.phone` | No |
| Email | `Contact.email` | No |
| **Date of birth** | `Contact.dateOfBirth` | No |
| Sex | `Contact.sex` | No |
| Clinic patient number (UHID) | `Contact.uhid` | No |
| Patient id in the clinic's own system | `Contact.externalId` | No |
| Staff-only free-text notes | `Contact.notes` | No |
| **Household / guardian link** — a dependant registered against a guardian's phone | `Contact.guardianContactId`, `Contact.dependentKey` | No |

### Health data — sensitive personal data under the SPDI Rules

| Data | Where | App-encrypted |
|---|---|---|
| **Diagnosis** | `VisitRecord.diagnosis` | No |
| **Prescription (free text)** | `VisitRecord.prescription` | No |
| **Prescription (structured lines)** — drug, strength, dose, frequency, duration, route, instructions | `PrescriptionItem.*` | No |
| Clinical advice, follow-up date | `VisitRecord.advice/followUpAt` | No |
| **Clinician's private notes** — never shown to the patient | `VisitRecord.internalNotes` | No |
| Treating doctor, service/reason for visit | `VisitRecord.expertName/service` | No |
| **Allergies** — substance, reaction, severity | `Allergy.substance/reaction/severity` | No |
| **Uploaded documents** — prescription scans, reports, discharge summaries | `VisitDocument.data` | **Yes** |

> Note the asymmetry, which we consider our single worst technical exposure: a **scanned** prescription is encrypted; the **same prescription typed in** is not.

### Calls, messages and conversation content

| Data | Where | App-encrypted |
|---|---|---|
| Caller and recipient numbers, direction, duration, language | `Call.fromNumber/toNumber/durationSec/language` | No |
| **Full call transcript** | `TranscriptTurn.text` | No |
| AI-generated call summary | `Call.summary` | No |
| **Sentiment, sentiment score, topics** (LLM-derived) | `Call.sentiment/sentimentScore/topics` | No |
| Data the agent collected during the call | `Call.collectedData` | No |
| Recording link (audio itself stays with the carrier) | `Call.recordingUrl` | No |
| **WhatsApp conversation content** | `WhatsappTurn.text/waId` | No |
| **Patient chatbot conversation content** | `PortalChatTurn.text` | No |
| Appointment — patient name, number, patient no., doctor, service, time | `Appointment.*` | No |
| Captured call outcomes (lead, booking, enquiry) | `Outcome.callerName/callerNumber/fields` | No |

### Patient portal access records

| Data | Where | App-encrypted |
|---|---|---|
| One-time sign-in code | `PortalOtp.codeHash` | Hashed (SHA-256 + pepper) |
| Phone number an OTP was requested for | `PortalOtp.phone` | No |
| Patient session token | `PortalLogin.tokenHash` | Hashed |
| **Patient IP address and browser** | `PortalLogin.ip/userAgent` | No |

---

## 4. How data flows

### A. Inbound patient phone call

1. Patient dials the clinic's number → **telephony carrier** (Twilio / Plivo / Exotel, depending on the number).
2. Carrier connects to our voice server (**GCP `us-east1`, United States**).
3. Caller's audio is streamed **in real time to Google Gemini Live** (global endpoint) so the agent can hear and answer. Where the realtime model is not used, Google Cloud Speech-to-Text / Text-to-Speech, or Deepgram / ElevenLabs where a clinic supplies its own key.
4. The transcript is written to our database turn by turn.
5. At the end of the call, **one further LLM pass** produces the summary, sentiment, sentiment score, topics and collected fields.
6. Optionally, depending on what the clinic has connected: a **Google Calendar** event is created (patient name, full phone number, service, doctor, notes); the call is pushed to **HubSpot** (number, summary, sentiment, collected fields, recording link); a **webhook** fires to an endpoint the clinic configured; a WhatsApp confirmation is sent via **Meta Cloud API**.

Where the carrier records the call, **the audio lives in the carrier's account, not ours.** We hold only the link. Deleting our record does not delete their audio.

### B. Patient chatbot (the highest-sensitivity flow)

1. Patient opens the clinic's chatbot link and enters their mobile number.
2. A one-time code is sent by **SMS via the carrier**. Rows are created even for numbers with no patient record, so response timing cannot be used to discover who is a patient.
3. On verification, a session cookie is issued. Where one number belongs to several household members, the patient selects which person they are.
4. When the patient asks a question, we send to **Google Gemini (global endpoint)**: their **name, age, sex, recorded allergies, and released visit history including prescriptions.**
   - Date of birth is deliberately withheld from the model; age is computed and sent instead.
   - The clinician's private notes are never sent.
   - A diagnosis is sent only after a clinician has explicitly released it.

### C. Inbound WhatsApp message

Patient messages the clinic's WhatsApp number → **Meta Cloud API** webhook → matched to the patient by their number → recent conversation history and clinic knowledge sent to **Gemini** → reply sent back through Meta.

### D. Emergency tripwire

Runs on WhatsApp and on both call pipelines. Keyword-pattern matching on what the patient says; on a match the agent redirects to emergency services. It is a backstop, not triage, and nothing records that it fired to the patient.

---

## 5. Retention — what is actually deleted, and when

| Data | Deletion behaviour |
|---|---|
| **Call content** — transcripts, summary, sentiment, topics, collected data, recording link | Purged after a window the clinic sets. **Off by default** — until a clinic sets a window, kept indefinitely. |
| **Clinical records** — visits, prescriptions, allergies, documents | **Never deleted on a timer, by design.** A clinic must retain medical records for years; deletion is a deliberate staff action. |
| Patient sign-in codes, expired sessions | Purged continuously. |
| **Audit logs** | **Never deleted.** Holds actor emails and IP addresses indefinitely. |
| Account, billing, invoices | Kept while the account is open; invoices for the statutory tax period. |

**Two mechanical weaknesses counsel should know:**

1. The retention sweeper is an **in-process timer running every 6 hours inside a single long-lived server process**. There is no cron and no external scheduler. If that process is down, retention silently does not run anywhere.
2. Purging clears the recording *link* we hold. **The audio at the carrier is untouched** and must be deleted with the carrier separately.

---

## 6. Known gaps — full and unvarnished

We are disclosing these to you deliberately. They are the gap between what we publish and an ideal posture, and we would rather you priced the risk accurately.

### Most serious

1. **Clinical free text is not encrypted at application level.** Everything a doctor *types* — diagnosis, prescription, advice, private notes, allergies, and every call transcript and chat message — is plaintext in the database. A stolen database dump is readable medical records. Only provider credentials and *uploaded* documents carry a second encryption layer. (Fixing this is non-trivial: encrypted columns cannot be searched or sorted in SQL, and patient search currently depends on that.)

2. **Deleting a patient or an organisation.** *(Resolved 2026-08-24 — retained here because it shaped the documents you are reviewing.)* Until that date there was no delete path for either, and a *manual* organisation deletion was incomplete: call records, transcripts, appointments, captured outcomes and WhatsApp history carry organisation ids with **no foreign key constraint**, so they survived it — someone hand-deleting a clinic left patient names, phone numbers and full call transcripts behind and believed they were gone. Patient deletion is now a self-service action for Admin/Owner roles, and organisation deletion is an operator-run script that sweeps those unparented tables explicitly, in one transaction. The "by our team within 30 days" promise is now one we can keep in full.

3. **Children's data is unhandled** — see Q2. No age check, no parental-consent record, no age gate, no restriction on profiling minors.

### Serious

4. **Retention depends on a single process** with no external scheduler — see §5.
5. **Reading a patient record is not audited.** Write actions are logged well. But opening a patient's record logs nothing, patient search logs nothing, and a staff CSV export of the **entire patient list including dates of birth** logs nothing. For medical records, read access is exactly what an investigation would need.
6. **Audit logs are kept forever**, with actor emails and IP addresses, covered by no retention policy.
7. **No subject-access export.** No mechanism produces everything held about one person; it is manual.

### Known and accepted for now

- Single-region **US hosting** for application, database and backups.
- **No ISO 27001, no SOC 2**, no third-party audit report.
- **No SSO/SAML, no customer-managed encryption keys, no enforced MFA.**
- **Call-recording disclosure is a prompt instruction to the AI, not a deterministic pre-roll announcement,** and nothing records that it was actually spoken. It also says nothing about *transcription*, which happens on 100% of calls regardless. *We would particularly like your view on this one under the SPDI Rules and any wiretap/consent analysis.*
- One category of outbound webhook is sent **unsigned** while others are cryptographically signed — same payload, including patient phone numbers and call summaries.
- Housekeeping, disclosed for completeness: live payment-gateway credentials and other live secrets currently sit in plaintext files on a developer machine. Rotation is outstanding and is being handled independently of this review.

---

## 7. The documents for review

Six public documents. **They are not yet deployed to our live site** — the live site currently serves an older, generic version. Full text of the two principal documents is in the appendices below; the remainder can be sent in the same form on request.

| Document | URL when deployed | Purpose | Appendix |
|---|---|---|---|
| **Privacy Policy** | `/privacy` | Primary notice. DPDP + SPDI. Also required by Meta App Review. | **A** |
| **Data Processing Addendum** | `/dpa` | The document hospital procurement reads. | **B** |
| Terms of Service | `/terms` | Clinic warranties, clinical disclaimers, liability. | on request |
| Sub-processors | `/subprocessors` | Every third party, what it receives, where. | §4 + §3 above |
| Security | `/security` | Control descriptions. | on request |
| Data deletion | `/data-deletion` | Meta App Review requirement. | on request |

**Provenance:** these were drafted in-house against the application source code, under a rule of *no claim without a code path*. Every factual assertion in this packet is traceable to a named database table or source file and can be evidenced on request. They have not previously been reviewed by a lawyer.

---

## Appendix A — Privacy Policy (full text as drafted)

**Last updated: August 3, 2026**

VaaniYantra provides AI receptionists that answer calls and messages for clinics and hospitals. Because that work touches patients' medical information, this policy is deliberately specific about what we hold, where it goes, and what we can and cannot do on request.

### Who is responsible for what

Two different relationships run through this service, and the distinction decides who you should approach.

**For patient data, the clinic is the Data Fiduciary and we are a Data Processor.** The clinic decides which patients to record, what to record about them, and why. We act on the clinic's instructions. If you are a patient and want your records corrected or erased, ask the clinic — they control the record. If you approach us directly we will route your request to them and support them in answering it.

**For the clinic's own account, we are the Data Fiduciary.** Staff names and email addresses, billing details, invoices and audit logs are ours to answer for, and you can raise those with us directly.

### What we hold

**Clinic staff accounts** — name, email address, the organisation you belong to, your role, and sign-in identity (handled by Google Firebase Authentication; we never see your password).

**Billing details** — business name, address, GSTIN where supplied, contact email and phone, and the invoices we are required to issue. Card details are handled by our payment gateway and never reach us.

**Patient records the clinic keeps here** — name, mobile number, email, date of birth, sex, the clinic's own patient number, and household links where a clinic registers a dependant against a guardian's phone number.

**Health data** — consultations and their diagnosis, prescriptions (both free text and structured medicine lines), advice, follow-up dates, clinicians' private notes, recorded allergies, and documents the clinic uploads such as prescription scans, reports and discharge summaries. Under the SPDI Rules this is sensitive personal data and we treat it as the most restricted category we hold.

**Calls and messages** — caller and recipient numbers, time and duration, a full transcript of what was said, an AI-generated summary, sentiment and topics, information the agent collected during the call, and messages exchanged in the patient chatbot or on WhatsApp. Where your telephony provider records a call, we store the link it gives us; the audio itself stays in that provider's account.

**Access records** — an audit log of actions taken in the clinic's account, including the acting user and their IP address, and sign-in records for the patient portal including IP address and browser.

### Why we hold it

To answer calls and messages as the clinic's agent, book and remind patients of appointments, show the clinic its call history and reports, let a patient read their own prescriptions, bill for the service, support customers, and keep the service secure. We do not sell personal data. We do not use patients' conversations to advertise to them, and we do not use clinic or patient data to train AI models.

### Where your data is processed — including outside India

**Our servers and database are hosted with Google Cloud in the United States** (region us-east1), and our encrypted nightly backups are stored in the same region. Several services we depend on — Google's speech and language models, and some telephony and messaging carriers — are reached on global endpoints that may process data outside India.

This means that a patient's call audio, transcript and the records the clinic keeps here are processed outside India. If your clinic has a data-localisation requirement, tell us before you onboard so we can be clear about whether we can meet it. We would rather lose the sale than misdescribe this.

The full list of third parties, what each receives and where it processes, is on our sub-processor page.

### What we send to AI providers

The service is built on Google's Gemini models. During a phone call the caller's audio is streamed to Google in real time so the agent can hear and answer. Afterwards the transcript is sent for summarising.

In the patient chatbot, so the assistant can answer questions about a patient's own treatment, we include that patient's name, age, sex, recorded allergies and released visit history — including prescriptions — in the request to the model. Their date of birth is deliberately withheld from it. If a clinic is not comfortable with medical details reaching a model provider, the chatbot should not be enabled.

### Sharing

We share data only with the providers needed to run the service, each under their own terms — hosting and AI (Google), telephony and SMS (Twilio, Plivo or Exotel, depending on the number), messaging (Meta/WhatsApp), and payments (Cashfree). Where a clinic connects an optional integration such as Google Calendar, a CRM, or its own webhook endpoint, data flows to that destination on the clinic's instruction and under the clinic's responsibility. We may disclose data where the law requires it.

### How long we keep it

**Call content:** clinic owners can set a retention window, after which transcripts, summaries, sentiment and collected data are purged automatically. **This is off by default** — until a clinic sets a window, call content is kept indefinitely. Purging clears the recording link we hold; audio stored by your telephony provider must be deleted with that provider.

**Clinical records:** patient records, consultations, prescriptions, allergies and uploaded documents are not deleted on a timer. They are medical records, and the clinic decides when they go.

**Everything else:** account, billing and audit records are kept for as long as the account is open, and invoices for the period tax law requires. Patient portal sign-in codes and expired sessions are purged continuously.

### Your rights

Under the DPDP Act you may ask for access to your personal data, correction of it, erasure, and information about who we have shared it with; you may nominate someone to exercise those rights on your behalf; and you may complain to us and then to the Data Protection Board.

Two limits we would rather state than hide. First, if you are a **patient**, the clinic holds your record and decides on erasure — we act on their instruction. Second, we do not yet offer a self-service export of everything we hold about you; access requests are fulfilled by our team, by hand, within 30 days. We are building both properly rather than claiming them prematurely.

### Children's data

Clinics treat children, and a clinic may register a child as a dependant on a guardian's mobile number. Where they do, that child's medical record sits here on the same basis as any other.

We do not verify a patient's age and we do not collect parental consent — the clinic holds the relationship with the family and is responsible for the lawful basis, including any consent required for a child under the DPDP Act. Anyone who verifies the guardian's mobile number with a one-time code can reach the records of the household members registered on it. Clinics should keep that in mind before registering a dependant, and can block portal access for any patient at any time.

### Security

Traffic is encrypted in transit. Provider credentials and uploaded patient documents are encrypted in the database with AES-256-GCM under a key held outside it. Access is controlled by role, isolated per organisation, and administrative actions are written to an audit log. A patient reaches records only after verifying their mobile number with a one-time code, and a diagnosis stays hidden from them until a clinician releases it.

To be precise about the limit: other clinical text — diagnoses, typed prescriptions, allergies, call transcripts and chat messages — is stored in the database without a second layer of application-level encryption, protected by access control, network isolation and encrypted backups. Our security page describes the controls in more detail.

### If something goes wrong

If a breach affects personal data we hold, we will notify the affected clinic without undue delay, with what we know and what we are doing, and report to the Data Protection Board of India as the DPDP Act requires. Where we are the processor, the clinic decides how its patients are told, and we will give them what they need to do it.

### Grievance Officer

If you are unhappy with how we have handled your data, contact our Grievance Officer. We will acknowledge within 7 days and respond substantively within 30.

> **Baliji Manikanta**, Grievance Officer
> info@vaaniyantra.com
> Postal address and registered details are on our contact page.

If we do not resolve it, you may complain to the Data Protection Board of India.

### Changes

We will update this page when the service changes and move the date at the top. Where a change materially affects how we handle patient data, we will tell customers directly rather than relying on you noticing.

### Contact

General questions: info@vaaniyantra.com. Clinics: our Data Processing Addendum sets out our obligations as your processor.

---

## Appendix B — Data Processing Addendum (full text as drafted)

**Last updated: August 3, 2026**

This Addendum applies whenever we process personal data about your patients on your behalf. It forms part of our Terms of Service and takes precedence over them on data protection. It is written to be read, not to be survived; where a control is weaker than you would like, it says so plainly so you can decide with your eyes open.

### 1. Roles

For patient data, **you are the Data Fiduciary and we are your Data Processor** under the Digital Personal Data Protection Act 2023. You decide which patients are recorded, what is recorded, and why. We process only to provide the service.

For your own account — staff identities, billing, invoices and audit records — we act as Data Fiduciary and our Privacy Policy governs.

### 2. Scope of processing

**Subject matter:** providing an AI receptionist, appointment booking and a patient records portal. **Duration:** for as long as your subscription is active, plus the deletion period in section 8. **Data subjects:** your patients, their guardians and dependants, and people who call or message you. **Categories:** contact details, date of birth and sex, appointment history, call and message content including transcripts, and health data — diagnoses, prescriptions, allergies, clinical notes and uploaded documents.

### 3. Our obligations

We will: process patient data only to provide the service and on your documented instructions, including your configuration of it; not sell it, and not use it to train AI models; keep it confidential and limit access to personnel who need it; assist you with your patients' requests as set out in section 6; notify you of a breach as set out in section 7; and delete or return data as set out in section 8.

If we believe an instruction from you breaches the law, we will tell you rather than quietly comply.

### 4. Your obligations

You will: hold a lawful basis for the data you put into the service and for our processing of it; give your patients the notice the law requires, including that an AI agent handles their calls and messages and that their data is processed by our providers, some outside India; obtain any consent required, including for a child; keep your own access controls sound, including who on your staff can see records; and answer your patients' requests, with our help.

### 5. Security measures, as implemented

**In place:** encryption in transit; provider credentials and uploaded patient documents encrypted at rest with AES-256-GCM under a key held outside the database; per-organisation isolation; role-based access control on every route; an audit log of administrative and clinical write actions; patient portal access only after one-time-code verification of the patient's mobile number, with rate limits and hashed codes; clinician-controlled release of a diagnosis, with private clinical notes never exposed on a patient-facing path; the ability to revoke a patient's portal access immediately; encrypted nightly database backups; and monitored uptime alerting.

**Limits you should know before signing:**

Clinical free text — diagnoses, typed prescriptions, allergies, call transcripts and chat messages — is stored without a second, application-level layer of encryption. It is protected by access control, network isolation and encrypted backups.

Data is hosted in the **United States**, and our AI and most carrier providers are reached on global endpoints. We do not currently offer India-resident processing.

Reads of a patient record are audited, as are searches of your patient list, bulk CSV exports, and write actions. There is no customer-managed encryption key, no SSO/SAML, and no independent security certification such as ISO 27001 or SOC 2.

### 6. Assisting with data-principal requests

If a patient contacts us directly we will not act on their record ourselves — we will route the request to you, because you control it. On your written request we will help you locate, correct, export or delete a patient's data.

Deleting a single patient is now a self-service action in your dashboard, available to Admin and Owner roles. It removes that person's record, consultations, prescriptions, allergies and attachments and ends their chatbot access; your appointment history is kept with their name, number and patient number removed. Call logs are not covered by it — those are governed by the retention window in section 8.

Honestly stated: producing a *complete export* of everything held about one person is still performed by our team rather than a button in the dashboard, within 30 days of your request. Plan your own response times accordingly.

### 7. Breach notification

If we become aware of a personal data breach affecting your data, we will notify you without undue delay and in any case within **72 hours**, with what happened, the categories and approximate volume affected, the likely consequences, and what we are doing. We will report to the Data Protection Board of India as required of us. As Data Fiduciary, deciding whether and how to inform your patients is yours, and we will give you what you need.

### 8. Deletion and return

You can delete agents, knowledge documents, consultations and connections yourself at any time, and set a retention window after which call transcripts and analysis are purged automatically. That window is off unless you set it.

On termination, we will delete your organisation's data within **30 days** of your written request, except records we must keep by law, such as invoices, for the statutory period. Before you close the account, export what you need — reports and patient lists export as CSV, and clinical records are available through the API.

### 9. Sub-processors

You authorise the sub-processors listed on our sub-processor page, which names what each receives and where it processes. We remain responsible for their performance. We will update that page before a new sub-processor begins handling customer data and notify you of material additions; if you object, your remedy is to stop using the affected feature or to terminate.

### 10. Cross-border transfer

You acknowledge that providing the service involves processing patient data outside India, as described in section 5 and on the sub-processor page. You confirm you have the lawful basis for that transfer and have told your patients about it.

### 11. Audit

On reasonable written notice, no more than once a year, we will answer a security questionnaire and provide the documentation we hold. We do not currently hold a third-party audit report, and we will not claim otherwise. On-site audits are by agreement.

### 12. Signing this

This Addendum applies automatically to every customer processing patient data — you do not need to sign it for it to bind us. If your procurement process needs a countersigned copy, or terms specific to your institution, write to info@vaaniyantra.com and we will work through it.

Questions about how we handle data, or a complaint, go to the Grievance Officer named in our Privacy Policy.

---

*End of packet. Prepared for the purpose of obtaining legal advice and treated as confidential.*
