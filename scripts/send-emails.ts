/**
 * Fourth stage: actually send the drafts, from the business mailbox, over SMTP.
 *
 *   npx tsx scripts/send-emails.ts                      # dry run — who would go today, nothing sends
 *   npx tsx scripts/send-emails.ts --apply              # sends today's batch
 *   npx tsx scripts/send-emails.ts --apply --per-day=25 --sequence=1
 *
 * Requires three variables in .env:
 *   ZOHO_SMTP_USER=info@vaaniyantra.com
 *   ZOHO_SMTP_PASS=<app-specific password, NOT the account password>
 *   ZOHO_SMTP_HOST=smtp.zoho.in       # smtp.zoho.com if the account is US-hosted
 *
 * The password must be an application-specific password, generated in Zoho Mail
 * under Settings -> Security -> App Passwords. Zoho refuses the account password
 * over SMTP once two-factor is on, and an app password can be revoked by itself
 * without touching the account.
 *
 * -- Why this throttles, and why raising the cap is a bad trade -----------------
 * vaaniyantra.com has effectively no sending history. Reputation at a receiving
 * mail server is built from consistent volume over weeks, so a domain that has
 * sent almost nothing and then emits a thousand messages in an afternoon looks,
 * to a spam filter, exactly like a compromised account. The failure mode is not
 * "some land in spam" — it is the domain getting filtered, including mail to
 * customers who asked for it. That takes months to undo and no copy survives it.
 *
 * Zoho also enforces a per-plan daily ceiling and suspends accounts for bulk
 * unsolicited mail, so the cap here is what keeps the mailbox itself alive.
 *
 * The ramp that works: 20/day the first week, 40 the second, 60 after that, and
 * never past 100 from one mailbox. Sends are spaced with jitter for the same
 * reason — evenly spaced bursts are themselves a bulk-mail signal.
 *
 * Every address that receives a message is recorded in sales/leads/.sent.json,
 * so re-running is safe and no clinic is ever written to twice.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

const APPLY = process.argv.includes('--apply');
const OUT_DIR = join(process.cwd(), 'sales', 'leads');
const SENT_LOG = join(OUT_DIR, '.sent.json');

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SEQUENCE = arg('sequence', '1');
const PER_DAY = Math.max(1, Number(arg('per-day', '20')));
const MERGE_CSV = join(OUT_DIR, 'drafts', `seq${SEQUENCE}-merge.csv`);

/** Spacing between messages. Bulk mail arrives evenly spaced; a person does not. */
const MIN_GAP_MS = 45_000;
const MAX_GAP_MS = 110_000;

const USER = process.env.ZOHO_SMTP_USER || '';
const PASS = process.env.ZOHO_SMTP_PASS || '';
const HOST = process.env.ZOHO_SMTP_HOST || 'smtp.zoho.in';
// Matches the sign-off draft-emails.ts already puts at the bottom of the body.
// A From name that disagrees with the signature is the kind of small mismatch a
// spam filter notices and a reader distrusts.
const FROM_NAME = arg('from-name', 'Baliji Manikanta');

/**
 * A cold message to a business needs a one-line way out that does not require a
 * reply. Leaving it off is what turns an irritated reader into a spam report,
 * and spam reports are what domain reputation is actually made of.
 */
const OPT_OUT = '\n\nIf this is not something you want, reply STOP and I will not write again.';

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  if (!header) return [];
  return body.map((r) =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(MERGE_CSV)) {
    console.error(`x no drafts at ${MERGE_CSV}`);
    console.error('  run: npx tsx scripts/draft-emails.ts --apply');
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(MERGE_CSV, 'utf8')).filter(
    (r) => r.email && r.subject && r.body,
  );
  const sent: Record<string, string> = existsSync(SENT_LOG)
    ? JSON.parse(readFileSync(SENT_LOG, 'utf8'))
    : {};

  const pending = rows.filter((r) => !sent[r.email.toLowerCase()]);
  const batch = pending.slice(0, PER_DAY);

  console.log('> send plan');
  console.log(`  sequence     ${SEQUENCE}`);
  console.log(`  drafts       ${rows.length}`);
  console.log(`  already sent ${Object.keys(sent).length}`);
  console.log(`  pending      ${pending.length}`);
  console.log(`  today        ${batch.length} (cap ${PER_DAY})`);
  console.log(`  from         ${USER || '(ZOHO_SMTP_USER unset)'} via ${HOST}`);
  const mins = Math.round((batch.length * ((MIN_GAP_MS + MAX_GAP_MS) / 2)) / 60000);
  console.log(`  duration     roughly ${mins} min, spaced with jitter`);

  if (!batch.length) {
    console.log('\n  Nothing pending. Either everything has gone, or raise --per-day.');
    return;
  }

  if (!APPLY) {
    console.log('\n  Dry run — nothing sent. First three recipients:');
    for (const r of batch.slice(0, 3)) console.log(`    ${r.email}  "${r.subject}"`);
    console.log('\n  Re-run with --apply to send.');
    return;
  }

  if (!USER || !PASS) {
    console.error('\nx ZOHO_SMTP_USER and ZOHO_SMTP_PASS must be set in .env.');
    console.error('  Zoho Mail -> Settings -> Security -> App Passwords.');
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    host: HOST,
    port: 465,
    secure: true,
    auth: { user: USER, pass: PASS },
  });

  try {
    await transport.verify();
    console.log('\n  SMTP connection verified.');
  } catch (err) {
    console.error(`\nx SMTP login failed: ${(err as Error).message}`);
    console.error('  Check the region host (smtp.zoho.in vs smtp.zoho.com), and that the');
    console.error('  password is an app password rather than the account password.');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;

  for (const [i, r] of batch.entries()) {
    const key = r.email.toLowerCase();
    try {
      await transport.sendMail({
        from: `"${FROM_NAME}" <${USER}>`,
        to: r.email,
        subject: r.subject,
        text: r.body + OPT_OUT,
      });
      // Record before the next send, not at the end of the run: a crash halfway
      // through must not leave sent mail unrecorded, or the rerun sends it twice.
      sent[key] = new Date().toISOString();
      writeFileSync(SENT_LOG, JSON.stringify(sent, null, 2), 'utf8');
      ok++;
      console.log(`  [${i + 1}/${batch.length}] sent -> ${r.email}`);
    } catch (err) {
      // One bad address must not abort the batch, and must not be logged as sent.
      console.error(`  [${i + 1}/${batch.length}] FAILED ${r.email}: ${(err as Error).message}`);
    }
    if (i < batch.length - 1) {
      await sleep(MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
    }
  }

  console.log(`\n-- done --  ${ok}/${batch.length} sent, log at ${SENT_LOG}`);
  console.log('  Run again tomorrow; already-sent addresses are skipped automatically.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
