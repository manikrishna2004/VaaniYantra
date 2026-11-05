/**
 * Third stage: merge the lead list into personalised, ready-to-send drafts.
 *
 *   npx tsx scripts/draft-emails.ts                          # dry run — renders one email so you can read it
 *   npx tsx scripts/draft-emails.ts --apply                  # writes 50 drafts for email one
 *   npx tsx scripts/draft-emails.ts --apply --sequence=2 --recording=https://youtu.be/xxxx
 *   npx tsx scripts/draft-emails.ts --apply --limit=25 --presenter="Baliji Manikanta"
 *
 * The copy, the reasoning behind the three-email ladder, and the list of claims
 * that must never appear in writing all live in sales/OUTREACH.md. This script is
 * only the merge — if you want to change what the email says, change it there and
 * here together.
 *
 * Writes two things per run:
 *   sales/leads/drafts/seq<N>/<clinic>.txt   one file per lead, paste-ready
 *   sales/leads/drafts/seq<N>-merge.csv      email,subject,body for any mail-merge tool
 *
 * It sends nothing. Sending is yours, from a mailbox you actually read.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const OUT_DIR = join(process.cwd(), 'sales', 'leads');
const DRAFT_DIR = join(OUT_DIR, 'drafts');

/** Matches sales/OUTREACH.md §7: fifty a day, ramped. */
const DEFAULT_LIMIT = 50;

/**
 * Which copy variant to merge — sales/OUTREACH.md §2 by default, §9 for the Gulf.
 *
 * This is not a localisation nicety. The India pitch leads with the after-hours
 * gap and mentions the confirmation in passing; in the Gulf the confirmation IS
 * the pitch, because WhatsApp is how patients there already expect a clinic to
 * talk to them and there is no DLT registration standing in the way. Merging the
 * India paragraph onto a Dubai list would bury the one line that sells it.
 */
const VARIANT: 'default' | 'gulf' = process.argv.includes('--variant=gulf') ? 'gulf' : 'default';

const SUBJECTS_SEQ1 = [
  'your after-hours calls',
  // Possessive is substituted, not hardcoded: a name already ending in s
  // ("Nayel Clinics") takes a bare apostrophe, and "Clinics's" in a subject line
  // is exactly the tell that gives a mail merge away.
  'quick question about {{clinicPossessive}} phone',
  'the calls you never hear about',
];

type Row = Record<string, string>;

// ── CSV ──────────────────────────────────────────────────────────────────────
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

// ── Personalisation ──────────────────────────────────────────────────────────
function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/** "Riverchase Animal Hospital's" but "St James'" — do not double the s. */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/**
 * A vet's callers are not patients, and saying "patients" to a vet is the kind of
 * small wrongness that tells the reader this was a mail merge.
 */
function vocabulary(vertical: string): { caller: string; desk: string } {
  return vertical === 'vet'
    ? { caller: 'the pet owner', desk: 'your front desk' }
    : { caller: 'the patient', desk: 'reception' };
}

/**
 * One clause, at most. See OUTREACH.md §5 — never the rating, never the review
 * count quoted back at them.
 */
function fitClause(row: Row): string {
  if (!row.website?.trim()) {
    return " You're running on the phone entirely, which is exactly where this fits.";
  }
  if (Number(row.reviews ?? 0) >= 100) {
    return ' You look busy enough that the line must get stacked at peak.';
  }
  return '';
}

/**
 * Google Places returns a business name exactly as it was registered, which in
 * the Gulf routinely means the English and Arabic names concatenated, often with
 * a branch and city appended:
 *
 *   "Abeer Medical Center - Bawadi, Jeddah مركز العبير الطبي - البوادي، جدة"
 *
 * Dropped into a subject line verbatim, that reads as a mail merge that broke —
 * which is the one impression a cold email cannot survive. 186 of the 794 Gulf
 * leads carry Arabic in the name, so this is a quarter of the list rather than
 * an edge case worth ignoring.
 *
 * Keep the Latin-script part, drop a trailing branch/city fragment, and cap the
 * length: a subject line is not the place for a full legal entity name.
 */
