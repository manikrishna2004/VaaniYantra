import { prisma } from '@/lib/db';
import { getOrgCredentials } from '@/lib/integrations';

// Phase 6D — CRM push (HubSpot). On a completed call, if the workspace has a
// HubSpot Private App token connected, upsert the caller as a Contact (by phone)
// and attach a Note with the call summary. Uses only data already captured (no
// LLM), so it works regardless of LLM quota. Gated on a connected token.

const HS = 'https://api.hubapi.com';
// HubSpot-defined association type id for Note → Contact.
const NOTE_TO_CONTACT = 202;

async function hs(token: string, path: string, init: RequestInit) {
  const res = await fetch(`${HS}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return res;
}

// Pull common fields out of the freeform collected data ({key: value|null}).
function mapContactProps(collected: Record<string, unknown> | null): Record<string, string> {
  const props: Record<string, string> = {};
  if (!collected) return props;
  for (const [k, v] of Object.entries(collected)) {
    if (v == null || v === '') continue;
    const key = k.toLowerCase();
    const val = String(v);
    if (!props.email && /e-?mail/.test(key) && val.includes('@')) props.email = val;
    else if (!props.company && /compan|organi[sz]ation|business/.test(key)) props.company = val;
    else if (!props.firstname && /name/.test(key)) {
      const parts = val.trim().split(/\s+/);
      props.firstname = parts[0];
      if (parts.length > 1) props.lastname = parts.slice(1).join(' ');
    }
  }
  return props;
}

async function upsertContact(token: string, phone: string, props: Record<string, string>): Promise<string | null> {
  // Find an existing contact by phone.
  const search = await hs(token, '/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
      properties: ['phone'],
      limit: 1,
    }),
  });
  if (search.ok) {
    const j = (await search.json()) as { results?: { id: string }[] };
    const existing = j.results?.[0]?.id;
    if (existing) {
      await hs(token, `/crm/v3/objects/contacts/${existing}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: props }),
      }).catch(() => {});
      return existing;
    }
  }
  // Create a new contact.
  const create = await hs(token, '/crm/v3/objects/contacts', {
    method: 'POST',
    body: JSON.stringify({ properties: { phone, ...props } }),
  });
  if (!create.ok) {
    console.error('[crm] contact create failed', create.status, await create.text().catch(() => ''));
    return null;
  }
  const j = (await create.json()) as { id: string };
  return j.id;
}

async function createNote(token: string, contactId: string, body: string, when: Date): Promise<void> {
  const res = await hs(token, '/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: { hs_note_body: body, hs_timestamp: when.toISOString() },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
        },
      ],
    }),
  });
  if (!res.ok) console.error('[crm] note create failed', res.status, await res.text().catch(() => ''));
}

export async function pushCallToCrm(callId: string): Promise<void> {
  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        direction: true,
        fromNumber: true,
        toNumber: true,
        summary: true,
        sentiment: true,
        collectedData: true,
        recordingUrl: true,
        createdAt: true,
        workspace: { select: { orgId: true } },
        agent: { select: { name: true } },
      },
    });
    const orgId = call?.workspace?.orgId;
    if (!orgId) return;
    const creds = await getOrgCredentials(orgId);
    const token = (creds as Record<string, string | undefined>).hubspot;
    if (!token) return;

    const phone = call!.direction === 'INBOUND' ? call!.fromNumber : call!.toNumber;
    const collected =
      call!.collectedData && typeof call!.collectedData === 'object'
        ? (call!.collectedData as Record<string, unknown>)
        : null;
    const props = mapContactProps(collected);

    const contactId = await upsertContact(token, phone, props);
    if (!contactId) return;

    const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
    const noteLines = [
      `VaaniYantra ${call!.direction.toLowerCase()} call — agent ${call!.agent?.name ?? 'VaaniYantra'}`,
      call!.summary ? `Summary: ${call!.summary}` : '',
      call!.sentiment ? `Sentiment: ${call!.sentiment}` : '',
      collected ? `Collected: ${JSON.stringify(collected)}` : '',
      call!.recordingUrl && base ? `Recording: ${base}${call!.recordingUrl}` : '',
    ].filter(Boolean);
    await createNote(token, contactId, noteLines.join('\n'), call!.createdAt);
    console.log('[crm] pushed call', callId, 'to HubSpot contact', contactId);
  } catch (err) {
    console.error('[crm] push failed', err);
  }
}
