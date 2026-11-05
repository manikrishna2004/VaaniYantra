/**
 * Clinic lead sourcing from Google Places — the list the B2B databases could not build.
 *
 *   npx tsx scripts/find-clinics.ts                          # dry run — prints the plan and the call count
 *   npx tsx scripts/find-clinics.ts --apply                  # runs it, writes sales/leads/clinics.csv
 *   npx tsx scripts/find-clinics.ts --apply --cities=gulf --verticals=vet,dental
 *   npx tsx scripts/find-clinics.ts --apply --cities=Dubai,"Kuala Lumpur"
 *   npx tsx scripts/find-clinics.ts --apply --channel=phone     # rank for cold calling instead
 *
 * Stage 1 of 2. Stage 2 is scripts/find-clinic-emails.ts, which turns the websites
 * this produces into contactable inboxes.
 *
 * Why Places and not a B2B prospecting database: a single-location vet or dental
 * practice keeps a Google Maps listing and a phone number, not a rich company profile.
 * Nine filtered queries against an intent/firmographic database returned ~2 genuine
 * clinics per 45 rows — publishers, associations and device manufacturers filled the rest.
 * Places indexes exactly the population we want, and returns the phone number, which
 * matters because the product being sold is answered on that phone.
 *
 * Billing: every page of every query is a paid Text Search call. The default is a DRY
 * RUN that bills nothing and prints the worst-case call count. Results are cached under
 * sales/leads/.cache, so re-running only pays for queries it has not already made —
 * delete the cache directory to force fresh data.
 *
 * Requires GOOGLE_PLACES_API_KEY (falls back to GOOGLE_CLOUD_API_KEY) with the
 * "Places API (New)" enabled on the project.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const OUT_DIR = join(process.cwd(), 'sales', 'leads');
const CACHE_DIR = join(OUT_DIR, '.cache');

/**
 * Which channel the list is for. This is not cosmetic — it changes both who is kept
 * and how they are ranked.
 *
 *   email (default) — a practice with no website has no inbox to find, so it is dropped.
 *   phone           — a website is irrelevant; not having one is a positive signal,
 *                     because it means a phone-first practice with no booking widget.
 *
 * Email is the default because cold-calling a clinic reaches the receptionist, who has
 * no buying authority and whose job this product appears to threaten.
 */
const CHANNEL: 'email' | 'phone' =
  process.argv.includes('--channel=phone') ? 'phone' : 'email';

/** Website hosts that are a social page, not a site with a contact inbox to scrape. */
const NON_SCRAPEABLE_HOSTS = /facebook\.com|instagram\.com|linktr\.ee|wa\.me|linkedin\.com|twitter\.com|x\.com/i;

const API_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || '';
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/** Text Search returns at most 20 per page and stops at 3 pages (60 places) per query. */
const MAX_PAGES = 3;
const PAGE_DELAY_MS = 2_000; // a fresh nextPageToken needs a moment before it is valid
const QUERY_DELAY_MS = 250;

/** Only the fields we use. Every extra field can move the call into a pricier SKU. */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.primaryTypeDisplayName',
  'places.googleMapsUri',
  'nextPageToken',
].join(',');

// ── Where to look ────────────────────────────────────────────────────────────
// Grouped by how sellable the market is today, not by geography for its own sake.
const CITY_PRESETS: Record<string, string[]> = {
  // No HIPAA, no GDPR, large multilingual populations — the language stack is an asset here.
  gulf: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Doha', 'Riyadh', 'Jeddah', 'Kuwait City', 'Manama', 'Muscat'],
  sea: ['Singapore', 'Kuala Lumpur', 'Manila', 'Bangkok', 'Jakarta', 'Ho Chi Minh City'],
  anz: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Auckland'],
  africa: ['Nairobi', 'Lagos', 'Johannesburg', 'Cape Town', 'Accra'],
  latam: ['Mexico City', 'Guadalajara', 'Monterrey', 'Sao Paulo', 'Bogota', 'Santiago'],
  // US is listed for veterinary specifically: animals are not covered by HIPAA,
  // so no BAA is required. Do not point this at US human healthcare.
  usvet: ['Austin', 'Dallas', 'Phoenix', 'Denver', 'Tampa', 'Charlotte', 'Portland', 'Nashville', 'San Diego', 'Atlanta'],
};

const VERTICALS: Record<string, string[]> = {
  vet: ['veterinary clinic', 'animal hospital', 'pet clinic'],
  dental: ['dental clinic', 'dentist'],
  clinic: ['medical clinic', 'polyclinic', 'family medicine clinic'],
  hospital: ['private hospital'], // opt-in: enterprise procurement, needs SSO/SLA you do not have
};

/**
 * Names that Places returns inside these searches but that never answer a patient line.
 * Learned the expensive way from the database attempt.
 */
