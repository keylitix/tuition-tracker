'use strict';

// Plan amount math (spec §7.4). The billed total must ALWAYS equal the balance
// exactly, with any rounding remainder on the final cycle — a few cents left
// outstanding would raise a false delinquency flag.

const test = require('node:test');
const assert = require('node:assert');
const {
  computePlan, isValidPlan, PLAN_SPECS,
  computeParentPlan, customPaymentPolicy, monthlyCyclesUntilMay1, jan15Of, may1Of, CONVENIENCE_FEE_RATE,
} = require('../src/lib/plans');

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

test('every plan bills the exact balance in total', () => {
  for (const bal of [6000, 6250, 5999.99, 4000, 12345.67, 0.03]) {
    for (const plan of Object.keys(PLAN_SPECS)) {
      const c = computePlan(bal, plan);
      assert.strictEqual(sum(c.amountsCents), Math.round(bal * 100),
        `total mismatch for ${plan} @ ${bal}`);
    }
  }
});

test('monthly splits into 9 cycles with remainder on the last', () => {
  const c = computePlan(1000, 'monthly'); // 100000 cents / 9 = 11111 r1
  assert.strictEqual(c.cycles, 9);
  assert.strictEqual(c.object, 'subscription');
  assert.strictEqual(c.intervalMonths, 1);
  assert.strictEqual(c.amountsCents[0], 11111);
  assert.strictEqual(c.amountsCents[8], 11112); // remainder on final
});

test('semester is two 6-month cycles', () => {
  const c = computePlan(4000, 'semester');
  assert.strictEqual(c.cycles, 2);
  assert.strictEqual(c.intervalMonths, 6);
  assert.deepStrictEqual(c.amountsCents, [200000, 200000]);
});

test('annual is a single invoice for the full balance', () => {
  const c = computePlan(5000, 'annual');
  assert.strictEqual(c.object, 'invoice');
  assert.strictEqual(c.cycles, 1);
  assert.deepStrictEqual(c.amountsCents, [500000]);
});

test('rejects non-positive balances and unknown plans', () => {
  assert.throws(() => computePlan(0, 'monthly'), /greater than zero/);
  assert.throws(() => computePlan(-100, 'annual'), /greater than zero/);
  assert.throws(() => computePlan(1000, 'weekly'), /Unknown plan/);
  assert.ok(isValidPlan('monthly') && !isValidPlan('weekly'));
});

// --- Parent self-serve plans (date-anchored + convenience fee) ---------------

const SY = '2026-2027'; // spring anchors: Jan 15 2027, May 1 2027

test('monthly cycle count = drafts on/before May 1, first draft now', () => {
  // Aug 14 -> Aug,Sep,Oct,Nov,Dec,Jan,Feb,Mar,Apr (May 14 > May 1) = 9
  assert.strictEqual(monthlyCyclesUntilMay1(new Date(Date.UTC(2026, 7, 14, 12)), SY), 9);
  // Dec 1 -> Dec,Jan,Feb,Mar,Apr,May (May 1 lands exactly on the deadline) = 6
  assert.strictEqual(monthlyCyclesUntilMay1(new Date(Date.UTC(2026, 11, 1, 12)), SY), 6);
  // Apr 20 -> Apr only (May 20 > May 1) = 1
  assert.strictEqual(monthlyCyclesUntilMay1(new Date(Date.UTC(2027, 3, 20, 12)), SY), 1);
  // May 1 itself counts; May 2 does not -> still >= 1
  assert.strictEqual(monthlyCyclesUntilMay1(new Date(Date.UTC(2027, 4, 1, 6)), SY), 1);
  assert.strictEqual(monthlyCyclesUntilMay1(new Date(Date.UTC(2027, 5, 10, 12)), SY), 1);
});

test('parent full plan: one payment now, card adds 3% fee', () => {
  const now = new Date(Date.UTC(2026, 7, 14, 12));
  const bank = computeParentPlan(10000, 'full', { now, schoolYear: SY, method: 'bank' });
  assert.strictEqual(bank.cycles, 1);
  assert.deepStrictEqual(bank.tuitionCents, [1000000]);
  assert.strictEqual(bank.feeTotalCents, 0);
  assert.strictEqual(bank.totalWithFeeCents, 1000000);

  const card = computeParentPlan(10000, 'full', { now, schoolYear: SY, method: 'card' });
  assert.strictEqual(card.feeTotalCents, 30000); // 3% of $10,000
  assert.strictEqual(card.totalWithFeeCents, 1030000);
});

