import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { SAC_CODE, stateName } from '@/lib/billing/tax';
import { PrintButton } from './PrintButton';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// A single tax invoice, laid out to print cleanly to A4/PDF (the browser's
// "Save as PDF" is the download path — no PDF dependency to maintain).
//
// Every figure is read from the stored invoice, never recomputed: the GST rate
// and both parties' addresses change over time, and a reissued invoice must
// match the one the customer already has.

const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default async function InvoicePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // Deliberately outside the (app) route group: this page prints to PDF, so it
  // must not carry the dashboard sidebar and header.
  const ctx = await requireWorkspace();

  // Scoped by orgId as well as id — an invoice must not be readable across
  // tenants by guessing its identifier.
  const inv = await prisma.invoice.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
  });
  if (!inv) notFound();

  const hasTax = inv.taxRate > 0 && inv.cgstInr + inv.sgstInr + inv.igstInr > 0;

  return (
    <div className="mx-auto max-w-3xl p-6 print:p-0">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link href="/settings/billing" className="text-sm text-muted hover:text-ink">
          ← Back to billing
        </Link>
        <PrintButton />
      </div>

      <div className="rounded-2xl border border-border bg-surface p-8 print:rounded-none print:border-0 print:bg-white print:p-0 print:text-black">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="h-display text-2xl font-semibold">
              {hasTax ? 'Tax Invoice' : 'Invoice'}
            </h1>
            <p className="mt-1 text-sm text-muted">{inv.number}</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold text-ink print:text-black">VaaniYantra</p>
            {inv.sellerName && <p className="text-muted">{inv.sellerName}</p>}
            {inv.sellerAddress && (
              <p className="whitespace-pre-line text-xs text-muted">{inv.sellerAddress}</p>
            )}
            {inv.sellerGstin && <p className="mt-1 text-xs text-muted">GSTIN: {inv.sellerGstin}</p>}
          </div>
        </div>

        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Billed to</h2>
            <p className="mt-1 text-sm text-ink print:text-black">{inv.buyerName || '—'}</p>
            {inv.buyerAddress && (
              <p className="whitespace-pre-line text-xs text-muted">{inv.buyerAddress}</p>
            )}
            {inv.buyerGstin && <p className="mt-1 text-xs text-muted">GSTIN: {inv.buyerGstin}</p>}
            {inv.buyerState && (
              <p className="text-xs text-muted">
                Place of supply: {stateName(inv.buyerState) ?? inv.buyerState}
              </p>
            )}
          </div>
          <div className="sm:text-right">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Details</h2>
            <p className="mt-1 text-sm text-muted">
              Issued <span className="text-ink print:text-black">{day(inv.issuedAt)}</span>
            </p>
            <p className="text-sm text-muted">
              Period{' '}
              <span className="text-ink print:text-black">
                {day(inv.periodStart)} – {day(inv.periodEnd)}
              </span>
            </p>
            {inv.paymentMethod && (
              <p className="text-sm text-muted">
                Paid by <span className="uppercase text-ink print:text-black">{inv.paymentMethod}</span>
              </p>
            )}
          </div>
        </div>

        <table className="mt-8 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted">
              <th className="pb-2">Description</th>
              {hasTax && <th className="pb-2">SAC</th>}
              <th className="pb-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="py-3 text-ink print:text-black">{inv.description}</td>
              {hasTax && <td className="py-3 text-muted">{SAC_CODE}</td>}
              <td className="py-3 text-right text-ink print:text-black">{inr(inv.subtotalInr)}</td>
            </tr>
          </tbody>
        </table>

        <div className="mt-4 flex justify-end">
          <dl className="w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd className="text-ink print:text-black">{inr(inv.subtotalInr)}</dd>
            </div>
            {inv.discountInr > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Discount{inv.promoCode ? ` (${inv.promoCode})` : ''}</dt>
                <dd className="text-success">−{inr(inv.discountInr)}</dd>
              </div>
            )}
            {hasTax && (
              <>
                <div className="flex justify-between border-t border-border pt-1.5">
                  <dt className="text-muted">Taxable value</dt>
                  <dd className="text-ink print:text-black">{inr(inv.taxableInr)}</dd>
                </div>
                {inv.igstInr > 0 ? (
                  <div className="flex justify-between">
                    <dt className="text-muted">IGST @ {inv.taxRate}%</dt>
                    <dd className="text-ink print:text-black">{inr(inv.igstInr)}</dd>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-muted">CGST @ {inv.taxRate / 2}%</dt>
                      <dd className="text-ink print:text-black">{inr(inv.cgstInr)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted">SGST @ {inv.taxRate / 2}%</dt>
                      <dd className="text-ink print:text-black">{inr(inv.sgstInr)}</dd>
                    </div>
                  </>
                )}
              </>
            )}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
              <dt className="text-ink print:text-black">Total paid</dt>
              <dd className="text-ink print:text-black">{inr(inv.totalInr)}</dd>
            </div>
          </dl>
        </div>

        <p className="mt-10 border-t border-border pt-4 text-xs text-muted">
          {hasTax
            ? 'This is a computer-generated tax invoice and does not require a signature.'
            : 'This is a computer-generated invoice and does not require a signature. VaaniYantra is not currently registered for GST, so no tax has been charged.'}
        </p>
      </div>
    </div>
  );
}
