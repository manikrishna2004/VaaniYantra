/**
 * Copy an agent — with its knowledge base — into another organisation.
 *
 *   npx tsx scripts/clone-agent.ts --list
 *   npx tsx scripts/clone-agent.ts --agent-id=cmt… --to-org=<id|slug>
 *   npx tsx scripts/clone-agent.ts --agent-id=cmt… --to-org=<id|slug> --apply
 *
 * Dry run by default, like the other operator scripts. Run it with --list (or
 * with nothing) first: it prints every organisation, its workspaces and its
 * agents, which is the only reliable way to pick the two ids this needs.
 *
 * PASS --agent-id. Names are not unique and are not a safe handle — there are
 * two agents called "Ramya" in production, one of them a LIVE healthcare line
 * (see the note in seed-pare-demo.ts). --name is offered only as a FILTER for
 * --list, never as a way to choose what gets copied.
 *
 * WHAT IS COPIED
 *   - every column on the agent except id / workspaceId / userId / timestamps,
 *     picked up by spread rather than a hand-written list so a column added to
 *     the schema later comes along on its own.
 *   - each knowledge Document the agent is linked to, AND its DocumentChunks
 *     with their embeddings. Documents are workspace-scoped, so an agent moved
 *     across organisations without them can answer nothing. Copying the stored
 *     embeddings rather than re-ingesting means no Gemini key is needed and no
 *     embedding calls are billed — the vectors are identical either way.
 *
 * WHAT IS NOT COPIED, deliberately
 *   - PHONE NUMBERS. PhoneNumber.e164 is globally unique and a number belongs to
 *     one workspace and one provider account, so a number cannot exist twice.
 *     THE CLONE ANSWERS NOTHING UNTIL A NUMBER IS ASSIGNED TO IT on /numbers.
 *     The source agent keeps its line and is never touched by this script.
 *   - calls, outcomes and monthly sheets: history belongs to the org that made it.
 *   - portals, which carry their own tokens and per-org branding.
 *
 * geminiApiKey is copied AS CIPHERTEXT, which is correct only because both orgs
 * live in the same deployment and share SECRET_ENC_KEY — the clone then bills
 * the same BYO key as the original. Pass --drop-gemini-key to fall back to the
 * org integration / platform key instead.
 *
 *   --agent-id=cmt…      the agent to copy (see /agents, or the URL)
 *   --to-org=…           destination org: id, slug, or exact name
 *   --to-workspace=…     destination workspace id, when the org has several
 *   --as-email=…         creator attribution; defaults to the org's OWNER
 *   --name="…"           rename the copy (default: the source name)
 *   --drop-gemini-key    do not copy the agent's own Gemini key
 *   --overwrite          update an existing same-named agent instead of refusing
 *   --list               print orgs / workspaces / agents and exit
 */
import { prisma } from '@/lib/db';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^["']|["']$/g, '') : undefined;
}

// Omitting a null column is the same as writing null, and it sidesteps Prisma's
// Json null handling (a Json? field rejects a bare null and wants DbNull). This
// is why the copy is built by stripping rather than by listing columns.
function withoutNulls(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
}

async function printInventory(nameFilter?: string) {
  const orgs = await prisma.organization.findMany({
    orderBy: { name: 'asc' },
    include: {
      workspaces: {
        orderBy: { name: 'asc' },
        include: {
          agents: {
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              agentType: true,
              status: true,
              phoneNumbers: { select: { e164: true } },
            },
          },
        },
      },
    },
  });
  console.log('');
  for (const org of orgs) {
    console.log(`  ${org.name}  [${org.slug}]  ${org.id}  (${org.status}, plan ${org.plan})`);
    for (const ws of org.workspaces) {
      console.log(`    workspace  ${ws.name}  ${ws.id}`);
      const agents = nameFilter
        ? ws.agents.filter((a) => a.name.toLowerCase().includes(nameFilter.toLowerCase()))
        : ws.agents;
      if (!agents.length) console.log('      (no agents)');
      for (const a of agents) {
        const lines = a.phoneNumbers.map((n) => n.e164).join(', ') || 'no number';
        console.log(`      agent  ${a.name}  ${a.id}  (${a.agentType}, ${a.status}, ${lines})`);
      }
    }
  }
  console.log('');
}

