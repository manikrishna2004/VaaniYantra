import dns from 'dns/promises';
import net from 'net';

// Shared SSRF guard for any server-side request to a user-supplied URL (webhook
// delivery, URL knowledge ingest, …). Refuses non-public targets — localhost,
// private ranges, and critically on GCP the link-local metadata server
// 169.254.169.254 — by resolving the hostname and checking every resolved IP.

export class SsrfError extends Error {}

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unknown format → treat as unsafe
}

// Validate and resolve a URL, throwing SsrfError if it is not safe to fetch.
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('That does not look like a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http(s) URLs are supported.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new SsrfError('That host is not allowed.');
  }
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which
  // net.isIP does not accept — so without this an address literal fell through
  // to the DNS branch and was only blocked because the lookup happened to fail.
  // Strip them so an IPv6 literal is classified by the same rules as IPv4.
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  let addrs: string[];
  if (net.isIP(literal)) {
    addrs = [literal];
  } else {
    try {
      const results = await dns.lookup(host, { all: true });
      addrs = results.map((r) => r.address);
    } catch {
      throw new SsrfError('Could not resolve that host.');
    }
  }
  if (addrs.length === 0 || addrs.some(isPrivateIp)) {
    throw new SsrfError('That URL resolves to a non-public address and was blocked.');
  }
  return url;
}