const NAME_EXCLUSIONS = [
  /\bassociation\b/i, /\bsociety\b/i, /\bcouncil\b/i, /\bfederation\b/i,
  /\buniversity\b/i, /\bcollege\b/i, /\binstitute\b/i, /\bschool\b/i,
  /\bsupply\b/i, /\bsupplies\b/i, /\bwholesale\b/i, /\bdistributor\b/i,
  /\bpharmaceutical/i, /\bequipment\b/i, /\bmanufactur/i, /\bjournal\b/i,
];

type Place = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  primaryTypeDisplayName?: { text?: string };
  googleMapsUri?: string;
};

type Lead = {
  place_id: string;
  name: string;
  vertical: string;
  city: string;
  address: string;
  phone_international: string;
  phone_national: string;
  website: string;
  rating: string;
  reviews: string;
  category: string;
  maps_url: string;
  fit_score: number;
  fit_reasons: string;
};

// ── Argument parsing ─────────────────────────────────────────────────────────
function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function resolveCities(): string[] {
  const raw = argValue('cities') ?? 'gulf,sea';
  const out: string[] = [];
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const preset = CITY_PRESETS[token.toLowerCase()];
    if (preset) out.push(...preset);
    else out.push(token);
  }
  return [...new Set(out)];
}

function resolveVerticals(): string[] {
  const raw = argValue('verticals') ?? 'vet,dental,clinic';
  const out: string[] = [];
  for (const token of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!VERTICALS[token]) {
      console.error(`✖ unknown vertical "${token}" — pick from: ${Object.keys(VERTICALS).join(', ')}`);
      process.exit(1);
    }
    out.push(token);
  }
  return [...new Set(out)];
}

// ── Scoring ──────────────────────────────────────────────────────────────────
/**
 * A transparent heuristic, not a measurement. It ranks who is most likely to be
 * losing calls today, so the top of the CSV is where to start working.
 *
 * The website signal flips with the channel, which is the whole reason CHANNEL exists:
 * for phone outreach, no website is the strongest positive signal there is; for email
 * it disqualifies the lead outright, and an own domain becomes the thing worth having.
 */
function scoreLead(p: Place): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (CHANNEL === 'phone') {
    if (!p.websiteUri) {
      score += 3;
      reasons.push('no website (phone-first practice, no online booking to compete with)');
    }
  } else {
    const host = p.websiteUri ?? '';
    if (host && !NON_SCRAPEABLE_HOSTS.test(host)) {
      score += 2;
      reasons.push('own domain (contact page likely to carry a real inbox)');
    } else if (host) {
      reasons.push('social page only (an inbox is unlikely to be findable)');
    }
  }

  const reviews = p.userRatingCount ?? 0;
  if (reviews >= 100) {
    score += 2;
    reasons.push(`${reviews} reviews (high footfall implies high call volume)`);
  } else if (reviews >= 30) {
    score += 1;
    reasons.push(`${reviews} reviews (established practice)`);
  }

  const rating = p.rating ?? 0;
  if (rating > 0 && rating < 4.3) {
    score += 1;
    reasons.push(`${rating.toFixed(1)} rating (service friction is often phone responsiveness)`);
  }

  return { score, reasons };
}

// ── Places client ────────────────────────────────────────────────────────────
function cacheKeyFor(query: string, page: number): string {
  return createHash('sha1').update(`${query}::${page}`).digest('hex').slice(0, 16);
}

