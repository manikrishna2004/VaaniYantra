import crypto from 'crypto';
import { getPlatformConfig } from '@/lib/platform';
import { fetchWithTimeout } from '@/lib/net/fetch';
import { WA_TEMPLATE_DEFINITIONS, type WaTemplateDefinition } from '@/lib/whatsapp-templates';

// WhatsApp via Meta's Cloud API — a shared platform sender, plus own-brand
// numbers for businesses that want one.
//
// The platform owns a single verified Cloud API sender that every org uses by
// default, with no setup at all. Its credentials live in PlatformConfig,
// founder-set in /admin: the Meta app id/secret, our WABA id, a long-lived
// system-user token with whatsapp_business_messaging, and the phone-number id
// of the shared sender (`meta_default_phone_number_id`).
//
// A business can also connect its OWN WhatsApp number through Meta Embedded
// Signup on the Connectors page — messages then come from the clinic's own
// brand instead of ours. That requires VaaniYantra to be a Meta **Tech
// Provider**, which Meta verified on 2026-08-09. The per-business WABA id,
// phone-number id and access token are stored encrypted per-org in the
// Integration table (see connectors.ts, provider `whatsapp_cloud`); the shared
// sender remains the fallback for every org that hasn't connected one.
//
// NOTE: business-initiated messages (proactive confirmations / owner alerts)
// require Meta-approved message templates; free-form text only lands inside the
// 24h customer-service window. Until a template is approved, proactive sends are
// rejected and the caller falls back to SMS (connectors.ts sendConfirmation).

const DEFAULT_GRAPH_VERSION = 'v21.0';

export const META_KEYS = {
  appId: 'meta_app_id',
  appSecret: 'meta_app_secret',
  configId: 'meta_config_id', // Embedded Signup configuration id
  verifyToken: 'meta_verify_token', // webhook verification challenge
  graphVersion: 'meta_graph_version',
  // For platform-owned numbers (the pool): our WABA + a long-lived system-user
  // token with whatsapp_business_messaging. Used to send from pool numbers.
  wabaId: 'meta_waba_id',
  systemUserToken: 'meta_system_user_token',
  // The single shared platform sender: one phone-number id under our WABA that
  // every org falls back to when it has no own-brand number (the "one number
  // for all businesses" model). Sends with the system-user token.
  defaultPhoneNumberId: 'meta_default_phone_number_id',
} as const;

export type MetaConfig = {
  appId: string | null;
  appSecret: string | null;
  configId: string | null;
  verifyToken: string | null;
  graphVersion: string;
  wabaId: string | null;
  systemUserToken: string | null;
  defaultPhoneNumberId: string | null;
};

export type WhatsappCloudConfig = {
  wabaId: string;
  phoneNumberId: string;
  // Present for own-brand (Embedded Signup) numbers. Absent for platform-pool
  // numbers, which send with the platform system-user token instead.
  accessToken?: string;
  platform?: boolean;
  verifiedName?: string;
  displayPhone?: string;
};

// Audit F-9.2: getMetaConfig did 8 uncached PlatformConfig (DB) reads on every
// WhatsApp send. Cache with a short TTL like the other config resolvers
// (getGeminiApiKey/tunables). Admin changes propagate within the TTL, or call
// invalidateMetaConfigCache() to apply immediately.
let _metaCache: { at: number; cfg: MetaConfig } | null = null;
const META_CACHE_TTL_MS = 30_000;

export function invalidateMetaConfigCache(): void {
  _metaCache = null;
}

export async function getMetaConfig(): Promise<MetaConfig> {
  if (_metaCache && Date.now() - _metaCache.at < META_CACHE_TTL_MS) return _metaCache.cfg;
  const [appId, appSecret, configId, verifyToken, graphVersion, wabaId, systemUserToken, defaultPhoneNumberId] =
    await Promise.all([
      getPlatformConfig(META_KEYS.appId),
      getPlatformConfig(META_KEYS.appSecret),
      getPlatformConfig(META_KEYS.configId),
      getPlatformConfig(META_KEYS.verifyToken),
      getPlatformConfig(META_KEYS.graphVersion),
      getPlatformConfig(META_KEYS.wabaId),
      getPlatformConfig(META_KEYS.systemUserToken),
      getPlatformConfig(META_KEYS.defaultPhoneNumberId),
    ]);
  const cfg: MetaConfig = {
    appId,
    appSecret,
    configId,
    verifyToken,
    graphVersion: graphVersion || DEFAULT_GRAPH_VERSION,
    wabaId,
    systemUserToken,
    defaultPhoneNumberId,
  };
  _metaCache = { at: Date.now(), cfg };
  return cfg;
}

