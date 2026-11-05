# Launching the Starter Kit

Everything between a finished zip and money arriving. The payment flow is built
and tested; what is left is mostly checking settings in the Cashfree dashboard.

---

## 1. How it works

```
 /kit  ─ sales page
   │
   └─▶ /kit/buy ─ name + email ─▶ POST /api/kit/checkout
                                        │  creates a KitOrder (PENDING)
                                        │  creates a vkt_… order at Cashfree
                                        ▼
                                 Cashfree hosted checkout
                                        │
                        ┌───────────────┴────────────────┐
                        ▼                                ▼
          /kit/thanks?order_id=…            POST /api/kit/webhook
          re-reads the order from            verifies the HMAC, marks
          Cashfree and settles it            PAID, emails the link
                        │                                │
                        └──────────┬─────────────────────┘
                                   ▼
                       KitOrder → PAID + downloadToken
                                   │
                                   ▼
                   /api/kit/download?token=… streams the zip
```

Two things about that shape are deliberate:

**The browser returning does not prove payment.** `/kit/thanks` re-reads the
order from Cashfree's API and only that answer unlocks the file. Anyone can
open the return URL with any order id.

**Both paths settle the order, and settling is idempotent.** The redirect
regularly beats the webhook, and a buyer who has just paid will not accept
"check your email in a minute". Whichever arrives first issues the token; the
second is a no-op and never mints a second one.

## 2. Why it is INR-only

Cashfree cannot charge a card issued outside India — the dashboard refuses it
outright, and the API rejects every non-INR currency. This is already encoded
in `internationalEnabled` in `src/lib/cashfree.ts`.

So there is no dollar price. A foreign buyer would have reached a payment page
only to be declined, which is worse than not offering it. If overseas sales
matter later, that needs a second rail (a merchant of record such as Lemon
Squeezy or Paddle) rather than a second price on the same one.

---

## 3. Before the first sale

### 3.1 Point the webhook at the right place

Kit orders carry their own `notify_url`, so they reach `/api/kit/webhook`
without any dashboard change. But if you also have a **global** webhook set at
**Cashfree → Developers → Webhooks**, it will receive kit events too.

That is handled: the billing webhook now ignores any order id starting `vkt_`
and answers 200. Without that it would have answered 500 — "unresolved order" —
and Cashfree would have retried a payment that was in fact processed correctly.

Make sure the global webhook, if set, points at:

```
https://vaaniyantra.com/api/billing/cashfree/webhook
```

### 3.2 Put the file where the server can read it

The zip is **not** in `public/`. Anything under `public/` is served by Next to
anyone who guesses the filename, which would make the payment step decorative.

```bash
node product/package-kit.mjs
cp product/dist/voice-agent-starter-kit-1.0.0.zip private/voice-agent-starter-kit.zip
```

`private/` is gitignored. On the VM, put the file somewhere outside the web
root and set:

```
KIT_FILE_PATH=/opt/vaani/voice-agent-starter-kit.zip
```

If the file is missing, a paying buyer gets a 503 and the server logs
`PAID order … but the kit file is missing`. Check that log after deploying.

### 3.3 Set the base URL

The return URL and the emailed download link are both built from it:

```
PUBLIC_BASE_URL=https://vaaniyantra.com
```

Without it the checkout falls back to the request's own origin, which works but
means the **email link is not sent at all** — the webhook has no site URL to
build one from. Set it.

### 3.4 Apply the database change

```bash
npx prisma db push
```

Adds the `KitOrder` table. Purely additive — it touches nothing that exists.

### 3.5 Run the tests

```bash
npx tsx scripts/test-kit-purchase.ts
```

Checks the only question that matters commercially: can anyone get the file
without paying. It covers guessed tokens, unpaid orders, double settlement,
the download cap, expiry, and a late failure webhook trying to revoke a
completed payment.

---

## 4. Test with real money

Put ₹299 through it yourself, with a real card or UPI, on production.

There is no substitute. Sandbox does not exercise the webhook signature, the
redirect timing, or your own email deliverability. Watch for:

1. The redirect lands on `/kit/thanks` and shows a download button, not
   "confirming".
2. The zip downloads and opens on a machine that has never had the project.
3. The receipt email arrives, and its link works.
4. `KitOrder` has one row, `PAID`, with a `paidAt` and a token.

Then refund yourself from the Cashfree dashboard.

---

## 5. Tax and records

Cashfree is a gateway, not a merchant of record — **you are the seller**. That
means GST on a ₹299 digital sale to an Indian customer is yours to account for,
unlike the Lemon Squeezy arrangement previously considered here.

The ₹299 is quoted inclusive of tax, so the taxable value and the GST component
have to be derived from it at the rate applying to SAC `998314` (the code
already used for the platform's invoices — see `src/lib/billing/tax.ts`).

The kit's orders are deliberately **not** in the `Invoice` table, which is
org-scoped and belongs to the managed service. Every kit sale is one `KitOrder`
row with an email, an amount and a timestamp, which is what your accountant
needs. Talk to them before the first payout, not at year end.

Nothing here is tax advice.

---

## 6. Refunds

`/refunds` now has a **One-off digital products** section covering this: 14
days, full refund if the kit does not work as described.

Refund from the Cashfree dashboard against the `vkt_…` order id. There is
nothing to revoke afterwards — the download token expires on its own, and a kit
already downloaded cannot be taken back. At ₹299 that is the right trade;
arguing costs more than the refund.

---

## 7. What this is actually for

₹299 does not build a business. 500 sales is ₹1.5 lakh, minus fees, for work
already done.

The kit earns its place three other ways:

1. **It qualifies leads.** Someone who buys it, sets it up, and hits the limits
   of a self-hosted prototype is a far warmer lead for the managed service than
   anyone who filled in a contact form. Every buyer's email is in `KitOrder`.
2. **It is proof.** "Here is the working thing, ₹299, judge for yourself" beats
   any case study you do not have yet.
3. **It gives the reels something to sell.** A 30-second video cannot sell a
   ₹50,000 build. It can sell a ₹299 download, and that buyer list is who you
   later tell about the build.

The receipt email and `/kit/thanks` should both mention that you also build and
run these. That link is where the actual revenue is.
