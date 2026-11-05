import { prisma } from '@/lib/db';
import { NativePatientProvider } from './native';
import { describePatient } from '@/lib/patients/age';
import { renderPrescription } from '@/lib/patients/prescription';
import type { PatientDataProvider, ProviderKind, VisitsResult, PatientVisit } from './types';

// Resolve which patient-data provider an organization is on.
//
// Mirrors getTelephonyProvider(): one factory, everything else depends on the
// interface. Adding the `rest` and `fhir` providers is a case arm here plus a
// file — no caller changes, because no caller knows which provider it has.

const CACHE_MS = 30_000;
const cache = new Map<string, { provider: PatientDataProvider; at: number }>();

function isKind(v: string | null | undefined): v is ProviderKind {
  return v === 'native' || v === 'push' || v === 'rest' || v === 'fhir';
}

export async function getPatientProvider(orgId: string): Promise<PatientDataProvider> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.provider;

  let kind: ProviderKind = 'native';
  let label: string | undefined;
  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { patientProvider: true, patientProviderConfig: true },
    });
    if (isKind(org?.patientProvider)) kind = org.patientProvider;
    const cfg = (org?.patientProviderConfig ?? {}) as Record<string, unknown>;
    if (typeof cfg.systemName === 'string' && cfg.systemName.trim()) label = cfg.systemName.trim();
  } catch (err) {
    // Falling back to native on a config read failure keeps the clinic working
    // in the mode that needs no external dependency.
    console.error('[patients] provider lookup failed, defaulting to native', err);
  }

  const provider = buildProvider(kind, label);
  cache.set(orgId, { provider, at: Date.now() });
  return provider;
}

function buildProvider(kind: ProviderKind, label?: string): PatientDataProvider {
  switch (kind) {
    case 'push':
      return new NativePatientProvider('push', label);
    case 'rest':
    case 'fhir':
      // Not built yet. Deliberately falls back to the mirrored store rather
      // than throwing: an org mis-set to a provider that doesn't exist should
      // degrade to showing whatever records it already has, not 500 on every
      // patient screen.
      console.warn(`[patients] provider "${kind}" is not implemented yet — using mirrored store`);
      return new NativePatientProvider('push', label);
    case 'native':
    default:
      return new NativePatientProvider('native', label);
  }
}

/** Test hook + used after an admin changes an org's provider. */
export function clearPatientProviderCache(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

function fmtDate(d: Date, tz = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/**
 * The patient's demographics, as a prompt block.
 *
 * Age and sex only — deliberately NOT the date of birth. Age carries all of the
 * clinical value (paediatric framing, whether a dose sounds plausible) and none
 * of the identity value, and this string is sent to a third-party model on every
 * single turn. The prompt already tells the model never to ask a patient to
 * confirm their date of birth; putting it in the same prompt would be careless.
 */
export function formatPatientBlock(
  patient: { dateOfBirth?: Date | string | null; sex?: string | null },
  now: Date = new Date(),
): string {
  const summary = describePatient(patient.dateOfBirth ?? null, patient.sex ?? null, now);
  if (!summary) return '';
  return `\n\nPatient: ${summary}.`;
}

/**
 * Render a patient's visits as the prompt block the chatbot answers from.
 *
 * Takes the whole VisitsResult rather than an array so the three outcomes stay
 * distinguishable all the way into the prompt. Telling the model "records are
 * temporarily unavailable" instead of "no records exist" is the difference
 * between the bot saying "I can't pull those up right now, please call the
 * clinic" and it assuring a patient they were never prescribed anything.
 */
export function formatRecordsBlock(result: VisitsResult, timezone?: string): string {
  if (result.status === 'unavailable') {
    return (
      '\n\nPatient record:\n(UNAVAILABLE — their records could not be retrieved right now. ' +
      'Tell the patient you cannot access their records at the moment and ask them to try shortly ' +
      'or contact the clinic. Do NOT say they have no records, and do not guess what was prescribed.)'
    );
  }
  if (result.status === 'empty') {
    return '\n\nPatient record:\n(No visit records have been filed for this patient yet.)';
  }
  const body = result.visits
    .map((v: PatientVisit) => {
      const lines = [
        `Visit on ${fmtDate(v.visitedAt, timezone)}${v.expertName ? ` with ${v.expertName}` : ''}${v.service ? ` — ${v.service}` : ''}`,
      ];
      if (v.diagnosis) lines.push(`  Diagnosis: ${v.diagnosis}`);
      // Redacting the diagnosis is NOT sufficient on its own. A visit showing a
      // prescription and no diagnosis invites the model to work backwards from
      // the drug — which is precisely the disclosure the doctor withheld.
      else if (v.diagnosisPending) {
        lines.push(
          '  Diagnosis: NOT YET RELEASED — the doctor is still reviewing it. If asked, say exactly that. ' +
            'Do NOT infer or guess a diagnosis from the medicines or the reason for the visit.',
        );
      }
      // One renderer, shared with the staff record and the patient portal, so
      // the medicines the chatbot reads out are the medicines on the screen.
      const rx = renderPrescription(v);
      if (rx.kind === 'items') {
        lines.push('  Prescription:');
        for (const line of rx.lines) lines.push(`    - ${line}`);
        // The structured lines already carry the schedule in words. Saying so
        // stops the model paraphrasing "twice a day (BD)" into something else.
        lines.push('    (Read these medicines back exactly as written. Do NOT change a dose, a schedule or a duration.)');
      } else if (rx.kind === 'text') {
        lines.push(`  Prescription: ${rx.text}`);
      }
      if (v.advice) lines.push(`  Advice: ${v.advice}`);
      if (v.followUpAt) lines.push(`  Follow-up due: ${fmtDate(v.followUpAt, timezone)}`);
      if (v.documents.length) {
        lines.push(
          `  Attached: ${v.documents.map((d) => d.name).join(', ')} (the patient can download these from the Records tab)`,
        );
      }
      return lines.join('\n');
    })
    .join('\n\n')
    .slice(0, 6000);
  return `\n\nPatient record:\n${body}`;
}

/** Convenience for UI code that just wants a list and treats failure as empty. */
export function visitsOrEmpty(result: VisitsResult): PatientVisit[] {
  return result.status === 'ok' ? result.visits : [];
}

export { NativePatientProvider, attachDocument, MAX_DOC_BYTES, MAX_DOCS_PER_VISIT, ALLOWED_DOC_TYPES } from './native';
export type * from './types';
export { renderPrescription, formatItem, dosesPerDay, parseRxItems } from './prescription';
export type { RxItemLike, RxRendered } from './prescription';
