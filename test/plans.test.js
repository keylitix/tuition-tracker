'use strict';

// Plan amount math (spec §7.4). The billed total must ALWAYS equal the balance
// exactly, with any rounding remainder on the final cycle — a few cents left
// outstanding would raise a false delinquency flag.

const test = require('node:test');
const assert = require('node:assert');
const { computePlan, isValidPlan, PLAN_SPECS } = require('../src/lib/plans');

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
