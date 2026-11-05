import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { checkDownloadToken, recordDownload } from '@/lib/kit/purchase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The paid artefact.
 *
 * This is the only way to get the file. It deliberately does NOT live in
 * public/ — anything under public/ is served by Next to anyone who guesses the
 * name, which would make the whole payment step decorative.
 *
 * A valid, unexpired, unexhausted token belonging to a PAID order is the sole
 * authorisation. There is no session, because the buyer has no account.
 */

/** Where the zip lives on the server. Outside public/, and configurable. */
function kitFilePath(): string | null {
  const configured = process.env.KIT_FILE_PATH;
  const path = resolve(configured || 'private/voice-agent-starter-kit.zip');
  return existsSync(path) ? path : null;
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token');
  const check = await checkDownloadToken(token);

  if (!check.ok) {
    // Say which it is. A buyer whose link expired needs different help from
    // someone who mistyped it, and "denied" for both generates support mail.
    const messages: Record<string, { status: number; error: string }> = {
      unknown: { status: 404, error: 'That download link is not valid.' },
      unpaid: { status: 402, error: 'That order has not been paid.' },
      expired: { status: 410, error: 'That download link has expired. Reply to your receipt and we will send a new one.' },
      exhausted: { status: 429, error: 'That link has been used the maximum number of times. Reply to your receipt for a new one.' },
    };
    const m = messages[check.reason];
    return NextResponse.json({ error: m.error }, { status: m.status });
  }

  const path = kitFilePath();
  if (!path) {
    // The buyer has paid and we cannot deliver. Loud, because it needs a human.
    console.error('[kit] PAID order', check.order.orderId, 'but the kit file is missing. Set KIT_FILE_PATH.');
    return NextResponse.json(
      { error: 'The download is temporarily unavailable. We have been notified — please reply to your receipt.' },
      { status: 503 },
    );
  }

  // Counted before the stream starts. Counting after would mean an aborted
  // download is free, which is the wrong way for the cap to fail.
  await recordDownload(check.order.orderId);

  const stat = statSync(path);
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(stat.size),
      'content-disposition': `attachment; filename="${basename(path)}"`,
      // A paid artefact behind a one-off token must never sit in a shared cache.
      'cache-control': 'private, no-store',
    },
  });
}
