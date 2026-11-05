/**
 * Add whole months, clamping month-end rather than rolling over: Jan 31 + 1
 * month is Feb 28 (or 29), not Mar 3.
 *
 * Lives on its own rather than in cashfree-sync so the invoice module can use it
 * without the two importing each other.
 */
export function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCMonth(out.getUTCMonth() + months);
  if (out.getUTCDate() < day) out.setUTCDate(0);
  return out;
}
