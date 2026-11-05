/**
 * The guide, inside the product.
 *
 * GUIDE.md exists and goes deeper, but nobody reads a Markdown file while
 * staring at an empty "API key" box. Every instruction needed to fill a step
 * lives here instead, and the setup screen shows it right above the fields.
 *
 * Rules for writing these:
 *
 *   • Name the screen the buyer is looking at. "Settings → API Settings", not
 *     "your account page" — menus are findable, paraphrases are not.
 *   • Put the thing that silently goes wrong in `warn`. Those are the lines
 *     that save an afternoon, and they are why this is worth reading at all.
 *   • Say what a value looks like, so a wrong paste is obvious immediately.
 *
 * Links are written as [label](https://url) and turned into real anchors by
 * the page. No HTML — the page builds nodes rather than setting innerHTML.
 */

export const HELP = {
  business: {
    intro:
      'This is what the agent says it is. It goes straight into the prompt, so the words you choose here are the words the caller hears.',
    steps: [
      'Business name — say it exactly as you would answer the phone. "Sunrise Dental" rather than "Sunrise Dental Pvt Ltd".',
      'What kind of business — this decides the vocabulary the agent reaches for and what it treats as none of its business. "dental clinic" and "dental surgery" produce noticeably different calls.',
      'What the agent calls itself — any first name. Callers use it, so pick something easy to hear over a phone line.',
      'Timezone — pick the city you actually operate in. The list is every timezone your computer knows.',
      'Opening line — leave blank and the agent builds a sensible one from the two names above.',
    ],
    warn:
      'The timezone is the one field where a mistake does real damage. Every appointment is worked out from it, and a wrong one books people on the wrong day without any error appearing anywhere.',
  },

  ai: {
    intro: 'This is the brain and the voice. A key takes about a minute to create.',
    steps: [
      'Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with any Google account.',
      'Click **Create API key**, pick a project, and copy the key.',
      'Paste it above, then press **Test the AI key**.',
      'Enable billing on that project at [ai.studio/projects](https://ai.studio/projects) — see the warning below.',
      'Voice: try a few. Aoede is calm, Puck is bright, Charon is deep. Pick with your ears, and with your customers in mind.',
      'Model: native audio sounds the most human and follows whatever language the caller speaks. The half-cascade "live" model replies a touch faster and sticks to one language.',
    ],
    warn:
      'Creating a key is free, but live phone calls are billed, and this catches almost everyone. A key with no billing behind it looks perfect — it lists every model — then Google closes the session the instant a call starts, and your agent answers the phone and says nothing. The Test button opens a real session and tells you outright if this is the problem.',
  },

  twilio: {
    intro:
      'Twilio sells phone numbers in about 100 countries and you can be taking calls in ten minutes. Everything is self-serve.',
    steps: [
      'Sign up at [twilio.com](https://www.twilio.com/try-twilio).',
      'From the Console dashboard, copy the **Account SID** (it starts with `AC`) and the **Auth Token**, and paste both above.',
      'Buy a number: **Phone Numbers → Manage → Buy a number**, filtered by **Voice**. A US local number is about $1.15 a month.',
      'Start ngrok in a terminal: `ngrok http 8080`, and paste the `https://` address it prints into the Public URL box above.',
      'Press **Test Twilio** and **Test the public URL**. Both must pass.',
      'Copy the webhook URL shown below the fields, then in Twilio go to **Phone Numbers → your number → Voice Configuration** and set **A call comes in** to **Webhook**, **HTTP POST**, with that URL.',
      'Ring the number.',
    ],
    warn:
      'Two things bite here. A trial account only calls numbers you have verified and plays a trial message first, so upgrade before showing anyone. And the free ngrok address changes every time you restart it — when it does you must update it both here and in Twilio, which is the most common reason a working agent suddenly stops answering.',
  },

  exotel: {
    intro:
      'Exotel is the better choice for Indian numbers and Indian pricing, but it works differently from Twilio in two ways that matter.',
    steps: [
      'Sign up at [exotel.com](https://exotel.com) and complete KYC. Numbers are issued by Exotel after verification — start this early, it takes days.',
      'Go to **Settings → API Settings** and copy the **Account SID**, **API Key** and **API Token** into the boxes above.',
      'Pick the region host matching your account. For an Indian account that is `api.in.exotel.com`.',
      'Start ngrok: `ngrok http 8080`, and paste the `https://` address into the Public URL box.',
      'Press **Test Exotel** and **Test the public URL**.',
      'Copy the `wss://` address shown below the fields. In Exotel go to **App Bazaar → Create App**, add a **Voicebot** applet, and set its URL to that address.',
      'Save the App, then under **ExoPhones** attach it to your number.',
    ],
    warn:
      'Exotel never asks your server what to do when a call arrives — there is no webhook. Routing is the Voicebot applet you attach to the number, which is why the address here is `wss://` and not `https://`. Also, if the test returns 401, it means one of exactly three things: wrong API key or token, wrong Account SID, or the wrong region host. Exotel answers 401 for all three.',
  },

  whatsapp: {
    intro:
      'Optional. This sends the caller a confirmation after a booking. Skip it and the agent simply never mentions one.',
    steps: [
      'Go to [developers.facebook.com](https://developers.facebook.com/apps) and create an app of type **Business**.',
      'Add the **WhatsApp** product. It gives you a test number and a **Phone number ID** — copy that into the box above.',
      'Make a permanent token: [business.facebook.com](https://business.facebook.com) → **Settings → Users → System Users → Add**, role **Admin**.',
      'On that system user: **Add Assets** → your WhatsApp app → enable **Manage**. Then **Generate New Token**, tick `whatsapp_business_messaging` and `whatsapp_business_management`, and set expiry to **Never**.',
      'In **WhatsApp Manager → Message Templates → Create Template**, make one named exactly as in the box above, **category Utility**, language English.',
      'Give it this body, with three placeholders: `Hi {{1}}, your appointment at {{2}} is confirmed for {{3}}.`',
      'Submit it, wait for approval (usually minutes), then press **Test WhatsApp**.',
    ],
    warn:
      'WhatsApp will not let you message someone who has not messaged you in the last 24 hours — and a person who just rang your phone has not. That is why the confirmation has to be an approved template, and why free text silently fails. Worse, a template\'s category can never be changed: pick Marketing instead of Utility by mistake and your confirmations get filtered forever, with no error. You have to delete it and start again under a new name.',
  },

  calendar: {
    intro:
      'Optional, and worth it — this is what lets the agent see real free time and make real bookings. Without it the agent takes messages instead and never promises a slot.',
    steps: [
      'Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.',
      '**APIs & Services → Library** → search **Google Calendar API** → **Enable**.',
      '**OAuth consent screen** → **External**. Fill in the required fields, add the scope `https://www.googleapis.com/auth/calendar`, and add your own Google account under **Test users**.',
      '**Credentials → Create Credentials → OAuth client ID** → type **Web application**.',
      'Under **Authorised redirect URIs**, add the exact address shown below the fields. Copy it from there — it must match character for character.',
      'Copy the **Client ID** and **Client secret** into the boxes above and press Save.',
      'Press **Connect Google Calendar**, sign in, and allow access. You will see an "unverified app" warning — it is your own app, click through it.',
      'Press **Test the calendar**. It reports how many slots are free today.',
    ],
    warn:
      'If bookings stop working after about a week, the test will say `invalid_grant`. It means your consent screen is still in **Testing**, where Google expires these tokens after 7 days. Fix it with **OAuth consent screen → Publish App**, then press Connect again. If Google says it returned no refresh token, the account has already authorised this app once — remove it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and reconnect.',
  },

  hours: {
    intro:
      'When you are open, and how the agent behaves. These have working defaults, so you can leave them alone and come back later.',
    steps: [
      'Opens / closes / open days — the agent will never offer a time outside these, on a closed day, in the past, or starting within the next 15 minutes.',
      'Appointment length — how long one booking blocks out in the calendar.',
      'Announce recordings — required by law in some places. Check what applies where your callers are.',
      'Pause before the agent replies — how long a silence means the caller has finished. 300ms feels natural; 150 is sharp but cuts off anyone who pauses to think; 600 feels slow and polite.',
    ],
    warn:
      'That pause setting changes the personality of the agent more than most edits to the prompt do. If it feels rude, raise it before you rewrite anything.',
  },
};

/** Which help block applies to a step, given the chosen telephony provider. */
export function helpFor(stepKey, provider = 'twilio') {
  if (stepKey === 'phone') return HELP[provider === 'exotel' ? 'exotel' : 'twilio'];
  return HELP[stepKey] || null;
}
