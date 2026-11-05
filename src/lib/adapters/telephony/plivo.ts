import type {
  AccountNumber,
  PlaceCallParams,
  PlaceCallResult,
  ProvisionedNumber,
  RedirectAction,
  TelephonyProvider,
} from './types';
import { fetchWithTimeout } from '@/lib/net/fetch';

// Plivo implementation (global PSTN, typically cheaper than Twilio/Exotel).
// Plivo maps closely onto Twilio: it can buy numbers via API and fetches a
// per-call answer document (Plivo XML) — so usesAnswerWebhook + canBuyNumbers
// are both true. Two notable differences from Twilio:
//   • Inbound routing isn't a raw VoiceUrl on the number; a number points at a
//     Plivo Application which holds the answer_url. We create/reuse one app per
//     account (name below) and link numbers to it (app id cached on the account).
//   • The audio media stream is Plivo's own dialect (playAudio/clearAudio over
//     the WS, `<Stream>` XML element) — handled in the voice-server/codec, not
//     here. This adapter only speaks the REST API.
//
// Auth is HTTP Basic with Auth ID + Auth Token against api.plivo.com.
const PLIVO_HOST = 'https://api.plivo.com';
const PLIVO_APP_NAME = 'VaaniYantra';

export class PlivoProvider implements TelephonyProvider {
  readonly name = 'plivo';
  readonly canBuyNumbers = true;
  readonly usesAnswerWebhook = true;

  private authId: string;
  private authToken: string;
  // Cached Application id (answer_url) numbers get linked to. Seeded from the
  // stored account when known; discovered/created lazily otherwise.
  private appId: string | null;
  // Called after we discover or create the Plivo Application, so the caller can
  // persist the id back onto the account and skip the lookup next time.
  private onAppId?: (appId: string) => void;

