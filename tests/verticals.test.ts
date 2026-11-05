import { describe, it, expect } from 'vitest';
import {
  AGENT_TYPES,
  SELECTABLE_AGENT_TYPES,
  VERTICAL_TEMPLATES,
  agentTypeLabel,
  selectableAgentTypesFor,
  type AgentVertical,
} from '@/lib/constants';
import { agentInputSchema } from '@/lib/validation';

// The vertical catalogue is the product surface of the agency pivot: it decides
// which industries can be sold, and every agent row in the database holds one of
// its values forever. The file's own comments state the rules ("nothing here may
// be deleted", "retired stays resolvable") and nothing enforced them until now.

const RETIRED = AGENT_TYPES.filter((t) => 'retired' in t && t.retired).map((t) => t.value);
const LIVE = SELECTABLE_AGENT_TYPES.map((t) => t.value);

describe('the vertical catalogue', () => {
  it('gives every type a template, including retired ones', () => {
    // A retired type without a template is an agent that throws the moment it
    // takes a call — readOutcomeConfig indexes VERTICAL_TEMPLATES directly.
    for (const t of AGENT_TYPES) {
      expect(VERTICAL_TEMPLATES[t.value as AgentVertical], `${t.value} has no template`).toBeTruthy();
    }
  });

  it('has no template without a type to reach it', () => {
    const declared = new Set<string>(AGENT_TYPES.map((t) => t.value));
    for (const key of Object.keys(VERTICAL_TEMPLATES)) {
      expect(declared.has(key), `${key} has a template but is not in AGENT_TYPES`).toBe(true);
    }
  });

  it('accepts every type through the zod schema the API validates with', () => {
    // AGENT_TYPE_VALUES is derived from this catalogue rather than hand-copied,
    // so this asserts the derivation still holds for retired types too — editing
    // an agent created under one must not 400.
    const shape = agentInputSchema.shape.agentType;
    for (const t of AGENT_TYPES) {
      expect(shape.safeParse(t.value).success, `${t.value} rejected`).toBe(true);
    }
    expect(shape.safeParse('no_such_vertical').success).toBe(false);
  });

  it('keeps the values that live rows and issued templates depend on', () => {
    // These strings are written into Agent.agentType. Renaming one silently
    // re-points every agent holding it at the "other" fallback.
    for (const value of ['healthcare', 'hospital', 'dental', 'specialist', 'diagnostics', 'other']) {
      expect(AGENT_TYPES.map((t) => t.value)).toContain(value);
    }
  });

  it('sells the six agency verticals', () => {
    for (const value of ['healthcare', 'real_estate', 'restaurant', 'education', 'interior_design', 'lead_screening']) {
      expect(LIVE, `${value} should be selectable`).toContain(value);
    }
  });

  it('keeps the unsold verticals resolvable but unsellable', () => {
    expect(RETIRED).toEqual(expect.arrayContaining(['insurance', 'finance', 'ecommerce', 'salon']));
    for (const value of RETIRED) {
      expect(LIVE, `${value} must not be offered`).not.toContain(value);
      expect(VERTICAL_TEMPLATES[value as AgentVertical]).toBeTruthy();
    }
  });

  it('offers the same list with or without the demo allow-list', () => {
    // The allow-list existed to unlock real estate, which is now sold openly.
    // If this ever diverges again, someone has re-added a demo-only vertical
    // and the flag needs a fresh look.
    expect(selectableAgentTypesFor(true)).toEqual(selectableAgentTypesFor(false));
  });

  it('labels an unknown type without claiming it is healthcare', () => {
    expect(agentTypeLabel('no_such_vertical')).toBe('Other');
    expect(agentTypeLabel(null)).toBe('Other');
    expect(agentTypeLabel('interior_design')).toBe('Interior Design');
  });
});

describe('every template is usable as written', () => {
  it.each(AGENT_TYPES.map((t) => [t.value, VERTICAL_TEMPLATES[t.value as AgentVertical]] as const))(
    '%s',
    (_value, tpl) => {
      expect(tpl.greeting.trim().length).toBeGreaterThan(10);
      expect(tpl.promptSeed.trim().length).toBeGreaterThan(40);
      expect(tpl.serviceName.trim()).not.toBe('');
      expect(tpl.serviceDurationMin).toBeGreaterThan(0);

      const captures = tpl.outcome.captures;
      expect(captures.length).toBeGreaterThan(0);
      expect(captures.some((c) => c.required)).toBe(true);
      // Duplicate keys would silently overwrite each other in collectedData.
      expect(new Set(captures.map((c) => c.key)).size).toBe(captures.length);

      // Every {{placeholder}} in a message must be a field the agent was told
      // to collect, or one of the two the deliverer always supplies. A typo
      // here reaches the customer as a literal "{{naem}}" in an SMS.
      const known = new Set([...captures.map((c) => c.key), 'business', 'callerNumber']);
      for (const template of [tpl.outcome.callerTemplate, tpl.outcome.ownerTemplate]) {
        for (const [, key] of template.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(known.has(key), `${_value}: {{${key}}} is not a captured field`).toBe(true);
        }
      }
    },
  );
});
