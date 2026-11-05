'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ArrowLeft, ArrowRight, AlertCircle } from 'lucide-react';
import { Button, Card, Field, Input, Select, Textarea, Spinner } from '@/components/ui';
import { WeeklyHours } from '@/components/WeeklyHours';
import { VoicePreview } from '@/components/VoicePreview';
import {
  LANGUAGES,
  AGENT_DIRECTIONS,
  DEFAULT_SYSTEM_PROMPT,
  defaultVoiceFor,
  LANGUAGE_MODES,
  GEMINI_VOICES,
  AGENT_TYPES,
  SELECTABLE_AGENT_TYPES,
  selectableAgentTypesFor,
  VERTICAL_TEMPLATES,
  type AgentVertical,
  type OutcomePreset,
} from '@/lib/constants';
import {
  defaultBusinessHours,
  type BusinessHours,
  type AgentVariable,
} from '@/lib/agent-behavior';

type DocOption = { id: string; name: string };
// A teammate a doctor can be linked to, and whether they have connected their
// own Google Calendar yet.

// The practice-type values that map to a template. Anything else (legacy
// "general", or an unset value) is treated as "not chosen yet" in the picker.
const VERTICAL_VALUES = new Set<string>(AGENT_TYPES.map((t) => t.value));

export type AgentFormValues = {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  greeting: string;
  language: string;
  voice: string;
  languageMode: 'single' | 'hybrid' | 'auto' | 'multi';
  geminiVoice: string;
  // Derived from the catalogue rather than re-listed, so the two can't drift.
  agentType: '' | AgentVertical;
  industryLabel: string;
  endCallInstructions: string;
  recordingDisclosure: boolean;
  direction: 'INBOUND' | 'OUTBOUND' | 'BOTH';
  status: 'ACTIVE' | 'PAUSED';
  maxCallSeconds: number;
  temperature: number;
  documentIds: string[];
  // Bring-your-own Gemini key (demo accounts only). Write-only: the saved key
  // is never sent back to the browser, so '' here means "leave it alone".
  geminiApiKey: string;
  businessHours: BusinessHours;
  afterHoursMessage: string;
  fallbackMessage: string;
  transferEnabled: boolean;
  transferNumber: string;
  transferMessage: string;
  transferTriggers: string;
  variables: AgentVariable[];
  bookingConfig: {
    enabled: boolean;
    timezone: string;
    serviceName: string;
    serviceDurationMin: number;
    lookaheadDays: number;
    dailyStart: number;
    dailyEnd: number;
    multiPerSlot: boolean;
    slotCapacity: number;
    businessName: string;
  };
  // ── Outcome engine: what to capture + how leads/orders reach owner & caller.
  outcomeConfig: {
    type: string;
    captures: { key: string; label: string; required: boolean }[];
    callerTemplate: string;
    ownerTemplate: string;
    ownerNumbers: string; // comma/newline separated in the UI; split to array on save
    deliver: { whatsapp: boolean; inApp: boolean };
  };
};

// Map a vertical's outcome preset into the editable form shape.
function outcomeFromPreset(o: OutcomePreset): AgentFormValues['outcomeConfig'] {
  return {
    type: o.type,
    captures: o.captures.map((c) => ({ key: c.key, label: c.label, required: !!c.required })),
    callerTemplate: o.callerTemplate,
    ownerTemplate: o.ownerTemplate,
    ownerNumbers: '',
    deliver: { whatsapp: true, inApp: true },
  };
}

const DEFAULTS: AgentFormValues = {
  name: '',
  description: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  greeting: 'Hello! Thank you for calling. How can I help you today?',
  language: 'en-IN',
  voice: 'en-IN-Neural2-A',
  languageMode: 'single',
  geminiVoice: 'Aoede',
  agentType: '',
  industryLabel: '',
  endCallInstructions: '',
  recordingDisclosure: false,
  direction: 'BOTH',
  status: 'ACTIVE',
  maxCallSeconds: 600,
  temperature: 0.6,
  documentIds: [],
  geminiApiKey: '',
  businessHours: defaultBusinessHours(),
  afterHoursMessage: "Sorry, you've reached us outside our business hours. Please call back during working hours.",
  fallbackMessage: '',
  transferEnabled: false,
  transferNumber: '',
  transferMessage: 'Sure, let me connect you to a team member. Please hold.',
  transferTriggers: '',
  variables: [],
  bookingConfig: {
    enabled: false,
    timezone: 'Asia/Kolkata',
    serviceName: 'appointment',
    serviceDurationMin: 30,
    lookaheadDays: 14,
    dailyStart: 9,
    dailyEnd: 18,
    multiPerSlot: false,
    slotCapacity: 4,
    businessName: '',
  },
  outcomeConfig: outcomeFromPreset(VERTICAL_TEMPLATES.other.outcome),
};

// Every greeting/prompt a practice-type template can put in the box. Text that
// matches one of these was written by us, so re-seeding over it loses nothing;
// anything else is the user's own and is preserved when they switch type.
const TEMPLATE_GREETINGS = new Set(Object.values(VERTICAL_TEMPLATES).map((t) => t.greeting));
const TEMPLATE_PROMPTS = new Set(Object.values(VERTICAL_TEMPLATES).map((t) => t.promptSeed));

/** True when this text is the user's own writing rather than a seeded default. */
function isOwnText(value: string, seeds: Set<string>): boolean {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 && !seeds.has(value) && !seeds.has(trimmed);
}

