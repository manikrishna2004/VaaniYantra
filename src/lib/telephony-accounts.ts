import { prisma } from '@/lib/db';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import {
  getTelephonyProvider,
  twilioWithCredentials,
  exotelWithCredentials,
  plivoWithCredentials,
  type TelephonyProvider,
} from '@/lib/adapters/telephony';
import type { PhoneNumber, TwilioAccount, ExotelAccount, PlivoAccount } from '@prisma/client';

// #1: customer-connected Twilio accounts (bring-your-own credentials). A
// workspace may connect several; each owns the numbers provisioned/imported
// under it. The auth token is encrypted at rest and never returned to the
// client — the UI only ever sees the SID + a connected/default flag.

export type TwilioAccountView = {
  id: string;
  label: string;
  accountSid: string;
  isDefault: boolean;
  numberCount: number;
  createdAt: string;
};

function decryptToken(a: TwilioAccount): string {
  return decryptSecret(a.authToken);
}

// Build a telephony provider for a stored account's credentials.
export function providerForAccount(a: TwilioAccount): TelephonyProvider {
  return twilioWithCredentials(a.accountSid, decryptToken(a));
}

export async function listTwilioAccounts(workspaceId: string): Promise<TwilioAccountView[]> {
  const rows = await prisma.twilioAccount.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    include: { _count: { select: { numbers: true } } },
  });
  return rows.map((a) => ({
    id: a.id,
    label: a.label,
    accountSid: a.accountSid,
    isDefault: a.isDefault,
    numberCount: a._count.numbers,
    createdAt: a.createdAt.toISOString(),
  }));
}

