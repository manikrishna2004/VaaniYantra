import { redirect } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { homePathFor } from '@/lib/auth/permissions';
import { checkoutPlanError, isPlanKey } from '@/lib/billing/catalogue';
import { CheckoutFlow } from '@/components/CheckoutFlow';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Checkout' };

// Dedicated checkout page — reached from the "Upgrade"/"Renew" buttons on the
// billing page. Kept out of /settings so it gets the full width instead of the
// settings column, and so a half-finished checkout can be abandoned by simply
// going back.
export default async function CheckoutPage(props: { searchParams: Promise<{ plan?: string }> }) {
  const ctx = await requireWorkspace();
  const { plan } = await props.searchParams;

  // Free needs no checkout, Enterprise is contact-sales, and a retired plan is
  // no longer sold; anything else unrecognized is a stale link. Non-owners
  // can't buy at all. Same catalogue-derived rule the checkout API enforces.
  // A non-owner cannot buy, and can no longer even open /settings/billing — so
  // sending them there would bounce them from one refusal to a 404. Send them
  // home instead; the owner still lands on the billing page they came from.
  if (ctx.role !== 'OWNER') redirect(homePathFor(ctx.role));
  if (!isPlanKey(plan) || (await checkoutPlanError(plan)) !== null) {
    redirect('/settings/billing');
  }

  return <CheckoutFlow plan={plan} email={ctx.user.email} />;
}
