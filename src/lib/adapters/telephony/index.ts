import type { TelephonyProvider } from './types';
import { MockTelephonyProvider } from './mock';

let cached: TelephonyProvider | null = null;

export function getTelephonyProvider(): TelephonyProvider {
  if (cached) return cached;
  if (process.env.USE_MOCK_TELEPHONY !== 'false') {
    cached = new MockTelephonyProvider();
    return cached;
  }
  const { TwilioProvider } = require('./twilio') as typeof import('./twilio');
  cached = new TwilioProvider();
  return cached;
}

export function isMockTelephony(): boolean {
  return process.env.USE_MOCK_TELEPHONY !== 'false';
}

// #1: build a Twilio provider for a specific customer account's credentials,
// independent of USE_MOCK_TELEPHONY (a connected account is always real Twilio).
export function twilioWithCredentials(accountSid: string, authToken: string): TelephonyProvider {
  const { TwilioProvider } = require('./twilio') as typeof import('./twilio');
  return new TwilioProvider({ accountSid, authToken });
}

// Build an Exotel provider for a specific customer account's credentials. A
// connected Exotel account is always real Exotel (never mock).
export function exotelWithCredentials(creds: {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  subdomain?: string;
}): TelephonyProvider {
  const { ExotelProvider } = require('./exotel') as typeof import('./exotel');
  return new ExotelProvider(creds);
}

// Build a Plivo provider for a specific customer account's credentials. A
// connected Plivo account is always real Plivo (never mock).
export function plivoWithCredentials(creds: {
  authId: string;
  authToken: string;
  appId?: string | null;
  onAppId?: (appId: string) => void;
}): TelephonyProvider {
  const { PlivoProvider } = require('./plivo') as typeof import('./plivo');
  return new PlivoProvider(creds);
}

export type {
  TelephonyProvider,
  PlaceCallParams,
  ProvisionedNumber,
  AccountNumber,
  RedirectAction,
} from './types';
