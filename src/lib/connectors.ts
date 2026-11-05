import { prisma } from '@/lib/db';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import { toE164 } from '@/lib/phone';
import { getCalendarConfig } from '@/lib/calendar';
import { refreshAccessToken } from '@/lib/google-oauth';
import {
  getMetaConfig,
  getPlatformDefaultCloudConfig,
  sendCloudText,
  sendCloudTemplate,
  type WhatsappCloudConfig,
} from '@/lib/whatsapp-cloud';
import type { WaTemplate } from '@/lib/whatsapp-templates';
import { whatsappEnabled } from '@/lib/flags';
import type { ExotelAccount, PlivoAccount } from '@prisma/client';

// Phase v2 #2 — Connectors. External apps a workspace connects so agents can
// take REAL actions: Google Calendar (book appointments) and WhatsApp (Twilio).

export const CONNECTORS = [
  { key: 'google', label: 'Google Calendar', hint: 'Check a doctor’s real availability and book confirmed appointments.' },
  { key: 'whatsapp', label: 'WhatsApp', hint: 'Send WhatsApp confirmations/follow-ups via your Twilio sender.' },
] as const;

// ── WhatsApp config (stored in the Integration table, encrypted) ────────────
const WHATSAPP_PROVIDER = 'whatsapp';

export type WhatsappConfig = { from: string; accountSid?: string; authToken?: string };

export async function getWhatsappConfig(orgId: string | null | undefined): Promise<WhatsappConfig | null> {
  if (!orgId) return null;
  const row = await prisma.integration.findFirst({ where: { orgId, provider: WHATSAPP_PROVIDER, enabled: true } });
  if (!row) return null;
  try {
    return JSON.parse(decryptSecret(row.secret)) as WhatsappConfig;
  } catch {
    return null;
  }
}

export async function setWhatsappConfig(orgId: string, createdById: string, cfg: WhatsappConfig): Promise<void> {
  const secret = encryptSecret(JSON.stringify(cfg));
  await prisma.integration.upsert({
    where: { orgId_provider_userId: { orgId, provider: WHATSAPP_PROVIDER, userId: '' } },
    update: { secret, lastFour: cfg.from.slice(-4), enabled: true },
    create: { orgId, provider: WHATSAPP_PROVIDER, secret, lastFour: cfg.from.slice(-4), createdById },
  });
}

export async function disconnectWhatsapp(orgId: string): Promise<void> {
  await prisma.integration.deleteMany({ where: { orgId, provider: WHATSAPP_PROVIDER } });
}

// ── WhatsApp Cloud API (own-brand, via Meta Embedded Signup) ────────────────
// Stored per-org in the Integration table, encrypted. Distinct from the Twilio
// `whatsapp` provider above; sendWhatsApp() prefers this when present.
const WHATSAPP_CLOUD_PROVIDER = 'whatsapp_cloud';

export async function getWhatsappCloudConfig(orgId: string | null | undefined): Promise<WhatsappCloudConfig | null> {
  if (!orgId) return null;
  const row = await prisma.integration.findFirst({ where: { orgId, provider: WHATSAPP_CLOUD_PROVIDER, enabled: true } });
  if (!row) return null;
  try {
    return JSON.parse(decryptSecret(row.secret)) as WhatsappCloudConfig;
  } catch {
    return null;
  }
}

export async function setWhatsappCloudConfig(orgId: string, createdById: string, cfg: WhatsappCloudConfig): Promise<void> {
  const secret = encryptSecret(JSON.stringify(cfg));
  const lastFour = (cfg.displayPhone || cfg.phoneNumberId).slice(-4);
  await prisma.integration.upsert({
    where: { orgId_provider_userId: { orgId, provider: WHATSAPP_CLOUD_PROVIDER, userId: '' } },
    update: { secret, lastFour, enabled: true },
    create: { orgId, provider: WHATSAPP_CLOUD_PROVIDER, secret, lastFour, createdById },
  });
}

export async function disconnectWhatsappCloud(orgId: string): Promise<void> {
  await prisma.integration.deleteMany({ where: { orgId, provider: WHATSAPP_CLOUD_PROVIDER } });
}

// Reverse-lookup the org that owns a given Cloud API phone-number id (from an
// inbound webhook). Low volume, so we decrypt-and-match; add an index column if
// this ever gets hot.
export async function findOrgIdByCloudPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const rows = await prisma.integration.findMany({ where: { provider: WHATSAPP_CLOUD_PROVIDER, enabled: true } });
  for (const row of rows) {
    try {
      const cfg = JSON.parse(decryptSecret(row.secret)) as WhatsappCloudConfig;
      if (cfg.phoneNumberId === phoneNumberId) return row.orgId;
    } catch {
      /* skip unreadable rows */
    }
  }
  return null;
}

