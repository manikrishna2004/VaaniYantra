/**
 * One-off backfill: turn free-text experts into real Doctor records.
 *
 *   npx tsx scripts/backfill-doctors.ts                       # dry run
 *   npx tsx scripts/backfill-doctors.ts --apply               # write
 *   npx tsx scripts/backfill-doctors.ts --apply \
 *     --assign-shared-to <userId>                             # + repoint shared cal
 *
 * Doctors used to exist only as `{name}` entries inside
 * `Agent.bookingConfig.experts`, matched at booking time by case-insensitive
 * substring. Appointments recorded the matched name in `expertName` and nothing
 * else, so there is no id to migrate from — only names.
 *
 * Safe to re-run: every step is keyed on something stable and skips work already
 * done. The dry run touches nothing and prints exactly what --apply would do.
 *
 * ── The shared calendar ────────────────────────────────────────────────────
 * `Integration.userId = ""` is the clinic-wide "universal" connection. Every
 * existing appointment was booked on it, and each carries a `calendarEventId`
 * that only that connection's token can reach. Retiring the sentinel without
 * repointing those rows would strand every one of them: cancel and reschedule
 * would silently stop touching the real calendar while still reporting success.
 *
 * This script therefore REPORTS whose Google account the shared connection is,
 * and only moves it when you name the user to move it to. It cannot work that
 * out on its own — the account email is inside an encrypted blob, and which
 * human it belongs to is a judgement only the clinic can make.
 */