async function main() {
  const agentId = arg('agent-id');
  const toOrgRef = arg('to-org');
  const toWorkspaceId = arg('to-workspace');
  const asEmail = arg('as-email');
  const newName = arg('name');
  const dropGeminiKey = process.argv.includes('--drop-gemini-key');
  const overwrite = process.argv.includes('--overwrite');
  const apply = process.argv.includes('--apply');
  const listOnly = process.argv.includes('--list');

  if (listOnly || !agentId || !toOrgRef) {
    if (!listOnly) {
      console.error(
        '\nUsage: npx tsx scripts/clone-agent.ts --agent-id=<id> --to-org=<id|slug|name> ' +
          '[--to-workspace=<id>] [--as-email=…] [--name="…"] [--drop-gemini-key] [--overwrite] [--apply]' +
          '\n\nEverything currently in the database:',
      );
    }
    await printInventory(arg('name'));
    if (!listOnly) process.exit(1);
    return;
  }

  // The source is looked up by id alone — it is globally unique, and requiring
  // the operator to also name the source org would just be another thing to get
  // wrong. What it belongs to is printed below, so a mistyped id is obvious.
  const source = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      workspace: { include: { org: { select: { id: true, name: true, slug: true } } } },
      phoneNumbers: { select: { e164: true } },
      knowledgeLinks: { include: { document: { include: { chunks: true } } } },
    },
  });
  if (!source) {
    console.error(`No agent ${agentId}. Run with --list to see what exists.`);
    process.exit(1);
    return;
  }

  const org = await prisma.organization.findFirst({
    where: { OR: [{ id: toOrgRef }, { slug: toOrgRef }, { name: toOrgRef }] },
    include: {
      workspaces: { orderBy: { createdAt: 'asc' } },
      memberships: { include: { user: true } },
    },
  });
  if (!org) {
    console.error(`No organisation matching "${toOrgRef}" by id, slug or name. Run with --list.`);
    process.exit(1);
    return;
  }
  if (org.id === source.workspace.orgId) {
    console.error(
      `${org.name} is the agent's OWN organisation — this script copies BETWEEN orgs. ` +
        'Duplicating inside one workspace would collide on the agent name.',
    );
    process.exit(1);
    return;
  }

  const target = toWorkspaceId
    ? org.workspaces.find((w) => w.id === toWorkspaceId)
    : org.workspaces[0];
  if (!target) {
    console.error(
      toWorkspaceId
        ? `Workspace ${toWorkspaceId} is not in ${org.name}.`
        : `${org.name} has no workspace. Open the app once as a member of it.`,
    );
    process.exit(1);
    return;
  }
  if (!toWorkspaceId && org.workspaces.length > 1) {
    console.error(
      `${org.name} has ${org.workspaces.length} workspaces — pass --to-workspace=<id> rather than ` +
        'letting this land on whichever was created first:',
    );
    for (const w of org.workspaces) console.error(`    ${w.name}  ${w.id}`);
    process.exit(1);
    return;
  }

  // Attribution only (Agent.userId is SetNull on delete), but a copy credited to
  // nobody is confusing in the UI, so prefer a real member of the target org.
  const creator = asEmail
    ? org.memberships.find((m) => m.user.email === asEmail.toLowerCase())
    : org.memberships.find((m) => m.role === 'OWNER') ??
      org.memberships.find((m) => m.role === 'ADMIN') ??
      org.memberships[0];
  if (asEmail && !creator) {
    console.error(`${asEmail} is not a member of ${org.name}. Members:`);
    for (const m of org.memberships) console.error(`    ${m.user.email}  (${m.role})`);
    process.exit(1);
    return;
  }

  const name = newName || source.name;
  const clash = await prisma.agent.findFirst({ where: { workspaceId: target.id, name } });
  if (clash && !overwrite) {
    console.error(
      `\n  ${org.name} already has an agent called "${name}" (${clash.id}).\n` +
        '  Re-run with --overwrite to update that row in place, or --name="…" to copy alongside it.\n',
    );
    process.exit(1);
    return;
  }

  // Documents are per-workspace, so each one has to be recreated on the far
  // side. A same-named document already there is REUSED rather than copied
  // again, which is what makes a second --apply run harmless.
  const existingDocs = await prisma.document.findMany({
    where: {
      workspaceId: target.id,
      name: { in: source.knowledgeLinks.map((l) => l.document.name) },
    },
    select: { id: true, name: true },
  });
  const reused = new Map(existingDocs.map((d) => [d.name, d.id]));

  console.log(`\n  from        ${source.workspace.org.name} / ${source.workspace.name}`);
  console.log(`  agent       ${source.name} (${source.id}, ${source.agentType}, ${source.status})`);
  console.log(
    `  its number  ${
      source.phoneNumbers.map((n) => n.e164).join(', ') || 'none'
    }  — NOT copied, stays here`,
  );
  console.log(`  to          ${org.name} / ${target.name} (${target.id})`);
  console.log(`  as          ${name}${clash ? `  — OVERWRITING ${clash.id}` : ' (new agent)'}`);
  console.log(`  creator     ${creator?.user.email ?? 'unattributed'}`);
  console.log(
    `  gemini key  ${
      source.geminiApiKey
        ? dropGeminiKey
          ? 'dropped — falls back to org/platform key'
          : 'copied (clone bills the same key)'
        : 'none on the source'
    }`,
  );
  for (const link of source.knowledgeLinks) {
    const d = link.document;
    console.log(
      `  document    ${d.name}  (${d.chunks.length} chunks)  ${
        reused.has(d.name) ? '— already in the target workspace, will reuse' : '— will copy'
      }`,
    );
  }
  if (!source.knowledgeLinks.length) console.log('  document    none linked');

  if (!apply) {
    console.log('\n  Dry run. Re-run with --apply to write.\n');
    return;
  }

  const columns: Record<string, unknown> = { ...source };
  // Identity, ownership and timestamps belong to the new row, not the old one.
  for (const k of ['id', 'workspaceId', 'userId', 'createdAt', 'updatedAt']) delete columns[k];
  // The `include` relations come back on `source` too; they are not columns.
  for (const k of ['workspace', 'phoneNumbers', 'knowledgeLinks']) delete columns[k];
  const data = {
    ...withoutNulls(columns),
    name,
    ...(dropGeminiKey ? { geminiApiKey: null } : {}),
  };

  const agent = clash
    ? await prisma.agent.update({ where: { id: clash.id }, data })
    : await prisma.agent.create({
        data: { ...data, workspaceId: target.id, userId: creator?.userId ?? null } as never,
      });
  console.log(`\n  ${clash ? 'updated' : 'created'} agent ${agent.id}`);

  for (const link of source.knowledgeLinks) {
    const d = link.document;
    let docId = reused.get(d.name);
    if (!docId) {
      const copy = await prisma.document.create({
        data: {
          workspaceId: target.id,
          userId: creator?.userId ?? null,
          name: d.name,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          status: d.status,
          sourceType: d.sourceType,
          ...withoutNulls({ sourceUrl: d.sourceUrl, faqItems: d.faqItems, rawText: d.rawText }),
        },
      });
      // Embeddings are carried over verbatim: same text, same model, so
      // re-embedding would spend a Gemini call to arrive at the same vector.
      if (d.chunks.length) {
        await prisma.documentChunk.createMany({
          data: d.chunks.map((c) => ({
            documentId: copy.id,
            index: c.index,
            content: c.content,
            embedding: c.embedding,
          })),
        });
      }
      docId = copy.id;
      console.log(`  copied document ${d.name} -> ${docId} (${d.chunks.length} chunks)`);
    } else {
      console.log(`  reused document ${d.name} -> ${docId}`);
    }
    await prisma.agentKnowledge.upsert({
      where: { agentId_documentId: { agentId: agent.id, documentId: docId } },
      create: { agentId: agent.id, documentId: docId },
      update: {},
    });
  }

  console.log(`\n  Done. Open /agents/${agent.id} to edit it.`);
  console.log('  It has NO phone number yet — assign one on /numbers before it can take a call.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
