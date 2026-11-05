import type {
  AccountNumber,
  PlaceCallParams,
  PlaceCallResult,
  ProvisionedNumber,
  RedirectAction,
  TelephonyProvider,
} from './types';

// Offline stand-in for Twilio. Provisions fake numbers and "places" calls by
// returning a synthetic SID. The actual conversation for mock calls is driven
// by the simulator in the voice pipeline (see lib/voice/simulator.ts), so no
// real PSTN connection is made.
export class MockTelephonyProvider implements TelephonyProvider {
  readonly name = 'mock-telephony';
  readonly canBuyNumbers = true;
  readonly usesAnswerWebhook = true;

  async provisionNumber(): Promise<ProvisionedNumber> {
    const last4 = Math.floor(1000 + Math.random() * 9000);
    return {
      e164: `+1555010${last4}`,
      providerSid: 'PNmock' + Math.random().toString(36).slice(2, 12),
    };
  }

  async placeCall(_params: PlaceCallParams): Promise<PlaceCallResult> {
    return { providerSid: 'CAmock' + Math.random().toString(36).slice(2, 12) };
  }

  async redirectCall(providerSid: string, action: RedirectAction): Promise<void> {
    console.log('[mock-telephony] redirectCall', providerSid, JSON.stringify(action));
  }

  async listAccountNumbers(): Promise<AccountNumber[]> {
    return []; // no external account in mock mode
  }

  async configureNumberWebhook(
    providerSid: string,
    params: { voiceUrl: string; statusUrl?: string },
  ): Promise<void> {
    console.log('[mock-telephony] configureNumberWebhook', providerSid, params.voiceUrl);
  }

  buildAnswerDocument(params: { voiceWsUrl: string; callId: string }) {
    const streamUrl = `${params.voiceWsUrl}/twilio?callId=${encodeURIComponent(params.callId)}`;
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Connect>' +
      `<Stream url="${streamUrl}" />` +
      '</Connect></Response>';
    return { contentType: 'text/xml', body };
  }
}
