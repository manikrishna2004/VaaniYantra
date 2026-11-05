/**
 * Create VaaniYantra's WhatsApp message templates on the PLATFORM WABA.
 *
 *   npx tsx scripts/provision-wa-templates.ts                        # what exists vs what is missing
 *   npx tsx scripts/provision-wa-templates.ts --apply                # create the missing ones
 *   npx tsx scripts/provision-wa-templates.ts --only=enquiry_received --apply
 *
 * Dry run by default, like the other operator scripts.
 *
 * WHY THIS EXISTS: provisionTemplates() has always been able to do this, but it
 * only ever ran against a CUSTOMER's WABA at Embedded Signup connect time. The
 * platform's own shared sender — the one every org without its own number uses,
 * including the demo line — was populated by hand in WhatsApp Manager. So when a
 * new template is added to WA_TEMPLATE_DEFINITIONS it silently does not exist
 * where most messages are actually sent from, and the only symptom is a send
 * that fails with the template's name in the log.
 *
 * A template must be APPROVED, not merely created, before it delivers. Utility
 * templates are usually reviewed within minutes; this script prints the status
 * so you can check rather than assume. Re-running is safe: Meta's
 * "already exists" (subcode 2388024) is treated as success by createTemplate.
 *
 * Needs the platform WABA id and system-user token in PlatformConfig — the same
 * two values /admin uses. The token needs whatsapp_business_management; a token
 * that can only SEND will fail here with a permissions error.
 */
import { getMetaConfig, createTemplate, fetchTemplateStatuses } from '@/lib/whatsapp-cloud';
import { WA_TEMPLATE_DEFINITIONS } from '@/lib/whatsapp-templates';
import { prisma } from '@/lib/db';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^["']|["']$/g, '') : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const only = (arg('only') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const cfg = await getMetaConfig();
  if (!cfg.wabaId || !cfg.systemUserToken) {
    console.error(
      'No platform WABA on file. Set the WABA id and the system-user token in /admin ' +
        '(they are the same two values the shared sender uses) and re-run.',
    );
    process.exit(1);
  }

  const wanted = only.length ? WA_TEMPLATE_DEFINITIONS.filter((d) => only.includes(d.name)) : WA_TEMPLATE_DEFINITIONS;
  if (!wanted.length) {
    console.error(`--only matched no template. Known: ${WA_TEMPLATE_DEFINITIONS.map((d) => d.name).join(', ')}`);
    process.exit(1);
  }

  // What Meta already holds. Read first so the summary distinguishes "missing"
  // from "created but still in review" — two very different reasons for a
  // message not to arrive.
  const existing = await fetchTemplateStatuses(cfg, cfg.systemUserToken, cfg.wabaId);
  const rowFor = (name: string, lang: string) => existing.find((t) => t.name === name && t.language === lang);

  console.log(`\n  WABA        ${cfg.wabaId}`);
  console.log(`  graph       ${cfg.graphVersion}`);
  console.log(`  on file     ${existing.length} template(s)\n`);

  // CATEGORY is shown because Meta DERIVES it from the content and it is not
  // always what we asked for. A template we submitted as UTILITY and Meta filed
  // as MARKETING is capped per user and never free — it fails with 131049 or
  // 131042 while every real UTILITY template on the same WABA delivers. That is
  // invisible unless you print it, which is why this column exists.
  const missing: typeof wanted = [];
  const miscategorised: Array<{ def: (typeof wanted)[number]; id: string; got: string }> = [];
  for (const def of wanted) {
    const row = rowFor(def.name, def.language);
    const flag = row && row.category && row.category !== def.category ? `  <- WANTED ${def.category}` : '';
    console.log(`  ${def.name.padEnd(32)} ${(row?.status ?? 'MISSING').padEnd(10)} ${row?.category ?? ''}${flag}`);
    if (!row) missing.push(def);
    else if (flag && row.id) miscategorised.push({ def, id: row.id, got: row.category! });
  }

  // A miscategorised template CANNOT be repaired here, and this must not pretend
  // otherwise. Meta fixes the category at approval: an edit carrying `category`
  // is rejected with subcode 3835031 ("You cannot update an approved template
  // category"), while the same edit without it returns 200 and leaves the
  // category exactly as it was. The only fix is a NEW template, under a new
  // name, whose wording earns the category.
  if (miscategorised.length) {
    console.log(`\n  ${miscategorised.length} filed under a category we did not ask for:`);
    for (const m of miscategorised) {
      console.log(`    ${m.def.name}: Meta says ${m.got}, we asked for ${m.def.category}`);
    }
    console.log('    A category cannot be changed after approval. Add a NEW template under a');
    console.log('    different name whose wording earns the category, and point the sender at');
    console.log('    it. MARKETING is capped per recipient (131049) and is never free');
    console.log('    (131042), so this is a delivery fault, not a label.');
  }

  if (!missing.length) {
    if (apply && miscategorised.length) {
      const after = await fetchTemplateStatuses(cfg, cfg.systemUserToken!, cfg.wabaId!);
      console.log('\n  Status now:');
      for (const def of wanted) {
        const row = after.find((t) => t.name === def.name && t.language === def.language);
        console.log(`  ${def.name.padEnd(32)} ${(row?.status ?? 'MISSING').padEnd(10)} ${row?.category ?? ''}`);
      }
    }
    console.log('\n  Nothing to create. A template that is not APPROVED will not deliver yet.\n');
    return;
  }

  console.log(`\n  ${missing.length} to create: ${missing.map((d) => d.name).join(', ')}`);
  if (!apply) {
    console.log('\n  Dry run. Re-run with --apply to create them.\n');
    return;
  }

  console.log('');
  const failed: Array<{ name: string; reason: string }> = [];
  for (const def of missing) {
    const reason = await createTemplate(cfg, cfg.systemUserToken, cfg.wabaId, def);
    console.log(`  ${reason ? 'FAILED ' : 'created'} ${def.name}${reason ? ` — ${reason}` : ''}`);
    if (reason) failed.push({ name: def.name, reason });
  }

  // Re-read rather than assume: creation succeeding says nothing about review,
  // and this is the number that decides whether a message actually arrives.
  const after = await fetchTemplateStatuses(cfg, cfg.systemUserToken, cfg.wabaId);
  console.log('\n  Status now:');
  for (const def of wanted) {
    const s = after.find((t) => t.name === def.name && t.language === def.language)?.status;
    console.log(`  ${def.name.padEnd(32)} ${s ?? 'MISSING'}`);
  }
  console.log('\n  Only APPROVED templates deliver. Utility review is usually minutes.\n');

  if (failed.length) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