// The single shared platform sender used for every org that hasn't connected its
// own number — the "one WhatsApp number for all businesses" model. Needs our
// WABA + system-user token + the designated default phone-number id. `platform`
// makes tokenFor() send with the system-user token.
export function getPlatformDefaultCloudConfig(cfg: MetaConfig): WhatsappCloudConfig | null {
  if (!cfg.wabaId || !cfg.systemUserToken || !cfg.defaultPhoneNumberId) return null;
  return { wabaId: cfg.wabaId, phoneNumberId: cfg.defaultPhoneNumberId, platform: true };
}

// Whether the platform's own app credentials are on file (shown in /admin).
export function isMetaConfigured(cfg: MetaConfig): boolean {
  return Boolean(cfg.appId && cfg.appSecret && cfg.configId);
}

function graph(cfg: MetaConfig, path: string): string {
  return `https://graph.facebook.com/${cfg.graphVersion}${path}`;
}

// ── Embedded Signup (own-brand numbers) ─────────────────────────────────────
//
// Restored 2026-08-09, when Meta verified VaaniYantra as a Tech Provider
// (App ID 1937548380248554, Business ID 846707008323240). These were removed in
// a7a7ed3 when the product moved to a single shared sender — that sender stays
// as the default and the fallback; own-brand numbers are an opt-in override.
//
// The flow: the browser SDK returns an auth `code` plus the WABA id and
// phone-number id the customer picked; we exchange the code for a
// business-scoped token, subscribe our app to their WABA so their webhooks
// reach us, and register the number for Cloud API sending.

// Exchange the Embedded Signup `code` for a business-scoped access token.
export async function exchangeCode(cfg: MetaConfig, code: string): Promise<string> {
  const url = new URL(graph(cfg, '/oauth/access_token'));
  url.searchParams.set('client_id', cfg.appId!);
  url.searchParams.set('client_secret', cfg.appSecret!);
  url.searchParams.set('code', code);
  const res = await fetchWithTimeout(url.toString(), { timeoutMs: 15_000, retries: 1 });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!res.ok || !json.access_token) throw new Error(json.error?.message || `code exchange failed (${res.status})`);
  return json.access_token;
}

