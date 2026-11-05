import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { isSuperAdmin, getBaseSystemPrompt, getCallGuidance, getLiveConfig } from '@/lib/platform';
import { composeSystemInstruction } from '@/lib/voice/prompt';
import { applyVariables } from '@/lib/agent-behavior';
import { readOutcomeConfig } from '@/lib/connectors/outcomes';
import { readBookingConfig } from '@/lib/connectors/booking';
import { costOptimized } from '@/lib/flags';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// #4: show the founder the EXACT system instruction + parameter set sent to the
// Gemini Live model.
//
// Without ?agentId this renders a representative sample, which is fine for
// checking the admin-editable base prompt and call guidance but tells you
// nothing about a specific agent. That gap cost a real debugging session: an
// agent was not asking callers for their name and the preview could not show
// why, because it never rendered that agent. Pass ?agentId=<id> to compose the
// real thing — same composer the live pipeline uses.
export async function GET(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const agentId = new URL(req.url).searchParams.get('agentId')?.trim();

  const [basePrompt, callGuidance, live] = await Promise.all([
    getBaseSystemPrompt(),
    getCallGuidance(),
    getLiveConfig(),
  ]);

  // A representative agent so the preview reflects a real configuration. The
  // {{placeholders}} mirror how an agent's own systemPrompt/greeting look.
  let sample = {
    systemPrompt:
      'You are Maya, the receptionist for Acme Dental. Greet callers warmly, book appointments, and answer questions about hours and services.',
    greeting: 'Hello! Thanks for calling Acme Dental. How can I help you today?',
    languageMode: 'hybrid',
    language: 'hi-IN',
    fallbackMessage: 'Sorry, I didn’t catch that — could you say it another way?',
    endCallInstructions: 'the caller has booked an appointment or says goodbye',
  };

  let parts = {
    basePrompt,
    corePrompt: sample.systemPrompt,
    knowledge: '\n\n[Knowledge base excerpts for the agent are injected here, when present.]',
    languageMode: sample.languageMode,
    language: sample.language,
    fallbackMessage: sample.fallbackMessage as string | null,
    endCallInstructions: sample.endCallInstructions as string | null,
    callGuidance,
    greeting: sample.greeting,
    recordingDisclosure: false,
    captures: undefined as ReturnType<typeof readOutcomeConfig>['captures'] | undefined,
    agentType: null as string | null,
    industryLabel: null as string | null,
    // The booking block used to be appended by live.ts after the composer ran,
    // so it never appeared here — and it is the single largest section a booking
    // agent receives. Now composed in one place, it shows up in the preview too.
    booking: null as Parameters<typeof composeSystemInstruction>[0]['booking'],
  };

  let agentName: string | null = null;

  if (agentId) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    agentName = agent.name;
    // Mirrors src/lib/voice/live.ts: same defaults, same variable substitution.
    const greeting = applyVariables(
      agent.greeting?.trim() || 'Hello! Thanks for calling. How can I help you today?',
      agent.variables,
    );
    const endCallInstructions =
      agent.endCallInstructions?.trim() ||
      "the caller's request is complete (their booking is confirmed, their details are recorded, or their questions are answered) and they confirm they need nothing else";

    sample = {
      systemPrompt: agent.systemPrompt,
      greeting,
      languageMode: agent.languageMode,
      language: agent.language,
      fallbackMessage: agent.fallbackMessage ?? '',
      endCallInstructions,
    };

    parts = {
      ...parts,
      corePrompt: applyVariables(agent.systemPrompt, agent.variables),
      knowledge:
        '\n\n[Knowledge base excerpts are retrieved per call and injected here — not shown in this preview.]',
      languageMode: agent.languageMode,
      language: agent.language,
      fallbackMessage: agent.fallbackMessage,
      endCallInstructions,
      greeting,
      recordingDisclosure: agent.recordingDisclosure === true,
      captures: readOutcomeConfig(agent).captures,
      agentType: agent.agentType,
      industryLabel: agent.industryLabel,
      booking: readBookingConfig(agent).enabled
        ? {
            // Rendered for "now" so the preview reads like a real call's does.
            nowInTz: new Intl.DateTimeFormat('en-GB', {
              timeZone: readBookingConfig(agent).timezone,
              weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
              hour: 'numeric', minute: '2-digit', hour12: true,
            }).format(new Date()),
            todayIso: new Intl.DateTimeFormat('en-CA', {
              timeZone: readBookingConfig(agent).timezone,
              year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date()),
            timezone: readBookingConfig(agent).timezone,
            concise: costOptimized(agent),
          }
        : null,
    };
  }

  const systemText = composeSystemInstruction(parts);

  // The full config object passed to ai.live.connect() (see src/lib/voice/live.ts).
  const params = {
    model: live.model,
    voice: live.voice,
    temperature: live.temperature,
    responseModalities: ['AUDIO'],
    silenceDurationMs: live.silenceMs,
    startOfSpeechSensitivity: live.startSensitivity,
    endOfSpeechSensitivity: 'HIGH',
    prefixPaddingMs: live.prefixPaddingMs,
    // The window is the biggest line on the bill — Live re-processes it on every
    // turn — so an operator tuning cost needs to see it here next to the prompt
    // whose length it does NOT cap (the system instruction sits outside it).
    compressionTriggerTokens: live.compressionTriggerTokens,
    compressionTargetTokens: live.compressionTargetTokens,
    inputAudioTranscription: true,
    outputAudioTranscription: true,
    // end_call is now always registered (owner instructions or the default).
    endCallTool: true,
  };

  return NextResponse.json({ systemText, params, sample, agentId: agentId ?? null, agentName });
}