import { PrismaClient } from '@prisma/client';
import { decryptSecret } from '../src/lib/crypto';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
// Read-only audit: after --apply, prove that every name the agents can still
// name has a Doctor row. Run this until it reports zero gaps for every org
// BEFORE deploying the rewire — after it, the config list is no longer read and
// a missing row means the agent silently cannot offer that person.
const VERIFY = process.argv.includes('--verify');
const SHARED_TO = (() => {
  const i = process.argv.indexOf('--assign-shared-to');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const SHARED = '';

function norm(name: string): string {
  return name.trim().toLowerCase();
}

async function main() {
  console.log(APPLY ? '▶ applying' : '▶ dry run (pass --apply to write)');

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });

  for (const org of orgs) {
    const agents = await prisma.agent.findMany({
      where: { workspace: { orgId: org.id } },
      select: { id: true, workspaceId: true, bookingConfig: true },
    });
    const appts = await prisma.appointment.findMany({
      where: { orgId: org.id },
      select: { id: true, expertName: true, doctorId: true, calendarUserId: true },
    });

    // Names from two places. The appointment side matters as much as the config
    // side: production holds appointments for "Dr Raani" and "Dr Manikanta",
    // neither of whom appears in any agent's expert list any more. Skipping them
    // would leave those bookings attached to nobody.
    const fromConfig = new Map<
      string,
      { name: string; userId: string | null; calendarId: string | null; workspaceId: string }
    >();
    for (const a of agents) {
      const cfg = (a.bookingConfig ?? {}) as { experts?: unknown };
      for (const e of Array.isArray(cfg.experts) ? cfg.experts : []) {
        const o = (e ?? {}) as { name?: unknown; userId?: unknown; calendarId?: unknown };
        const name = typeof o.name === 'string' ? o.name.trim() : '';
        if (!name) continue;
        fromConfig.set(norm(name), {
          name,
          userId: typeof o.userId === 'string' && o.userId.trim() ? o.userId.trim() : null,
          // Carried across deliberately. An expert could own a NAMED CALENDAR
          // inside the clinic's single shared Google account, and Doctor had no
          // column for it — so without this, a clinic running one calendar per
          // doctor in one Google account silently loses per-doctor routing on
          // the day the rewire ships, and every booking piles onto the default.
          calendarId: typeof o.calendarId === 'string' && o.calendarId.trim() ? o.calendarId.trim() : null,
          workspaceId: a.workspaceId,
        });
      }
    }
    const fromAppointments = new Set(
      appts.map((a) => a.expertName?.trim()).filter((n): n is string => Boolean(n)).map(norm),
    );

    const allNames = new Set([...fromConfig.keys(), ...fromAppointments]);
    if (allNames.size === 0 && !appts.length) continue;

    console.log(`\n── ${org.name} (${org.id})`);

    const existing = await prisma.doctor.findMany({ where: { orgId: org.id }, select: { id: true, displayName: true } });
    const byName = new Map(existing.map((d) => [norm(d.displayName), d.id]));

    const anyWorkspace =
      agents[0]?.workspaceId ??
      (await prisma.workspace.findFirst({ where: { orgId: org.id }, select: { id: true } }))?.id;
    if (!anyWorkspace) {
      console.log('  ! no workspace — skipping');
      continue;
    }

    // 1-2. A Doctor per distinct name.
    for (const key of allNames) {
      if (byName.has(key)) continue;
      const cfg = fromConfig.get(key);
      const displayName =
        cfg?.name ?? appts.find((a) => a.expertName && norm(a.expertName) === key)!.expertName!.trim();
      console.log(`  ${APPLY ? 'creating' : 'would create'} doctor "${displayName}"${cfg?.userId ? ' (linked)' : ''}`);
      if (APPLY) {
        const created = await prisma.doctor.create({
          data: {
            orgId: org.id,
            workspaceId: cfg?.workspaceId ?? anyWorkspace,
            displayName,
            userId: cfg?.userId ?? null,
            calendarId: cfg?.calendarId ?? null,
            // These people were already being offered to callers. Migrating
            // them as anything other than bookable would take the clinic's
            // doctors off the phone the moment this ships.
            bookable: true,
          },
        });
        byName.set(key, created.id);
      } else {
        // A placeholder id so the linking pass below reports what --apply WOULD
        // do. Without it a dry run says "0 linked, 17 unmatched" — the exact
        // opposite of the truth, and precisely the output that would talk an
        // operator out of running the migration that fixes it.
        byName.set(key, `dry-run:${key}`);
      }
    }

    // Verify mode stops here: it reports the gap and changes nothing.
    if (VERIFY) {
      const live = await prisma.doctor.findMany({
        where: { orgId: org.id },
        select: { displayName: true, bookable: true, specialisation: true },
      });
      const have = new Set(live.map((d) => norm(d.displayName)));
      const missing = [...fromConfig.values()].filter((c) => !have.has(norm(c.name)));
      const unspecialised = live.filter((d) => d.bookable && !d.specialisation);
      console.log(`  doctors: ${live.length}, config names: ${fromConfig.size}`);
      if (missing.length) {
        console.log(`  ! MISSING ${missing.length}: ${missing.map((m) => m.name).join(', ')}`);
      } else {
        console.log('  ok — every configured name has a doctor row');
      }
      if (unspecialised.length) {
        // Not a failure. They book exactly as before; a caller just cannot yet
        // ask for them by trade until each fills in a specialisation.
        console.log(`  note: ${unspecialised.length} bookable doctor(s) have no specialisation set`);
      }
      continue;
    }

    // 3. Attach appointments by name.
    let linked = 0;
    let unmatched = 0;
    for (const a of appts) {
      if (a.doctorId) continue;
      const key = a.expertName ? norm(a.expertName) : '';
      const doctorId = key ? byName.get(key) : undefined;
      if (!doctorId) {
        // A booking with no doctor named is normal ("any doctor"); it stays
        // unattributed rather than being guessed into someone's calendar.
        if (key) unmatched++;
        continue;
      }
      linked++;
      if (APPLY) await prisma.appointment.update({ where: { id: a.id }, data: { doctorId } });
    }
    console.log(`  ${APPLY ? 'linked' : 'would link'} ${linked} appointment(s) to a doctor`);
    if (unmatched) console.log(`  ! ${unmatched} appointment(s) name a doctor that could not be created`);

    // 4. Report the shared connection.
    const shared = await prisma.integration.findUnique({
      where: { orgId_provider_userId: { orgId: org.id, provider: 'googleCalendar', userId: SHARED } },
    });
    if (shared) {
      let email = '(could not decrypt)';
      try {
        email = (JSON.parse(decryptSecret(shared.secret)) as { email?: string }).email ?? '(no email stored)';
      } catch {
        /* a rotated SECRET_ENC_KEY looks exactly like this; say so rather than guess */
      }
      const onShared = appts.filter((a) => !a.calendarUserId).length;
      console.log(`  shared calendar belongs to: ${email}`);
      console.log(`  ${onShared} appointment(s) still point at it`);

      // 5. Repoint it, only when told who to.
      if (SHARED_TO) {
        const member = await prisma.membership.findUnique({
          where: { userId_orgId: { userId: SHARED_TO, orgId: org.id } },
        });
        const existingOwn = await prisma.integration.findUnique({
          where: { orgId_provider_userId: { orgId: org.id, provider: 'googleCalendar', userId: SHARED_TO } },
        });
        if (!member) {
          console.log(`  ! ${SHARED_TO} is not a member here — not repointing`);
        } else if (existingOwn) {
          // They already have their own connection. That is fine ONLY when it is
          // the same Google account — then the shared row is redundant, the
          // events stay reachable through the personal token, and each
          // appointment keeps its own stored calendarId so it still resolves to
          // the right calendar inside that account.
          //
          // A different account would be a silent disaster: the appointments
          // would point at a token that cannot see their events, and every
          // later cancel or reschedule would no-op while reporting success.
          let ownEmail = '(could not decrypt)';
          try {
            ownEmail = (JSON.parse(decryptSecret(existingOwn.secret)) as { email?: string }).email ?? '';
          } catch {
            /* fall through to the refusal below */
          }
          if (ownEmail && ownEmail === email) {
            console.log(`  ${SHARED_TO} already connects the SAME account (${ownEmail})`);
            console.log(`  ${APPLY ? 'Repointing' : 'Would repoint'} appointments and retire the shared row`);
            if (APPLY) {
              const res = await prisma.appointment.updateMany({
                where: { orgId: org.id, OR: [{ calendarUserId: null }, { calendarUserId: SHARED }] },
                data: { calendarUserId: SHARED_TO },
              });
              await prisma.integration.update({ where: { id: shared.id }, data: { enabled: false } });
              console.log(`  repointed ${res.count} appointment(s); shared connection disabled`);
            }
          } else {
            console.log(`  ! ${SHARED_TO} connects a DIFFERENT account (${ownEmail || 'unknown'}) than the shared one (${email})`);
            console.log('  ! not repointing — their token could not reach these events. Resolve by hand.');
          }
        } else {
          console.log(`  ${APPLY ? 'repointing' : 'would repoint'} the shared connection to ${SHARED_TO}`);
          if (APPLY) {
            await prisma.integration.update({ where: { id: shared.id }, data: { userId: SHARED_TO } });
            const res = await prisma.appointment.updateMany({
              where: { orgId: org.id, OR: [{ calendarUserId: null }, { calendarUserId: SHARED }] },
              data: { calendarUserId: SHARED_TO },
            });
            console.log(`  repointed ${res.count} appointment(s)`);
          }
        }
      } else {
        console.log('  (pass --assign-shared-to <userId> to move it to a real account)');
      }
    }
  }

  console.log(APPLY ? '\n✔ done' : '\n✔ dry run complete — re-run with --apply to write');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
