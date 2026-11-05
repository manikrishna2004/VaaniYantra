# The Connector Guide

Everything the kit talks to, how to connect it, and the specific place each one
goes wrong.

The section numbers match the steps in the setup screen, so when you are
staring at a blank field you can jump straight to the part that fills it.

1. [How the pieces fit](#1-how-the-pieces-fit)
2. [Your business details](#2-your-business-details)
3. [Gemini — the brain](#3-gemini--the-brain)
4. [The phone line — Twilio or Exotel](#4-the-phone-line--twilio-or-exotel)
5. [WhatsApp — the confirmation](#5-whatsapp--the-confirmation)
6. [Google Calendar — the diary](#6-google-calendar--the-diary)
7. [Going live](#7-going-live)
8. [Law, cost and honesty](#8-law-cost-and-honesty)
9. [When something breaks](#9-when-something-breaks)

> **You do all of this in the setup screen**, at <http://localhost:8080/setup>,
> not in a text editor — and the steps are built into it. Every step there has
> a **How to get these** panel with the same click-by-click instructions you
> will find here, so you may never need this file.
>
> This document is the longer version: the same steps plus the reasoning, for
> when something behaves oddly and you want to know why.
>
> The screen is refused to anything that is not the machine running the server,
> because it holds your API keys. That includes requests arriving through your
> ngrok tunnel, even though the tunnel runs on this same machine — see 7.2.

---

## 1. How the pieces fit

When someone rings your number, this happens in about a second and a half:

1. **Your phone provider** answers and opens a websocket to this server.
   Twilio asks what to do first, by POSTing to `/voice`, and your server replies
   with TwiML pointing at `/media`. Exotel does not ask — it connects straight
   to `/exotel`, because you told it to in their dashboard.
2. The provider streams the caller's voice in small chunks, 50 a second.
3. `lib/codec.js` converts each chunk to the 16kHz PCM the model wants, and
   `lib/live.js` streams it to **Gemini Live**.
4. Gemini decides when the caller has finished a sentence, thinks, and streams
   speech back as 24kHz PCM.
5. That gets converted back to the provider's format and played to the caller.
6. If the model wants to *do* something rather than say something, it calls one
   of the tools in `lib/tools.js`, which talk to **Google Calendar** and
   **WhatsApp**.

The audio formats differ and almost nothing else does. Twilio speaks 8kHz
µ-law, one byte a sample, in 20ms frames. Exotel speaks raw 16-bit PCM at 8kHz
in 200ms chunks that must be a multiple of 320 bytes. Every one of those
differences lives in `lib/providers.js`, which is why the rest of the kit never
mentions either company.

The two things worth understanding, because they are where the "feel" of the
agent lives:

**Interruption.** A real receptionist stops talking when you start. The phone
provider buffers everything we send it, so when the caller cuts in we have to
explicitly tell it to throw away the audio it has not played yet. That is the
`clear` message in `server.js`. Without it, you talk over each other for two
seconds.

**Turn-taking.** *Pause before the agent replies*, in step 6 of the setup
screen, decides how long a silence means "your turn". 300ms feels natural. Drop it to 150 and the agent feels sharp but will
cut off anyone who pauses to think. Raise it to 600 and it feels slow and
polite. This one number changes the personality more than most prompt edits.

---

## 2. Your business details

**Setup screen → step 1.**

`What kind of business` matters more than it looks. It is dropped into the prompt and
decides what vocabulary the agent reaches for and what it treats as out of
scope. "dental clinic" and "dental surgery" produce noticeably different calls.

The timezone is a dropdown of every zone your computer knows, which exists so
nobody types `IST` or `+05:30`. Getting it wrong is the worst bug this system
can have: it fails silently, and the caller finds out by turning up on the
wrong day.

Opening hours are **step 6**. These are what the agent offers, in your
timezone. It will never offer a slot
outside them, on a closed day, in the past, or starting in the next 15 minutes.

---

## 3. Gemini — the brain

### 3.1 Get a key

Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in
with any Google account, click **Create API key**, and paste it into **step 2**
of the setup screen. Press **Test the AI key** — it asks Google what models
that key can reach, so a working key tells you so immediately.

### 3.1b You also need billing on the project

This is the single most common reason a correctly-built agent answers the phone
and then says nothing, and it gives almost no clue on its own.

Creating a key is free. A key with no billing behind it authenticates fine and
lists every model, so every simple check passes. But the realtime Live API is
billed, and the instant a call opens a session Google closes it again — with
the caller already on the line.

Enable billing, or add credits, on the project at
[ai.studio/projects](https://ai.studio/projects).

Then press **Test the AI key** in step 2. That button does not just check the
key: it opens a real live session and waits to see whether it survives. If the
project cannot pay, it says so in those words. It is the only check that
matches what a caller actually experiences.

### 3.2 Choosing a model

There are two families and they behave differently on a phone call:

**Native-audio** models hear and speak directly. They pick up tone, they
handle a caller switching language mid-sentence, and they sound the most human.
They also ignore `AGENT_LANGUAGE` — they follow the caller instead. This is the
default, and what you want for a business that serves more than one language.

**Half-cascade** models (the ones with `live` in the name) transcribe, think in
text, then speak. Slightly faster to first word, cheaper, and they *do* honour
`AGENT_LANGUAGE`, which pins the accent. Better for a single-language business
where you want tight control of pronunciation.

Try both. Change it in step 2, run `npm run simulate`, and listen to the two
wav files back to back.

### 3.3 If the test says the model is not in your list

Model names change. The **Test the AI key** button lists the realtime models
your key can actually reach — pick one of those and put it in the Model box.

### 3.4 The voice

`Puck` (bright), `Charon` (deep), `Kore` (warm, neutral), `Fenrir` (gravelly),
`Aoede` (calm), `Leda` (young), `Orus` (formal), `Zephyr` (light). Choose with
your ears and your customers in mind, not by reading the list. A dental clinic
and a nightclub do not want the same voice.

---

## 4. The phone line — Twilio or Exotel

Pick one in **step 3** of the setup screen. The credential fields change to
match, and so does the URL the screen tells you to paste into their dashboard.

Which to choose:

| | Twilio | Exotel |
|---|---|---|
| Where | ~100 countries | India and APAC |
| Sign-up | Self-serve, minutes | KYC with documents, days |
| Numbers | Bought in the dashboard or by API | Provisioned by Exotel, never by API |
| Billing | USD | INR |
| Inbound routing | A webhook your server answers | A Voicebot applet you attach to the number |

If you are in India serving Indian callers, Exotel is cheaper and the numbers
are local. Everywhere else, Twilio. If you just want to hear the thing work
today, Twilio — you can be taking calls in ten minutes.

### 4.1 Your public URL — both providers need this first

Neither provider can reach `localhost`. In development you need a tunnel:

```bash
ngrok http 8080
```

It prints something like `https://a1b2-49-37-1-2.ngrok-free.app`. Paste that
into **step 3**, then press **Test the public URL** — it fetches your own
server through that address, so it can tell the difference between "not
reachable" and "something else answered".

> **The free ngrok URL changes every time you restart it.** When it does you
> must update it in the setup screen *and* in your provider's dashboard.
> Forgetting one of the two is the single most common reason a working agent
> stops answering.

### 4.2 Twilio

Sign up at [twilio.com](https://www.twilio.com/try-twilio). The trial gives you
credit and a number, but **trial numbers only call verified numbers** and play a
recorded message before your agent speaks. Upgrade before you show anyone.

From the console dashboard, copy the **Account SID** (it starts `AC`) and the
**Auth Token** into step 3, then press **Test Twilio**. It lists the numbers on
the account, which is the fastest confirmation that you pasted the right pair.

**Buy a number:** Phone Numbers → Manage → Buy a number, filtered by **Voice**.
A US local number is about $1.15/month. For a number in India, Germany,
Australia and many others, Twilio wants address and business documents first and
approval takes days — start with a US or UK number and swap later.

**Point it at your server:** Phone Numbers → your number → Voice Configuration.
Under **A call comes in**, choose **Webhook**, method **HTTP POST**, and paste
the URL the setup screen shows you. It ends in `/voice`.

Ring the number.

### 4.3 Exotel

Exotel works differently in two ways that matter.

**You cannot buy a number through the API.** ExoPhones are provisioned by Exotel
after KYC. Start that early; everything else here takes minutes and that takes
days.

**Exotel never asks your server what to do.** There is no answer webhook. You
build a flow in their dashboard and attach it to the number:

1. **Exotel dashboard → App Bazaar → Create App.**
2. Add a **Voicebot** applet.
3. Set its URL to the `wss://…/exotel` address the setup screen shows you.
   Copy it from there — it is not the path Twilio uses.
4. Save the App, then under **ExoPhones** attach this App to your number.

For the credentials, go to **Settings → API Settings** and copy the **Account
SID**, **API Key** and **API Token** into step 3. Choose the region host that
matches your account — for an Indian account that is `api.in.exotel.com`.

Press **Test Exotel**. If it says 401, it is one of exactly three things: wrong
API key or token, wrong Account SID, or the wrong region host. Exotel returns
the same 401 for all three, which is why the test names all three rather than
pretending to know which.

### 4.4 The caller's number

The agent needs the caller's number to send a WhatsApp confirmation.

**Exotel** puts it on the start message automatically. Nothing to do.

**Twilio** does not, unless asked. The kit's TwiML already includes the
parameter that asks for it:

```xml
<Connect><Stream url="…">
  <Parameter name="from" value="{{From}}" />
</Stream></Connect>
```

Twilio substitutes `{{From}}` before opening the stream. If confirmations are
not arriving and the server log says `from unknown`, that parameter has gone
missing — check you have not replaced the TwiML in `lib/providers.js` with a
hand-written one.

---

## 5. WhatsApp — the confirmation

This is the connector that most often appears to work and silently sends
nothing. Read 5.1 before you do anything else; it will save you an afternoon.

### 5.1 The rule that governs everything

WhatsApp does not let businesses message people freely. There are exactly two
ways to send:

**Free-form text** works only inside a **24-hour window** that opens when the
customer messages *you*. Someone who just rang your phone has not messaged you.
The window is shut. A text send returns error `131047` and the customer sees
nothing.

**Templates** work any time, to anyone — but the exact wording must be approved
by Meta in advance, and you can only fill in the blanks you declared.

So a booking confirmation **must be a template**. There is no way around this
and no amount of prompt engineering changes it.

### 5.2 Create the app

1. Go to [developers.facebook.com](https://developers.facebook.com/apps) and
   **Create App** → type **Business**.
2. Add the **WhatsApp** product.
3. It gives you a **test number** and a **Phone number ID**. The test number can
   message up to 5 recipients you add manually — plenty for building.

```
WHATSAPP_PHONE_NUMBER_ID=123456789012345
```

### 5.3 Get a token that does not expire

The token shown on that first screen lasts **24 hours**. If you paste that in,
your confirmations stop working tomorrow and you will not notice.

For a permanent one:

1. [business.facebook.com](https://business.facebook.com) → **Settings** →
   **Users** → **System Users** → **Add**. Name it, role **Admin**.
2. **Add Assets** → your WhatsApp app → enable **Manage**.
3. **Generate New Token** → pick your app → tick `whatsapp_business_messaging`
   and `whatsapp_business_management` → set expiry to **Never**.

```
WHATSAPP_ACCESS_TOKEN=EAAG...
```

### 5.4 Create the confirmation template

**WhatsApp Manager → Message Templates → Create Template.**

- Name: `appointment_confirmation`
- **Category: Utility.** Not Marketing.
- Language: English

Body — the `{{1}}` placeholders are filled in, in order, by
`connectors/whatsapp.js`:

```
Hi {{1}}, your appointment at {{2}} is confirmed for {{3}}.
Reply here if you need to change it.
```

Submit. Approval usually takes minutes.

> **Category is permanent.** You cannot change a template's category after it is
> created. If you pick Marketing by mistake, the message is treated as
> promotional, can be blocked by the customer's marketing opt-out, and will
> quietly fail to arrive for some recipients. Delete it and make a new one under
> a different name — you cannot rename or recategorise the old one.

Then:

```
WHATSAPP_TEMPLATE_NAME=appointment_confirmation
WHATSAPP_TEMPLATE_LANG=en
```

`npm run check` will confirm it exists and is APPROVED.

### 5.5 Going beyond the test number

To message anyone rather than 5 test recipients, you need a real WhatsApp
Business number and Meta Business verification — business documents, a few days
of review. Do it once the agent is working, not before.

---

## 6. Google Calendar — the diary

**Setup screen → step 5.** Optional: skip it and the agent takes messages about
appointments instead of booking them, and never promises a time it cannot keep.

### 6.1 What you are setting up

The agent needs standing permission to read your free/busy and create events
without a human clicking "allow" each time. That is what a refresh token is.

Most guides have you mint one by hand in Google's OAuth playground. The setup
screen does it with a button instead — but you still need to create the
credentials first, because they have to belong to you and not to us.

### 6.2 Create the credentials

1. [console.cloud.google.com](https://console.cloud.google.com) → create a
   project.
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
3. **OAuth consent screen** → **External** → fill in the required fields.
   Under **Scopes** add `https://www.googleapis.com/auth/calendar`.
   Under **Test users** add the Google account whose calendar this is.
4. **Credentials → Create Credentials → OAuth client ID** → **Web application**.

Under **Authorised redirect URIs**, add the exact URI the setup screen shows you
in step 5. It looks like this:

```
http://localhost:8080/setup/google/callback
```

> It is `localhost`, deliberately, not your public URL. Google allows plain
> `http` only for localhost, and a localhost redirect does not break every time
> your ngrok URL changes. Nothing is exposed by this — the redirect only ever
> happens in your own browser, on your own machine.

Copy the **Client ID** and **Client secret** into step 5 and save.

### 6.3 Connect it

Press **Connect Google Calendar**.

A Google window opens, you sign in as the calendar's owner and allow access.
You will see an "unverified app" warning — it is your own app, click through it.
The window closes itself and the refresh token is saved for you.

Press **Test the calendar**. It reports how many slots are free today, which
confirms it is reading the calendar you meant.

### 6.4 Choose the calendar

`primary` is the account's main calendar and is usually right.

For a dedicated calendar, open Google Calendar → that calendar's **Settings** →
**Integrate calendar** → copy the **Calendar ID** (it looks like an email
address) into step 5. Make sure the account you connected in 6.3 has **Make
changes to events** on it.

### 6.5 If it stops working after a week

The test will say `invalid_grant`. It means the refresh token died, and the
cause is almost always that your OAuth consent screen is still in **Testing**,
where refresh tokens expire after **7 days**.

Fix: **OAuth consent screen → Publish App.** For a calendar scope only you use,
Google does not require a verification review to publish, though it will warn
you. Then press **Connect Google Calendar** again to mint a fresh token.

### 6.6 "Google returned no refresh token"

This happens when the account has already authorised this app once — Google
issues a refresh token on first consent only.

Fix: go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions),
remove the app, and press Connect again.

---

## 7. Going live

### 7.1 Somewhere to run it

ngrok is for testing. For production you need a host with a stable URL that
supports websockets. Any of these work, all have a usable free or cheap tier:
**Render**, **Railway**, **Fly.io**, or any small VPS.

Deploy the folder and set your settings as environment variables in the host's
dashboard, using the same names shown in `.env.example`. A real environment
variable always wins over `config.json`, so the host's dashboard stays in
charge and you never have to ship a config file full of keys.

Set `PUBLIC_URL` to the host's https URL and update your provider's dashboard to
match.

Note that the setup screen will not open on a deployed server — it is refused to
anything that is not the machine running it. Use `npm run check` over SSH
instead, which runs exactly the same tests.

The one requirement people miss: the host must support **long-lived websocket
connections**. Most serverless and edge platforms do not, which rules out
deploying this to a plain serverless function.

### 7.2 What is exposed, and what is not

Once a tunnel is running, your machine is on the internet. Three of this
server's paths are public by necessity and the rest are shut:

| Path | Who can reach it | Why |
|---|---|---|
| `/voice` | anyone | Twilio has to fetch it when a call arrives |
| `/media`, `/exotel` | anyone | the provider streams audio into it |
| `/health` | anyone | so the setup screen can prove the tunnel works |
| `/setup`, `/setup/*` | this machine only | it reads and writes your API keys |
| `/calls` | this machine only | transcripts, with callers' names and numbers |

**Why "this machine only" is harder than it sounds.** A tunnel runs on your
computer and forwards to `localhost`, so a request from the other side of the
world arrives looking like it came from your own machine. Checking only that
the connection is local would publish your keys to anyone holding the tunnel
URL. The kit therefore also rejects any request carrying a proxy header, and
any request whose `Host` is not localhost. Through a tunnel, all three checks
have to pass and they cannot.

If you want to reach the setup screen on a server you are not sitting at,
forward the port over SSH rather than opening it up:

```bash
ssh -L 8080:localhost:8080 you@your-server
```

Then open `http://localhost:8080/setup` on your own machine. The traffic is
inside the SSH tunnel, and the server still only ever sees a local request.

**Verifying Twilio.** Anyone who finds your URL can also POST to `/voice` and
get TwiML back. It leaks nothing and starts no call on its own, but for
production you should check Twilio's request signature — Twilio's docs describe
the HMAC-SHA1 scheme, and your auth token is the key.

### 7.3 The kit does not transfer calls

There is no "put me through to a human" in this kit, and that is deliberate.

Moving a live call mid-conversation is provider-specific: Twilio can do it with
a REST call, and Exotel cannot do it at all from here, because its Voicebot
applet owns the media path. A feature that silently works on one provider and
not the other is worse than no feature, because the failure lands on a real
caller who was told to hold.

So the agent is told plainly that it cannot transfer, and never to offer. When
someone asks for a person, it takes their name and number with `take_message`
and says someone will ring straight back. That is a promise the kit keeps.

If you need real transfers, you are past what a prototype should do — that is
the point at which a hosted platform with warm transfer, queueing and agent
availability earns its money.

### 7.4 Keeping an eye on it

`calls.json` holds every call with its transcript. Read the last few after any
change:

```bash
curl localhost:8080/calls
```

Reading transcripts is the only reliable way to improve the prompt. You will
find the agent mishearing one specific word, or over-explaining one specific
thing, and fix it in a line.

---

## 8. Law, cost and honesty

**Recording and consent.** Two-party-consent jurisdictions — including several
US states — require you to tell callers the call is recorded or processed.
Ticking *Announce that calls may be recorded* in step 6 makes the agent say so
in its first sentence. Find out what applies where your callers are; this is not legal
advice.

**Disclosing the agent is not human.** Some places require it on request, some
on every call. The shipped prompt tells the agent to answer honestly when asked
and never to claim to be a person. Do not edit that out. Beyond the law, a
caller who discovers they were deceived does not come back.

**Health, legal and financial advice.** The prompt forbids inventing answers
about treatments, prices and policy. If you are running this for a clinic,
keep that restriction. An agent that confidently states a wrong price has made
a promise your business has to honour or refuse.

**Data.** `calls.json` contains callers' names, numbers and what they said out
loud. That is personal data. If your callers are in the EU or UK, GDPR applies
to it: keep it only as long as you need it, and be able to delete a person's
records on request. It is in `.gitignore` for a reason — do not commit it, and
do not leave it on a shared machine.

**Cost.** Per minute: Twilio inbound ~$0.0085, Gemini Live audio ~$0.03–0.09
depending on model, WhatsApp utility ~$0.004 with the first 1000/month free.
Roughly 3–7 cents a minute all in. Set a billing alert on Google Cloud before
you point a real number at it — an agent stuck in a loop with a confused caller
is the expensive failure mode.

---

## 9. When something breaks

**The phone rings but nobody answers.** Twilio console → **Monitor → Logs →
Errors**. It tells you exactly what it got from your webhook. Usually
`PUBLIC_URL` does not match the ngrok URL any more.

**Silence after it connects.** Your server terminal says why. In order of
likelihood:

- `model session closed: Your prepayment credits are depleted` — the key is
  fine, the Google project cannot pay for realtime. See 3.1b.
- No `GEMINI_API_KEY` saved at all.
- `AGENT_VOICE` is not a real voice name.

The giveaway for the billing case is a log that reads `model session open`
immediately followed by a close. Press **Test the AI key** and it will tell you
outright.

**The agent hears me but I cannot hear it.** Almost always `<Start><Stream>`
instead of `<Connect><Stream>` in the TwiML — `Start` is one-way.

**It talks over me.** Set `BARGE_THRESHOLD=0.04` as an environment variable so
it notices you sooner. If instead it cuts you off when you pause to think, raise
*Pause before the agent replies* in step 6.

**It offers times that are not free.** It is not calling `check_availability`.
Press **Test the calendar** in step 5. If it is not connected, the agent is
told it cannot see the diary and will correctly refuse to promise a time. Run
with `LOG_PROMPT=true` to print the whole instruction it receives.

**Bookings land on the wrong day.** The timezone in step 1 is wrong. It must be
the full name of the place your business is in.

**WhatsApp sends nothing.** Press **Test WhatsApp** in step 4 — it tells you
whether the template exists and is approved, and lists the ones that do exist. Error `132001` means the name or language does not
match. `131047` means it fell back to plain text outside the 24-hour window —
which is exactly what section 5.1 warns about.

**It was working yesterday.** In order of likelihood: the ngrok URL changed and
was not updated in both places, the WhatsApp token was a 24-hour one, or the
Google refresh token expired because the consent screen is still in Testing.

**The setup screen will not open.** It is served only to the machine running the
server. If you are trying to reach it from another computer, or through your
tunnel, that is the refusal working as intended.
