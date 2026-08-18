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
// Well past the monthly plan's final draft (Apr 14) and its cancel point (May 14),
// to prove no 10th draft ever fires.
const JUN_20_2027 = Math.floor(Date.UTC(2027, 5, 20, 12, 0, 0) / 1000);

function addMonthsUnix(unix, months) {
  const d = new Date(unix * 1000);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return Math.floor(d.getTime() / 1000);
}

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

// C) Parent monthly: a subscription that drafts now + monthly, stopped after N
// cycles by cancel_at (exactly how stripeEvents sets it post-checkout). Enrolling
// Aug 14 -> 9 drafts (Aug..Apr), last on/before May 1, then cancels (no 10th).
async function testParentMonthly() {
  console.log('\n=== C) Parent monthly (first now, last <= May 1) ===');
  const clock = await newClock();
  const clockId = clock.id;
  try {
    const { customer, pm } = await newCustomerOnClock(clockId, 'parent-monthly');
    const product = await stripe.products.create({ name: 'Test — monthly' });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: 100000, recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
      default_payment_method: pm.id,
      proration_behavior: 'none',
    });
    const start = sub.current_period_start;
    const cancelAt = addMonthsUnix(start, 9); // cycles * interval_months
    await stripe.subscriptions.update(sub.id, { cancel_at: cancelAt });
    console.log(`  sub ${sub.id}; first draft now; cancel_at ${fmtDate(cancelAt)}`);

    await advanceTo(clockId, JUN_20_2027);
    await sleep(3000);
    const paid = await paidInvoices(customer.id);
    const after = await stripe.subscriptions.retrieve(sub.id);
    const total = paid.reduce((s, p) => s + p.amount, 0);
    const last = paid.length ? paid[paid.length - 1].created : 0;
    console.log(`  ${paid.length} draft(s), total ${fmt(total)}, last ${fmtDate(last)}; sub status=${after.status}`);
    console.log(`  dates: ${paid.map((p) => fmtDate(p.created)).join(', ')}`);
    const ok = paid.length === 9 && total === 900000 && last <= JAN_15_2027 + 90 * DAY && after.status === 'canceled';
    console.log(`  RESULT: ${ok ? 'PASS ✓ 9 drafts = $9,000, last by May 1, then cancels' : 'FAIL ✗'}`);
    return ok;
  } finally { await delClock(clockId); }
}

// D) Office monthly: the subscription SCHEDULE createPlan builds (N monthly-interval
// iterations, end_behavior cancel).
async function testOfficeMonthly() {
  console.log('\n=== D) Office monthly schedule (N drafts, then cancel) ===');
  const clock = await newClock();
  const clockId = clock.id;
  try {
    const { customer } = await newCustomerOnClock(clockId, 'office-monthly');
    const product = await stripe.products.create({ name: 'Test — office monthly' });
    const schedule = await stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: 'now',
      end_behavior: 'cancel',
      phases: [{ items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: 100000, recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }], iterations: 9 }],
    });
    console.log(`  schedule ${schedule.id} status=${schedule.status}`);

    await advanceTo(clockId, JUN_20_2027);
    await sleep(3000);
    const paid = await paidInvoices(customer.id);
    const sched = await stripe.subscriptionSchedules.retrieve(schedule.id);
    const total = paid.reduce((s, p) => s + p.amount, 0);
    console.log(`  ${paid.length} draft(s), total ${fmt(total)}; schedule status=${sched.status}`);
    const ok = paid.length === 9 && total === 900000 && ['canceled', 'completed', 'released'].includes(sched.status);
    console.log(`  RESULT: ${ok ? 'PASS ✓ 9 drafts = $9,000, then stops' : 'FAIL ✗'}`);
    return ok;
  } finally { await delClock(clockId); }
}

const SUITE = {
  semester: async () => {
    const a = await testParentTrialLeg();
    const b = await testOfficeSchedule();
    return { 'parent semester': a, 'office semester': b };
  },
  monthly: async () => {
    const c = await testParentMonthly();
    const d = await testOfficeMonthly();
    return { 'parent monthly': c, 'office monthly': d };
  },
};

(async () => {
  const which = (process.argv[2] || 'all').toLowerCase();
  const groups = which === 'all' ? ['semester', 'monthly'] : [which];
  console.log(`Dry run [${groups.join(', ')}] — clocks frozen at ${fmtDate(AUG_14_2026)}`);
  const results = {};
  for (const g of groups) {
    if (!SUITE[g]) { console.error(`Unknown suite "${g}" (use: semester | monthly | all)`); process.exit(2); }
    Object.assign(results, await SUITE[g]());
  }
  console.log('\nOVERALL:');
  let allOk = true;
  for (const [name, ok] of Object.entries(results)) {
    console.log(`  ${name}: ${ok ? 'PASS' : 'FAIL'}`);
    allOk = allOk && ok;
  }
  console.log('(All test objects were deleted with their clocks.)');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