/** Why an inbound WhatsApp message did (or did not) resolve to an org. */
export type InboundWhatsappRoute =
  | { orgId: string; reason: 'own-number' | 'patient-match' }
  | { orgId: null; reason: 'unknown-number' | 'unknown-sender' | 'ambiguous' };

/**
 * Which clinic should answer an inbound WhatsApp message.
 *
 * There are two cases, and they are genuinely different:
 *
 *   Own-brand number — the business messaged is the business that answers.
 *   Match the recipient's phone-number id against the stored integration.
 *
 *   The SHARED platform sender — every clinic messages from the same number, so
 *   the recipient id identifies the PLATFORM and says nothing about which
 *   clinic the patient meant. Matching it against a stored id is wrong twice:
 *   the stored copy goes stale (outbound rebuilds the sender from platform
 *   config every send, inbound compared a frozen snapshot, and inbound silently
 *   died the day the real number replaced the sandbox one), and every org would
 *   match the same id anyway, so the first row would win and one clinic's
 *   patients would land in another clinic's workspace.
 *
 *   So shared-sender traffic is routed by the PATIENT instead: the org that has
 *   this person on file. If two clinics both have them, we refuse. Delivering a
 *   medical conversation to the wrong clinic is worse than delivering it
 *   nowhere, and a silent wrong answer is the one outcome with no recovery.
 */
export async function resolveInboundWhatsappOrg(input: {
  phoneNumberId: string;
  from: string;
}): Promise<InboundWhatsappRoute> {
  const meta = await getMetaConfig().catch(() => null);
  const shared = meta?.defaultPhoneNumberId;
  const isSharedSender = !!shared && input.phoneNumberId === shared;

  if (!isSharedSender) {
    const orgId = await findOrgIdByCloudPhoneNumberId(input.phoneNumberId);
    return orgId ? { orgId, reason: 'own-number' } : { orgId: null, reason: 'unknown-number' };
  }

  const digits = input.from.replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
  if (!digits) return { orgId: null, reason: 'unknown-sender' };

  // Contacts are stored E.164 ("+91…"), but accept a bare-digits row too rather
  // than lose a patient to a formatting difference.
  const rows = await prisma.contact.findMany({
    where: { phone: { in: [`+${digits}`, digits] } },
    select: { orgId: true },
    distinct: ['orgId'],
    take: 5,
  });

  if (rows.length === 0) return { orgId: null, reason: 'unknown-sender' };
  if (rows.length > 1) return { orgId: null, reason: 'ambiguous' };
  return { orgId: rows[0].orgId, reason: 'patient-match' };
}

// Reverse-lookup the org that owns a WhatsApp sender number (inbound). Matches a
// designated connected Twilio/Exotel number first, then the legacy paste-in.
export async function findOrgIdByWhatsappFrom(from: string): Promise<string | null> {
  const digits = from.replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
  if (!digits) return null;

  const numbers = await prisma.phoneNumber.findMany({
    where: { whatsappEnabled: true },
    select: { e164: true, workspace: { select: { orgId: true } } },
  });
  for (const n of numbers) {
    if (n.e164.replace(/[^\d]/g, '') === digits) return n.workspace.orgId;
  }

  const rows = await prisma.integration.findMany({ where: { provider: WHATSAPP_PROVIDER, enabled: true } });
  for (const row of rows) {
    try {
      const cfg = JSON.parse(decryptSecret(row.secret)) as WhatsappConfig;
      if (cfg.from && cfg.from.replace(/[^\d]/g, '') === digits) return row.orgId;
    } catch {
      /* skip unreadable rows */
    }
  }
  return null;
}

// ── HubSpot CRM (stored in the Integration table; read via getOrgCredentials) ──
// Push a contact + call note to the org's HubSpot when calls complete (crm.ts).
// The secret is a HubSpot Private App access token.
const HUBSPOT_PROVIDER = 'hubspot';

export async function getHubspotConnected(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  return Boolean(
    await prisma.integration.findFirst({ where: { orgId, provider: HUBSPOT_PROVIDER, enabled: true } }),
  );
}