test('parent monthly: tuition splits across the May-1 cycle count', () => {
  const now = new Date(Date.UTC(2026, 7, 14, 12));
  const p = computeParentPlan(9000, 'monthly', { now, schoolYear: SY, method: 'bank' });
  assert.strictEqual(p.cycles, 9);
  assert.strictEqual(p.intervalMonths, 1);
  assert.strictEqual(sum(p.tuitionCents), 900000); // exact
  assert.strictEqual(p.tuitionCents.every((c) => c === 100000), true); // $1,000 x9
});

test('parent semester: two equal payments, 2nd anchored to Jan 15', () => {
  const now = new Date(Date.UTC(2026, 7, 14, 12));
  const p = computeParentPlan(7000, 'semester', { now, schoolYear: SY, method: 'card' });
  assert.strictEqual(p.cycles, 2);
  assert.deepStrictEqual(p.tuitionCents, [350000, 350000]);
  assert.deepStrictEqual(p.feeCents, [10500, 10500]); // 3% each
  assert.strictEqual(p.secondChargeDate.getTime(), jan15Of(SY).getTime());
  assert.strictEqual(jan15Of(SY).getUTCMonth(), 0); // January
  assert.strictEqual(jan15Of(SY).getUTCDate(), 15);
});

test('parent monthly card fee tracks tuition per cycle, ledger stays whole', () => {
  const now = new Date(Date.UTC(2026, 7, 14, 12));
  const p = computeParentPlan(9000, 'monthly', { now, schoolYear: SY, method: 'card' });
  // Tuition still sums to the exact balance (fee is separate, never tuition).
  assert.strictEqual(sum(p.tuitionCents), 900000);
  assert.strictEqual(p.feeTotalCents, sum(p.tuitionCents.map((t) => Math.round(t * CONVENIENCE_FEE_RATE))));
});

test('parent plan rejects bad method / balance', () => {
  const now = new Date(Date.UTC(2026, 7, 14, 12));
  assert.throws(() => computeParentPlan(1000, 'full', { now, schoolYear: SY, method: 'crypto' }), /Unknown method/);
  assert.throws(() => computeParentPlan(0, 'full', { now, schoolYear: SY, method: 'bank' }), /greater than zero/);
});

// --- Other amount: date-based minimum floor -------------------------------

test('custom payment: before Jan 15, any amount (>= $1); default = full balance', () => {
  // $9,000 total, nothing paid, full balance still $9,000, in September.
  const p = customPaymentPolicy(9000, 9000, 0, { now: new Date(Date.UTC(2026, 8, 1, 12)), schoolYear: SY });
  assert.strictEqual(p.minCents, 100);           // $1 practical floor
  assert.strictEqual(p.defaultCents, 900000);    // suggests full
  assert.strictEqual(p.balanceCents, 900000);
  assert.strictEqual(p.afterJan15, false);
});

test('custom payment: in January, floor + default = remaining half', () => {
  // $9,000 total, $2,000 already paid -> half is $4,500, remaining half $2,500.
  const p = customPaymentPolicy(7000, 9000, 2000, { now: new Date(Date.UTC(2027, 0, 20, 12)), schoolYear: SY });
  assert.strictEqual(p.afterJan15, true);
  assert.strictEqual(p.afterMay1, false);
  assert.strictEqual(p.remainingHalfCents, 250000);
  assert.strictEqual(p.minCents, 250000);        // cannot pay less than remaining half
  assert.strictEqual(p.defaultCents, 250000);    // defaults to it
});

test('custom payment: in January but half already met -> $1 floor, no block', () => {
  // Paid $5,000 of $9,000 -> already past the $4,500 half. Balance $4,000.
  const p = customPaymentPolicy(4000, 9000, 5000, { now: new Date(Date.UTC(2027, 0, 20, 12)), schoolYear: SY });
  assert.strictEqual(p.remainingHalfCents, 0);
  assert.strictEqual(p.minCents, 100);           // any amount toward the rest
  assert.strictEqual(p.defaultCents, 100);
});

test('custom payment: on/after May 1, full balance required', () => {
  const p = customPaymentPolicy(4000, 9000, 5000, { now: new Date(Date.UTC(2027, 4, 2, 12)), schoolYear: SY });
  assert.strictEqual(p.afterMay1, true);
  assert.strictEqual(p.minCents, 400000);        // must pay the whole $4,000
  assert.strictEqual(p.defaultCents, 400000);
});
