/**
 * Second stage of lead sourcing: turn clinic websites into contactable inboxes.
 *
 *   npx tsx scripts/find-clinic-emails.ts                 # dry run — how many sites would be visited
 *   npx tsx scripts/find-clinic-emails.ts --apply         # visits them, writes clinics-with-email.csv
 *   npx tsx scripts/find-clinic-emails.ts --apply --in=sales/leads/clinics.csv --concurrency=4
 *
 * Google Places gives a name, a phone number and a website. It does not give an email,
 * because Google does not hold one. The address is almost always on the site itself —
 * in a mailto: link, on a contact page, or in the footer — so this fetches the homepage,
 * follows whatever looks like a contact page, and pulls addresses out of both.
 *
 * Costs nothing: these are ordinary public web requests, not a metered API. It is still
 * someone else's server, so requests are concurrency-limited, timed out, cached to disk,
 * and sent with a user agent that says who is asking.
 *
 * Emails are ranked, not just collected. An address on the practice's own domain beats a
 * free webmail one, and a role inbox (info@, reception@, appointments@) beats a personal
 * one — role inboxes are read by whoever runs the front desk, which is who we want.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';

const APPLY = process.argv.includes('--apply');
const OUT_DIR = join(process.cwd(), 'sales', 'leads');
const CACHE_DIR = join(OUT_DIR, '.cache-web');

/**
 * Per-request budget. Tunable because it dominates the runtime of a large list:
 * a site that answers at all almost always answers within two or three seconds,
 * so on a list where a meaningful share of the domains are parked, expired or
 * firewalled, the wall-clock cost is mostly this timeout multiplied by the dead
 * ones. Dropping it to ~6s on a 1,600-row list turns hours into minutes and
 * loses only the pathologically slow, which are not leads worth waiting for.
 */
const REQUEST_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.argv.find((a) => a.startsWith('--timeout='))?.slice(10) ?? 15_000),
);
const POLITE_DELAY_MS = 400;
const USER_AGENT =
  'CallseraLeadBot/1.0 (+https://vaaniyantra.com; contact: info@vaaniyantra.com)';

/** Paths worth trying when the homepage carries no address. */
const CONTACT_PATHS = ['/contact', '/contact-us', '/contactus', '/about', '/about-us', '/reach-us'];

/** Link text or href fragments that suggest a contact page. */
const CONTACT_HINTS = /contact|reach|enquir|inquir|about|kontakt|appointment/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Addresses that appear on clinic sites but belong to the toolchain, not the clinic:
 * template boilerplate, analytics vendors, image filenames caught by the regex.
 */
const EMAIL_JUNK = [
  /@(example|domain|yourdomain|email|test|sentry|wix|wixpress|squarespace|godaddy|shopify|cloudflare|jquery|schema)\./i,
  /\.(png|jpg|jpeg|gif|svg|webp|css|js|woff2?)$/i,
  /^(no-?reply|donotreply|postmaster|abuse|webmaster)@/i,
  /sentry\.io|@sentry|wixpress\.com/i,
];

/** Role inboxes, best first. Whoever runs the front desk reads these. */
const ROLE_PRIORITY = [
  'reception', 'frontdesk', 'front.desk', 'appointments', 'booking', 'bookings',
  'info', 'contact', 'enquiries', 'enquiry', 'inquiries', 'hello', 'clinic',
  'admin', 'office', 'mail',
];

const FREE_WEBMAIL = /@(gmail|yahoo|hotmail|outlook|live|icloud|aol|protonmail|yandex|mail)\./i;

type Row = Record<string, string>;

// ── Tiny RFC4180 CSV reader/writer ───────────────────────────────────────────
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }

  const [headers, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!headers) return [];
  return body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function csvCell(value: string): string {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Row[], headers: string[]): string {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h] ?? '')).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ── Fetching ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cacheFileFor(url: string): string {
  return join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex').slice(0, 20)}.html`);
}

async function getHtml(url: string): Promise<string | null> {
  const cacheFile = cacheFileFor(url);
  if (existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) { writeFileSync(cacheFile, '', 'utf8'); return null; }
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) { writeFileSync(cacheFile, '', 'utf8'); return null; }

    const html = await res.text();
    writeFileSync(cacheFile, html, 'utf8');
    return html;
  } catch {
    writeFileSync(cacheFile, '', 'utf8'); // negative-cache so a re-run does not retry it
    return null;
  }
}

// ── Extraction ───────────────────────────────────────────────────────────────
function harvest(html: string): string[] {
  const found = new Set<string>();

  const $ = cheerio.load(html);
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const addr = href.slice(7).split('?')[0].trim();
    if (addr) found.add(addr);
  });

  // Cloudflare and some themes write the address with entities or spaced-out @.
  const text = html.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0]);

  return [...found]
    .map((e) => e.toLowerCase().replace(/^mailto:/, '').trim())
    .filter((e) => !EMAIL_JUNK.some((re) => re.test(e)));
}

function registrableHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Highest score wins. Documented rather than clever, so the CSV can be argued with. */
function rankEmail(email: string, siteHost: string): number {
  let score = 0;
  const [local, domain = ''] = email.split('@');

  if (siteHost && (domain === siteHost || domain.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${domain}`))) {
    score += 5; // on the practice's own domain
  } else if (FREE_WEBMAIL.test(email)) {
    score += 1; // plenty of small clinics really do run on gmail
  }

  const roleIndex = ROLE_PRIORITY.findIndex((r) => local === r || local.startsWith(`${r}.`) || local.startsWith(`${r}-`));
  if (roleIndex >= 0) score += Math.max(1, 4 - Math.floor(roleIndex / 4));

  return score;
}

function contactUrls(html: string, base: string): string[] {
  const urls = new Set<string>();
  try {
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const label = $(el).text();
      if (!CONTACT_HINTS.test(href) && !CONTACT_HINTS.test(label)) return;
      try {
        const abs = new URL(href, base);
        if (abs.protocol.startsWith('http') && registrableHost(abs.href) === registrableHost(base)) {
          urls.add(abs.href.split('#')[0]);
        }
      } catch { /* skip unparseable href */ }
    });
  } catch { /* skip unparseable page */ }
  return [...urls].slice(0, 3);
}

// ── Main ─────────────────────────────────────────────────────────────────────
function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function processRow(row: Row): Promise<Row> {
  const site = row.website?.trim();
  if (!site) return { ...row, email: '', all_emails: '', email_source: 'no website' };

  const base = site.startsWith('http') ? site : `https://${site}`;
  const host = registrableHost(base);
  const collected = new Map<string, string>(); // email -> where it was found

  const home = await getHtml(base);
  if (home) {
    for (const e of harvest(home)) if (!collected.has(e)) collected.set(e, base);
  }

  if (!collected.size) {
    const candidates = home ? contactUrls(home, base) : [];
    for (const path of CONTACT_PATHS) {
      if (candidates.length >= 4) break;
      candidates.push(new URL(path, base).href);
    }

    for (const url of [...new Set(candidates)].slice(0, 4)) {
      await sleep(POLITE_DELAY_MS);
      const html = await getHtml(url);
      if (!html) continue;
      for (const e of harvest(html)) if (!collected.has(e)) collected.set(e, url);
      if (collected.size) break;
    }
  }

  if (!collected.size) {
    return { ...row, email: '', all_emails: '', email_source: home ? 'none found' : 'site unreachable' };
  }

  const ranked = [...collected.keys()].sort((a, b) => rankEmail(b, host) - rankEmail(a, host));
  const best = ranked[0];

  return {
    ...row,
    email: best,
    all_emails: ranked.join(' | '),
    email_source: collected.get(best) ?? '',
  };
}

async function main() {
  const inFile = argValue('in') ?? join(OUT_DIR, 'clinics.csv');
  const outFile = argValue('out') ?? join(OUT_DIR, 'clinics-with-email.csv');
  // Ceiling raised from 8 to 20: these are single requests to ~1,600 *different*
  // hosts, not a hammering of one server, so the politeness that matters is the
  // per-host delay below rather than a low global ceiling.
  const concurrency = Math.max(1, Math.min(20, Number(argValue('concurrency') ?? 4)));

  if (!existsSync(inFile)) {
    console.error(`✖ ${inFile} not found. Run scripts/find-clinics.ts --apply first.`);
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(inFile, 'utf8'));
  const withSite = rows.filter((r) => r.website?.trim());

  console.log(`▶ ${APPLY ? 'applying' : 'dry run (pass --apply to fetch and write)'}`);
  console.log(`  input        ${inFile}`);
  console.log(`  leads        ${rows.length}`);
  console.log(`  with website ${withSite.length} — these are the ones that can be visited`);
  console.log(`  concurrency  ${concurrency}`);
  console.log(`  output       ${outFile}`);

  if (!APPLY) {
    console.log('\n  Nothing was fetched. These are free public requests, not a metered API —');
    console.log('  the dry run exists so you can see the scale before starting.');
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const results: Row[] = [];
  let done = 0;

  for (let i = 0; i < withSite.length; i += concurrency) {
    const batch = withSite.slice(i, i + concurrency);
    const settled = await Promise.all(batch.map((r) => processRow(r)));
    results.push(...settled);
    done += batch.length;
    const hits = results.filter((r) => r.email).length;
    process.stdout.write(`\r  visited ${done}/${withSite.length} — ${hits} emails found`);
    await sleep(POLITE_DELAY_MS);
  }
  console.log('');

  const found = results.filter((r) => r.email);
  const ordered = [
    ...found.sort((a, b) => Number(b.fit_score ?? 0) - Number(a.fit_score ?? 0)),
    ...results.filter((r) => !r.email),
  ];

  const headers = [
    'name', 'email', 'vertical', 'city', 'phone_international', 'website',
    'rating', 'reviews', 'fit_score', 'fit_reasons', 'all_emails', 'email_source',
    'address', 'category', 'maps_url', 'place_id',
  ];
  writeFileSync(outFile, toCsv(ordered, headers), 'utf8');

  const ownDomain = found.filter((r) => {
    const d = r.email.split('@')[1] ?? '';
    return d && registrableHost(r.website) === d;
  }).length;

  console.log('\n── done ─────────────────────────────────────────');
  console.log(`  sites visited  ${withSite.length}`);
  console.log(`  emails found   ${found.length} (${Math.round((found.length / Math.max(1, withSite.length)) * 100)}%)`);
  console.log(`    own domain   ${ownDomain}`);
  console.log(`    webmail      ${found.length - ownDomain}`);
  console.log(`  unreachable    ${results.filter((r) => r.email_source === 'site unreachable').length}`);
  console.log(`  none on site   ${results.filter((r) => r.email_source === 'none found').length}`);
  console.log(`  written        ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
