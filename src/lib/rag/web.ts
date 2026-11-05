import dns from 'dns/promises';
import net from 'net';

// Fetch a public web page and extract its readable text. Used by the knowledge
// base "Add from URL" / re-crawl flow.
//
// SECURITY: this fetches a server-side URL on the customer's behalf, so it is an
// SSRF vector. We refuse non-public targets (localhost, private ranges, and —
// critically on GCP — the link-local metadata server 169.254.169.254) by
// resolving the hostname and checking every resolved IP before fetching.

const MAX_BYTES = 3_000_000; // 3 MB cap on fetched HTML
const FETCH_TIMEOUT_MS = 15_000;

export class UrlIngestError extends Error {}

function isPrivateIp(ip: string): boolean {
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
    // IPv4-mapped (::ffff:a.b.c.d)
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unknown format → treat as unsafe
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlIngestError('That does not look like a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlIngestError('Only http(s) URLs are supported.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new UrlIngestError('That host is not allowed.');
  }
  // Resolve and reject if ANY resolved address is private/link-local.
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      const results = await dns.lookup(host, { all: true });
      addrs = results.map((r) => r.address);
    } catch {
      throw new UrlIngestError('Could not resolve that host.');
    }
  }
  if (addrs.length === 0 || addrs.some(isPrivateIp)) {
    throw new UrlIngestError('That URL resolves to a non-public address and was blocked.');
  }
  return url;
}

const MAX_REDIRECTS = 5;

export async function fetchUrlText(raw: string): Promise<{ title: string; text: string; finalUrl: string }> {
  let url = await assertPublicUrl(raw);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    // Follow redirects manually and re-validate every hop. fetch's built-in
    // redirect: 'follow' would skip assertPublicUrl on the redirect target, so a
    // public URL could 302 to a private/metadata address (SSRF bypass).
    for (let hop = 0; ; hop++) {
      res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'VaaniYantraBot/1.0 (+knowledge-base crawler)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw new UrlIngestError('That URL redirects too many times.');
      url = await assertPublicUrl(new URL(location, url).toString());
    }
  } catch (err: any) {
    if (err instanceof UrlIngestError) throw err;
    throw new UrlIngestError(err?.name === 'AbortError' ? 'The page took too long to load.' : 'Could not fetch that URL.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new UrlIngestError(`The page returned HTTP ${res.status}.`);

  const ctype = res.headers.get('content-type') ?? '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new UrlIngestError('That page is too large to ingest.');
  const body = buf.toString('utf8');

  const hostname = url.hostname;
  if (ctype.includes('text/html') || /<html[\s>]/i.test(body)) {
    return { ...extractHtml(body, hostname), finalUrl: res.url || url.toString() };
  }
  // Plain text / other text-like.
  return { title: hostname, text: body.trim(), finalUrl: res.url || url.toString() };
}

function extractHtml(html: string, fallbackTitle: string): { title: string; text: string } {
  // cheerio is required dynamically so it stays out of any non-server bundle.
  const cheerio = require('cheerio') as typeof import('cheerio');
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg, iframe, form, nav, header, footer, aside').remove();
  const title = ($('title').first().text() || fallbackTitle).trim();
  const scope = $('main').length ? $('main') : $('article').length ? $('article') : $('body');
  const text = scope
    .text()
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
