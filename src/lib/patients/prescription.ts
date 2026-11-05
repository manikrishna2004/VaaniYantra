import { z } from 'zod';
import { rxFrequency, rxRoute, RX_FREQUENCIES, RX_ROUTES } from '@/lib/constants';

/**
 * The one place a prescription turns into words.
 *
 * Used by the staff record (PatientDetail), the patient portal (PatientPortal)
 * and the chatbot's context (formatRecordsBlock). Three surfaces, one renderer,
 * because a medicine list that reads differently depending on where you look at
 * it is worse than no list at all.
 *
 * Dependency-free apart from constants, so client components can import it.
 */

/** The subset of PrescriptionItem this module needs. Structural, not Prisma. */
export type RxItemLike = {
  drug: string;
  strength?: string | null;
  dose?: string | null;
  frequency?: string | null;
  durationDays?: number | null;
  route?: string | null;
  instructions?: string | null;
};

export type RxInput = {
  items?: RxItemLike[] | null;
  prescription?: string | null;
};

export type RxRendered =
  | { kind: 'none' }
  /** Structured lines. `text` is the whole script, one medicine per line. */
  | { kind: 'items'; items: RxItemLike[]; lines: string[]; text: string }
  /** Legacy or push-sourced free text, shown verbatim. */
  | { kind: 'text'; text: string };

/**
 * THE RULE: a visit renders its items if it has any, otherwise the free text.
 * Never both.
 *
 * A visit can legitimately hold both — an integrated clinic pushes structured
 * items alongside the prose blob its own system prints, and a visit written
 * before this feature shipped and edited after it will have picked up items.
 * Showing the two together produces a prescription that says two things, and a
 * patient reading "Amoxicillin 500 mg twice a day" above "amox 500 TDS" has to
 * guess. Guessing about a dose is exactly the harm this whole module exists to
 * remove, so the structured version — the one we can validate and count — wins
 * outright, everywhere, including in the chatbot's context.
 */
export function renderPrescription(input: RxInput): RxRendered {
  const items = (input.items ?? []).filter((i) => i.drug?.trim());
  if (items.length > 0) {
    const lines = items.map(formatItem);
    return { kind: 'items', items, lines, text: lines.join('\n') };
  }
  const text = input.prescription?.trim();
  return text ? { kind: 'text', text } : { kind: 'none' };
}

/**
 * One medicine, as a sentence a patient can act on.
 *
 * Expands the abbreviation AND keeps it: the patient does not know what "BD"
 * means, the model must not guess, and the doctor wants to see the notation
 * they typed. So "BD" becomes "twice a day (BD)" — both readings, no ambiguity.
 */
export function formatItem(item: RxItemLike): string {
  const head = [item.drug.trim(), item.strength?.trim()].filter(Boolean).join(' ');

  const parts: string[] = [];
  if (item.dose?.trim()) parts.push(item.dose.trim());

  const freq = rxFrequency(item.frequency);
  if (freq) {
    // `abbr` is null for the entries that are already English ("once a week"),
    // so the echo never degrades into "once a week (WEEKLY)".
    parts.push(freq.abbr ? `${freq.patient} (${freq.abbr})` : freq.patient);
  }

  const route = rxRoute(item.route);
  if (route?.patient) parts.push(route.patient);

  if (item.durationDays && item.durationDays > 0) {
    parts.push(`for ${item.durationDays} ${item.durationDays === 1 ? 'day' : 'days'}`);
  }
  if (item.instructions?.trim()) parts.push(item.instructions.trim());

  const detail = parts.join(', ');
  return detail ? `${head} — ${detail}` : head;
}

/**
 * How many doses of this medicine are due in a day, or null when the question
 * has no numeric answer (as-needed, one-off, weekly).
 *
 * Exists so the chatbot answers "how many tablets today?" by lookup. Left to
 * the model, that question becomes arithmetic on prose — and a model that
 * miscounts a dose is the failure mode this feature was built to prevent.
 */
export function dosesPerDay(item: RxItemLike): number | null {
  return rxFrequency(item.frequency)?.perDay ?? null;
}

/** Valid values, for zod enums and `<select>` options. */
export const RX_FREQUENCY_VALUES = RX_FREQUENCIES.map((f) => f.value);
export const RX_ROUTE_VALUES = RX_ROUTES.map((r) => r.value);

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * The one gate every write path goes through: the staff form, the v1 push API,
 * and the visit PATCH. A drug line that reaches the database unvalidated is a
 * drug line the chatbot will read out to a patient.
 *
 * Deliberately lenient about *missing* fields and strict about *wrong* ones. A
 * doctor who types only "Amoxicillin" gets a saved line; a client that sends
 * `frequency: "twice"` gets an error rather than a silently dropped instruction
 * that leaves the patient with a medicine and no schedule.
 */
const rxItemSchema = z.object({
  drug: z.string().trim().min(1, 'Every medicine needs a name.').max(200),
  strength: z.string().trim().max(100).nullish(),
  dose: z.string().trim().max(100).nullish(),
  frequency: z.enum(RX_FREQUENCY_VALUES as [string, ...string[]]).nullish(),
  // 365 is not a clinical limit — it is a typo guard. "for 3000 days" is a
  // slipped keystroke, and a prescription is not the place to accept one.
  durationDays: z.coerce.number().int().positive().max(365).nullish(),
  route: z.enum(RX_ROUTE_VALUES as [string, ...string[]]).nullish(),
  instructions: z.string().trim().max(500).nullish(),
});

/** Hard cap. A real script is under ten lines; a thousand is a bad request. */
export const MAX_RX_ITEMS = 30;

export type ParsedRxItems = { items: RxItemLike[] } | { error: string };

/**
 * Parse the `prescriptionItems` JSON blob a client sends.
 *
 * Returns `{ items: [] }` for an explicit empty array — meaning "clear the
 * medicines" — which callers MUST keep distinct from not sending the field at
 * all. See the note on `VisitInput.items`.
 */
export function parseRxItems(raw: unknown): ParsedRxItems {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { items: [] };
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { error: 'Could not read the medicine list.' };
    }
  }
  if (!Array.isArray(value)) return { error: 'The medicine list must be a list.' };
  if (value.length > MAX_RX_ITEMS) return { error: `A prescription can hold at most ${MAX_RX_ITEMS} medicines.` };

  const items: RxItemLike[] = [];
  for (const entry of value) {
    // A wholly blank row is what an untouched "add medicine" row looks like in
    // the UI. Dropping it is right; erroring on it would make the form feel
    // broken for doing nothing.
    if (isBlankRow(entry)) continue;
    const parsed = rxItemSchema.safeParse(entry);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'That medicine line is not valid.' };
    }
    const p = parsed.data;
    items.push({
      drug: p.drug,
      strength: p.strength || null,
      dose: p.dose || null,
      frequency: p.frequency || null,
      durationDays: p.durationDays ?? null,
      route: p.route || null,
      instructions: p.instructions || null,
    });
  }
  return { items };
}

function isBlankRow(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return true;
  return Object.values(entry as Record<string, unknown>).every(
    (v) => v == null || (typeof v === 'string' && !v.trim()),
  );
}
