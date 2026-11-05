// Telephony adapter — provisions numbers and places/receives calls.
// Built provider-agnostic; Twilio is the default implementation.

export type ProvisionedNumber = {
  e164: string;
  providerSid: string;
};

// A number that already exists in the provider account (for "connect existing").
export type AccountNumber = {
  e164: string;
  providerSid: string;
  voiceUrl?: string; // currently configured voice webhook, if any
};

export type PlaceCallParams = {
  to: string;
  from: string;
  // Public webhook the provider should hit for call control (TwiML) and which
  // upgrades the call to a Media Stream pointed at the voice-server.
  answerWebhookUrl: string;
  statusWebhookUrl?: string;
};

export type PlaceCallResult = {
  providerSid: string;
};

// Action used to redirect a live, in-progress call (e.g. for transfer or an
// after-hours hangup). Rendered to provider call-control (TwiML for Twilio).
export type RedirectAction = {
  say?: string; // spoken to the caller first (provider TTS)
  dial?: string; // E.164 number to connect the caller to
  hangup?: boolean; // end the call after say/dial
};

export interface TelephonyProvider {
  readonly name: string;

  // Capability flags so routes/UI can branch without try/catching unsupported
  // operations. Twilio supports both; Exotel supports neither (numbers are
  // KYC-provisioned in its dashboard and inbound routes via a Voicebot applet
  // rather than a per-call answer webhook).
  readonly canBuyNumbers: boolean;
  readonly usesAnswerWebhook: boolean;

  // Buy / register a phone number capable of voice.
  provisionNumber(areaCodeOrCountry?: string): Promise<ProvisionedNumber>;

  // List numbers already owned in the provider account (to connect/import them).
  listAccountNumbers(): Promise<AccountNumber[]>;

  // Point a number's inbound voice webhook at our server so calls reach us.
  configureNumberWebhook(
    providerSid: string,
    params: { voiceUrl: string; statusUrl?: string },
  ): Promise<void>;

  // Start an outbound call. The provider connects audio to the voice-server via
  // the answer webhook.
  placeCall(params: PlaceCallParams): Promise<PlaceCallResult>;

  // Produce the call-control document (TwiML) returned to the provider when a
  // call is answered, bridging media to the realtime voice WebSocket.
  buildAnswerDocument(params: {
    voiceWsUrl: string;
    callId: string;
  }): { contentType: string; body: string };

  // Redirect a live call — used for human transfer and after-hours hangup.
  redirectCall(providerSid: string, action: RedirectAction): Promise<void>;
}
