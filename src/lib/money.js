'use strict';

// Display helpers only. All monetary arithmetic (sums, balances) is done in SQL
// against DECIMAL(10,2) columns — never reconstructed from JS floats (spec §4).

function toCents(input) {
  // Parse a user-entered dollar string/number to an integer cent count, then
  // back to a fixed 2dp number for storage. Rejects NaN.
  const n = typeof input === 'number' ? input : parseFloat(String(input).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// Normalize a user-entered amount to a 2-decimal number suitable for DECIMAL(10,2).
// Returns null if not a valid number.
function normalizeAmount(input) {
  const cents = toCents(input);
  if (cents === null) return null;
  return cents / 100;
}

function formatUSD(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

module.exports = { toCents, normalizeAmount, formatUSD };
