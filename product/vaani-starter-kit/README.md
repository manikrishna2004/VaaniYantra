# The Voice Agent Starter Kit

A phone number that answers itself, understands the caller, books them into a
real calendar, and sends a WhatsApp confirmation before they have put the phone
down.

Set it up in a browser, on your own machine. You own all of it — every line is
readable JavaScript with no build step. There is no account to create with us,
no per-minute fee to us, and nothing phones home.

---

## What it does

```
   caller                                              you
     │                                                  │
     │  rings your number                               │
     ▼                                                  │
  Twilio ──────▶ server.js ──────▶ Gemini Live          │
  or Exotel      │      ▲          (listens, thinks,    │
     ▲           │      │           speaks)             │
     └───────────┘      │                               │
      agent's voice     │                               │
                        ├──▶ Google Calendar ───────────┤ real booking
                        └──▶ WhatsApp ────────▶ caller  │ confirmation
```

The agent holds a natural spoken conversation. It can be interrupted mid
sentence. It checks a real diary before offering a time, and it will not invent
one. If it cannot help, it takes a message instead of guessing.

## What you need

| | | |
|---|---|---|
| Node.js 20+ | free | nodejs.org |
| A Google Gemini API key, **with billing enabled** | see below | aistudio.google.com/apikey |
| A phone number from Twilio **or** Exotel | ~$1/mo, or Indian pricing | twilio.com / exotel.com |
| ngrok, for testing | free | ngrok.com |
| WhatsApp Business (optional) | free tier available | business.facebook.com |
| A Google account (optional) | free | for the calendar |

Only Node and a Gemini key are needed to hear it talk.

> **The realtime API is paid, and this catches people out.** Creating a key is
> free, and a key with no billing behind it looks perfect — it lists every
> model. But the moment a call opens a live session, Google closes it, and your
> agent answers the phone and says nothing.
>
> Enable billing or add credits on the project at
> [ai.studio/projects](https://ai.studio/projects). The setup screen's **Test
> the AI key** button opens a real session and tells you plainly if this is the
> problem, so you find out in five seconds rather than on a call.

## Thirty minutes, start to finish

**1. Install and start it** (2 min)

```bash
npm install
npm start
```

**2. Open the setup screen**

```
http://localhost:8080/setup
```

Everything is configured there, and the guide is built into it. Each step has
a **How to get these** panel with click-by-click instructions — which page of
Twilio, which menu in Exotel, where Google hides the setting — plus the thing
that silently goes wrong at that step.

Each step also has a **Test** button that makes a real call to the service and
tells you exactly what is wrong if it fails — not "invalid credentials", but
which of the three things it could be.

| Step | What it wants |
|---|---|
| 1. Your business | Name, what kind of business, what the agent calls itself, timezone |
| 2. Voice & AI | Gemini key, which model, which voice, which language |
| 3. Phone line | Twilio or Exotel, their credentials, and your public URL |
| 4. WhatsApp | Optional. Skip it and the agent simply never mentions a confirmation |
| 5. Calendar | Optional. One button connects Google — no OAuth playground |
| 6. Hours & rules | Opening hours, appointment length, recording notice, turn-taking |

There is no `.env` to edit and no code to change. Settings are saved to
`config.json` and take effect immediately — switching from Twilio to Exotel
applies on the very next call, without a restart.

> The setup screen is served **only to the machine running the server**. It
> holds your API keys, so it is refused to anything arriving over the network,
> including your public tunnel.

**3. Hear it talk** (2 min)

```bash
npm run simulate
```

That writes `greeting.wav`. Play it. That is your agent, reading the prompt you
can edit. No phone number needed yet.

**4. Put it on a real number** (15 min)

Run `ngrok http 8080`, paste the https URL into step 3 of the setup screen, and
the screen shows you **the exact URL to paste into your provider's dashboard**,
with a copy button. It differs by provider:

- **Twilio** asks your server what to do, so you give it `…/voice` as the
  webhook for "A call comes in".
- **Exotel** never asks. You attach a Voicebot applet to your ExoPhone pointing
  straight at `wss://…/exotel`.

Ring the number.

**5. Check everything at a glance**

```bash
npm run check
```

The same tests as the setup screen, from the terminal — useful once it is
deployed somewhere you only reach over SSH.

## Making it yours

Everything about how the agent behaves is in **`agent/prompt.md`**. It is plain
English, it is re-read on every call, and it is the only file most people ever
need to touch. Change a line, run `npm run simulate`, listen.

`agent/examples/` has finished prompts for a dental clinic, a salon and a real
estate office. Copy one over `prompt.md` to start from it.

## The files

```
server.js              the phone line: answer webhook + audio bridge
setup/index.html       the setup screen
agent/prompt.md        ← the agent's personality. Start here.
agent/prompt.js        assembles the final instruction at call time
lib/live.js            the Gemini Live conversation
lib/codec.js           phone audio ⇄ model audio, both wire formats
lib/providers.js       every Twilio-vs-Exotel difference, in one file
lib/config.js          the settings schema the setup screen is built from
lib/tests.js           the connection tests behind every Test button
lib/setup-api.js       saving settings, and the Google OAuth flow
lib/tools.js           what the agent can DO: check diary, book, take message
connectors/calendar.js Google Calendar
connectors/whatsapp.js WhatsApp Cloud API
connectors/store.js    calls.json — every call, transcript and booking
```

## What it costs to run

Per minute of conversation, roughly:

| | |
|---|---|
| Twilio inbound (or Exotel, priced in INR) | ~$0.0085 |
| Gemini Live audio (billing required) | ~$0.03–0.09 depending on model |
| WhatsApp utility message | ~$0.004, first 1000/month free |
| Google Calendar | free |

Call it **3 to 7 cents a minute**, plus about a dollar a month for the number.
A clinic taking 100 calls a month at 3 minutes each lands near $12.

`GUIDE.md section 8` covers the legal side — call recording consent, and what
you must not let the agent claim.

## Support

The kit is sold as-is, with the guide. If you get stuck, the most useful thing
you can send is the output of `npm run check` plus the last 20 lines of the
server terminal.

## Licence

One business, unlimited phone numbers. Modify it freely, run it for your own
company or for a client you build it for. You may not resell or redistribute
the kit itself. See LICENCE.txt.