function cleanClinicName(raw: string): string {
  let s = (raw ?? '').trim();

  // Arabic, Arabic Supplement, and the presentation-form blocks Places uses.
  s = s.replace(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();

  // Stripping an Arabic name can strand a space before its punctuation, so
  // "Tails Veterinary Centre , Bahrain" keeps the gap into the subject line.
  s = s.replace(/\s+([,;])/g, '$1');

  // "Name - Branch, City" -> "Name", but only when what survives is still a
  // name. A practice genuinely called "Smile - Dental" keeps both halves.
  // A pipe needs no surrounding spaces to be a separator ("Dr.Nair| (MDS)");
  // a dash does, or hyphenated names lose their second half.
  // The space before the dash is optional — Places listings routinely carry
  // "Clinica Maria Medical Center- The Filipino", and requiring both spaces let
  // that through into the possessive. A space *after* is still required, or
  // "Al-Shuyoukh" and "e-Dental" lose their second half.
  const head = s.split(/\s*[-–—]\s+|\s*\|\s*/)[0].trim();
  if (head.length >= 4) s = head;

  // Qualifications trailing the name are not part of what to call the practice.
  s = s.replace(/\s*\((?:MDS|BDS|MBBS|DDS|MD|PhD|LLC|FZ ?LLC|WLL)\)\s*$/i, '').trim();

  // Both ends: when the Arabic name came *first* ("عيادات نايل | Nayel Clinics")
  // removing it leaves the separator stranded at the head, not the tail.
  s = s.replace(/^[\s,;:|(–—-]+/, '').replace(/[\s,;:|(–—-]+$/, '').trim();

  // An unmatched bracket left behind by stripping a parenthesised Arabic name.
  if (s.includes(')') && !s.includes('(')) s = s.replace(/\s*\)\s*$/, '').trim();

  // Trim at a word boundary rather than mid-word.
  if (s.length > 45) s = s.slice(0, 45).replace(/\s+\S*$/, '').trim();

  // A listing typed in lower case ("mercy veterinary clinic") is the owner's
  // casual entry, not a styled wordmark. Title-case it so the subject line does
  // not look careless — but leave anything already carrying capitals alone, so a
  // deliberate "e-Dental" or an acronym survives.
  // Shouting is the other half of the same problem: "ALL CARE VETERINARY CLINIC"
  // in a sentence reads like a database record, not a practice. Only fold names
  // that carry a space, so a genuine acronym ("NMC", "IKIGAI") survives intact.
  if (s && s === s.toUpperCase() && /[A-Z]/.test(s) && s.includes(' ')) {
    s = s.toLowerCase();
  }

  if (s && s === s.toLowerCase()) {
    // Not \b[a-z]: an apostrophe is a word boundary, so "murphy's" would become
    // "Murphy'S" — which reads as a merge that broke, in the subject line no less.
    s = s.replace(/(^|[^A-Za-z'])([a-z])/g, (_m, pre, c) => pre + c.toUpperCase());
  }

  return s || 'your practice';
}

/** Names that mark an institution with a switchboard rather than a front desk. */
const INSTITUTION = /\b(hospital|medical city|health ?care city|group|complex|university|polyclinic|medical center \d|center \d)\b/i;

/**
 * How likely this lead is to be *reachable by a cold email from one person*.
 *
 * This deliberately disagrees with fit_score, which rewards a busy phone and so
 * ranks a 12,000-review hospital top. Busy is right; reachable is not. A hospital
 * that size has a switchboard, a call centre, an IT function and a procurement
 * process — the mail lands with someone who cannot buy and does not forward. The
 * practice this product actually fits has one or two rooms, a single front desk,
 * and an owner-dentist who reads info@ themselves.
 *
 * Order matters more than it looks: send-emails.ts walks this list from the top
 * at 20/day, so the ranking decides who receives the *warm-up* batch — the sends
 * that establish the domain's reputation and produce the first replies. Spending
 * those on hospital switchboards is the expensive version of being wrong.
 */
function reachability(row: Row): number {
  const reviews = Number(row.reviews ?? 0) || 0;
  let score = 0;

  // Enough reviews to be a real, trading practice; few enough to be one site.
  if (reviews >= 20 && reviews <= 400) score += 100;
  else if (reviews > 400 && reviews <= 1000) score += 40;
  else if (reviews > 1000) score -= 60;
  else score += 10; // under 20 — real, just quiet

  if (INSTITUTION.test(row.name ?? '')) score -= 80;

  // Owner-operated verticals: a dental or vet practice is nearly always a single
  // site with the owner on the premises. "clinic" covers both that and the
  // 400-bed variety, so it earns nothing either way.
  if (row.vertical === 'dental' || row.vertical === 'vet') score += 25;

  // An address on the practice's own domain reaches the practice. A gmail.com
  // address on a business listing is more often an agency or a stale contact.
  if (row.email && !/@(gmail|hotmail|yahoo|outlook|live|icloud)\./i.test(row.email)) score += 15;

  // A name we cannot personalise costs the strongest subject line variant.
  if (cleanClinicName(row.name ?? '') === 'your practice') score -= 25;

  return score;
}

// ── Templates ────────────────────────────────────────────────────────────────
/**
 * The one paragraph that differs between the India and Gulf ladders — kept in a
 * single function so the two versions cannot quietly drift apart. Both are
 * transcribed from sales/OUTREACH.md (§2 and §9); change them there and here
 * together, and keep the claims inside what §6 permits.
 */
function middleParagraph(row: Row, caller: string, desk: string): string {
  if (VARIANT === 'gulf') {
    return (
      `Most practices have never counted it.${fitClause(row)} We answer those calls in the ` +
      "caller's own language — Arabic, Hindi, Malayalam, Tagalog, English, and the mix people " +
      'actually speak — book straight into the doctor\'s calendar, and send the confirmation on ' +
      `WhatsApp. Nothing to install, and no SMS registration to wait on. It isn't a replacement ` +
      `for ${desk}. It's the hours ${desk} isn't there.`
    );
  }
  return (
    `Most practices have never counted it.${fitClause(row)} I build an AI receptionist that ` +
    "picks up those calls in the caller's own language, books straight into your calendar, and " +
    `texts ${caller} the confirmation. It isn't a replacement for ${desk}. It's the hours ` +
    `${desk} isn't there.`
  );
}

function bodySeq1(
  row: Row,
  presenter: string,
  site: string,
  _subjectVariant: number,
  recording: string,
): string {
  const clinic = cleanClinicName(row.name ?? '');
  const { caller, desk } = vocabulary(row.vertical ?? '');

  // The video is the hook, so it goes above the fold rather than being offered.
  // That trades away email one's original ask — "want me to send it?" — so the
  // close has to carry a new one, and the ladder loses a rung. See OUTREACH.md §1.
  const reel = recording
    ? ['90 seconds of it taking a real booking, start to finish:', '', recording, '']
    : [];

  const how =
    VARIANT === 'gulf'
      ? "It answers in the caller's own language — Arabic, Hindi, Malayalam, Tagalog, " +
        "English, and the mix people actually speak — books into the doctor's calendar, " +
        'and confirms on WhatsApp. Nothing to install.'
      : "It answers in the caller's own language, books into your calendar, and texts " +
        `${caller} the confirmation.`;

  return [
    'Hi —',
    '',
    ...reel,
    `Your entire appointment booking can run like that — the after-hours calls included, ` +
      `and the ones that come while ${desk} already has a queue at the counter.`,
    '',
    how,
    '',
    `Not a replacement for ${desk}. The hours ${desk} isn't there.`,
    '',
    `Worth a look at ${possessive(clinic)} line?`,
    '',
    `— ${presenter}`,
    site,
  ].join('\n');
}

function bodySeq2(row: Row, recording: string): string {
  const clinic = cleanClinicName(row.name ?? '');
  void clinic;
  return [
    'Sent this to a few practices this month and thought you might want it either way — 90 seconds of the assistant taking a booking, start to finish:',
    '',
    recording,
    '',
    'The part worth watching is 0:40, where the caller changes their mind about the time and it just handles it.',
    '',
    "If it's useful: worth 15 minutes to point it at one of your lines for a fortnight and see what it catches? I'd rather show you on your own number than talk about it on mine.",
  ].join('\n');
}

function bodySeq3(row: Row): string {
  const clinic = cleanClinicName(row.name ?? '');
  return [
    "I'll stop here — I don't want to be the reason your inbox is annoying.",
    '',
    `If after-hours calls aren't a problem worth solving at ${clinic}, just say "not now" and I'll close the file properly.`,
    '',
    "If it's the wrong time rather than the wrong thing, tell me when to come back and I will.",
  ].join('\n');
}

/**
 * Stable per-lead subject choice. Keyed on place_id where we have one (Places ids do
 * not change), falling back to the email address.
 */
function subjectVariantFor(row: Row): number {
  const key = row.place_id?.trim() || row.email?.trim() || row.name?.trim() || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % SUBJECTS_SEQ1.length;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'lead';
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const inFile = argValue('in') ?? join(OUT_DIR, 'clinics-with-email.csv');
  const sequence = Number(argValue('sequence') ?? 1);
  const limit = Number(argValue('limit') ?? DEFAULT_LIMIT);
  const presenter = argValue('presenter') ?? process.env.SALES_PRESENTER ?? 'Baliji Manikanta';
  const site = argValue('site') ?? 'vaaniyantra.com';
  const recording = argValue('recording') ?? '';

  if (![1, 2, 3].includes(sequence)) {
    console.error('✖ --sequence must be 1, 2 or 3.');
    process.exit(1);
  }
  if (sequence === 2 && !recording) {
    console.error('✖ Email two is the recording. Pass --recording=<url>.');
    console.error('  OUTREACH.md §3: do not send email two without it — the ladder rests on that artefact.');
    process.exit(1);
  }
  if (!existsSync(inFile)) {
    console.error(`✖ ${inFile} not found. Run find-clinics.ts then find-clinic-emails.ts first.`);
    process.exit(1);
  }

  const all = parseCsv(readFileSync(inFile, 'utf8'));
  const sendable = all
    .filter((r) => r.email?.trim())
    .sort((a, b) => reachability(b) - reachability(a))
    .slice(0, limit);

  console.log(`▶ ${APPLY ? 'applying' : 'dry run (pass --apply to write the drafts)'}`);
  console.log(`  input      ${inFile}`);
  console.log(`  leads      ${all.length} (${all.filter((r) => r.email?.trim()).length} with an email)`);
  console.log(`  sequence   email ${sequence}`);
  console.log(`  drafting   ${sendable.length} (limit ${limit} — OUTREACH.md §7 caps sending at 50/day)`);

  if (!sendable.length) {
    console.error('\n✖ Nothing to draft.');
    process.exit(1);
  }

  const rendered = sendable.map((row) => {
    const clinic = cleanClinicName(row.name ?? '');
    // Derived from the lead's own identity, not its position in the file, so emails
    // two and three land on the same subject line — and therefore the same thread —
    // however the CSV has been regenerated or re-sorted since email one went out.
    const variant = subjectVariantFor(row);
    const line = SUBJECTS_SEQ1[variant]
      .replace('{{clinicPossessive}}', possessive(clinic))
      .replace('{{clinic}}', clinic);
    const subject = sequence === 1 ? line : `Re: ${line}`;
    const body =
      sequence === 1 ? bodySeq1(row, presenter, site, variant, recording)
      : sequence === 2 ? bodySeq2(row, recording)
      : bodySeq3(row);
    return { email: row.email.trim(), name: clinic, subject, body };
  });

  if (!APPLY) {
    const sample = rendered[0];
    console.log('\n── sample ───────────────────────────────────────');
    console.log(`To:      ${sample.email}`);
    console.log(`Subject: ${sample.subject}`);
    console.log('');
    console.log(sample.body);
    console.log('─────────────────────────────────────────────────');
    console.log('\n  Nothing written. Read it above, then re-run with --apply.');
    if (sequence !== 2) console.log('  Emails two and three reply in the same thread — do not start a new one.');
    return;
  }

  const seqDir = join(DRAFT_DIR, `seq${sequence}`);
  mkdirSync(seqDir, { recursive: true });

  for (const r of rendered) {
    const file = join(seqDir, `${slugify(r.name)}.txt`);
    writeFileSync(file, `To: ${r.email}\nSubject: ${r.subject}\n\n${r.body}\n`, 'utf8');
  }

  const mergeCsv =
    ['email,subject,body']
      .concat(rendered.map((r) => [r.email, r.subject, r.body].map(csvCell).join(',')))
      .join('\r\n') + '\r\n';
  const mergeFile = join(DRAFT_DIR, `seq${sequence}-merge.csv`);
  writeFileSync(mergeFile, mergeCsv, 'utf8');

  console.log('\n── done ─────────────────────────────────────────');
  console.log(`  drafts     ${rendered.length} → ${seqDir}`);
  console.log(`  merge file ${mergeFile}`);
  console.log('\n  Nothing has been sent. Send from a mailbox you read, plain text,');
  console.log('  and check SPF/DKIM/DMARC on the domain first (OUTREACH.md §7).');
}

main();