const STEPS = [
  { key: 'basics', label: 'Basics', desc: 'Name your agent and tell it what to do on calls.' },
  { key: 'voice', label: 'Voice & Language', desc: 'Pick how the agent sounds and which languages it speaks.' },
  { key: 'booking', label: 'Bookings', desc: 'Optional: let the agent book real appointments. Skip if you don’t take bookings.' },
  { key: 'outcomes', label: 'Messages & Alerts', desc: 'Optional: the texts callers get and how new leads reach you. Good defaults are already filled in.' },
  { key: 'advanced', label: 'Advanced', desc: 'Optional: knowledge documents, business hours, human transfer, and variables.' },
] as const;

export function AgentForm({
  initial,
  whatsappEnabled = false,
  demoVerticals = false,
  hasGeminiKey = false,
}: {
  initial?: Partial<AgentFormValues>;
  // Feature flag passed from the server; while false, WhatsApp never appears as
  // a channel option and every message goes by SMS.
  whatsappEnabled?: boolean;
  // This account may pick the demo practice types (real estate) and give an
  // agent its own Gemini key. Off for every ordinary customer.
  demoVerticals?: boolean;
  // Whether the agent being edited already has its own key stored. The key
  // itself never reaches the browser — only this flag does.
  hasGeminiKey?: boolean;
}) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<AgentFormValues>(() => {
    const merged = { ...DEFAULTS, ...initial };
    // Agents created before these fields existed arrive with null — normalize.
    const bh = initial?.businessHours;
    merged.businessHours =
      bh && typeof bh === 'object' && Array.isArray((bh as BusinessHours).days)
        ? (bh as BusinessHours)
        : defaultBusinessHours();
    merged.variables = Array.isArray(initial?.variables) ? (initial!.variables as AgentVariable[]) : [];
    merged.geminiVoice = (initial?.geminiVoice as string) || 'Aoede';
    // Write-only: an existing key is shown as a "saved" badge, never as text.
    merged.geminiApiKey = '';
    // Only keep a real vertical; legacy/unset values show as "Select…".
    merged.agentType = VERTICAL_VALUES.has(initial?.agentType as string)
      ? (initial!.agentType as AgentFormValues['agentType'])
      : '';
    merged.industryLabel = (initial?.industryLabel as string | null) ?? '';
    merged.endCallInstructions = (initial?.endCallInstructions as string | null) ?? '';
    merged.recordingDisclosure = initial?.recordingDisclosure === true;
    const bc = initial?.bookingConfig;
    merged.bookingConfig =
      bc && typeof bc === 'object'
        ? { ...DEFAULTS.bookingConfig, ...(bc as AgentFormValues['bookingConfig']) }
        : DEFAULTS.bookingConfig;
    merged.bookingConfig.businessName = merged.bookingConfig.businessName ?? '';
    // Outcome config: use the stored one, else seed from the agent's vertical.
    const seedVertical = (VERTICAL_VALUES.has(merged.agentType as string) ? merged.agentType : 'other') as
      keyof typeof VERTICAL_TEMPLATES;
    const oc = initial?.outcomeConfig as Partial<AgentFormValues['outcomeConfig']> | undefined;
    merged.outcomeConfig =
      oc && typeof oc === 'object' && (Array.isArray(oc.captures) ? oc.captures.length : false)
        ? {
            type: oc.type ?? VERTICAL_TEMPLATES[seedVertical].outcome.type,
            captures: (oc.captures as any[]).map((c) => ({
              key: c?.key ?? '',
              label: c?.label ?? c?.key ?? '',
              required: c?.required === true,
            })),
            callerTemplate: oc.callerTemplate ?? '',
            ownerTemplate: oc.ownerTemplate ?? '',
            ownerNumbers: Array.isArray(oc.ownerNumbers) ? (oc.ownerNumbers as string[]).join(', ') : (oc.ownerNumbers as string) ?? '',
            deliver: {
              whatsapp: oc.deliver?.whatsapp !== false,
              inApp: oc.deliver?.inApp !== false,
            },
          }
        : outcomeFromPreset(VERTICAL_TEMPLATES[seedVertical].outcome);
    return merged;
  });
  const [documents, setDocuments] = useState<DocOption[]>([]);
  // "Remove the saved Gemini key on next save" — distinct from an empty field,
  // which means "leave whatever is stored".
  const [clearKey, setClearKey] = useState(false);
  const [numberCount, setNumberCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Set when a practice-type change left the user's own greeting/prompt in
  // place, so the UI can say so rather than looking like it did nothing.
  const [keptOwnText, setKeptOwnText] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/knowledge')
      .then((r) => r.json())
      .then((docs) => setDocuments(docs.map((d: any) => ({ id: d.id, name: d.name }))))
      .catch(() => {});
    fetch('/api/numbers')
      .then((r) => r.json())
      .then((nums) => setNumberCount(Array.isArray(nums) ? nums.length : 0))
      .catch(() => setNumberCount(0));
  }, []);

  // #5: agents need a connected phone number (only enforced when creating).
  const needsNumber = !isEdit && numberCount === 0;

  const modeHint = LANGUAGE_MODES.find((m) => m.value === values.languageMode)?.hint;
  // #3: plain-English "describe your agent" → AI-reframed system prompt.
  const [describe, setDescribe] = useState('');
  const [generating, setGenerating] = useState(false);

  async function generatePrompt() {
    if (!describe.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/generate-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: describe.trim(),
          agentType: values.agentType || 'other',
          industryLabel: values.industryLabel,
        }),
      });
      const b = await res.json();
      if (res.ok && b.prompt) set('systemPrompt', b.prompt);
      else setError(b.error || 'Could not generate a prompt.');
    } catch {
      setError('Could not generate a prompt.');
    } finally {
      setGenerating(false);
    }
  }

  function set<K extends keyof AgentFormValues>(key: K, value: AgentFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false); // a fresh edit invalidates the "Saved" confirmation
  }

  // The picker offers current practice types, plus this agent's own type when
  // it is a retired one — otherwise editing a pre-healthcare agent would show a
  // blank "Select…" and silently re-seed its prompt the moment anything else on
  // the form was saved.
  const practiceTypeOptions = useMemo(() => {
    const selectable = selectableAgentTypesFor(demoVerticals);
    const own = AGENT_TYPES.find(
      (t) =>
        t.value === values.agentType &&
        'retired' in t &&
        t.retired &&
        !selectable.some((o) => o.value === t.value),
    );
    return own ? [...selectable, own] : selectable;
  }, [values.agentType, demoVerticals]);

  // Picking a practice type seeds the greeting, prompt, and booking defaults so
  // the agent is usable immediately. Users can edit everything after.
  //
  // Text the user wrote themselves is NOT overwritten. Switching practice type
  // is easy to do late — or to do twice while comparing — and silently
  // discarding a prompt someone spent ten minutes on (or has been running for
  // months, on the edit form) is the worst outcome this control can produce.
  // Anything still matching a template seed is fair game, so picking a second
  // type after a first still re-seeds properly. `overwriteText` lets the user
  // ask for the template explicitly, from the note rendered under the select.
  function applyVertical(value: AgentFormValues['agentType'], overwriteText = false) {
    setSaved(false);
    if (!value) {
      setValues((v) => ({ ...v, agentType: '' }));
      setKeptOwnText(false);
      return;
    }
    const t = VERTICAL_TEMPLATES[value];
    const ownGreeting = !overwriteText && isOwnText(values.greeting, TEMPLATE_GREETINGS);
    const ownPrompt = !overwriteText && isOwnText(values.systemPrompt, TEMPLATE_PROMPTS);
    setKeptOwnText(ownGreeting || ownPrompt);
    setValues((v) => ({
      ...v,
      agentType: value,
      // Don't clobber an industry label the user typed for "other".
      industryLabel: value === 'other' ? v.industryLabel : '',
      greeting: ownGreeting ? v.greeting : t.greeting,
      systemPrompt: ownPrompt ? v.systemPrompt : t.promptSeed,
      bookingConfig: {
        ...v.bookingConfig,
        enabled: true,
        serviceName: t.serviceName,
        serviceDurationMin: t.serviceDurationMin,
        multiPerSlot: t.multiPerSlot,
      },
      // Re-seed capture fields + message templates from the vertical, but keep
      // any owner numbers / channel toggles the user already set.
      outcomeConfig: {
        ...v.outcomeConfig,
        type: t.outcome.type,
        captures: t.outcome.captures.map((c) => ({ key: c.key, label: c.label, required: !!c.required })),
        callerTemplate: t.outcome.callerTemplate,
        ownerTemplate: t.outcome.ownerTemplate,
      },
    }));
  }

  function setOutcome(patch: Partial<AgentFormValues['outcomeConfig']>) {
    setValues((v) => ({ ...v, outcomeConfig: { ...v.outcomeConfig, ...patch } }));
    setSaved(false);
  }
  function setCapture(i: number, patch: Partial<AgentFormValues['outcomeConfig']['captures'][number]>) {
    setValues((v) => ({
      ...v,
      outcomeConfig: {
        ...v.outcomeConfig,
        captures: v.outcomeConfig.captures.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
      },
    }));
    setSaved(false);
  }
  function addCapture() {
    setValues((v) => ({
      ...v,
      outcomeConfig: { ...v.outcomeConfig, captures: [...v.outcomeConfig.captures, { key: '', label: '', required: false }] },
    }));
  }
  function removeCapture(i: number) {
    setValues((v) => ({
      ...v,
      outcomeConfig: { ...v.outcomeConfig, captures: v.outcomeConfig.captures.filter((_, idx) => idx !== i) },
    }));
  }
  function setDeliver(patch: Partial<AgentFormValues['outcomeConfig']['deliver']>) {
    setValues((v) => ({ ...v, outcomeConfig: { ...v.outcomeConfig, deliver: { ...v.outcomeConfig.deliver, ...patch } } }));
    setSaved(false);
  }

  function onLanguageChange(code: string) {
    setValues((v) => ({ ...v, language: code, voice: defaultVoiceFor(code) }));
  }

  function toggleDoc(id: string) {
    setValues((v) => ({
      ...v,
      documentIds: v.documentIds.includes(id)
        ? v.documentIds.filter((d) => d !== id)
        : [...v.documentIds, id],
    }));
  }

  function setBusinessHours(patch: Partial<BusinessHours>) {
    setValues((v) => ({ ...v, businessHours: { ...v.businessHours, ...patch } }));
  }

  function setBooking(patch: Partial<AgentFormValues['bookingConfig']>) {
    setValues((v) => ({ ...v, bookingConfig: { ...v.bookingConfig, ...patch } }));
  }




  function setVar(i: number, patch: Partial<AgentVariable>) {
    setValues((v) => ({
      ...v,
      variables: v.variables.map((x, idx) => (idx === i ? { ...x, ...patch } : x)),
    }));
  }
  function addVar() {
    setValues((v) => ({ ...v, variables: [...v.variables, { key: '', value: '' }] }));
  }
  function removeVar(i: number) {
    setValues((v) => ({ ...v, variables: v.variables.filter((_, idx) => idx !== i) }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Manual validation so required fields on non-visible steps are caught.
    if (!values.name.trim()) {
      setError('Give the agent a name.');
      setStep(0);
      return;
    }
    if (!values.systemPrompt.trim()) {
      setError('A behavior prompt is required.');
      setStep(0);
      return;
    }
    // Owner alert numbers must look like real phone numbers, or alerts vanish.
    const ownerNumberList = values.outcomeConfig.ownerNumbers
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const badOwnerNumber = ownerNumberList.find((n) => !/^\+?\d[\d\s-]{6,17}$/.test(n));
    if (badOwnerNumber) {
      setError(`“${badOwnerNumber}” doesn't look like a phone number. Use the country code, e.g. +91 98765 43210.`);
      setStep(3);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { geminiApiKey: typedKey, ...rest } = values;
      const payload = {
        ...rest,
        // Omitted unless the user typed a new key or pressed Remove — otherwise
        // every ordinary save would post '' and wipe the stored key.
        ...(demoVerticals && (typedKey.trim() || clearKey)
          ? { geminiApiKey: clearKey ? '' : typedKey.trim() }
          : {}),
        // '' means the user never picked an industry — store as "other".
        agentType: values.agentType || 'other',
        industryLabel: values.agentType === 'other' ? values.industryLabel.trim() : '',
        variables: values.variables.filter((v) => v.key.trim()),
        bookingConfig: { ...values.bookingConfig },
        outcomeConfig: {
          type: values.outcomeConfig.type,
          captures: values.outcomeConfig.captures
            .map((c) => ({ key: c.key.trim(), label: c.label.trim() || c.key.trim(), required: c.required }))
            .filter((c) => c.key),
          callerTemplate: values.outcomeConfig.callerTemplate,
          ownerTemplate: values.outcomeConfig.ownerTemplate,
          ownerNumbers: values.outcomeConfig.ownerNumbers
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          deliver: values.outcomeConfig.deliver,
        },
      };
      const res = await fetch(isEdit ? `/api/agents/${initial!.id}` : '/api/agents', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.formErrors?.[0] || body?.error || 'Failed to save agent');
      }
      const agent = await res.json();
      if (isEdit) {
        setSaving(false);
        setSaved(true);
        router.refresh();
      } else {
        router.push(`/agents/${agent.id ?? initial!.id}`);
        router.refresh();
      }
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  const isLast = step === STEPS.length - 1;

  // ── Focus + scroll management ──────────────────────────────────────────────
  // Changing step swaps the whole panel underneath the user. Without moving
  // focus, keyboard and screen-reader users are left pointing at a control that
  // no longer exists and get no announcement that anything changed.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef(step);

  useEffect(() => {
    if (stepRef.current === step) return; // skip the initial mount
    stepRef.current = step;
    headingRef.current?.focus();
    // The stepper sits above the panel; scroll it into view so a long previous
    // step doesn't leave the user mid-page on the new one.
    headingRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [step]);

  // Validation used to render its message at the foot of a long form while
  // simultaneously jumping to step 0 — so the user landed at the top, the error
  // was off-screen below, and pressing "Create agent" looked like it did
  // nothing. The message now sits above the panel and takes focus.
  useEffect(() => {
    if (!error) return;
    errorRef.current?.focus();
    errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);

  // Losing a part-built agent to a stray back-navigation is expensive; this is
  // the browser's own prompt, so it can't be styled but is never suppressed.
  const isDirty = !saved && (values.name.trim().length > 0 || step > 0);
  useEffect(() => {
    if (!isDirty || saving) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty, saving]);

  /** Blocks Next only when the current step has something actually wrong. */
  function stepError(i: number): string | null {
    if (i === 0) {
      if (!values.name.trim()) return 'Give the agent a name.';
      if (!values.systemPrompt.trim()) return 'A behavior prompt is required.';
    }
    return null;
  }

  function goNext() {
    const problem = stepError(step);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  /** Jumping around the stepper is allowed, but not away from a broken step. */
  function goToStep(i: number) {
    if (i > step) {
      const problem = stepError(step);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setError(null);
    setStep(i);
  }

  // Enter in a single-line input must not implicitly submit the wizard —
  // with the submit button present on every step, the browser would create
  // the agent mid-form. Creating stays explicit via the Create/Save button.
  function onFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) {
      e.preventDefault();
    }
  }

  return (
    <form onSubmit={onSubmit} onKeyDown={onFormKeyDown} className="mx-auto max-w-3xl">
      {/* ── Step progress ──────────────────────────────────────────────────
          Was an <ol> of unlabelled buttons: no aria-current, a bare "✓" that
          screen readers announced as "check mark", and labels hidden below the
          sm breakpoint — so on a phone the most complex flow in the product
          showed five numbered circles and no way to tell them apart. */}
      <nav aria-label="Agent setup steps" className="mb-6">
        <ol className="flex items-center">
          {STEPS.map((s, i) => {
            const active = i === step;
            const done = i < step;
            return (
              <li
                key={s.key}
                className={i < STEPS.length - 1 ? 'flex flex-1 items-center' : 'flex items-center'}
              >
                <button
                  type="button"
                  onClick={() => goToStep(i)}
                  aria-current={active ? 'step' : undefined}
                  className="flex items-center gap-2.5 rounded-lg text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors duration-base ease-standard ${
                      active
                        ? 'bg-primary text-on-primary ring-4 ring-primary/15'
                        : done
                          ? 'bg-primary-soft text-primary ring-1 ring-inset ring-primary/40'
                          : 'bg-surface-2 text-muted ring-1 ring-inset ring-border-strong'
                    }`}
                    aria-hidden="true"
                  >
                    {done ? <Check className="h-4 w-4" /> : i + 1}
                  </span>
                  {/* Announced regardless of viewport, shown from sm up. */}
                  <span className="sr-only">
                    Step {i + 1} of {STEPS.length}: {s.label}
                    {done ? ' (completed)' : ''}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`hidden text-sm font-medium sm:block ${
                      active ? 'text-ink' : done ? 'text-ink-soft' : 'text-muted'
                    }`}
                  >
                    {s.label}
                  </span>
                </button>
                {i < STEPS.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={`mx-3 h-0.5 flex-1 rounded-full transition-colors duration-base ${
                      done ? 'bg-primary/60' : 'bg-border-strong'
                    }`}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Current-step header. tabIndex -1 so focus can be moved here on step
          change without adding it to the tab order. */}
      <div className="mb-5">
        <p className="eyebrow mb-1.5 sm:hidden">
          Step {step + 1} of {STEPS.length}
        </p>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="h-display text-display-sm font-semibold outline-none"
        >
          {STEPS[step].label}
        </h2>
        <p className="mt-1 text-sm text-muted">{STEPS[step].desc}</p>
      </div>

      {/* Errors live here — above the panel, in view — not at the foot of the
          form where a validation jump left them off-screen. */}
      {error && (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="mb-5 flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger outline-none"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Step 1: Basics ── */}
      {step === 0 && (
        <Card className="space-y-4">
          <Field
            label="Practice type"
            hint="Pick the closest match — it fills in a starter greeting, prompt, and booking settings you can edit."
          >
            <Select
              value={values.agentType}
              onChange={(e) => applyVertical(e.target.value as AgentFormValues['agentType'])}
            >
              <option value="">Select…</option>
              {practiceTypeOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          {/* Switching practice type keeps text the user wrote. Without this
              note the select would look like it had simply not worked. */}
          {keptOwnText && (
            <p className="-mt-2 text-xs text-muted">
              Kept the greeting and prompt you wrote. Booking and message defaults were updated.{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                onClick={() => applyVertical(values.agentType, true)}
              >
                Use this practice type&rsquo;s wording instead
              </button>
            </p>
          )}

          {/* #9: free-text practice type when "Other" is chosen. */}
          {values.agentType === 'other' && (
            <Field label="Your practice" hint="Tell us what your practice does so the AI tailors the agent.">
              <Input
                value={values.industryLabel}
                onChange={(e) => set('industryLabel', e.target.value)}
                placeholder="e.g. Physiotherapy centre, Fertility clinic, Veterinary clinic"
              />
            </Field>
          )}

          <Field label="Agent name">
            <Input
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Front Desk Assistant"
              required
            />
          </Field>
          <Field label="Description (optional)" hint="A note for you and your team — the agent never sees it.">
            <Input
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="What this agent is for"
            />
          </Field>

          {/* #3: describe in plain English → AI writes the system prompt */}
          <Field
            label="Describe your agent"
            hint="Write what you want in plain language; we’ll turn it into a behavior prompt below (which you can edit)."
          >
            <Textarea
              value={describe}
              onChange={(e) => setDescribe(e.target.value)}
              className="min-h-[70px]"
              placeholder="e.g. A friendly dental clinic receptionist that greets callers, books appointments, and confirms on WhatsApp."
            />
          </Field>
          <Button type="button" variant="secondary" size="sm" onClick={generatePrompt} disabled={generating || !describe.trim()}>
            {generating ? 'Generating…' : '✨ Generate behavior prompt'}
          </Button>

          <Field label="What should the agent say and do?" hint="Plain instructions for how the agent talks and behaves on calls. Use the generator above if you’re unsure.">
            <Textarea
              value={values.systemPrompt}
              onChange={(e) => set('systemPrompt', e.target.value)}
              className="min-h-[180px]"
              required
            />
          </Field>

          <Field label="Greeting" hint="The first thing the agent says when it picks up.">
            <Textarea
              value={values.greeting}
              onChange={(e) => set('greeting', e.target.value)}
              className="min-h-[70px]"
            />
          </Field>

          <Field
            label="Auto end-call instructions"
            hint="Optional. When these conditions are met, the agent says goodbye and hangs up on its own."
          >
            <Textarea
              value={values.endCallInstructions}
              onChange={(e) => set('endCallInstructions', e.target.value)}
              className="min-h-[60px]"
              placeholder="e.g. End the call once the appointment is booked and confirmed, or if the caller says goodbye."
            />
          </Field>

          <label className="flex items-start gap-3 rounded-lg border border-border-strong bg-surface-2 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.recordingDisclosure}
              onChange={(e) => set('recordingDisclosure', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              <span className="block text-sm font-medium text-ink">Announce call recording</span>
              <span className="block text-xs text-ink-soft">
                The agent starts every call by telling the caller it may be recorded for quality and
                training. Recommended when recording is on — required by law in many places.
              </span>
            </span>
          </label>
        </Card>
      )}

      {/* ── Step 2: Voice & Language ── */}
      {step === 1 && (
        <Card className="space-y-4">
          <Field
            label="Language"
            hint={values.languageMode === 'auto' ? 'Used as the fallback when a caller’s location is unknown.' : undefined}
          >
            <Select value={values.language} onChange={(e) => onLanguageChange(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} · {l.nativeLabel}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Language mode" hint={modeHint}>
            <Select
              value={values.languageMode}
              onChange={(e) => set('languageMode', e.target.value as AgentFormValues['languageMode'])}
            >
              {LANGUAGE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Voice"
            hint={`${GEMINI_VOICES.find((g) => g.id === values.geminiVoice)?.note ?? ''} — Gemini Live native voice. Press ▶ to hear a sample.`}
          >
            <div className="flex items-center gap-2">
              <Select
                value={values.geminiVoice}
                onChange={(e) => set('geminiVoice', e.target.value)}
                className="flex-1"
              >
                {GEMINI_VOICES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label} ({g.gender === 'female' ? '♀ female' : '♂ male'}) — {g.note}
                  </option>
                ))}
              </Select>
              <VoicePreview voiceId={values.geminiVoice} lang={values.language} />
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Direction">
              <Select
                value={values.direction}
                onChange={(e) => set('direction', e.target.value as AgentFormValues['direction'])}
              >
                {AGENT_DIRECTIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={values.status}
                onChange={(e) => set('status', e.target.value as AgentFormValues['status'])}
              >
                <option value="ACTIVE">Active</option>
                <option value="PAUSED">Paused</option>
              </Select>
            </Field>
          </div>
          <Field label={`Creativity · ${values.temperature.toFixed(1)}`} hint="Lower = focused, higher = varied.">
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={values.temperature}
              onChange={(e) => set('temperature', parseFloat(e.target.value))}
              className="w-full accent-primary"
            />
          </Field>
          <Field label="Longest allowed call (seconds)">
            <Input
              type="number"
              min={30}
              max={3600}
              value={values.maxCallSeconds}
              onChange={(e) => set('maxCallSeconds', parseInt(e.target.value || '600', 10))}
            />
          </Field>
        </Card>
      )}

      {/* ── Step 3: Booking & Experts ── */}
      {step === 2 && (
        <Card className="space-y-3">
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={values.bookingConfig.enabled}
              onChange={(e) => setBooking({ enabled: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
            <span>
              <span className="block text-sm font-medium text-ink">Appointment booking</span>
              <span className="block text-xs text-muted">
                Let the agent check real availability and book confirmed slots during the call. Requires Google
                Calendar connected under Connectors.
              </span>
            </span>
          </label>

          {values.bookingConfig.enabled && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Business name" hint="Shown in confirmations, e.g. “Smile Dental Clinic”.">
                  <Input
                    value={values.bookingConfig.businessName}
                    onChange={(e) => setBooking({ businessName: e.target.value })}
                    placeholder="Your clinic / business name"
                  />
                </Field>
                <Field label="Service name" hint="Used in the calendar event + confirmation.">
                  <Input
                    value={values.bookingConfig.serviceName}
                    onChange={(e) => setBooking({ serviceName: e.target.value })}
                    placeholder="consultation, cleaning, blood test…"
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Slot length (min)">
                  <Input
                    type="number"
                    value={values.bookingConfig.serviceDurationMin}
                    onChange={(e) => setBooking({ serviceDurationMin: Number(e.target.value) || 30 })}
                  />
                </Field>
                <Field label="Open hour" hint="0–23, local.">
                  <Input
                    type="number"
                    value={values.bookingConfig.dailyStart}
                    onChange={(e) => setBooking({ dailyStart: Number(e.target.value) || 0 })}
                  />
                </Field>
                <Field label="Close hour" hint="1–24, local.">
                  <Input
                    type="number"
                    value={values.bookingConfig.dailyEnd}
                    onChange={(e) => setBooking({ dailyEnd: Number(e.target.value) || 24 })}
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {/* #4: only allow bookings within the next N days. */}
                <Field
                  label="Only allow bookings within (days)"
                  hint="Callers can book at most this many days ahead. e.g. 7 = this week only."
                >
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    value={values.bookingConfig.lookaheadDays}
                    onChange={(e) => setBooking({ lookaheadDays: Number(e.target.value) || 14 })}
                  />
                </Field>
                <Field label="Time zone" hint="IANA name, e.g. Asia/Kolkata.">
                  <Input
                    value={values.bookingConfig.timezone}
                    onChange={(e) => setBooking({ timezone: e.target.value })}
                    placeholder="Asia/Kolkata"
                  />
                </Field>
              </div>
              {/* Doctors used to be typed in here as free text, in parallel with a
                  real Doctor table that the agent could barely see. They now
                  live in one place and set up their own profile from an invite
                  link, so this is a pointer rather than an editor. */}
              <div className="rounded-xl border border-border bg-surface-2 p-3.5">
                <h4 className="text-sm font-medium text-ink">Doctors &amp; consultants</h4>
                <p className="mt-1 text-[12px] text-muted">
                  Managed on the{' '}
                  <Link href="/team" className="text-primary underline">
                    Team
                  </Link>{' '}
                  page. Invite a doctor and they set up their own name, specialisation, working hours and
                  calendar — the agent offers whoever is set up there, by name and specialisation.
                </p>
              </div>

              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={values.bookingConfig.multiPerSlot}
                  onChange={(e) => setBooking({ multiPerSlot: e.target.checked })}
                  className="h-4 w-4 accent-primary"
                />
                <span>
                  <span className="block text-sm font-medium text-ink">Allow multiple bookings per slot</span>
                  <span className="block text-xs text-muted">
                    e.g. a sample-collection window or an OPD block that takes several patients at once. Off = one
                    booking per slot.
                  </span>
                </span>
              </label>
              {values.bookingConfig.multiPerSlot && (
                <Field label="Bookings allowed per slot">
                  <Input
                    type="number"
                    value={values.bookingConfig.slotCapacity}
                    onChange={(e) => setBooking({ slotCapacity: Math.max(2, Number(e.target.value) || 2) })}
                  />
                </Field>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ── Step 4: Outcomes & Alerts ── */}
      {step === 3 && (
        <div className="space-y-5">
          <Card>
            <h3 className="mb-1 text-sm font-medium text-ink">What the agent captures</h3>
            <p className="mb-4 text-xs text-muted">
              The details the agent collects before saving a {values.outcomeConfig.type || 'record'}. Seeded from your
              practice type — edit freely. The <span className="text-ink-soft">field key</span> is what templates
              reference as{' '}
              <code className="text-ink-soft">{'{{key}}'}</code>.
            </p>
            <div className="space-y-2">
              {values.outcomeConfig.captures.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-36"
                    value={c.key}
                    onChange={(e) => setCapture(i, { key: e.target.value.replace(/[^\w]/g, '') })}
                    placeholder="key"
                  />
                  <Input
                    className="min-w-[10rem] flex-1"
                    value={c.label}
                    onChange={(e) => setCapture(i, { label: e.target.value })}
                    placeholder="Label shown to the agent"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={c.required} onChange={(e) => setCapture(i, { required: e.target.checked })} />
                    required
                  </label>
                  <Button type="button" size="sm" variant="secondary" onClick={() => removeCapture(i)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={addCapture}>
              + Add field
            </Button>
          </Card>

          <Card>
            <h3 className="mb-1 text-sm font-medium text-ink">Messages</h3>
            <p className="mb-4 text-xs text-muted">
              Use <code className="text-ink-soft">{'{{key}}'}</code> for any captured field, plus{' '}
              <code className="text-ink-soft">{'{{business}}'}</code> and <code className="text-ink-soft">{'{{callerNumber}}'}</code>.
            </p>
            <div className="space-y-4">
              {whatsappEnabled ? (
                <p className="text-xs text-muted">
                  Booking confirmations, reminders, reschedules and lead replies are sent to the caller on{' '}
                  <span className="text-ink-soft">WhatsApp</span>, from VaaniYantra’s own verified number — nothing to
                  set up.
                </p>
              ) : (
                <p className="text-xs text-muted">
                  WhatsApp messaging is switched off for this deployment, so booking confirmations, reminders and lead
                  replies are not sent to the caller.
                </p>
              )}
              <Field label="Message to the caller (confirmation / acknowledgement)">
                <Textarea
                  rows={2}
                  value={values.outcomeConfig.callerTemplate}
                  onChange={(e) => setOutcome({ callerTemplate: e.target.value })}
                  placeholder="Hi {{name}}, thanks for calling. We’ll be in touch shortly."
                />
              </Field>
              <Field label="Alert to the owner (new lead / order / reservation)">
                <Textarea
                  rows={2}
                  value={values.outcomeConfig.ownerTemplate}
                  onChange={(e) => setOutcome({ ownerTemplate: e.target.value })}
                  placeholder="New lead — {{name}} ({{callerNumber}})."
                />
              </Field>
              <p className="text-[11px] text-muted">
                This wording is used for the caller message. Booking confirmations, reminders, reschedules and
                cancellations go out on WhatsApp as Meta-approved templates — see the{' '}
                <Link href="/docs/user-guide" className="text-primary underline">messaging guide</Link>.
              </p>
            </div>
          </Card>

          <Card>
            <h3 className="mb-1 text-sm font-medium text-ink">Where owner alerts go</h3>
            <p className="mb-4 text-xs text-muted">
              Phone number(s) with country code (e.g. +91 98765 43210), separated by commas. Leave blank to only keep updates
              in the app.
            </p>
            <Field label="Owner numbers">
              <Input
                value={values.outcomeConfig.ownerNumbers}
                onChange={(e) => setOutcome({ ownerNumbers: e.target.value })}
                placeholder="+919876543210, +14155550100"
              />
            </Field>
            <div className="mt-4 space-y-2">
              {whatsappEnabled && (
                <label className="flex items-center gap-2 text-sm text-ink-soft">
                  <input
                    type="checkbox"
                    checked={values.outcomeConfig.deliver.whatsapp}
                    onChange={(e) => setDeliver({ whatsapp: e.target.checked })}
                  />
                  Send owner alerts over WhatsApp
                </label>
              )}
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={values.outcomeConfig.deliver.inApp}
                  onChange={(e) => setDeliver({ inApp: e.target.checked })}
                />
                Show in the in-app Updates feed
              </label>
            </div>
          </Card>
        </div>
      )}

      {/* ── Step 5: Advanced ── */}
      {step === 4 && (
        <div className="space-y-5">
          <Card>
            <h3 className="mb-1 text-sm font-medium text-ink">Knowledge base</h3>
            <p className="mb-4 text-xs text-muted">
              Attach documents so the agent can answer from them.{' '}
              {documents.length === 0 && 'Upload documents from the Knowledge Base page first.'}
            </p>
            <div className="space-y-2">
              {documents.map((doc) => (
                <label
                  key={doc.id}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-border-strong bg-surface-2 px-3.5 py-2.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={values.documentIds.includes(doc.id)}
                    onChange={() => toggleDoc(doc.id)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="truncate text-ink">{doc.name}</span>
                </label>
              ))}
            </div>
          </Card>

          {/* Own Gemini key — demo accounts only. Write-only: the stored key is
              never sent to the browser, so the field starts empty even when one
              is saved, and an untouched field leaves it untouched. */}
          {demoVerticals && (
            <Card>
              <h3 className="mb-1 text-sm font-medium text-ink">This agent&rsquo;s own Gemini key</h3>
              <p className="mb-4 text-xs text-muted">
                Calls and knowledge lookups for this agent bill this key instead of the platform key.
                Leave empty to keep using the platform key.
              </p>
              {hasGeminiKey && !clearKey && (
                <p className="mb-3 text-xs text-ink-soft">
                  A key is saved for this agent.{' '}
                  <button
                    type="button"
                    onClick={() => setClearKey(true)}
                    className="text-primary underline"
                  >
                    Remove it
                  </button>{' '}
                  &mdash; or type a new one below to replace it.
                </p>
              )}
              {clearKey && (
                <p className="mb-3 text-xs text-danger">
                  The saved key will be removed when you save.{' '}
                  <button
                    type="button"
                    onClick={() => setClearKey(false)}
                    className="text-primary underline"
                  >
                    Keep it
                  </button>
                </p>
              )}
              <Field
                label="Gemini API key"
                hint="Stored encrypted; never shown again after saving."
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={values.geminiApiKey}
                  onChange={(e) => set('geminiApiKey', e.target.value)}
                  placeholder={hasGeminiKey ? 'Type a new key to replace the saved one' : 'AIza…'}
                />
              </Field>
            </Card>
          )}

          {/* Business hours */}
          <Card className="space-y-4">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={values.businessHours.enabled}
                onChange={(e) => setBusinessHours({ enabled: e.target.checked })}
                className="h-4 w-4 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-ink">Business hours</span>
                <span className="block text-xs text-muted">
                  Inbound calls outside these hours hear the after-hours message and are hung up.
                </span>
              </span>
            </label>

            {values.businessHours.enabled && (
              <div className="space-y-3">
                <WeeklyHours
                  value={values.businessHours}
                  onChange={(next) => setValues((v) => ({ ...v, businessHours: next }))}
                />
                <Field label="After-hours message">
                  <Textarea
                    value={values.afterHoursMessage}
                    onChange={(e) => set('afterHoursMessage', e.target.value)}
                    className="min-h-[60px]"
                  />
                </Field>
              </div>
            )}
          </Card>

          {/* Fallback + transfer */}
          <Card className="space-y-4">
            <Field
              label="Fallback response"
              hint="Said when the agent is unsure or can't handle a request. Leave blank to let the agent improvise."
            >
              <Textarea
                value={values.fallbackMessage}
                onChange={(e) => set('fallbackMessage', e.target.value)}
                className="min-h-[60px]"
                placeholder="e.g. I'm not certain about that — let me have a team member follow up with you."
              />
            </Field>

            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={values.transferEnabled}
                onChange={(e) => set('transferEnabled', e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-ink">Call transfer to a human</span>
                <span className="block text-xs text-muted">
                  When the caller asks for a person, hand the live call off to a number.
                </span>
              </span>
            </label>
            {values.transferEnabled && (
              <div className="space-y-3">
                <Field label="Transfer to number" hint="With country code, e.g. +91 98765 43210">
                  <Input
                    value={values.transferNumber}
                    onChange={(e) => set('transferNumber', e.target.value)}
                    placeholder="+919876543210"
                  />
                </Field>
                <Field label="Transfer message" hint="Spoken just before connecting.">
                  <Textarea
                    value={values.transferMessage}
                    onChange={(e) => set('transferMessage', e.target.value)}
                    className="min-h-[50px]"
                  />
                </Field>
                <Field
                  label="Trigger phrases"
                  hint="Comma-separated. Blank uses sensible defaults (human, agent, representative…)."
                >
                  <Input
                    value={values.transferTriggers}
                    onChange={(e) => set('transferTriggers', e.target.value)}
                    placeholder="talk to a human, speak to an agent"
                  />
                </Field>
              </div>
            )}
          </Card>

          {/* Custom variables */}
          <Card className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-ink">Custom variables</h3>
              <p className="text-xs text-muted">
                Reference them in the prompt or greeting as{' '}
                <code className="rounded bg-surface-2 px-1">{'{{key}}'}</code>.
              </p>
            </div>
            {values.variables.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={v.key}
                  onChange={(e) => setVar(i, { key: e.target.value })}
                  placeholder="key (e.g. company)"
                  className="w-1/3"
                />
                <Input
                  value={v.value}
                  onChange={(e) => setVar(i, { value: e.target.value })}
                  placeholder="value (e.g. VaaniYantra)"
                />
                <button
                  type="button"
                  onClick={() => removeVar(i)}
                  className="shrink-0 rounded-lg border border-border px-2.5 py-2 text-xs text-muted hover:text-ink"
                  aria-label="Remove variable"
                >
                  ✕
                </button>
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={addVar} className="w-full">
              + Add variable
            </Button>
          </Card>
        </div>
      )}

      {needsNumber && (
        <div className="mt-5 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-ink-soft">
          You can create and test this agent right away. To take real phone calls, you&rsquo;ll{' '}
          <Link href="/numbers" className="font-medium text-primary underline underline-offset-2">
            connect a phone number
          </Link>{' '}
          afterwards.
        </div>
      )}

      {/* Nav footer. Every step past Basics is optional (practice types pre-fill
          sensible defaults), so saving is always available — nobody has to
          click through five steps just to create an agent. */}
      <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-5">
        {/* Hidden rather than disabled on the first step: a permanently dead
            control is noise, and it still occupies the tab order. */}
        {step > 0 ? (
          <Button type="button" variant="secondary" onClick={() => goToStep(step - 1)}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {!isLast && (
            <Button type="button" variant="secondary" onClick={goNext}>
              Next
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Spinner />
                <span>{isEdit ? 'Saving…' : 'Creating…'}</span>
              </>
            ) : saved ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Saved
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Create agent'
            )}
          </Button>
        </div>
      </div>
      {!isEdit && !isLast && (
        <p className="mt-2.5 text-right text-xs text-muted">
          The remaining steps are optional — create now and fine-tune later.
        </p>
      )}
      {/* Saving/saved announced for screen readers, which otherwise get no
          feedback from a button whose label changed. */}
      <p aria-live="polite" className="sr-only">
        {saving ? 'Saving agent' : saved ? 'Agent saved' : ''}
      </p>
    </form>
  );
}