// Validate a Private App token against HubSpot (a cheap authenticated GET).
export async function verifyHubspotToken(token: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function setHubspotToken(orgId: string, createdById: string, token: string): Promise<void> {
  const secret = encryptSecret(token);
  await prisma.integration.upsert({
    where: { orgId_provider_userId: { orgId, provider: HUBSPOT_PROVIDER, userId: '' } },
    update: { secret, lastFour: token.slice(-4), enabled: true },
    create: { orgId, provider: HUBSPOT_PROVIDER, secret, lastFour: token.slice(-4), createdById },
  });
}

export async function disconnectHubspot(orgId: string): Promise<void> {
  await prisma.integration.deleteMany({ where: { orgId, provider: HUBSPOT_PROVIDER } });
}

// ── Status (for the Connectors page) ────────────────────────────────────────
// `whatsappCloud` reports an OPTIONAL own-brand number. Not connecting one is a
// perfectly good state, not a missing step: those orgs send over the platform's
// shared verified sender with no setup at all. The UI must say so rather than
// showing WhatsApp as unconfigured.
export async function getConnectorStatus(orgId: string) {
  const [google, whatsappCloud, hubspot] = await Promise.all([
    getCalendarConfig(orgId),
    getWhatsappCloudConfig(orgId),
    getHubspotConnected(orgId),
  ]);
  return {
    google: { connected: Boolean(google), email: google?.email ?? null, calendarId: google?.calendarId ?? null },
    whatsappCloud: {
      connected: Boolean(whatsappCloud),
      verifiedName: whatsappCloud?.verifiedName ?? null,
      displayPhone: whatsappCloud?.displayPhone ?? null,
    },
    hubspot: { connected: hubspot },
  };
}

// ── Actions (called by agents during/after a call) ──────────────────────────
//
// Google Drive used to live here: every completed call was archived to the
// clinic's Drive as a Doc, and outcomes were appended to a monthly Sheet. Both
// are gone. A clinic getting its data out now downloads a CSV from Reports,
// which works without a Google account and let us drop the `drive.file` scope —
// one less permission to ask a doctor for, and one less restricted scope to
// justify in Google's OAuth verification.

// The org's designated WhatsApp sender number (a connected Twilio/Exotel number
// the owner enabled WhatsApp on), with its provider account for credentials.
async function getOrgWhatsappNumber(orgId: string) {
  return prisma.phoneNumber.findFirst({
    where: { whatsappEnabled: true, workspace: { orgId } },
    include: { twilioAccount: true, exotelAccount: true, plivoAccount: true },
  });
}

const wa = (n: string) => `whatsapp:${toE164(n) ?? (n.startsWith('+') ? n : '+' + n)}`;

// Send a WhatsApp text through a specific Twilio account (the number's own BYO
// account, or the platform env Twilio) with the number as the sender.
async function sendViaTwilioNumber(accountSid: string, authToken: string, from: string, to: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: wa(from), To: wa(to), Body: body }).toString(),
    });
    if (!res.ok) console.error('[whatsapp] twilio-number send failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[whatsapp] twilio-number send error', err);
    return false;
  }
}

// Send a WhatsApp text through the owner's Exotel account (v2 messages API).
async function sendViaExotelNumber(acct: ExotelAccount, from: string, to: string, body: string): Promise<boolean> {
  try {
    const sub = acct.subdomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const res = await fetch(`https://${sub}/v2/accounts/${acct.accountSid}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${acct.apiKey}:${decryptSecret(acct.apiToken)}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            from: toE164(from) ?? from,
            to: toE164(to) ?? to,
            content: { recipient_type: 'individual', type: 'text', text: { body } },
          },
        ],
      }),
    });
    if (!res.ok) console.error('[whatsapp] exotel send failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[whatsapp] exotel send error', err);
    return false;
  }
}

// Send a WhatsApp TEMPLATE (business-initiated — the only thing Meta delivers
// outside a 24h window) through the owner's Exotel account. `tmpl.name` must
// match a template approved in their Exotel WhatsApp account; params fill the
// body {{1}}, {{2}}, … in order. Exotel's v2 messages API mirrors Meta's Cloud
// API template object.
async function sendTemplateViaExotelNumber(acct: ExotelAccount, from: string, to: string, tmpl: WaTemplate): Promise<boolean> {
  try {
    const sub = acct.subdomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const res = await fetch(`https://${sub}/v2/accounts/${acct.accountSid}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${acct.apiKey}:${decryptSecret(acct.apiToken)}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            from: toE164(from) ?? from,
            to: toE164(to) ?? to,
            content: {
              recipient_type: 'individual',
              type: 'template',
              template: {
                name: tmpl.name,
                language: { code: tmpl.lang, policy: 'deterministic' },
                ...(tmpl.params.length
                  ? { components: [{ type: 'body', parameters: tmpl.params.map((t) => ({ type: 'text', text: t })) }] }
                  : {}),
              },
            },
          },
        ],
      }),
    });
    if (!res.ok) console.error('[whatsapp] exotel template send failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[whatsapp] exotel template send error', err);
    return false;
  }
}

