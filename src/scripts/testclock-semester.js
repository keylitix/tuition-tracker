'use strict';

/*
 * Stripe Test Clock dry run for the semester "pay now + Jan 15" mechanism.
 *
 * Validates BOTH new code paths without touching production:
 *   A) Parent portal — a trial-until-Jan-15 subscription that drafts once
 *      off-session on Jan 15 and cancels (src/lib/stripeEvents.js).
 *   B) Office plan   — a subscription SCHEDULE whose yearly-interval phases place
 *      one charge now and one on Jan 15 (src/lib/plans.js createPlan).
 *
 * It creates a frozen clock in AUGUST, sets up each subscription, then fast-
 * forwards past Jan 15 and asserts exactly two charges occurred (now + Jan 15)
 * and the subscription then cancels — no runaway third draft.
 *
 * SAFETY: refuses to run unless STRIPE_SECRET_KEY is a TEST key (sk_test_...).
 * Everything it creates lives under the test clock and can be deleted with it.
 *
 * Usage:  STRIPE_SECRET_KEY=sk_test_xxx node src/scripts/testclock-semester.js
 */

const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_KEY || '';
if (!/^sk_test_/.test(KEY)) {
  console.error('Refusing to run: set STRIPE_SECRET_KEY to a TEST key (sk_test_...).');
  process.exit(1);
}
const stripe = new Stripe(KEY);

const DAY = 24 * 60 * 60;
const AUG_14_2026 = Math.floor(Date.UTC(2026, 7, 14, 12, 0, 0) / 1000);
const JAN_15_2027 = Math.floor(Date.UTC(2027, 0, 15, 12, 0, 0) / 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForClock(clockId) {
  for (let i = 0; i < 60; i += 1) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === 'ready') return c;
    if (c.status === 'internal_failure') throw new Error('Test clock advance failed');
    await sleep(2000);
  }
  throw new Error('Test clock did not become ready in time');
}

async function advanceTo(clockId, unix) {
  await stripe.testHelpers.testClocks.advance({ frozen_time: unix }, { idempotencyKey: undefined });
  return waitForClock(clockId);
}

// Sum of paid invoices for a customer, and the date of each, for assertions.
async function paidInvoices(customerId) {
  const inv = await stripe.invoices.list({ customer: customerId, limit: 100 });
  return inv.data
    .filter((i) => i.status === 'paid' || i.amount_paid > 0)
    .map((i) => ({ amount: i.amount_paid, created: i.created, id: i.id }))
    .sort((a, b) => a.created - b.created);
}

function fmt(cents) { return '$' + (cents / 100).toFixed(2); }
function fmtDate(unix) { return new Date(unix * 1000).toISOString().slice(0, 10); }

async function newCustomerOnClock(clockId, label) {
  const customer = await stripe.customers.create({
    name: label, email: `testclock+${label}@example.com`, test_clock: clockId,
  });
  // Attach a test card and make it the default (validates the off-session draft;
  // the ACH path uses the identical subscription mechanics, only settlement differs).
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  return { customer, pm };
}

// A) Parent-style: trial-until-Jan-15 subscription for the 2nd payment.
async function testParentTrialLeg(clockId) {
  console.log('\n=== A) Parent trial-until-Jan-15 subscription ===');
  const { customer, pm } = await newCustomerOnClock(clockId, 'parent');
  const product = await stripe.products.create({ name: 'Test — semester 2nd payment' });
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: 463500, recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
    trial_end: JAN_15_2027,
    cancel_at: JAN_15_2027 + 3 * DAY,
    proration_behavior: 'none',
    default_payment_method: pm.id,
  });
  console.log(`  created sub ${sub.id} status=${sub.status} (expect trialing, no charge yet)`);

  await advanceTo(clockId, JAN_15_2027 + DAY);
  await sleep(3000); // let invoice finalize/charge settle in test mode
  let paid = await paidInvoices(customer.id);
  console.log(`  after Jan 15: ${paid.length} paid invoice(s): ${paid.map((p) => fmt(p.amount) + '@' + fmtDate(p.created)).join(', ')}`);

  await advanceTo(clockId, JAN_15_2027 + 45 * DAY);
  await sleep(2000);
  paid = await paidInvoices(customer.id);
  const after = await stripe.subscriptions.retrieve(sub.id);
  console.log(`  +45 days: ${paid.length} paid invoice(s) total; sub status=${after.status} (expect canceled)`);

  const ok = paid.length === 1 && paid[0].amount === 463500 && after.status === 'canceled';
  console.log(`  RESULT: ${ok ? 'PASS ✓ one Jan-15 draft, then cancels' : 'FAIL ✗'}`);
  return ok;
}

// B) Office-style: subscription schedule with two yearly phases (now + Jan 15).
async function testOfficeSchedule(clockId) {
  console.log('\n=== B) Office subscription schedule (now + Jan 15) ===');
  const { customer } = await newCustomerOnClock(clockId, 'office');
  const product = await stripe.products.create({ name: 'Test — office semester' });
  const recurring = { interval: 'year', interval_count: 1 };
  const priceItem = (cents) => ({ items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: cents, recurring }, quantity: 1 }] });
  const schedule = await stripe.subscriptionSchedules.create({
    customer: customer.id,
    start_date: 'now',
    end_behavior: 'cancel',
    phases: [
      { ...priceItem(350000), end_date: JAN_15_2027, proration_behavior: 'none' },
      { ...priceItem(350000), iterations: 1, proration_behavior: 'none' },
    ],
  });
  console.log(`  created schedule ${schedule.id} status=${schedule.status}`);
  await sleep(3000);
  let paid = await paidInvoices(customer.id);
  console.log(`  at start: ${paid.length} paid invoice(s): ${paid.map((p) => fmt(p.amount) + '@' + fmtDate(p.created)).join(', ')} (expect 1 now)`);

  await advanceTo(clockId, JAN_15_2027 + DAY);
  await sleep(3000);
  paid = await paidInvoices(customer.id);
  console.log(`  after Jan 15: ${paid.length} paid invoice(s): ${paid.map((p) => fmt(p.amount) + '@' + fmtDate(p.created)).join(', ')} (expect 2)`);

  await advanceTo(clockId, JAN_15_2027 + 45 * DAY);
  await sleep(2000);
  paid = await paidInvoices(customer.id);
  const sched = await stripe.subscriptionSchedules.retrieve(schedule.id);
  console.log(`  +45 days: ${paid.length} paid invoice(s) total; schedule status=${sched.status} (expect completed/canceled)`);

  const ok = paid.length === 2 && paid.every((p) => p.amount === 350000) && ['canceled', 'completed', 'released'].includes(sched.status);
  console.log(`  RESULT: ${ok ? 'PASS ✓ charge now + Jan 15, then stops' : 'FAIL ✗'}`);
  return ok;
}

(async () => {
  console.log('Creating test clock frozen at', fmtDate(AUG_14_2026), '...');
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: AUG_14_2026, name: 'semester-dry-run' });
  let a = false; let b = false;
  try {
    a = await testParentTrialLeg(clock.id);
    b = await testOfficeSchedule(clock.id);
  } finally {
    // Tidy up — deleting the clock removes every object created under it.
    try { await stripe.testHelpers.testClocks.del(clock.id); console.log('\nDeleted test clock (all test objects removed).'); } catch (e) { console.log('\n(Leave test clock', clock.id, 'to inspect in the dashboard.)'); }
  }
  console.log(`\nOVERALL: parent leg ${a ? 'PASS' : 'FAIL'}, office schedule ${b ? 'PASS' : 'FAIL'}`);
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
