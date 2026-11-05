// Browser-side handoff to Cashfree's hosted payment page.
//
// Split out of CheckoutFlow because two places now send someone to Cashfree —
// buying a month of a plan, and topping up prepaid minutes — and a second copy
// of the SDK loader would eventually drift from this one on the exact thing
// that is hardest to notice: which mode the SDK was initialised in.
//
// Touches `window` only inside the functions, so importing it from a server
// component is harmless.

/** Load the Cashfree JS SDK once (there is no npm build of v3). */
async function loadCashfree(environment: string): Promise<any> {
  if (!(window as any).Cashfree) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load the Cashfree SDK'));
      document.head.appendChild(s);
    });
  }
  return (window as any).Cashfree({ mode: environment === 'production' ? 'production' : 'sandbox' });
}

/**
 * Hand off to Cashfree's hosted page. Both products take a session ID but go
 * through different SDK methods — a mandate authorization is not the same flow
 * as paying an order. Redirects away, so nothing after this runs.
 */
export async function openCashfreeCheckout(
  mode: 'subscription' | 'order',
  sessionId: string,
  environment: string,
): Promise<void> {
  const cashfree = await loadCashfree(environment);
  if (mode === 'subscription') {
    if (typeof cashfree.subscriptionsCheckout !== 'function') {
      throw new Error('Cashfree subscriptions checkout is unavailable');
    }
    await cashfree.subscriptionsCheckout({ subsSessionId: sessionId, redirectTarget: '_self' });
    return;
  }
  await cashfree.checkout({ paymentSessionId: sessionId, redirectTarget: '_self' });
}