// Verify credentials against Twilio (a cheap authenticated GET), then store them.
// The first account connected for a workspace becomes the default.
export async function connectTwilioAccount(
  workspaceId: string,
  input: { label: string; accountSid: string; authToken: string },
  createdById?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const accountSid = input.accountSid.trim();
  const authToken = input.authToken.trim();
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    return { ok: false, error: 'Account SID should look like AC… (34 chars).' };
  }
  if (authToken.length < 10) return { ok: false, error: 'Auth token looks too short.' };

  // Validate the credentials by fetching the account resource.
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') },
    });
    if (res.status === 401) return { ok: false, error: 'Twilio rejected these credentials (401).' };
    if (!res.ok) return { ok: false, error: `Could not verify with Twilio (${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach Twilio to verify credentials.' };
  }

  const existing = await prisma.twilioAccount.count({ where: { workspaceId } });
  try {
    await prisma.twilioAccount.create({
      data: {
        workspaceId,
        label: input.label.trim() || 'Twilio account',
        accountSid,
        authToken: encryptSecret(authToken),
        isDefault: existing === 0,
        createdById,
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return { ok: false, error: 'This Twilio account is already connected.' };
    throw e;
  }
  return { ok: true };
}

export async function deleteTwilioAccount(workspaceId: string, id: string): Promise<void> {
  const acct = await prisma.twilioAccount.findFirst({ where: { id, workspaceId } });
  if (!acct) return;
  await prisma.twilioAccount.delete({ where: { id } });
  // If we removed the default, promote the next remaining account.
  if (acct.isDefault) {
    const next = await prisma.twilioAccount.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    if (next) await prisma.twilioAccount.update({ where: { id: next.id }, data: { isDefault: true } });
  }
}

export async function setDefaultTwilioAccount(workspaceId: string, id: string): Promise<void> {
  const acct = await prisma.twilioAccount.findFirst({ where: { id, workspaceId } });
  if (!acct) return;
  await prisma.$transaction([
    prisma.twilioAccount.updateMany({ where: { workspaceId }, data: { isDefault: false } }),
    prisma.twilioAccount.update({ where: { id }, data: { isDefault: true } }),
  ]);
}

// Resolve which account to use for provisioning/importing/listing: an explicit
// id, else the workspace default. Returns null when the workspace has no
// connected account (caller falls back to the server env Twilio).
export async function resolveProvisioningAccount(
  workspaceId: string,
  accountId?: string | null,
): Promise<TwilioAccount | null> {
  if (accountId) return prisma.twilioAccount.findFirst({ where: { id: accountId, workspaceId } });
  return prisma.twilioAccount.findFirst({ where: { workspaceId, isDefault: true } });
}

// The provider to use for an operation on a specific number — its owning
// account's credentials, or the server env Twilio when the number predates BYO.
export async function providerForNumber(
  number: Pick<PhoneNumber, 'provider' | 'twilioAccountId' | 'exotelAccountId' | 'plivoAccountId'>,
): Promise<TelephonyProvider> {
  if (number.provider === 'exotel' && number.exotelAccountId) {
    const acct = await prisma.exotelAccount.findUnique({ where: { id: number.exotelAccountId } });
    if (acct) return providerForExotelAccount(acct);
  }
  if (number.provider === 'plivo' && number.plivoAccountId) {
    const acct = await prisma.plivoAccount.findUnique({ where: { id: number.plivoAccountId } });
    if (acct) return providerForPlivoAccount(acct);
  }
  if (number.twilioAccountId) {
    const acct = await prisma.twilioAccount.findUnique({ where: { id: number.twilioAccountId } });
    if (acct) return providerForAccount(acct);
  }
  return getTelephonyProvider();
}

export async function providerForNumberId(phoneNumberId: string | null): Promise<TelephonyProvider> {
  if (phoneNumberId) {
    const n = await prisma.phoneNumber.findUnique({
      where: { id: phoneNumberId },
      select: { provider: true, twilioAccountId: true, exotelAccountId: true, plivoAccountId: true },
    });
    if (n) return providerForNumber(n);
  }
  return getTelephonyProvider();
}

// ── Exotel BYO accounts (sibling of the Twilio functions above) ──────────────

export type ExotelAccountView = {
  id: string;
  label: string;
  accountSid: string;
  apiKey: string;
  subdomain: string;
  appUrl: string | null;
  isDefault: boolean;
  numberCount: number;
  createdAt: string;
};

// Build an Exotel telephony provider from a stored account (decrypts the token).
export function providerForExotelAccount(a: ExotelAccount): TelephonyProvider {
  return exotelWithCredentials({
    accountSid: a.accountSid,
    apiKey: a.apiKey,
    apiToken: decryptSecret(a.apiToken),
    subdomain: a.subdomain,
  });
}

export async function listExotelAccounts(workspaceId: string): Promise<ExotelAccountView[]> {
  const rows = await prisma.exotelAccount.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    include: { _count: { select: { numbers: true } } },
  });
  return rows.map((a) => ({
    id: a.id,
    label: a.label,
    accountSid: a.accountSid,
    apiKey: a.apiKey,
    subdomain: a.subdomain,
    appUrl: a.appUrl,
    isDefault: a.isDefault,
    numberCount: a._count.numbers,
    createdAt: a.createdAt.toISOString(),
  }));
}

// Verify credentials against Exotel (a cheap authenticated GET), then store them
// with the API token encrypted at rest. The first account becomes the default.
export async function connectExotelAccount(
  workspaceId: string,
  input: {
    label: string;
    accountSid: string;
    apiKey: string;
    apiToken: string;
    subdomain?: string;
    appUrl?: string;
  },
  createdById?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const accountSid = input.accountSid.trim();
  const apiKey = input.apiKey.trim();
  const apiToken = input.apiToken.trim();
  // Host only: tolerate a pasted "https://api.in.exotel.com/v1/" or similar.
  const subdomain = (input.subdomain || 'api.exotel.com')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const appUrl = input.appUrl?.trim() || null;
  if (!accountSid) return { ok: false, error: 'Account SID is required.' };
  if (apiKey.length < 4 || apiToken.length < 4) {
    return { ok: false, error: 'API Key / API Token look too short.' };
  }

  // Validate by fetching the account resource.
  try {
    const provider = exotelWithCredentials({ accountSid, apiKey, apiToken, subdomain }) as any;
    const { ok, status, detail } = await provider.verifyCredentials();
    // Exotel returns 401 for a wrong API Key/Token, for a right pair sent to the
    // wrong Account SID, and for a right pair sent to another region's host —
    // so name all three rather than telling someone their good key is bad.
    if (status === 401 || status === 403) {
      return {
        ok: false,
        error:
          `Exotel returned ${status} for SID "${accountSid}" on ${subdomain}. ` +
          'It answers that way for a wrong API Key/Token, but also when those are right and the ' +
          'Account SID or the region host is not — check all three in Exotel → Settings → API ' +
          '(the SID is case-sensitive, and the subdomain must be the exact host that page shows for your cluster).' +
          (detail ? ` Exotel said: ${detail}` : ''),
      };
    }
    if (status === 404) {
      return {
        ok: false,
        error: `Exotel has no account "${accountSid}" on ${subdomain} — check the Account SID and the region host.`,
      };
    }
    if (!ok) return { ok: false, error: `Could not verify with Exotel (${status}).` };
  } catch {
    return { ok: false, error: 'Could not reach Exotel to verify credentials (check the subdomain/region).' };
  }

  const existing = await prisma.exotelAccount.count({ where: { workspaceId } });
  try {
    await prisma.exotelAccount.create({
      data: {
        workspaceId,
        label: input.label.trim() || 'Exotel account',
        accountSid,
        apiKey,
        apiToken: encryptSecret(apiToken),
        subdomain,
        appUrl,
        isDefault: existing === 0,
        createdById,
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return { ok: false, error: 'This Exotel account is already connected.' };
    throw e;
  }
  return { ok: true };
}

export async function deleteExotelAccount(workspaceId: string, id: string): Promise<void> {
  const acct = await prisma.exotelAccount.findFirst({ where: { id, workspaceId } });
  if (!acct) return;
  await prisma.exotelAccount.delete({ where: { id } });
  if (acct.isDefault) {
    const next = await prisma.exotelAccount.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    if (next) await prisma.exotelAccount.update({ where: { id: next.id }, data: { isDefault: true } });
  }
}

export async function setDefaultExotelAccount(workspaceId: string, id: string): Promise<void> {
  const acct = await prisma.exotelAccount.findFirst({ where: { id, workspaceId } });
  if (!acct) return;
  await prisma.$transaction([
    prisma.exotelAccount.updateMany({ where: { workspaceId }, data: { isDefault: false } }),
    prisma.exotelAccount.update({ where: { id }, data: { isDefault: true } }),
  ]);
}

// Resolve which Exotel account to use for importing/listing: an explicit id,
// else the workspace default. Null when the workspace has no Exotel account.
export async function resolveExotelAccount(
  workspaceId: string,
  accountId?: string | null,
): Promise<ExotelAccount | null> {
  if (accountId) return prisma.exotelAccount.findFirst({ where: { id: accountId, workspaceId } });
  return prisma.exotelAccount.findFirst({ where: { workspaceId, isDefault: true } });
}

// ── Plivo BYO accounts (the low-cost sibling of the Twilio/Exotel functions) ──

export type PlivoAccountView = {
  id: string;
  label: string;
  authId: string;
  isDefault: boolean;
  numberCount: number;
  createdAt: string;
};

// Build a Plivo telephony provider from a stored account (decrypts the token).
// Passes the cached Application id and a callback that persists a freshly
// discovered/created app id back onto the account (best-effort).
export function providerForPlivoAccount(a: PlivoAccount): TelephonyProvider {
  return plivoWithCredentials({
    authId: a.authId,
    authToken: decryptSecret(a.authToken),
    appId: a.appId,
    onAppId: (appId) => {
      if (appId && appId !== a.appId) {
        void prisma.plivoAccount.update({ where: { id: a.id }, data: { appId } }).catch(() => {});
      }
    },
  });
}

export async function listPlivoAccounts(workspaceId: string): Promise<PlivoAccountView[]> {
  const rows = await prisma.plivoAccount.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    include: { _count: { select: { numbers: true } } },
  });
  return rows.map((a) => ({
    id: a.id,
    label: a.label,
    authId: a.authId,
    isDefault: a.isDefault,
    numberCount: a._count.numbers,
    createdAt: a.createdAt.toISOString(),
  }));
}

// Verify credentials against Plivo (a cheap authenticated GET), then store them
// with the Auth Token encrypted at rest. The first account becomes the default.
export async function connectPlivoAccount(
  workspaceId: string,
  input: { label: string; authId: string; authToken: string },
  createdById?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const authId = input.authId.trim();
  const authToken = input.authToken.trim();
  // Plivo Auth IDs are 20 uppercase alphanumerics (MA…/SA… for sub-accounts).
  if (!/^[A-Z0-9]{20}$/.test(authId)) {
    return { ok: false, error: 'Auth ID should be 20 characters (starts with MA or SA).' };
  }
  if (authToken.length < 10) return { ok: false, error: 'Auth Token looks too short.' };

  try {
    const provider = plivoWithCredentials({ authId, authToken }) as any;
    const { ok, status } = await provider.verifyCredentials();
    if (status === 401 || status === 403) return { ok: false, error: 'Plivo rejected these credentials.' };
    if (!ok) return { ok: false, error: `Could not verify with Plivo (${status}).` };
  } catch {
    return { ok: false, error: 'Could not reach Plivo to verify credentials.' };
  }

  const existing = await prisma.plivoAccount.count({ where: { workspaceId } });
  try {
    await prisma.plivoAccount.create({
      data: {
        workspaceId,
        label: input.label.trim() || 'Plivo account',
        authId,
        authToken: encryptSecret(authToken),
        isDefault: existing === 0,
        createdById,
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return { ok: false, error: 'This Plivo account is already connected.' };
    throw e;
  }
  return { ok: true };
}

export async function deletePlivoAccount(workspaceId: string, id: string): Promise<void> {
  const acct = await prisma.plivoAccount.findFirst({ where: { id, workspaceId } });
  if (!acct) return;
  await prisma.plivoAccount.delete({ where: { id } });
  if (acct.isDefault) {
    const next = await prisma.plivoAccount.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    if (next) await prisma.plivoAccount.update({ where: { id: next.id }, data: { isDefault: true } });
  }
}

export async function setDefaultPlivoAccount(workspaceId: string, id: string): Promise<void> {
  const acct = await prisma.plivoAccount.findFirst({ where: { id, workspaceId } });
  if (!acct) return;
  await prisma.$transaction([
    prisma.plivoAccount.updateMany({ where: { workspaceId }, data: { isDefault: false } }),
    prisma.plivoAccount.update({ where: { id }, data: { isDefault: true } }),
  ]);
}

// Resolve which Plivo account to use for provisioning/importing/listing: an
// explicit id, else the workspace default. Null when there's no Plivo account.
export async function resolvePlivoAccount(
  workspaceId: string,
  accountId?: string | null,
): Promise<PlivoAccount | null> {
  if (accountId) return prisma.plivoAccount.findFirst({ where: { id: accountId, workspaceId } });
  return prisma.plivoAccount.findFirst({ where: { workspaceId, isDefault: true } });
}
