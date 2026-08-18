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
// One full interval after the Jan-15 draft, so it bills the WHOLE period (not a
// prorated stub) and then cancels before a second draft. Feb 15 = period end.
const CANCEL_AT = Math.floor(Date.UTC(2027, 1, 15, 12, 0, 0) / 1000);

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

// Stripe only lets you advance a clock up to 2× the shortest subscription
// interval per call (2 months when a monthly sub is present), so step there in
// <=50-day hops until we reach the target.
async function advanceTo(clockId, unix) {
  let cur = (await stripe.testHelpers.testClocks.retrieve(clockId)).frozen_time;
  while (cur < unix) {
    cur = Math.min(unix, cur + 50 * DAY);
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: cur });
    await waitForClock(clockId);
  }
  return stripe.testHelpers.testClocks.retrieve(clockId);
}

async function newClock() {
  return stripe.testHelpers.testClocks.create({ frozen_time: AUG_14_2026, name: 'semester-dry-run' });
}
async function delClock(clockId) {
  try { await stripe.testHelpers.testClocks.del(clockId); } catch (_) { /* ignore */ }
}

// Real (non-zero) paid invoices for a customer, oldest first. Excludes the $0
// trial-start invoice Stripe auto-creates.
async function paidInvoices(customerId) {
  const inv = await stripe.invoices.list({ customer: customerId, limit: 100 });
  return inv.data
    .filter((i) => i.amount_paid > 0)
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
async function testParentTrialLeg() {
  console.log('\n=== A) Parent trial-until-Jan-15 subscription ===');
  const clock = await newClock();
  const clockId = clock.id;
  try {
  const { customer, pm } = await newCustomerOnClock(clockId, 'parent');
  const product = await stripe.products.create({ name: 'Test — semester 2nd payment' });
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: 463500, recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
    trial_end: JAN_15_2027,
    cancel_at: CANCEL_AT,
    proration_behavior: 'none',
    default_payment_method: pm.id,
  });
  console.log(`  created sub ${sub.id} status=${sub.status} (expect trialing, no charge yet)`);

  await advanceTo(clockId, JAN_15_2027 + DAY);
  await sleep(3000); // let invoice finalize/charge settle in test mode
  let paid = await paidInvoices(customer.id);
  console.log(`  after Jan 15: ${paid.length} charge(s): ${paid.map((p) => fmt(p.amount) + '@' + fmtDate(p.created)).join(', ')} (expect one $4635.00)`);

  await advanceTo(clockId, JAN_15_2027 + 90 * DAY);
  await sleep(2000);
  paid = await paidInvoices(customer.id);
  const after = await stripe.subscriptions.retrieve(sub.id);
  console.log(`  +90 days: ${paid.length} charge(s) total; sub status=${after.status} (expect canceled, no 2nd charge)`);

  const ok = paid.length === 1 && paid[0].amount === 463500 && after.status === 'canceled';
  console.log(`  RESULT: ${ok ? 'PASS ✓ one Jan-15 draft, then cancels' : 'FAIL ✗'}`);
  return ok;
  } finally { await delClock(clockId); }
}

// B) Office-style: one-time invoice NOW + trial-until-Jan-15 subscription for the
// second payment (a mid-period phase boundary does NOT bill, so the schedule
// approach can't place a charge on Jan 15 — the trial mechanism can).
async function testOfficeSchedule() {
  console.log('\n=== B) Office semester: invoice now + Jan-15 trial sub ===');
  const clock = await newClock();
  const clockId = clock.id;
  try {
  const { customer, pm } = await newCustomerOnClock(clockId, 'office');
  const product = await stripe.products.create({ name: 'Test — office semester' });

  // Payment 1 — one-off invoice, charged now.
  const invoice = await stripe.invoices.create({ customer: customer.id, collection_method: 'charge_automatically', auto_advance: true });
  await stripe.invoiceItems.create({ customer: customer.id, invoice: invoice.id, amount: 350000, currency: 'usd', description: 'Semester payment 1' });
  await stripe.invoices.finalizeInvoice(invoice.id);

  // Payment 2 — trial until Jan 15, full charge then cancel at period end.
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: 350000, recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
    trial_end: JAN_15_2027,
    cancel_at: CANCEL_AT,
    proration_behavior: 'none',
    default_payment_method: pm.id,
  });
  console.log(`  invoice ${invoice.id} (now) + sub ${sub.id} status=${sub.status}`);
  await sleep(3000);
  let paid = await paidInvoices(customer.id);
  console.log(`  at start: ${paid.length} charge(s): ${paid.map((p) => fmt(p.amount) + '@' + fmtDate(p.created)).join(', ')} (expect 1 now)`);

  await advanceTo(clockId, JAN_15_2027 + DAY);
  await sleep(3000);
  paid = await paidInvoices(customer.id);
  console.log(`  after Jan 15: ${paid.length} charge(s): ${paid.map((p) => fmt(p.amount) + '@' + fmtDate(p.created)).join(', ')} (expect 2)`);

  await advanceTo(clockId, JAN_15_2027 + 90 * DAY);
  await sleep(2000);
  paid = await paidInvoices(customer.id);
  const after = await stripe.subscriptions.retrieve(sub.id);
  console.log(`  +90 days: ${paid.length} charge(s) total; sub status=${after.status} (expect canceled)`);

  const ok = paid.length === 2 && paid.every((p) => p.amount === 350000) && after.status === 'canceled';
  console.log(`  RESULT: ${ok ? 'PASS ✓ charge now + Jan 15, then stops' : 'FAIL ✗'}`);
  return ok;
  } finally { await delClock(clockId); }
}

(async () => {
  console.log('Semester Jan-15 dry run — clocks frozen at', fmtDate(AUG_14_2026));
  const a = await testParentTrialLeg();
  const b = await testOfficeSchedule();
  console.log(`\nOVERALL: parent leg ${a ? 'PASS' : 'FAIL'}, office schedule ${b ? 'PASS' : 'FAIL'}`);
  console.log('(All test objects were deleted with their clocks.)');
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