// Subscribe our app to the business's WABA so we receive its message webhooks.
// Without this the number connects and can send, but nothing inbound arrives —
// so unlike the other setup steps this one is fatal, not best-effort.
export async function subscribeApp(cfg: MetaConfig, token: string, wabaId: string): Promise<void> {
  const res = await fetchWithTimeout(graph(cfg, `/${wabaId}/subscribed_apps`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
    retries: 1,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[wa-cloud] subscribe_app failed', res.status, detail);
    throw new Error('Could not subscribe to this WhatsApp account’s messages. Please try connecting again.');
  }
}

// Register the phone number with Cloud API (required once before sending). `pin`
// is the business's two-step-verification PIN; Embedded Signup usually sets it,
// so this is best-effort and non-fatal if the number is already registered.
export async function registerNumber(cfg: MetaConfig, token: string, phoneNumberId: string, pin = '000000'): Promise<void> {
  const res = await fetchWithTimeout(graph(cfg, `/${phoneNumberId}/register`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    timeoutMs: 15_000,
    retries: 1,
  });
  if (!res.ok) console.warn('[wa-cloud] register (non-fatal)', res.status, await res.text().catch(() => ''));
}

// Read the connected number's verified name + display number (for the UI).
export async function fetchNumberInfo(
  cfg: MetaConfig,
  token: string,
  phoneNumberId: string,
): Promise<{ verifiedName?: string; displayPhone?: string }> {
  const res = await fetchWithTimeout(graph(cfg, `/${phoneNumberId}?fields=verified_name,display_phone_number`), {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
    retries: 1,
  });
  const json = (await res.json().catch(() => ({}))) as { verified_name?: string; display_phone_number?: string };
  return { verifiedName: json.verified_name, displayPhone: json.display_phone_number };
}

// The token for a given connection: the business's own (from Embedded Signup)
// when it has connected a number, otherwise the platform system-user token that
// drives the shared sender.
function tokenFor(cfg: MetaConfig, wa: WhatsappCloudConfig): string | null {
  return wa.accessToken || cfg.systemUserToken || null;
}

// Send a free-form text message (valid inside the 24h service window, or as a
// reply). Returns whether Meta accepted it.
export async function sendCloudText(cfg: MetaConfig, wa: WhatsappCloudConfig, to: string, body: string): Promise<boolean> {
  const token = tokenFor(cfg, wa);
  if (!token) return false;
  try {
    const res = await fetchWithTimeout(graph(cfg, `/${wa.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'text',
        text: { body },
      }),
      timeoutMs: 15_000,
      retries: 2,
    });
    if (!res.ok) console.error('[wa-cloud] send text failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[wa-cloud] send text error', err);
    return false;
  }
}

// Send an approved template message (required for business-initiated messages
// outside the 24h window). `bodyParams` fill the template's {{1}}, {{2}}, … in
// order.
export async function sendCloudTemplate(
  cfg: MetaConfig,
  wa: WhatsappCloudConfig,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[] = [],
  otpCode?: string,
): Promise<boolean> {
  const token = tokenFor(cfg, wa);
  if (!token) return false;
  // Meta requires an authentication template's copy-code button to be sent as a
  // URL button carrying the code a SECOND time — the body parameter is the text
  // of the message, this is what tapping "Copy code" puts on the clipboard.
  // Without it the send is rejected for a missing button component.
  const components: object[] = [];
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) });
  }
  if (otpCode) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: otpCode }],
    });
  }
  try {
    const res = await fetchWithTimeout(graph(cfg, `/${wa.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          ...(components.length ? { components } : {}),
        },
      }),
      timeoutMs: 15_000,
      retries: 2,
    });
    if (!res.ok) console.error('[wa-cloud] send template failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('[wa-cloud] send template error', err);
    return false;
  }
}

// List the WABA's message templates (name + status), for the founder to see
// which are approved.
export async function listTemplates(cfg: MetaConfig, wa: WhatsappCloudConfig): Promise<Array<{ name: string; status: string; language: string }>> {
  const token = tokenFor(cfg, wa);
  if (!token) return [];
  const res = await fetch(graph(cfg, `/${wa.wabaId}/message_templates?fields=name,status,language&limit=100`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => ({}))) as { data?: Array<{ name: string; status: string; language: string }> };
  return json.data ?? [];
}

// ── Template provisioning for own-brand WABAs ───────────────────────────────
//
// A freshly connected WABA has no templates, so every proactive message would
// be rejected until someone created them by hand in WhatsApp Manager. As a Tech
// Provider we create them for the customer at connect time. Meta then reviews
// them (usually minutes for Utility); until each is APPROVED, sends of that
// template fail and the caller's existing SMS fallback covers it.

export type TemplateStatus = {
  name: string;
  status: string;
  language: string;
  /** Needed to edit it — see editTemplate. */
  id?: string;
  /** What Meta FILED it as, which is not always what we asked for. */
  category?: string;
};

