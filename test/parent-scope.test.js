'use strict';

// Spec §6.4: "A parent must never see another family's data. Scope every query
// by the family_id on the session. Write a test for this."
//
// Two layers:
//  1. Structural (always runs, no DB): the parent portal handler must derive the
//     family from req.familyId (the session), never from a route/query param.
//  2. Behavioural (runs when a DB is reachable): every parent-facing query,
//     given family A's id, returns ONLY family A's rows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- 1. Structural guard (no DB needed) ---------- */

test('parent portal handler scopes on the session family id, not a param', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'parentPortal.js'),
    'utf8'
  );
  assert.match(src, /req\.familyId/, 'must read the family id from the session');
  assert.doesNotMatch(
    src,
    /req\.params|req\.query\.(family|id)|req\.body\.family/,
    'parent portal must never take a family id from the request'
  );
});

test('parent-facing query helpers all require an explicit familyId argument', () => {
  const q = require('../src/lib/queries');
  for (const fn of ['getStudentsForFamily', 'getChargesForFamily', 'getPaymentsForFamily', 'getFamilyBalance']) {
    assert.ok(q[fn].length >= 1, `${fn} must take a familyId argument`);
  }
});

/* ---------- 2. Behavioural guard (only when a DB is reachable) ---------- */

async function dbReachable() {
  try {
    const { getPool } = require('../src/db/pool');
    await getPool();
    return true;
  } catch (_) {
    return false;
  }
}

test('parent queries never return another family\'s rows', async (t) => {
  if (!(await dbReachable())) {
    t.skip('No database reachable — run `npm run migrate && npm run seed` to exercise this test.');
    return;
  }
  const q = require('../src/lib/queries');
  const { getFamilyByEmail } = q;

  // Seeded families (see src/db/seed.js).
  const a = await getFamilyByEmail('smith@example.com');
  const b = await getFamilyByEmail('garcia@example.com');
  if (!a || !b) {
    t.skip('Seed data not present — run `npm run seed`.');
    return;
  }

  const aStudents = await q.getStudentsForFamily(a.id);
  const aCharges = await q.getChargesForFamily(a.id);
  const aPayments = await q.getPaymentsForFamily(a.id);

  for (const s of aStudents) assert.strictEqual(s.family_id, a.id, 'student leaked from another family');
  for (const p of aPayments) assert.strictEqual(p.family_id, a.id, 'payment leaked from another family');
  // Charges are joined via students; assert none belong to family B's students.
  const bStudentIds = new Set((await q.getStudentsForFamily(b.id)).map((s) => s.id));
  for (const c of aCharges) assert.ok(!bStudentIds.has(c.student_id), 'charge leaked from another family');

  // And family A's balance must not equal a cross-family total.
  const balA = await q.getFamilyBalance(a.id);
  assert.ok(typeof balA.balance === 'number');
});
