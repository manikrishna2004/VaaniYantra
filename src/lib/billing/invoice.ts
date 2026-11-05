import { prisma } from '@/lib/db';
import { getTaxConfig, computeTax, stateCodeFromGstin } from '@/lib/billing/tax';
import { addMonths } from '@/lib/dates';

// Tax invoices.
//
// GST requires a consecutive, unique series per financial year. India's FY runs
// April–March, so the series resets each April: VY/2026-27/0001.

/** "2026-27" for any date in FY 2026-27 (April 2026 – March 2027). */
export function financialYear(d: Date): string {
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1; // month 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Next number in the current financial year's series.
 *
 * Derived from the highest existing number rather than a counter, so it can
 * never drift from the invoices actually on record.
 *
 * Being inside a transaction is NOT enough on its own, which is what the note
 * here used to claim: two concurrent transactions both read the same maximum
 * and both compute the same next number, so one loses on the unique constraint.
 * Its recovery path then looks up its own gatewayOrderId, finds nothing, and
 * returns null — the customer is charged, the plan applies, and no statutory
 * tax invoice exists. So take an advisory lock on the financial year first and
 * let issuance for that series happen one at a time.
 */
async function nextInvoiceNumber(tx: typeof prisma, at: Date): Promise<string> {
  const fy = financialYear(at);
  const prefix = `VY/${fy}/`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${fy}`}))`;
  const last = await tx.invoice.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const lastSeq = last ? Number(last.number.slice(prefix.length)) : 0;
  const next = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

export type IssueInvoiceArgs = {
  orgId: string;
  plan: string;
  /** Catalogue price before any discount, pre-tax. */
  subtotalInr: number;
  /** Pre-tax amount actually charged (after promo). */
  taxableInr: number;
  promoCode?: string | null;
  gatewayOrderId?: string | null;
  paymentMethod?: string | null;
  at?: Date;
  /**
   * What was bought, in words. Defaults to a month of the plan — override it for
   * anything that is not a subscription month, such as a prepaid minutes top-up.
   */
  description?: string;
  /**
   * End of the period supplied. Defaults to a month after `at`. A purchase that
   * covers no period (minutes, which never expire) passes `at` itself rather
   * than claiming to bill a month nobody bought.
   */
  periodEnd?: Date;
};

/**
 * Write the invoice for a settled payment. Idempotent on gatewayOrderId — the
 * webhook and the return handler both land here for the same payment, and a
 * duplicate invoice number would be a compliance problem, not just noise.
 */
export async function issueInvoice(args: IssueInvoiceArgs): Promise<{ number: string } | null> {
  const at = args.at ?? new Date();

  if (args.gatewayOrderId) {
    const existing = await prisma.invoice.findFirst({
      where: { gatewayOrderId: args.gatewayOrderId },
      select: { number: true },
    });
    if (existing) return existing;
  }

  const [org, taxCfg] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: args.orgId },
      select: {
        name: true,
        gstin: true,
        gstStateCode: true,
        billingName: true,
        billingAddress: true,
        billingCountry: true,
      },
    }),
    getTaxConfig(),
  ]);
  if (!org) return null;

  // A GSTIN's own state code wins over a manually chosen one — it's the
  // authoritative place of supply and they can disagree.
  const buyerState = stateCodeFromGstin(org.gstin) ?? org.gstStateCode ?? null;
  // Outside India there is no place of supply and no GST — an export of service.
  const tax = computeTax(taxCfg, args.taxableInr, buyerState, org.billingCountry ?? 'IN');

  try {
    return await prisma.$transaction(async (tx) => {
      const number = await nextInvoiceNumber(tx as unknown as typeof prisma, at);
      const created = await tx.invoice.create({
        data: {
          number,
          orgId: args.orgId,
          plan: args.plan,
          description: args.description ?? `VaaniYantra ${args.plan} plan — 1 month subscription`,
          periodStart: at,
          periodEnd: args.periodEnd ?? addMonths(at, 1),
          subtotalInr: args.subtotalInr,
          discountInr: Math.max(0, Math.round((args.subtotalInr - args.taxableInr) * 100) / 100),
          taxableInr: tax.taxableInr,
          cgstInr: tax.cgstInr,
          sgstInr: tax.sgstInr,
          igstInr: tax.igstInr,
          totalInr: tax.totalInr,
          taxRate: tax.rate,
          sellerGstin: taxCfg.gstin,
          sellerName: taxCfg.legalName,
          sellerAddress: taxCfg.address,
          buyerName: org.billingName || org.name,
          buyerGstin: org.gstin,
          buyerAddress: org.billingAddress,
          buyerState,
          promoCode: args.promoCode ?? null,
          gatewayOrderId: args.gatewayOrderId ?? null,
          paymentMethod: args.paymentMethod ?? null,
        },
        select: { number: true },
      });
      return created;
    });
  } catch (err) {
    // A unique-constraint clash means a concurrent call won the race; the
    // invoice exists, which is the outcome we wanted.
    if (args.gatewayOrderId) {
      const existing = await prisma.invoice.findFirst({
        where: { gatewayOrderId: args.gatewayOrderId },
        select: { number: true },
      });
      if (existing) return existing;
    }
    console.error('[invoice] could not issue', err);
    return null;
  }
}