// Create one template in a WABA. Returns null on success, or a human-readable
// reason on failure. An already-existing template counts as success: connect is
// re-runnable (reconnecting a number must not fail because we got there first).
export async function createTemplate(
  cfg: MetaConfig,
  token: string,
  wabaId: string,
  def: WaTemplateDefinition,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(graph(cfg, `/${wabaId}/message_templates`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: def.name,
        language: def.language,
        category: def.category,
        // An AUTHENTICATION template has no body text of ours: Meta composes it
        // (and the security line) from these flags, and rejects a `text` field
        // here outright. It must also carry an OTP button or it is not a valid
        // authentication template.
        components:
          def.category === 'AUTHENTICATION'
            ? [
                { type: 'BODY', add_security_recommendation: true },
                ...(def.codeExpirationMinutes
                  ? [{ type: 'FOOTER', code_expiration_minutes: def.codeExpirationMinutes }]
                  : []),
                {
                  type: 'BUTTONS',
                  buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: def.otpButtonText || 'Copy code' }],
                },
              ]
            : [
                {
                  type: 'BODY',
                  text: def.body,
                  ...(def.example.length ? { example: { body_text: [def.example] } } : {}),
                },
              ],
      }),
      timeoutMs: 20_000,
      retries: 1,
    });
    if (res.ok) return null;
    const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string; error_subcode?: number } };
    const msg = detail.error?.message || `HTTP ${res.status}`;
    // 2388024 = a template with this name and language already exists.
    if (detail.error?.error_subcode === 2388024 || /already exists/i.test(msg)) return null;
    console.error('[wa-cloud] create template failed', def.name, res.status, msg);
    return msg;
  } catch (err) {
    console.error('[wa-cloud] create template error', def.name, err);
    return err instanceof Error ? err.message : 'network error';
  }
}

// Edit an EXISTING template's body in place, by template id.
//
// Why this exists rather than delete-and-recreate: Meta blocks reuse of a
// deleted template's name for 30 days, so recreating under the same name is not
// available when a body turns out to be wrong. Editing keeps the name and the
// id.
//
// This edits the BODY ONLY, and deliberately does not send `category`. Meta
// fixes the category at approval: an edit carrying it is rejected with subcode
// 3835031, "You cannot update an approved template category", while the same
// edit without it returns 200 and leaves the category unchanged. A template
// filed as MARKETING therefore stays MARKETING however it is reworded — which
// matters, because marketing messages are capped per user (131049) and are never
// free (131042). Fixing a miscategorised template means creating a NEW one whose
// wording earns the category, not editing this one.
//
// An edit puts the template back into PENDING review. The previously approved
// version keeps sending meanwhile, so this is safe to run against a template
// that is in use — but the NEW body is not live until it is approved, and code
// that depends on the new parameter layout must wait for that.
export async function editTemplate(
  cfg: MetaConfig,
  token: string,
  templateId: string,
  def: WaTemplateDefinition,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(graph(cfg, `/${templateId}`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        components: [
          {
            type: 'BODY',
            text: def.body,
            ...(def.example.length ? { example: { body_text: [def.example] } } : {}),
          },
        ],
      }),
      timeoutMs: 20_000,
      retries: 1,
    });
    if (res.ok) return null;
    const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = detail.error?.message || `HTTP ${res.status}`;
    console.error('[wa-cloud] edit template failed', def.name, res.status, msg);
    return msg;
  } catch (err) {
    console.error('[wa-cloud] edit template error', def.name, err);
    return err instanceof Error ? err.message : 'network error';
  }
}

// Create every provisionable template in a newly connected WABA.
//
// Best-effort by design: a customer whose number connects but whose templates
// fail review is in a strictly better position than one whose connection was
// rolled back, and proactive messages fall back to SMS meanwhile. The caller
// surfaces `failed` so the UI can say which need attention.
export async function provisionTemplates(
  cfg: MetaConfig,
  token: string,
  wabaId: string,
): Promise<{ created: number; failed: Array<{ name: string; reason: string }> }> {
  const failed: Array<{ name: string; reason: string }> = [];
  let created = 0;
  for (const def of WA_TEMPLATE_DEFINITIONS) {
    const reason = await createTemplate(cfg, token, wabaId, def);
    if (reason) failed.push({ name: def.name, reason });
    else created += 1;
  }
  return { created, failed };
}

// Template names + review status for a WABA, using an explicit token so this
// works for a business's own WABA as well as the platform's.
export async function fetchTemplateStatuses(
  cfg: MetaConfig,
  token: string,
  wabaId: string,
): Promise<TemplateStatus[]> {
  try {
    const res = await fetchWithTimeout(
      graph(cfg, `/${wabaId}/message_templates?fields=name,status,language,id,category&limit=100`),
      { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 15_000, retries: 1 },
    );
    if (!res.ok) return [];
    const json = (await res.json().catch(() => ({}))) as { data?: TemplateStatus[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

// Verify a Meta webhook payload: X-Hub-Signature-256 = sha256=HMAC(appSecret, rawBody).
export function verifyMetaSignature(appSecret: string, rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
