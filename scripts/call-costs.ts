/**
 * What calls actually cost to run, per call and per minute.
 *
 *   npx tsx scripts/call-costs.ts                 # last 7 days
 *   npx tsx scripts/call-costs.ts --days=30
 *   npx tsx scripts/call-costs.ts --days=1 --calls  # list every call
 *   npx tsx scripts/call-costs.ts --since=2026-08-31T18:00:00Z --calls
 *
 * Read-only. Reports the token spend recorded on each Call by the Live pipeline
 * (src/lib/voice/usage.ts) against RATE_PER_MINUTE_INR, the rate customers pay.
 *
 * Only calls placed after the usage columns shipped carry data — anything older
 * reads as zero and is excluded from the rollup rather than dragging the
 * average down. The rupee figures are estimates from a rate table that goes
 * stale; reconcile them against a Google invoice (which adds 18% GST on top)
 * before betting a price on them.
 */
import { prisma } from '../src/lib/db';
import { RATE_PER_MINUTE_INR } from '../src/lib/billing/catalogue';
import { usdInrRate } from '../src/lib/voice/usage';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const days = Number(arg('days') || 7);
const sinceArg = arg('since');
const showCalls = process.argv.includes('--calls');
const inr = (n: number) => `₹${n.toFixed(2)}`;

async function main() {
  // --since pins an exact instant, which is what makes a before/after
  // comparison honest: a day bucket straddles the change being measured, so the
  // "after" average is diluted by calls placed under the old configuration.
  let since: Date;
  if (sinceArg) {
    since = new Date(sinceArg);
    if (Number.isNaN(since.getTime())) {
      console.error(`--since=${sinceArg} is not a date. Use an ISO instant, e.g. 2026-08-31T18:00:00Z`);
      process.exitCode = 1;
      return;
    }
  } else {
    since = new Date(Date.now() - days * 86_400_000);
  }
  const window = sinceArg ? `since ${since.toISOString()}` : `Last ${days} day(s)`;
  const calls = await prisma.call.findMany({
    where: { createdAt: { gte: since } },
    select: {
      id: true, createdAt: true, status: true, durationSec: true,
      llmModel: true, llmTurns: true, llmPromptTokens: true, llmResponseTokens: true,
      llmAudioInTokens: true, llmAudioOutTokens: true, llmCostInr: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const measured = calls.filter((c) => c.llmTurns > 0);
  console.log(`\n${window}: ${calls.length} calls, ${measured.length} with usage recorded.`);
  console.log(`Rates: ${inr(RATE_PER_MINUTE_INR)}/min charged · USD_INR_RATE=${usdInrRate()}\n`);
  if (!measured.length) {
    console.log('No measured calls yet. Usage lands on calls placed after the columns shipped.');
    return;
  }

  if (showCalls) {
    for (const c of measured) {
      const min = c.durationSec / 60;
      const cost = c.llmCostInr ?? 0;
      console.log(
        `${c.createdAt.toISOString().slice(0, 16)}  ${c.id.slice(0, 10)}  ${min.toFixed(2)}min  ` +
          `${c.llmTurns} turns  in ${c.llmPromptTokens} (audio ${c.llmAudioInTokens})  ` +
          `out ${c.llmResponseTokens} (audio ${c.llmAudioOutTokens})  ` +
          `${inr(cost)}  ${min > 0 ? inr(cost / min) + '/min' : ''}  ${c.llmModel ?? '?'}`,
      );
    }
    console.log('');
  }

  const sum = (f: (c: (typeof measured)[number]) => number) => measured.reduce((a, c) => a + f(c), 0);
  const minutes = sum((c) => c.durationSec) / 60;
  const cost = sum((c) => c.llmCostInr ?? 0);
  const turns = sum((c) => c.llmTurns);
  const revenue = minutes * RATE_PER_MINUTE_INR;

  // The headline: Live re-bills the accumulated window every turn, so input
  // tokens per minute is the number that moves when compression is tuned.
  console.log(`Minutes            ${minutes.toFixed(2)}`);
  console.log(`Turns              ${turns} (${(turns / Math.max(minutes, 0.01)).toFixed(1)}/min)`);
  console.log(`Input tokens       ${sum((c) => c.llmPromptTokens)} (audio ${sum((c) => c.llmAudioInTokens)})`);
  console.log(`Output tokens      ${sum((c) => c.llmResponseTokens)} (audio ${sum((c) => c.llmAudioOutTokens)})`);
  console.log(`\nGemini cost        ${inr(cost)}  =  ${inr(cost / Math.max(minutes, 0.01))}/min`);
  console.log(`Charged            ${inr(revenue)}  =  ${inr(RATE_PER_MINUTE_INR)}/min`);

  const margin = revenue - cost;
  const pct = revenue > 0 ? (margin / revenue) * 100 : 0;
  console.log(
    `Gross margin       ${inr(margin)}  (${pct.toFixed(0)}%)  ` +
      '— before telephony, WhatsApp and GST',
  );
  if (margin < 0) {
    console.log(
      `\n  Every minute sold loses ${inr(-margin / Math.max(minutes, 0.01))}. ` +
        `Break-even needs Gemini under ${inr(RATE_PER_MINUTE_INR)}/min, or a higher rate.`,
    );
  }

  const models = [...new Set(measured.map((c) => c.llmModel).filter(Boolean))];
  if (models.length > 1) console.log(`\nModels in this window: ${models.join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
