import { describe, it, expect } from 'vitest';
import { detectRedFlag, normalize, skeleton, emergencyReply } from '@/lib/portal/red-flags';

// This is the only patient-safety control in the chatbot that does not depend on
// a language model. The precision list at the bottom is as important as the
// recall list: a detector that fires on ordinary clinic questions gets muted.

describe('normalize', () => {
  it('tokenises and strips punctuation', () => {
    expect(normalize('Chest-pain, since morning!')).toEqual(['chest', 'pain', 'since', 'morning']);
  });

  it('collapses stretched letters', () => {
    expect(normalize('chesttttt paaaain')).toEqual(['chestt', 'paain']);
  });

  it('strips Latin diacritics but keeps Devanagari matras', () => {
    expect(normalize('éxample')).toEqual(['example']);
    // सीने must survive intact — the matra carries meaning.
    expect(normalize('सीने में दर्द')).toContain('सीने');
  });
});

describe('skeleton', () => {
  it('folds every spelling of one Hinglish word onto a single form', () => {
    const forms = ['saans', 'sans', 'saanse', 'saanss', 'saans'];
    const bones = new Set(forms.map(skeleton));
    expect(bones.size).toBe(1);
    expect([...bones][0]).toBe('sns');
  });

  it('leaves a token alone when removing vowels would destroy it', () => {
    expect(skeleton('aa')).toBe('aa');
  });

  it('does not touch non-Latin script', () => {
    expect(skeleton('दर्द')).toBe('दर्द');
  });
});

describe('detectRedFlag — must fire (recall)', () => {
  const emergencies: [string, string][] = [
    ['I have chest pain since this morning', 'chest_pain'],
    ['severe chest tightness', 'chest_pain'],
    ['i think im having a heart attack', 'chest_pain'],
    ['seene mein dard ho raha hai', 'chest_pain'],
    ['सीने में दर्द है', 'chest_pain'],
    ['I cant breathe properly', 'breathlessness'],
    ['having trouble breathing', 'breathlessness'],
    ['saans nahi aa rahi', 'breathlessness'],
    ['sans nhi aa rhi', 'breathlessness'],
    ['saanse phool rahi hain', 'breathlessness'],
    ['heavy bleeding wont stop', 'severe_bleeding'],
    ['vomiting blood', 'severe_bleeding'],
    ['bahut khoon nikal raha hai', 'severe_bleeding'],
    ['I took too many tablets', 'overdose'],
    ['maine zyada goli kha li', 'overdose'],
    ['I want to kill myself', 'self_harm'],
    ['feeling suicidal', 'self_harm'],
    ['my mother is unconscious', 'unconscious'],
    ['papa behosh ho gaye', 'unconscious'],
    ['his face is drooping and speech is slurred', 'stroke'],
  ];

  it.each(emergencies)('fires on %j', (message, concept) => {
    const flag = detectRedFlag(message);
    expect(flag).not.toBeNull();
    expect(flag?.concept).toBe(concept);
  });

  it('fires when the patient is reporting someone else', () => {
    // Third-party reports are deliberately NOT suppressed — a person messaging
    // about their father's chest pain right now is still an emergency.
    expect(detectRedFlag('my father has chest pain')).not.toBeNull();
  });

  it('survives stretched letters and stray punctuation', () => {
    expect(detectRedFlag('CHESTTT PAIN!!!')).not.toBeNull();
  });
});

describe('detectRedFlag — must not fire (precision floor)', () => {
  // Asserted as a list so a loosened pattern shows up as a failing test rather
  // than as alert fatigue at a clinic six weeks later.
  const benign = [
    'what are your timings tomorrow',
    'can I get my prescription again',
    'how much is the consultation fee',
    'is Dr Mehta available on Friday',
    'I want to cancel my appointment',
    'do I take the tablet before or after food',
    'my BPO shift makes it hard to come in the morning',
    'can you send my reports to my email',
    'thanks doctor, feeling much better now',
    'my son needs a vaccination appointment',
  ];

  it.each(benign)('stays quiet on %j', (message) => {
    expect(detectRedFlag(message)).toBeNull();
  });

  it('does not fire on a substring inside an unrelated word', () => {
    // "bp" inside "bpo" is the classic substring-matching failure.
    expect(detectRedFlag('I work at a bpo')).toBeNull();
  });
});

describe('detectRedFlag — negation', () => {
  it('suppresses an explicit denial', () => {
    expect(detectRedFlag('no chest pain now')).toBeNull();
    expect(detectRedFlag('I do not have chest pain')).toBeNull();
  });

  it('suppresses Hinglish denial where the emergency phrase has no negation in it', () => {
    expect(detectRedFlag('nahi seene mein dard nahi hai')).toBeNull();
  });

  it('does NOT suppress a pattern whose own phrase contains the negation', () => {
    // "saans nahi aa rahi" is the symptom, so its "nahi" cannot be read as a
    // denial. Deliberate: a wasted turn beats a missed breathlessness report.
    expect(detectRedFlag('nahi saans nahi aa rahi')).not.toBeNull();
  });

  it('does not suppress when the negation is far away', () => {
    // "no" attaches to the appointment, not to the symptom.
    expect(detectRedFlag('no appointment is available but I have chest pain')).not.toBeNull();
  });
});

describe('emergencyReply', () => {
  it('always carries both Indian emergency numbers', () => {
    const reply = emergencyReply('Smile Dental');
    expect(reply).toContain('108');
    expect(reply).toContain('112');
    expect(reply).toContain('Smile Dental');
  });

  it('is harmless to receive by mistake — it never asserts a diagnosis', () => {
    const reply = emergencyReply('Smile Dental').toLowerCase();
    expect(reply).not.toContain('heart attack');
    expect(reply).not.toContain('you may be');
  });

  it('falls back to English for a language it has no table for', () => {
    expect(emergencyReply('Clinic', 'ta-IN')).toContain('108');
  });

  it('uses Hindi when the agent speaks it', () => {
    expect(emergencyReply('Clinic', 'hi-IN')).toContain('108');
    expect(emergencyReply('Clinic', 'hi-IN')).toMatch(/[ऀ-ॿ]/);
  });

  it('names the clinic even when the name is blank', () => {
    expect(emergencyReply('')).toContain('the clinic');
  });
});
