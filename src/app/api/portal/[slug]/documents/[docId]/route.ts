import { NextResponse } from 'next/server';
import { currentPortalSession } from '@/lib/portal/session';
import { getPatientProvider } from '@/lib/patients';
import { writeAudit } from '@/lib/audit';
import { clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Stream a prescription scan back to the patient it belongs to.
//
// The scope passed to readDocument() pins the file to this session's contact
// AND to a visit marked shared, so a valid session cannot walk document ids
// into somebody else's records. Every hit is audited — these are medical
// records, and "who downloaded what" is the question a clinic will eventually
// be asked.
export async function GET(req: Request, props: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await props.params;
  const session = await currentPortalSession(slug);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!session.portal.allowDownloads || !session.portal.allowRecords) {
    return NextResponse.json({ error: 'Downloads are turned off for this clinic.' }, { status: 403 });
  }

  const provider = await getPatientProvider(session.contact.orgId);
  if (!provider.capabilities.canReadDocuments) {
    return NextResponse.json({ error: 'Documents are not available here.' }, { status: 403 });
  }
  const doc = await provider.readDocument(docId, {
    orgId: session.contact.orgId,
    contactId: session.contact.id,
  });
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  void writeAudit({
    orgId: session.contact.orgId,
    action: 'portal.document.downloaded',
    targetType: 'VisitDocument',
    targetId: docId,
    metadata: { portal: slug, contactId: session.contact.id },
    ip: clientIp(req),
  });

  return new NextResponse(new Uint8Array(doc.buffer), {
    headers: {
      'Content-Type': doc.mimeType,
      // inline so a phone opens the scan in the browser rather than dumping it
      // into Downloads, which is where files go to be lost.
      'Content-Disposition': `inline; filename="${doc.name.replace(/[^\w.\- ]+/g, '_')}"`,
      'Content-Length': String(doc.buffer.length),
      'Cache-Control': 'private, no-store',
    },
  });
}