// Send a WhatsApp text through the owner's Plivo account. Plivo (a WhatsApp BSP)
// sends via its unified Message API with type="whatsapp"; `from` is the org's
// WhatsApp-registered Plivo number. Auth is Basic auth_id:auth_token.
async function sendViaPlivoNumber(acct: PlivoAccount, from: string, to: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${acct.authId}/Message/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${acct.authId}:${decryptSecret(acct.authToken)}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        src: (toE164(from) ?? from).replace(/^\+/, ''),
        dst: (toE164(to) ?? to).replace(/^\+/, ''),
        type: 'whatsapp',
        text: body,
      }),
    });
    if (!res.ok) console.error('[whatsapp] plivo send failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[whatsapp] plivo send error', err);
    return false;
  }
}

// Send a WhatsApp TEMPLATE (business-initiated) through the owner's Plivo
// account. `tmpl.name`/`tmpl.lang` must match a template approved in the org's
// Plivo WhatsApp account; params fill the body {{1}}, {{2}}, … in order. Plivo's
// template object mirrors Meta's Cloud API.
async function sendTemplateViaPlivoNumber(acct: PlivoAccount, from: string, to: string, tmpl: WaTemplate): Promise<boolean> {
  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${acct.authId}/Message/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${acct.authId}:${decryptSecret(acct.authToken)}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        src: (toE164(from) ?? from).replace(/^\+/, ''),
        dst: (toE164(to) ?? to).replace(/^\+/, ''),
        type: 'whatsapp',
        template: {
          name: tmpl.name,
          language: tmpl.lang,
          ...(tmpl.params.length
            ? { components: [{ type: 'body', parameters: tmpl.params.map((t) => ({ type: 'text', text: t })) }] }
            : {}),
        },
      }),
    });
    if (!res.ok) console.error('[whatsapp] plivo template send failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[whatsapp] plivo template send error', err);
    return false;
  }
}

// Send a WhatsApp text message. Resolution order: the org's own-brand Cloud API
// number (Meta Embedded Signup) → the shared platform sender. The Twilio/Exotel
// WhatsApp paths this comment used to list went away with the per-org senders in
// a7a7ed3; Cloud API is the only WhatsApp transport now.
// NOTE: free text only lands inside a 24h customer window; for
// business-initiated notifications use sendWhatsAppTemplate instead.
export async function sendWhatsApp(orgId: string, rawTo: string, body: string): Promise<boolean> {
  // WhatsApp is the only channel there is now, so the flag being off means no
  // proactive messaging at all rather than "fall back to SMS". WHATSAPP_ENABLED
  // must be true anywhere messages are expected to leave the building.
  if (!whatsappEnabled()) {
    console.error('[whatsapp] WHATSAPP_ENABLED is not true — nothing sent for org', orgId);
    return false;
  }
  // Providers hand us caller ids in mixed formats (Exotel: "0934…"); the
  // messaging APIs strictly need E.164.
  const to = toE164(rawTo) ?? rawTo;
  const meta = await getMetaConfig();

  // 1. The org's own-brand number, if it connected one (Embedded Signup). The
  //    patient sees the clinic's own WhatsApp identity rather than ours.
  const ownCloud = await getWhatsappCloudConfig(orgId);
  if (ownCloud && (await sendCloudText(meta, ownCloud, to, body))) return true;

  // 2. The shared platform sender — the default for every org that hasn't
  //    connected a number, and the fallback when an own-brand send fails.
  const platform = getPlatformDefaultCloudConfig(meta);
  if (platform && (await sendCloudText(meta, platform, to, body))) return true;

  console.error(
    '[whatsapp] delivery failed for org', orgId,
    '— own number:', ownCloud ? 'rejected' : 'not connected',
    '| platform sender:', platform ? 'rejected the message' : 'is not configured',
  );
  return false;
}

