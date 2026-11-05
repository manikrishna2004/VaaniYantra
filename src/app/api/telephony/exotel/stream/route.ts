import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Dynamic-URL endpoint for the Exotel Voicebot applet.
//
// Instead of hard-coding `wss://<host>/exotel` into the Exotel dashboard flow,
// the customer pastes THIS https URL as the Voicebot applet's URL. Exotel calls
// it per-call and expects a JSON body { "url": "wss://..." } telling it where to
// stream. Because the resolved WebSocket host is computed from our own env here,
// if our public host ever changes (e.g. a server migration) the applet keeps
// working with zero dashboard edits.
//
// Exotel may GET or POST this endpoint, so both are supported.
function streamUrl(): string {
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://localhost:3000';
  const host = base.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `wss://${host}/exotel`;
}

export async function GET() {
  return NextResponse.json({ url: streamUrl() });
}

export async function POST() {
  return NextResponse.json({ url: streamUrl() });
}
