# VaaniYantra — User Guide

VaaniYantra is an AI voice-calling platform. You create **AI phone agents** that
handle real inbound and outbound calls — answering questions, booking
appointments, and capturing information — in English and major Indian languages.

This guide walks a non-technical user through the whole product. For the REST
API, webhooks, and integration details, see the **[Developer Guide](./DEVELOPER_GUIDE.md)**.

---

## Table of contents

1. [Getting started](#1-getting-started)
2. [Organizations & workspaces](#2-organizations--workspaces)
3. [Creating an AI agent](#3-creating-an-ai-agent)
4. [Phone numbers](#4-phone-numbers)
5. [Knowledge base](#5-knowledge-base)
6. [Connectors](#6-connectors)
7. [Appointments](#7-appointments)
8. [Patients & your chatbot](#8-patients--your-chatbot)
9. [Calls & live monitoring](#9-calls--live-monitoring)
10. [Team & roles](#10-team--roles)
11. [What it costs](#11-what-it-costs)
12. [API keys & webhooks](#12-api-keys--webhooks)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Getting started

VaaniYantra is **invite-only** at the moment — accounts are created for
practices we have spoken to, rather than by open sign-up.

1. Tell us about your practice at **https://vaaniyantra.com/contact**. We reply
   within one working day and set you up.
2. Open the invitation link we send you, and create an account with
   **email + password** or **Sign in with Google**.
3. You land on the **Dashboard**. An **Organization** and **Workspace** are
   created for you automatically, on the pay-per-minute rate.

Already inside an organization? Your owner invites you from **Team**, and the
same link works for you.

**The typical first-run path:**
> Create an agent → connect a phone number → assign the agent to it → place a
> test call.

---

## 2. Organizations & workspaces

- An **Organization** is your account/company. It carries your plan and billing.
- A **Workspace** is a container inside an organization for agents, numbers,
  documents, and calls. Most users need only the default workspace; larger teams
  use several (e.g. "Sales", "Support").
- Switch or create workspaces from the **switcher at the top-left** of the
  sidebar.

> Numbers, agents, connectors, and API keys are scoped to a workspace/org. If
> something you created isn't showing, check you're in the right workspace.

---

## 3. Creating an AI agent

Go to **Agents → New agent**. The wizard has a few short steps:

**1) Describe the agent (plain English).**
Write what the agent should do in everyday language — e.g. *"You are the
receptionist for Smile Dental. Greet patients warmly, answer questions about
treatments, timings and fees, and book appointments."* We turn this into a
polished behavior prompt you can review and edit. Whatever you write, the agent
never gives medical advice — anything clinical becomes an appointment.

**2) Basics.**
- **Name** — for your reference.
- **Practice type** — pick from the list (Clinic / Polyclinic, Hospital, Dental
  Clinic, Specialist Practice, Diagnostic Lab) or choose *Other healthcare
  provider*. This tailors the greeting and booking flow.
- **Language** — English (`en-IN`) or Hindi, Tamil, Telugu, Malayalam, and more.
  Choose **Auto** to detect from the caller's number/region.
- **Voice** — pick from the available natural voices.
- **Direction** — inbound, outbound, or both.

**3) Greeting & behavior.**
- **Greeting** — the first line callers hear.
- **Business hours** — outside these hours the agent plays an after-hours
  message instead of taking the call.
- **Human transfer** *(optional)* — set trigger phrases and a number to forward
  to a person.
- **End-call** behavior and other tuning.

**4) Booking & doctors** *(for appointment agents).*
- **Practice & service names** — used in confirmations and calendar events.
- **Doctors & consultants** — the people a patient can be booked with, each with
  their own calendar and days off.
- **Confirmation message** — a template with placeholders like `{{name}}`,
  `{{service}}`, `{{time}}`, `{{date}}`. Patients are messaged on **WhatsApp**.
- **Booking window** — how many days ahead patients can book.

**5) Knowledge** *(optional).* Attach documents the agent can answer from (see
[Knowledge base](#5-knowledge-base)).

Save the agent. New agents start **Active**. You can edit any field later.

> **You need a connected phone number before an agent can take calls.** See the
> next section.

---

## 4. Phone numbers

Open **Numbers**. Each number, once it has an assigned agent, shows a **● live**
badge. Any number that isn't ready shows a **"To go live, finish these steps"**
checklist right on its card.

You can bring numbers from **Twilio** (global), **Plivo** (global) or
**Exotel** (India/APAC). In every case the number stays in your own carrier
account — VaaniYantra connects to it, it never buys on your behalf.

### Adding a number

In **Add a number**, pick your provider:

#### Twilio
1. **Connect your Twilio account** once (Account SID + Auth Token, from your
   Twilio Console). Credentials are stored encrypted.
2. Then either:
   - **Find my Twilio numbers** → **Import** an existing number, or
   - **Add manually** (enter the number in E.164 format, e.g. `+919876543210`).

   Buy the number itself in your own Twilio Console — VaaniYantra connects to
   numbers you already own rather than purchasing on your behalf.
3. Twilio numbers are **auto-connected** — we point the number's webhook at the
   platform automatically. Just assign an agent and it's live.

#### Plivo
1. **Connect your Plivo account** once (Auth ID + Auth Token, from your Plivo
   Console overview). Credentials are stored encrypted.
2. Then either **Find my Plivo numbers** → **Import**, or **Add manually** in
   E.164 format.
3. Plivo numbers are **auto-connected** — we point the number's webhook at the
   platform automatically. Assign an agent and it's live.

#### Exotel (India)
1. **Connect your Exotel account** once — Label, Account SID, API Key, API Token,
   Subdomain/region (e.g. `api.in.exotel.com`), and optionally an Outbound App
   URL. (Find the API Key/Token in Exotel → Settings → API.)
2. **Find my ExoPhones** → **Import**, or **Add manually** (ExoPhones can be
   local-format numbers like `04045901102`).
3. **Open the number's Settings → "Connect this number to your agent"** and
   follow the one-time steps: in the Exotel dashboard, add a **Voicebot applet**
   to the flow assigned to your ExoPhone and paste the WebSocket URL shown
   (either `wss://vaaniyantra.com/exotel` or the dynamic URL). Then use **Send
   test call** to confirm the agent answers.

> **Why Exotel needs a manual step:** Exotel has no API to configure call flows,
> so the Voicebot applet must be wired once in their dashboard. It's a one-time
> setup per Exotel account — the same flow serves all your ExoPhones.

### Assigning an agent

On each number's row, choose an agent from the dropdown. In **Settings** you can
also set a label, a caller-ID name, forward inbound calls to a human number, or
disable inbound calls.

---

## 5. Knowledge base

Go to **Knowledge**. Upload documents (PDF, DOCX, TXT) that your agents can
answer from. We split and index them so agents retrieve the right passage during
a call (retrieval-augmented answers). Attach specific documents to an agent from
the agent's **Knowledge** step.

File sizes are limited; the number of documents is not.

You can also add **FAQs** directly for quick question/answer pairs.

---

## 6. Connectors

Go to **Connectors** to let agents take real actions after a call:

- **Google Calendar** — connect a Google account and pick which calendar to use.
  Your agents then check real availability and book confirmed appointments as
  calendar events. VaaniYantra asks for calendar access only — it cannot see
  that account's Drive, mail or contacts.

  > To get your data *out*, use **Reports → Export CSV**. You can download your
  > calls, appointments, patients or updates, and any single call's full record
  > from that call's page. No Google account is needed for this.
- **WhatsApp** — booking confirmations and reminders go out on WhatsApp from a
  shared business number, with your own number connectable instead. Proactive
  messages use Meta-approved templates, so the wording of a confirmation or
  reminder is fixed rather than free text.
> **WhatsApp is the only notification channel.** SMS was removed once every
> proactive message had an approved WhatsApp template. There is no DLT
> registration to do, because DLT governs business SMS in India and none is
> sent; Meta's template review takes its place. The practical consequence is
> that a message with no approved template is **not delivered at all** rather
> than quietly arriving as a text.

---

## 7. Appointments

When a booking agent schedules an appointment, it appears under **Appointments**
with the customer, service, expert, and time. The platform:

- Creates the event on the connected Google **Calendar**.
- Sends the customer a **confirmation** on WhatsApp.
- Sends **reminders** (24 hours and 1 hour before).
- Lets you cancel/reschedule — each sends its own WhatsApp notice.

Bookings respect each expert's calendar and days off, and your configured
booking window.

---

## 8. Patients & your chatbot

Built for clinics: after a consultation you file what was prescribed, and the
patient can reopen your own chatbot later to read it back or ask a follow-up
question — instead of phoning reception for the third time.

### Create your chatbot

Go to **Patient Chatbot**, give it a name (your clinic's name works best), and
pick which agent it answers from — normally the same one answering your phone,
so it already knows your timings, services and fees from your knowledge base.

You get a link like `vaaniyantra.com/c/smile-dental`, and every appointment
confirmation carries it. When a patient taps it, they enter their mobile number
and we text them a 6-digit code — so each patient reaches only their own
prescriptions and visits, and the link itself is safe to print or share.

That means the mobile number on a patient's record is what they sign in with.
If someone changes their number, update it on their page or they will not be
able to get in. If a phone is lost, use **Block access** on the patient's page:
it signs them out at once and stops any new sign-in until you restore it.

### Record a consultation

Open **Patients**, choose the person, and fill in **Record a consultation**:

- **Prescription** — type it out. The chatbot answers dosage questions from this
  text, so a typed script is far more useful to the patient than a scan alone.
- **Diagnosis** and **Advice** — what you told them, in your words.
- **Attachments** — the scanned prescription or a report (PDF or photo, 5 MB
  each). Stored encrypted.
- **Internal notes** — staff only. Never shown to the patient, and never given
  to the chatbot.

Records are shared with the patient the moment you save. Untick **Share with the
patient right away** to hold one back, and release it later with **Share**.

### Deleting a patient

**Delete patient** is on the patient's page, for Admins and Owners only. It is
permanent and there is no undo.

What goes: their record, every consultation, prescription, diagnosis, advice,
allergy and attachment, and their access to your chatbot.

What stays: your **appointment history**. Past and upcoming bookings keep their
date, service and doctor, but no longer show the patient's name, number or
patient no. — so your day sheets and revenue still add up after someone asks to
be removed. Call logs are kept too; those are governed by your **data retention**
setting rather than by deleting a patient.

> **Family members on one number.** If the person you are deleting is the main
> contact for others on the same mobile, the deletion is refused and says so.
> Delete or move those family members first — otherwise a child's record would be
> left with no adult attached to it.

### What patients can do

- Read their prescriptions, diagnoses and advice, and open the scans.
- Ask questions — answered from their records plus your knowledge base.
- Book, move and cancel appointments, if you leave **Allow booking changes** on
  (needs Google Calendar connected and booking enabled on the agent).

The chatbot is told to read back what you prescribed but never to give new
medical advice, change a dose, or interpret symptoms — it refers those to you.

### About the link

**Anyone holding a patient's link can read that patient's records.** There is no
password, which is what makes it usable for an elderly patient who just wants to
check a dosage — but it also means a forwarded message hands over their history.

- The link is stripped from the address bar as soon as it opens, so it does not
  leak through browser history or screenshots.
- If a phone is lost or a link is shared by mistake, open the patient and use
  **New link** (kills the old one immediately) or **Revoke**.
- Every open and every file download is recorded in your audit log.

---

## 9. Calls & live monitoring

- **Live Calls** — see calls happening right now.
- **Call History** — every past call with direction, status, duration, the
  agent, an AI **summary**, **sentiment**, key topics, and any data the agent
  collected. Open a call to read its full **transcript**.
- **Dashboard** — headline metrics (total calls, talk time, completion rate,
  active agents) and a call-volume chart.

**Placing an outbound call:** from the Dashboard or Call History, use **Place a
test call** — choose an agent, the caller-ID number, and the number to dial.

---

## 10. Team & roles

Invite teammates from **Team**. Members have roles (e.g. Owner, Admin, Member)
that control what they can manage — numbers, integrations, billing, etc. Invites
are sent by email; the invitee accepts and joins your organization.

---

## 11. What it costs

There are no plans. One rate, billed for what you use:

| | Rate | How it is billed |
|---|-----:|---|
| **Standard** | **from ₹5 / minute** | Invoiced after the month ends, for the minutes your agents actually spent on calls |
| **At volume** | **Agreed with us** | Multi-branch groups and high call volumes are quoted against what your switchboard actually handles |

- **Nothing is paid up front** — no monthly fee, no minimum, no bundle of
  minutes to use up. A minute becomes billable only once the call has happened
  and is in your call log.
- **Everything is included** at that rate: unlimited agents, workspaces,
  branches, knowledge documents and the patient chatbot.
- **Settings → Billing** shows your rate, the minutes recorded this month and
  what they come to so far.
- There is a **safety cap** on monthly minutes so a runaway loop cannot run up a
  bill nobody can pay. Reaching it pauses calls and shows you who to email — we
  lift it straight away.
- Want the volume rate? Write to info@vaaniyantra.com with the call volume you
  expect and we will confirm it in writing.

> **On an older monthly plan?** Accounts opened before August 2026 keep the plan
> and price they signed up on, including its included minutes and overage rate,
> for as long as they like. Email us if you would rather move to the per-minute
> rate.

---

## 12. API keys & webhooks

Under **Settings** you can:

- **API keys** — create keys to use the REST API (list agents, pull calls &
  transcripts, place calls, etc.).
- **Webhooks** — register a URL to receive a signed JSON POST when a call
  completes or fails (great for Zapier/Make, or your own systems).
- **Slack** — the same events, formatted as a card in a channel you choose.

These are for developers — see the **[Developer Guide](./DEVELOPER_GUIDE.md)**.

> **What a connected Slack channel receives.** Each card carries the agent,
> direction, call duration, sentiment, status, the AI **summary** of the call and
> any details the agent collected. The caller's phone number is shown as the last
> four digits only.
>
> Worth knowing before you connect one: a Slack Incoming Webhook URL *is* the
> credential — anyone holding it can post to that channel, and everyone in the
> channel can read the summaries. Point it at a private channel that only the
> staff who should see call content can open, and treat the URL like a password.

---

## 13. Troubleshooting

**"You need a connected phone number before creating an agent."**
Connect a Twilio or Exotel number under **Numbers** first (Twilio *or* Exotel).

**A number isn't taking calls.**
Open its card — the **"To go live"** checklist lists exactly what's left
(assign an agent, enable inbound, and for Exotel, wire the Voicebot applet).

**An Exotel call rings my own phone instead of the agent.**
Your Exotel flow is set to forward. In the Exotel dashboard, replace the
Connect/forward applet with the **Voicebot** applet pointing at
`wss://vaaniyantra.com/exotel`, then send a test call.

**Calls connect but go silent after the greeting.**
This is usually the AI provider (Gemini) key hitting a rate/quota limit. Contact
your administrator to rotate/upgrade the key.

**I can't see an account/number I set up.**
Check you're in the correct **organization and workspace** (top-left switcher) —
everything is scoped to a workspace.