async function searchPage(
  query: string,
  page: number,
  pageToken?: string,
): Promise<{ places: Place[]; nextPageToken?: string; cached: boolean }> {
  const cacheFile = join(CACHE_DIR, `${cacheKeyFor(query, page)}.json`);
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    return { places: cached.places ?? [], nextPageToken: cached.nextPageToken, cached: true };
  }

  const body: Record<string, unknown> = { textQuery: query, pageSize: 20 };
  if (pageToken) body.pageToken = pageToken;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Places ${res.status} for "${query}" (page ${page}): ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { places?: Place[]; nextPageToken?: string };
  writeFileSync(cacheFile, JSON.stringify(json), 'utf8');
  return { places: json.places ?? [], nextPageToken: json.nextPageToken, cached: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── CSV ──────────────────────────────────────────────────────────────────────
function csvCell(value: string | number): string {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Lead[]): string {
  const headers: (keyof Lead)[] = [
    'name', 'vertical', 'city', 'phone_international', 'phone_national', 'website',
    'rating', 'reviews', 'fit_score', 'fit_reasons', 'address', 'category', 'maps_url', 'place_id',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cities = resolveCities();
  const verticals = resolveVerticals();
  const outFile = argValue('out') ?? join(OUT_DIR, 'clinics.csv');

  const queries: { text: string; city: string; vertical: string }[] = [];
  for (const city of cities) {
    for (const vertical of verticals) {
      for (const phrase of VERTICALS[vertical]) {
        queries.push({ text: `${phrase} in ${city}`, city, vertical });
      }
    }
  }

  console.log(`▶ ${APPLY ? 'applying' : 'dry run (pass --apply to call the API and write the CSV)'}`);
  console.log(`  channel    ${CHANNEL}${CHANNEL === 'email' ? ' (drops practices with no website — nothing to scrape)' : ' (keeps them; no website scores highest)'}`);
  console.log(`  cities     ${cities.length} — ${cities.join(', ')}`);
  console.log(`  verticals  ${verticals.join(', ')}`);
  console.log(`  queries    ${queries.length}`);
  console.log(`  max calls  ${queries.length * MAX_PAGES} (${queries.length} queries x up to ${MAX_PAGES} pages)`);
  console.log(`  max places ${queries.length * MAX_PAGES * 20} before dedup`);
  console.log(`  output     ${outFile}`);

  if (!APPLY) {
    console.log('\n  Nothing was called and nothing was billed.');
    console.log('  Confirm the per-call price for Text Search in your Google Cloud console,');
    console.log('  multiply by "max calls" above, then re-run with --apply.');
    return;
  }

  if (!API_KEY) {
    console.error('\n✖ No API key. Set GOOGLE_PLACES_API_KEY in .env and enable "Places API (New)".');
    process.exit(1);
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const byId = new Map<string, Lead>();
  let calls = 0;
  let cacheHits = 0;
  let failures = 0;
  let skipped = 0;

  for (const [i, q] of queries.entries()) {
    process.stdout.write(`  [${i + 1}/${queries.length}] ${q.text} … `);
    let pageToken: string | undefined;
    let found = 0;

    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { places, nextPageToken, cached } = await searchPage(q.text, page, pageToken);
        if (cached) cacheHits++;
        else calls++;

        for (const p of places) {
          if (!p.id || byId.has(p.id)) continue;

          const name = p.displayName?.text ?? '';
          const phone = p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? '';

          // A lead with no phone cannot be sold a phone product — keep the number
          // even on an email campaign, since it is what the pitch is about.
          if (!phone) { skipped++; continue; }
          if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') { skipped++; continue; }
          if (NAME_EXCLUSIONS.some((re) => re.test(name))) { skipped++; continue; }
          // No website, no inbox to find later. Only drop these on an email campaign.
          if (CHANNEL === 'email' && !p.websiteUri) { skipped++; continue; }

          const { score, reasons } = scoreLead(p);
          byId.set(p.id, {
            place_id: p.id,
            name,
            vertical: q.vertical,
            city: q.city,
            address: p.formattedAddress ?? '',
            phone_international: p.internationalPhoneNumber ?? '',
            phone_national: p.nationalPhoneNumber ?? '',
            website: p.websiteUri ?? '',
            rating: p.rating != null ? p.rating.toFixed(1) : '',
            reviews: String(p.userRatingCount ?? 0),
            category: p.primaryTypeDisplayName?.text ?? '',
            maps_url: p.googleMapsUri ?? '',
            fit_score: score,
            fit_reasons: reasons.join('; '),
          });
          found++;
        }

        if (!nextPageToken) break;
        pageToken = nextPageToken;
        if (!cached) await sleep(PAGE_DELAY_MS);
      }
      console.log(`+${found}`);
    } catch (err) {
      failures++;
      console.log(`✖ ${(err as Error).message}`);
    }

    await sleep(QUERY_DELAY_MS);
  }

  const leads = [...byId.values()].sort(
    (a, b) => b.fit_score - a.fit_score || Number(b.reviews) - Number(a.reviews),
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outFile, toCsv(leads), 'utf8');

  console.log('\n── done ─────────────────────────────────────────');
  console.log(`  billed calls   ${calls}`);
  console.log(`  cache hits     ${cacheHits} (free)`);
  console.log(`  failed queries ${failures}`);
  console.log(`  filtered out   ${skipped} (no phone, closed, or not a practice)`);
  console.log(`  leads written  ${leads.length} → ${outFile}`);

  const byVertical = new Map<string, number>();
  for (const l of leads) byVertical.set(l.vertical, (byVertical.get(l.vertical) ?? 0) + 1);
  for (const [v, n] of byVertical) console.log(`    ${v.padEnd(9)} ${n}`);

  if (CHANNEL === 'phone') {
    const noWebsite = leads.filter((l) => !l.website).length;
    console.log(`  of those, ${noWebsite} have no website at all — start there.`);
  } else {
    const ownDomain = leads.filter((l) => l.website && !NON_SCRAPEABLE_HOSTS.test(l.website)).length;
    console.log(`  of those, ${ownDomain} have their own domain — those are the scrapeable ones.`);
    console.log('  next: npx tsx scripts/find-clinic-emails.ts --apply');
  }

  if (failures === queries.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