  constructor(creds: { authId: string; authToken: string; appId?: string | null; onAppId?: (appId: string) => void }) {
    if (!creds?.authId || !creds?.authToken) {
      throw new Error('Plivo authId / authToken are required');
    }
    this.authId = creds.authId;
    this.authToken = creds.authToken;
    this.appId = creds.appId ?? null;
    this.onAppId = creds.onAppId;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.authId}:${this.authToken}`).toString('base64');
  }

  private apiBase(): string {
    return `${PLIVO_HOST}/v1/Account/${this.authId}`;
  }

  private async api(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetchWithTimeout(`${this.apiBase()}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // A hung Plivo API must not strand call placement / webhook config.
      timeoutMs: 15_000,
      retries: 1,
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.error || data?.message || data?.api_id || `HTTP ${res.status}`;
      throw new Error(`Plivo ${method} ${path} failed: ${msg}`);
    }
    return data;
  }

  // Cheap authenticated GET used to validate stored credentials.
  async verifyCredentials(): Promise<{ ok: boolean; status: number }> {
    const res = await fetch(`${this.apiBase()}/`, { headers: { Authorization: this.authHeader() } });
    return { ok: res.ok, status: res.status };
  }

  async provisionNumber(areaCodeOrCountry = 'US'): Promise<ProvisionedNumber> {
    // Plivo searches by ISO country (2-letter). Fall back to US if a Twilio-style
    // area code slips through.
    const country = /^[A-Za-z]{2}$/.test(areaCodeOrCountry) ? areaCodeOrCountry.toUpperCase() : 'US';
    const search = await this.api('GET', `/PhoneNumber/?country_iso=${country}&type=local&limit=1`);
    const candidate = search?.objects?.[0]?.number;
    if (!candidate) throw new Error('No available Plivo numbers for ' + country);
    // Buy it, linking our Application so inbound is wired in one step.
    const appId = await this.ensureApplication().catch(() => null);
    await this.api('POST', `/PhoneNumber/${candidate}/`, appId ? { app_id: appId } : {});
    return { e164: candidate.startsWith('+') ? candidate : `+${candidate}`, providerSid: candidate.replace(/^\+/, '') };
  }

  async listAccountNumbers(): Promise<AccountNumber[]> {
    const data = await this.api('GET', `/Number/?limit=20`);
    return (data?.objects ?? []).map((n: any) => {
      const num = String(n.number ?? '');
      return {
        e164: num.startsWith('+') ? num : `+${num}`,
        providerSid: num.replace(/^\+/, ''),
        voiceUrl: n.application ? String(n.application) : undefined,
      } as AccountNumber;
    });
  }

  // Ensure a Plivo Application with our answer_url exists; return its id. Reuses
  // the cached id, then an app matching PLIVO_APP_NAME, else creates one.
  private async ensureApplication(answerUrl?: string, hangupUrl?: string): Promise<string> {
    if (this.appId && !answerUrl) return this.appId;
    // Look for an existing app by name.
    if (!this.appId) {
      const found = await this.api('GET', `/Application/?app_name=${encodeURIComponent(PLIVO_APP_NAME)}&limit=1`).catch(
        () => null,
      );
      const existing = found?.objects?.[0]?.app_id;
      if (existing) this.appId = String(existing);
    }
    // Update (or create) so the answer/hangup URLs are current.
    if (answerUrl) {
      const payload: Record<string, unknown> = {
        answer_url: answerUrl,
        answer_method: 'POST',
        ...(hangupUrl ? { hangup_url: hangupUrl, hangup_method: 'POST' } : {}),
      };
      if (this.appId) {
        await this.api('POST', `/Application/${this.appId}/`, payload);
      } else {
        const created = await this.api('POST', `/Application/`, { app_name: PLIVO_APP_NAME, ...payload });
        this.appId = String(created?.app_id ?? created?.api_id ?? '');
      }
    }
    if (!this.appId) throw new Error('Could not resolve a Plivo Application');
    this.onAppId?.(this.appId);
    return this.appId;
  }

  async configureNumberWebhook(
    providerSid: string,
    params: { voiceUrl: string; statusUrl?: string },
  ): Promise<void> {
    // Point (or create) our Application at the answer URL, then link the number.
    const appId = await this.ensureApplication(params.voiceUrl, params.statusUrl);
    const number = providerSid.replace(/^\+/, '');
    await this.api('POST', `/Number/${number}/`, { app_id: appId });
  }

  async placeCall(params: PlaceCallParams): Promise<PlaceCallResult> {
    // Plivo returns a request_uuid here; the real CallUUID (needed for
    // transfer/hangup) arrives in the answer webhook and replaces it there.
    const data = await this.api('POST', `/Call/`, {
      from: params.from.replace(/^\+/, ''),
      to: params.to.replace(/^\+/, ''),
      answer_url: params.answerWebhookUrl,
      answer_method: 'POST',
      ...(params.statusWebhookUrl ? { hangup_url: params.statusWebhookUrl, hangup_method: 'POST' } : {}),
    });
    const uuid = data?.request_uuid || (Array.isArray(data?.request_uuid) ? data.request_uuid[0] : undefined) || data?.api_id;
    return { providerSid: String(uuid ?? '') };
  }

  async redirectCall(providerSid: string, action: RedirectAction): Promise<void> {
    // A pure hang-up is a direct call delete. Anything with speech/dial is a
    // live-call transfer to a small XML endpoint on the voice-server that renders
    // <Speak>/<Dial>/<Hangup> from the query — see /api/telephony/plivo/transfer.
    if (action.hangup && !action.say && !action.dial) {
      await this.api('DELETE', `/Call/${providerSid}/`);
      return;
    }
    const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
    const q = new URLSearchParams();
    if (action.say) q.set('say', action.say);
    if (action.dial) q.set('dial', action.dial);
    if (action.hangup) q.set('hangup', '1');
    const alegUrl = `${base}/api/telephony/plivo/transfer?${q.toString()}`;
    await this.api('POST', `/Call/${providerSid}/`, { legs: 'aleg', aleg_url: alegUrl, aleg_method: 'GET' });
  }

  // Plivo XML that hands the live audio to our voice-server WebSocket over a
  // bidirectional stream. keepCallAlive keeps the leg up for the whole session;
  // mulaw/8k matches our Twilio-shared codec.
  buildAnswerDocument(params: { voiceWsUrl: string; callId: string }) {
    const streamUrl = `${params.voiceWsUrl}/plivo?callId=${encodeURIComponent(params.callId)}`;
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
      '<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">' +
      escapeXml(streamUrl) +
      '</Stream>' +
      '</Response>';
    return { contentType: 'text/xml', body };
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
