/**
 * Exercises the Starter Kit purchase gate without touching Cashfree.
 *
 *   npx tsx scripts/test-kit-purchase.ts
 *
 * The question it answers is the only one that matters commercially: can
 * anyone get the file without having paid for it? Everything else about this
 * flow is recoverable; that is not.
 */
import { prisma } from '../src/lib/db';
import {
  checkDownloadToken,
  createPendingOrder,
  markPaid,
  markFailed,
  makeKitOrderId,
  recordDownload,
  isKitOrderId,
} from '../src/lib/kit/purchase';

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  if (!pass) failures++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const orderId = makeKitOrderId();
  const email = `test-${Date.now()}@example.com`;

  console.log('\n── order id shape ──');
  check('kit ids are recognised', isKitOrderId(orderId), orderId);
  check('plan ids are NOT treated as kit orders', !isKitOrderId('van_abc123_1700000000'));
  check('topup ids are NOT treated as kit orders', !isKitOrderId('vtm_abc123_1700000000'));

  console.log('\n── an unpaid order cannot download ──');
  const pending = await createPendingOrder({ email, name: 'Test Buyer', orderId, amountInr: 299 });
  check('created PENDING', pending.status === 'PENDING');
  check('no token issued before payment', pending.downloadToken === null);

  const guessed = await checkDownloadToken('not-a-real-token');
  check('a guessed token is refused', !guessed.ok && guessed.reason === 'unknown');

  const empty = await checkDownloadToken('');
  check('an empty token is refused', !empty.ok);

  console.log('\n── paying issues exactly one token ──');
  const paid = await markPaid(orderId, 'cf_test_1');
  check('status is PAID', paid?.status === 'PAID');
  check('token issued', Boolean(paid?.downloadToken));
  check('expiry set', Boolean(paid?.tokenExpiresAt));

  const again = await markPaid(orderId, 'cf_test_2');
  check('paying twice does not mint a second token', again?.downloadToken === paid?.downloadToken,
    'webhook and return URL both settle the same order');

  const token = paid!.downloadToken!;
  const good = await checkDownloadToken(token);
  check('the real token is accepted', good.ok);

  console.log('\n── the download cap is enforced ──');
  for (let i = 0; i < 5; i++) await recordDownload(orderId);
  const exhausted = await checkDownloadToken(token);
  check('refused after 5 downloads', !exhausted.ok && exhausted.reason === 'exhausted');

  console.log('\n── expiry is enforced ──');
  await prisma.kitOrder.update({
    where: { orderId },
    data: { downloadCount: 0, tokenExpiresAt: new Date(Date.now() - 1000) },
  });
  const expired = await checkDownloadToken(token);
  check('refused after expiry', !expired.ok && expired.reason === 'expired');

  console.log('\n── a failure cannot revoke a settled payment ──');
  await prisma.kitOrder.update({ where: { orderId }, data: { tokenExpiresAt: new Date(Date.now() + 60000) } });
  await markFailed(orderId);
  const stillPaid = await prisma.kitOrder.findUnique({ where: { orderId } });
  check('PAID survives a late failure webhook', stillPaid?.status === 'PAID',
    'Cashfree can report a failed attempt after a successful retry');

  console.log('\n── an unpaid order with a token still cannot download ──');
  const orderId2 = makeKitOrderId();
  await createPendingOrder({ email, name: 'Test Two', orderId: orderId2, amountInr: 299 });
  const settled = await markPaid(orderId2);
  // Force it back to PENDING while keeping the token, the worst-case state.
  await prisma.kitOrder.update({ where: { orderId: orderId2 }, data: { status: 'PENDING' } });
  const unpaid = await checkDownloadToken(settled!.downloadToken!);
  check('status is re-checked, not just the token', !unpaid.ok && unpaid.reason === 'unpaid');

  await prisma.kitOrder.deleteMany({ where: { email } });
  console.log('\n' + (failures ? `${failures} FAILED` : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
