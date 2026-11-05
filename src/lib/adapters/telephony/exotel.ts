import type {
  AccountNumber,
  PlaceCallParams,
  PlaceCallResult,
  ProvisionedNumber,
  RedirectAction,
  TelephonyProvider,
} from './types';

// Exotel implementation (India/APAC PSTN). Unlike Twilio, Exotel:
//   • does not sell numbers via API — ExoPhones are KYC-provisioned in the
//     Exotel dashboard, so we only ever "connect existing" (canBuyNumbers=false).
//   • routes inbound calls through a "Voicebot applet" configured on an App in
//     the dashboard (which connects straight to our /exotel WebSocket), rather
//     than fetching per-call TwiML from an answer webhook (usesAnswerWebhook=false).
//
// Auth is HTTP Basic with API Key + API Token, scoped to an Account SID, on a
// region-specific host (subdomain), e.g. https://api.in.exotel.com/v1/Accounts/<sid>.
export class ExotelProvider implements TelephonyProvider {
  readonly name = 'exotel';
  readonly canBuyNumbers = false;
  readonly usesAnswerWebhook = false;

  private accountSid: string;
  private apiKey: string;
  private apiToken: string;
  private subdomain: string;

  constructor(creds: { accountSid: string; apiKey: string; apiToken: string; subdomain?: string }) {
    if (!creds?.accountSid || !creds?.apiKey || !creds?.apiToken) {
      throw new Error('Exotel accountSid / apiKey / apiToken are required');
    }
    this.accountSid = creds.accountSid;
    this.apiKey = creds.apiKey;
    this.apiToken = creds.apiToken;
    this.subdomain = (creds.subdomain || 'api.exotel.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.apiKey}:${this.apiToken}`).toString('base64');
  }

  private apiBase(): string {
    return `https://${this.subdomain}/v1/Accounts/${this.accountSid}`;
  }

  // Cheap authenticated GET used to validate stored credentials. Exotel answers
  // 401 for a bad API Key/Token, but *also* for a good pair aimed at the wrong
  // Account SID or the wrong regional host — so we hand back what we tried and
  // whatever Exotel said, and let the caller explain the difference.
  async verifyCredentials(): Promise<{ ok: boolean; status: number; url: string; detail?: string }> {
    const url = `${this.apiBase()}.json`;
    const res = await fetch(url, { headers: { Authorization: this.authHeader() } });
    let detail: string | undefined;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      try {
        const j = JSON.parse(body);
        detail = j?.RestException?.Message ?? j?.message ?? j?.error;
      } catch {
        /* not JSON — fall through to the raw body */
      }
      detail = String(detail ?? body).trim().replace(/\s+/g, ' ').slice(0, 160) || undefined;
    }
    return { ok: res.ok, status: res.status, url, detail };
  }

  async provisionNumber(): Promise<ProvisionedNumber> {
    throw new Error(
      'Exotel numbers (ExoPhones) are provisioned in the Exotel dashboard, not via API. Use "Connect existing".',
    );
  }

  // Best-effort listing of ExoPhones on the account. Exotel's number APIs vary
  // by account/region, so on any non-OK response we return [] and let the UI
  // fall back to manual entry (the number itself is the providerSid for Exotel).
  async listAccountNumbers(): Promise<AccountNumber[]> {
    try {
      const res = await fetch(`${this.apiBase()}/IncomingPhoneNumbers.json`, {
        headers: { Authorization: this.authHeader() },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      // Exotel wraps the resource under `IncomingPhoneNumber` (singular) — an
      // object when there's one number, an array when there are several. It also
      // sometimes nests as { IncomingPhoneNumbers: { IncomingPhoneNumber: [...] } }.
      const raw =
        data?.IncomingPhoneNumber ??
        data?.IncomingPhoneNumbers?.IncomingPhoneNumber ??
        data?.IncomingPhoneNumbers ??
        data?.incoming_phone_numbers ??
        data?.numbers ??
        [];
      const list = Array.isArray(raw) ? raw : [raw];
      return list
        .map((n: any) => {
          if (!n) return null;
          // ExoPhones can be local formats (e.g. "04045901102"), not E.164.
          const e164 = n.PhoneNumber ?? n.phone_number ?? n.Number ?? n.number ?? n.FriendlyName;
          if (!e164) return null;
          return { e164: String(e164), providerSid: n.Sid ?? n.sid ?? String(e164), voiceUrl: n.VoiceUrl };
        })
        .filter(Boolean) as AccountNumber[];
    } catch {
      return [];
    }
  }

  // Inbound routing for Exotel is set by attaching a Voicebot-applet App to the
  // ExoPhone in the dashboard — not configurable through this API. Callers should
  // branch on `usesAnswerWebhook === false` and surface the manual instruction
  // instead of invoking this.
  async configureNumberWebhook(): Promise<void> {
    throw new Error(
      'Exotel inbound routing is configured in the Exotel dashboard (attach a Voicebot-applet App to the ExoPhone pointing at wss://<host>/exotel).',
    );
  }

  // Place an outbound call. For Exotel this connects `to` from the ExoPhone
  // (`from`, used as CallerId) to a streaming App; `answerWebhookUrl` must be the
  // Exotel App URL (exoml flow) that contains the Voicebot applet.
  async placeCall(params: PlaceCallParams): Promise<PlaceCallResult> {
    const body = new URLSearchParams({
      From: params.to, // Exotel dials `From` (the customer) and connects to the App
      CallerId: params.from, // the ExoPhone shown to the customer
      Url: params.answerWebhookUrl, // Exotel App (exoml) URL that streams to /exotel
    });
    if (params.statusWebhookUrl) body.set('StatusCallback', params.statusWebhookUrl);
    const res = await fetch(`${this.apiBase()}/Calls/connect.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(`Exotel placeCall failed: ${data?.RestException?.Message ?? res.status}`);
    }
    const sid = data?.Call?.Sid ?? data?.Call?.sid ?? data?.Sid;
    return { providerSid: sid };
  }

  // Live-call redirect (transfer / after-hours hangup) is not supported on Exotel
  // in v1 — the Voicebot applet owns the media path.
  async redirectCall(): Promise<void> {
    throw new Error('redirectCall is not supported for Exotel yet (transfer/after-hours).');
  }

  // Exotel does not fetch a per-call answer document; the Voicebot applet defines
  // the media stream. Provided for interface completeness only.
  buildAnswerDocument() {
    return { contentType: 'text/plain', body: '' };
  }
}
