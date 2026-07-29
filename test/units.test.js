'use strict';

// Fast unit tests for pure logic — no DB required.

const test = require('node:test');
const assert = require('node:assert');

const { normalizeAmount, formatUSD } = require('../src/lib/money');
const { currentSchoolYear, isValidSchoolYear } = require('../src/lib/schoolYear');
const { mapMethod, pickSchoolYear } = require('../src/lib/stripeEvents');

test('normalizeAmount parses currency-ish input to 2dp, rejects junk', () => {
  assert.strictEqual(normalizeAmount('6000'), 6000);
  assert.strictEqual(normalizeAmount('$1,250.50'), 1250.5);
  assert.strictEqual(normalizeAmount('-25'), -25); // refunds
  assert.strictEqual(normalizeAmount('abc'), null);
  assert.strictEqual(normalizeAmount(''), null);
});

test('formatUSD renders USD', () => {
  assert.strictEqual(formatUSD(1250.5), '$1,250.50');
  assert.strictEqual(formatUSD(0), '$0.00');
});

test('school year rolls over on August 1 (UTC)', () => {
  assert.strictEqual(currentSchoolYear(new Date('2026-08-01T00:00:00Z')), '2026-2027');
  assert.strictEqual(currentSchoolYear(new Date('2026-07-31T00:00:00Z')), '2025-2026');
  assert.ok(isValidSchoolYear('2026-2027'));
  assert.ok(!isValidSchoolYear('2026'));
});

test('mapMethod maps Stripe payment method types to our enum', () => {
  assert.strictEqual(mapMethod('us_bank_account'), 'ach');
  assert.strictEqual(mapMethod('card'), 'card');
  assert.strictEqual(mapMethod('link'), null);
});

test('pickSchoolYear honors valid metadata, else falls back to current', () => {
  assert.strictEqual(pickSchoolYear({ school_year: '2025-2026' }), '2025-2026');
  assert.strictEqual(pickSchoolYear({ school_year: 'nope' }), currentSchoolYear());
  assert.strictEqual(pickSchoolYear(null), currentSchoolYear());
});