// Send a business-initiated WhatsApp notification via an approved Meta template
// (the only thing Meta delivers outside a 24h customer window — e.g. a booking
// confirmation after a phone call). Prefers the org's own-brand number, then the
// shared platform sender. Returns whether Meta accepted it; callers keep an SMS
// fallback for when it doesn't (unconfigured sender, template not yet approved,
// Meta rejection).
//
// The own-brand attempt fails for a newly connected number until Meta finishes
// reviewing its templates (see provisionTemplates). Falling through to the
// shared sender keeps the message delivered during that window — the patient
// sees the platform's verified identity, exactly as they do for every org that
// has not connected a number. Delivery beats brand consistency here; the
// alternative fallback is SMS, which is not the clinic's identity either.
export async function sendWhatsAppTemplate(orgId: string, rawTo: string, tmpl: WaTemplate): Promise<boolean> {
  if (!whatsappEnabled()) return false;
  const to = toE164(rawTo) ?? rawTo;
  const meta = await getMetaConfig();

  const ownCloud = await getWhatsappCloudConfig(orgId);
  if (ownCloud && (await sendCloudTemplate(meta, ownCloud, to, tmpl.name, tmpl.lang, tmpl.params, tmpl.otpCode)))
    return true;

  const platform = getPlatformDefaultCloudConfig(meta);
  if (platform && (await sendCloudTemplate(meta, platform, to, tmpl.name, tmpl.lang, tmpl.params, tmpl.otpCode)))
    return true;

  console.error('[whatsapp] template', tmpl.name, 'not delivered for org', orgId, '— falling back to SMS');
  return false;
}

// Twilio WhatsApp sender (workspace sender + workspace or platform creds).
async function sendWhatsAppTwilio(orgId: string, to: string, body: string): Promise<boolean> {
  const cfg = await getWhatsappConfig(orgId);
  if (!cfg?.from) return false;
  const sid = cfg.accountSid || process.env.TWILIO_ACCOUNT_SID;
  const token = cfg.authToken || process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return false;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: wa(cfg.from),
        To: wa(to),
        Body: body,
      }).toString(),
    });
    if (!res.ok) console.error('[connectors] whatsapp send failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[connectors] whatsapp send error', err);
    return false;
  }
}

// Send a proactive customer message. WhatsApp is the only channel, so there is
// no channel argument to get wrong — the templates are what matters.
//
// A phone call opens no customer-service window, so Meta accepts these ONLY as
// pre-approved templates; free text is rejected outright. Extra templates after
// the first are tried in order when the one before is rejected, which is how a
// newly-introduced template ships safely: prefer the richer one, and degrade to
// the already-approved one for as long as Meta takes to review it.
//
// `body` is no longer a fallback that gets delivered — it is kept because
// several callers still compose one and it is what gets logged when nothing
// could be sent. Returns whether anything was actually delivered.
export async function sendConfirmation(
  orgId: string,
  to: string,
  body: string,
  ...waTemplates: (WaTemplate | undefined)[]
): Promise<boolean> {
  const templates = waTemplates.filter((t): t is WaTemplate => !!t);
  // Six of this function's callers invoke it as `void sendConfirmation(...)`.
  // Delivery already reports failure by returning false, but getMetaConfig() can
  // *throw* (network, DB) — which in a voided call is an unhandled rejection, and
  // in this process that used to end every call in flight. A throw is just
  // another kind of non-delivery, so it is reported the same way.
  try {
    if (templates.length === 0) {
      // Free text only lands inside a 24h window; outside one this simply fails,
      // and there is no longer an SMS underneath to catch it.
      if (await sendWhatsApp(orgId, to, body)) return true;
    } else {
      for (const tmpl of templates) {
        if (await sendWhatsAppTemplate(orgId, to, tmpl)) return true;
      }
      // Every template was refused — not yet approved, rejected in review, or
      // missing from this WABA entirely. Free text is NOT a replacement: Meta
      // refuses it for a business-initiated message, which is the whole reason
      // the templates exist. But it does deliver inside an open 24h
      // customer-service window, and a template-only path threw that case away.
      //
      // So this recovers a message that would otherwise be dropped, and never
      // sends one Meta would not have carried anyway: outside a window the
      // attempt simply fails, exactly as the template did.
      if (await sendWhatsApp(orgId, to, body)) return true;
    }
  } catch (err) {
    console.error('[connectors] delivery threw for org', orgId, err);
    return false;
  }
  console.error('[connectors] nothing delivered for org', orgId, '— message dropped:', body.slice(0, 80));
  return false;
}
