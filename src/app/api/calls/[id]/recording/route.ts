import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

// Serves the call recording. In mock mode there is no real audio, so we
// synthesize a short silent WAV sized roughly to the call duration — enough for
// the dashboard's audio player to render and "play". Real calls would redirect
// to (or proxy) the provider's recording URL.
export async function GET(_req: Request, props: Params) {
  const params = await props.params;
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'call:read')) return new Response('Forbidden', { status: 403 });

  const call = await prisma.call.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    select: { durationSec: true },
  });
  if (!call) return new Response('Not found', { status: 404 });

  const seconds = Math.min(Math.max(call.durationSec || 1, 1), 30);
  const wav = silentWav(seconds);
  // Response wants a web BodyInit; a plain ArrayBuffer is unambiguously valid.
  // A Node Buffer is always backed by a real ArrayBuffer (never SharedArrayBuffer).
  const body = wav.buffer.slice(
    wav.byteOffset,
    wav.byteOffset + wav.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'no-store',
    },
  });
}

// Build a mono 8kHz 16-bit silent WAV of the given length.
function silentWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // Samples remain zero (silence).
  return buffer;
}
