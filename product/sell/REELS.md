# Instagram reels for the Starter Kit

Three scripts, shot in order of difficulty. The first one is the one to make.

## The rule that decides whether any of this works

**Show the phone call. Do not explain the phone call.**

The product is a voice agent. The only proof that matters is a human voice
coming out of a phone speaker, on camera, answering something unscripted. Every
second spent on your face, a logo, or the words "AI powered" is a second the
viewer spends scrolling.

Audio is the product, so the reel only works with sound on. Put the agent's
words on screen as captions too — most people start muted, and the captions are
what make them turn sound on.

---

## Reel 1 — "I called my own clinic"

**Length:** 25–30 seconds. **Difficulty:** one phone, one take.

The whole reel is one continuous shot of a phone on a desk, speaker on, screen
visible. No cuts. The lack of cuts is the proof — a cut is where a viewer
assumes you faked it.

| Time | What is on screen | What is heard | Caption burned in |
|---|---|---|---|
| 0:00–0:03 | Your thumb dialling, phone flat on the desk | ringing | **I called my own clinic.** |
| 0:03–0:07 | Phone connects, timer starts | *"Thanks for calling Bright Smile Dental, this is Maya — how can I help?"* | Nobody works here. |
| 0:07–0:14 | Unmoving shot | You: *"Hi, do you have anything Thursday afternoon? Name's Ravi."* — Maya: *"Let me check, Ravi. I've got two thirty or four o'clock Thursday."* | It's checking a real calendar. |
| 0:14–0:20 | Unmoving shot | You: *"Two thirty's good."* — Maya: *"Done, Ravi — Thursday the first at two thirty. I'll send that to you on WhatsApp."* | — |
| 0:20–0:25 | Tilt to laptop: Google Calendar with the event appearing, then the WhatsApp message arriving | call ends | **It booked it. It sent it.** |
| 0:25–0:30 | Static end card | — | **The whole thing is $5. Link in bio.** |

### Why it is shaped like that

- **Interrupt it once**, around 0:10 — start your sentence before Maya finishes
  hers, and let it stop and listen. That single moment is what separates this
  from every scripted fake in the feed, and people who know the space will spot
  it immediately.
- **The calendar tilt at 0:20 is the whole reel.** Everything before it is
  setup. Do not rush it, and make sure the event's title and time are legible.
- **Use a real unscripted sentence.** "Do you have anything Thursday" said
  naturally beats a clean line read. Stumble a little.
- **Do not say the word AI** until the end card, if at all.

### Caption

> I pointed a phone number at some JavaScript running on my laptop.
>
> It answers, it checks the real calendar, it books, and it WhatsApps the
> confirmation before the caller hangs up.
>
> I packaged the whole workflow — the server, the prompt, and a setup screen
> where you plug in your own Twilio or Exotel, Gemini, WhatsApp and Calendar
> accounts — for the price of a coffee.
>
> Link in bio. You connect your own accounts; it runs on your machine and
> nothing phones home.

### Hook variants to test

Same footage, different first three seconds. Run the same reel four times over
two weeks with these:

1. "I called my own clinic. Nobody works there."
2. "This receptionist doesn't exist."
3. "Missed calls were costing this clinic ₹40,000 a month." *(only if true for a
   real client — do not invent it)*
4. "Watch me interrupt an AI mid-sentence."

Number 4 tends to perform with developers, number 1 with business owners.

---

## Reel 2 — "Thirty minutes, from nothing"

**Length:** 30–40 seconds. **Difficulty:** screen recording plus the phone.

A sped-up screen recording of the actual setup, with a running timer in the
corner. This one sells to developers and converts better than Reel 1, but to a
smaller audience.

| Time | Screen | Caption |
|---|---|---|
| 0:00–0:04 | Empty folder, terminal open | **Phone agent. Thirty minutes. Go.** |
| 0:04–0:09 | `npm install`, `npm start` | 3 dependencies. No build step. |
| 0:09–0:15 | The setup screen: typing a business name, pasting a Gemini key, pressing **Test** and getting a green tick | No config files |
| 0:15–0:20 | `npm run simulate` → `greeting.wav` plays | It's alive |
| 0:20–0:26 | Copy button in the setup screen → paste into Twilio | The only fiddly bit |
| 0:26–0:34 | Real phone rings on the desk, agent answers | **Timer: 00:28:41** |
| 0:34–0:40 | End card | **$5. Link in bio.** |

Do not fake the timer. If it takes you 41 minutes, put 41 minutes on screen —
somebody will try it and post that it took longer, and an honest number is
unarguable.

---

## Reel 3 — "The part everyone gets wrong"

**Length:** 20 seconds. **Difficulty:** trivial. **Purpose:** credibility, not
sales.

Straight to camera or over a screen recording of the WhatsApp error:

> Your AI books the appointment. Then it tries to WhatsApp the confirmation, and
> nothing arrives. No error the customer sees. Nothing.
>
> It's because WhatsApp won't let you message someone who hasn't messaged you
> first — unless you use a template Meta approved in advance.
>
> And here's the part that hurts: the template's category can never be changed.
> Pick "Marketing" instead of "Utility" by mistake, and your booking
> confirmations quietly get filtered forever. You have to delete it and start
> again under a new name.
>
> That's section 5 of the guide.

This one is not really selling the kit. It is proving you have actually shipped
this, which is what makes the other two reels believable. Post it between them.

---

## Posting

- **Format:** 9:16, 1080×1920. Captions burned in, not Instagram's auto ones —
  auto-captions mangle "Twilio" and "Gemini" and the mangling reads as sloppy.
- **Cadence:** Reel 1, wait three days, Reel 3, wait three days, Reel 2. Then
  re-cut Reel 1 with a new hook.
- **Link in bio** goes to `/kit`, not to the Lemon Squeezy checkout. The page
  answers the objections; the checkout does not.
- **Comments are the channel.** "Does it work in Hindi?" and "will this work
  for a salon?" are buying signals. Answer every one in the first two hours —
  it is also what the algorithm rewards.
- **Pin a comment** with the link, because half of viewers will not check the
  bio.

## What not to claim

The site's marketing has a standing rule against invented social proof, and it
applies here more than anywhere — a reel is where the temptation is highest.

Do not say a number of customers, hours saved or revenue recovered unless it is
a real figure from a real client who agreed to it. Do not stage a "customer"
testimonial. Do not imply the kit is what your paying clients run — they run the
hosted platform, which is a different and much larger thing.

The reel does not need any of it. The phone call is the proof.
