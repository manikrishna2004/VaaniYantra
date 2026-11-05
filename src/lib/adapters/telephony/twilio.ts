import type {
  AccountNumber,
  PlaceCallParams,
  PlaceCallResult,
  ProvisionedNumber,
  RedirectAction,
  TelephonyProvider,
} from './types';
import { fetchWithTimeout } from '@/lib/net/fetch';

// Twilio implementation using the REST API directly (no SDK dependency).
// Outbound calls and inbound webhooks both bridge audio to the voice-server via
// Twilio Media Streams (<Connect><Stream>).
export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';
  readonly canBuyNumbers = true;
  readonly usesAnswerWebhook = true;
  private accountSid: string;
  private authToken: string;

  // #1: accept explicit credentials for a customer-connected Twilio account;
  // fall back to the server env account when none are given (legacy behaviour).
  constructor(creds?: { accountSid: string; authToken: string }) {
    const sid = creds?.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    const token = creds?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error(
        'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set (required when USE_MOCK_TELEPHONY=false)',
      );
    }
    this.accountSid = sid;
    this.authToken = token;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
  }

  private apiBase(): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
  }

  async provisionNumber(areaCodeOrCountry = 'US'): Promise<ProvisionedNumber> {
    // 1. Search available numbers, 2. purchase the first.
    const searchRes = await fetch(
      `${this.apiBase()}/AvailablePhoneNumbers/${areaCodeOrCountry}/Local.json?VoiceEnabled=true&PageSize=1`,
      { headers: { Authorization: this.authHeader() } },
    );
    const search = (await searchRes.json()) as any;
    const candidate = search?.available_phone_numbers?.[0]?.phone_number;
    if (!candidate) throw new Error('No available Twilio numbers for ' + areaCodeOrCountry);

    const buyRes = await fetch(`${this.apiBase()}/IncomingPhoneNumbers.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ PhoneNumber: candidate }),
    });
    const bought = (await buyRes.json()) as any;
    return { e164: bought.phone_number, providerSid: bought.sid };
  }

  async listAccountNumbers(): Promise<AccountNumber[]> {
    const res = await fetch(`${this.apiBase()}/IncomingPhoneNumbers.json?PageSize=100`, {
      headers: { Authorization: this.authHeader() },
    });
    if (!res.ok) throw new Error(`Twilio listAccountNumbers failed: ${res.status}`);
    const data = (await res.json()) as any;
    return (data?.incoming_phone_numbers ?? []).map((n: any) => ({
      e164: n.phone_number,
      providerSid: n.sid,
      voiceUrl: n.voice_url || undefined,
    }));
  }

  async configureNumberWebhook(
    providerSid: string,
    params: { voiceUrl: string; statusUrl?: string },
  ): Promise<void> {
    const body = new URLSearchParams({ VoiceUrl: params.voiceUrl, VoiceMethod: 'POST' });
    if (params.statusUrl) {
      body.set('StatusCallback', params.statusUrl);
      body.set('StatusCallbackMethod', 'POST');
    }
    const res = await fetch(`${this.apiBase()}/IncomingPhoneNumbers/${providerSid}.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Twilio configureNumberWebhook failed: ${(await res.text()).slice(0, 160)}`);
    }
  }

  async placeCall(params: PlaceCallParams): Promise<PlaceCallResult> {
    const body = new URLSearchParams({
      To: params.to,
      From: params.from,
      Url: params.answerWebhookUrl,
    });
    if (params.statusWebhookUrl) {
      body.set('StatusCallback', params.statusWebhookUrl);
      body.set('StatusCallbackEvent', 'initiated ringing answered completed');
    }
    const res = await fetchWithTimeout(`${this.apiBase()}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      // A hung Twilio API must not block outbound call placement indefinitely.
      timeoutMs: 15_000,
      retries: 1,
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(`Twilio placeCall failed: ${data?.message ?? res.status}`);
    return { providerSid: data.sid };
  }

  async redirectCall(providerSid: string, action: RedirectAction): Promise<void> {
    let inner = '';
    if (action.say) inner += `<Say>${escapeXml(action.say)}</Say>`;
    if (action.dial) inner += `<Dial>${escapeXml(action.dial)}</Dial>`;
    if (action.hangup) inner += '<Hangup/>';
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
    const res = await fetch(`${this.apiBase()}/Calls/${providerSid}.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Twiml: twiml }),
    });
    if (!res.ok) {
      throw new Error(`Twilio redirectCall failed: ${(await res.text()).slice(0, 160)}`);
    }
  }

  buildAnswerDocument(params: { voiceWsUrl: string; callId: string }) {
    // <Connect><Stream> hands the live audio to our voice-server WebSocket.
    const streamUrl = `${params.voiceWsUrl}/twilio?callId=${encodeURIComponent(params.callId)}`;
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
      '<Connect>' +
      `<Stream url="${streamUrl}" />` +
      '</Connect>' +
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
