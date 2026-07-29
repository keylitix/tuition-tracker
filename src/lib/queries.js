'use strict';

// All data access. Every query is parameterized (spec §9). Every parent-facing
// read takes an explicit familyId and scopes on it — there is no parent query
// that can return another family's rows.

const { sql, query } = require('../db/pool');

const PAYMENT_METHODS = ['ach', 'card', 'check', 'pctc', 'adjustment', 'refund'];

/* ------------------------------------------------------------------ */
/* School years                                                        */
/* ------------------------------------------------------------------ */

async function listSchoolYears() {
  const r = await query(`
    SELECT school_year FROM (
      SELECT school_year FROM students
      UNION SELECT school_year FROM charges
      UNION SELECT school_year FROM payments
    ) x
    WHERE school_year IS NOT NULL
    ORDER BY school_year DESC;
  `);
  return r.recordset.map((row) => row.school_year);
}

/* ------------------------------------------------------------------ */
/* Admin — roster (spec §6.1)                                          */
/* ------------------------------------------------------------------ */

// One row per active family with charged/paid/balance for the year, plus the
// flags the office needs: past-due, unendorsed-PCTC, failed-payment.
async function getRoster({ year, search = '' }) {
  const r = await query(
    `
    SELECT
        f.id,
        f.name,
        f.email,
        f.stripe_customer_id,
        ISNULL(st.student_count, 0)                                   AS student_count,
        ISNULL(c.total_charges, 0)                                    AS charged,
        ISNULL(p.total_paid, 0)                                       AS paid,
        ISNULL(c.total_charges, 0) - ISNULL(p.total_paid, 0)          AS balance,
        ISNULL(pctc.unendorsed_count, 0)                              AS unendorsed_pctc_count,
        ISNULL(pctc.unendorsed_amount, 0)                             AS unendorsed_pctc_amount,
        CASE WHEN pf.family_id IS NOT NULL THEN 1 ELSE 0 END          AS has_failed_payment,
        f.plan_awaiting_auth                                          AS awaiting_auth,
        CASE WHEN c.earliest_due IS NOT NULL
                  AND c.earliest_due < CAST(SYSUTCDATETIME() AS DATE)
                  AND (ISNULL(c.total_charges, 0) - ISNULL(p.total_paid, 0)) > 0
             THEN 1 ELSE 0 END                                        AS past_due
    FROM families f
    LEFT JOIN (
        SELECT family_id, COUNT(*) AS student_count
        FROM students WHERE active = 1 AND school_year = @year
        GROUP BY family_id
    ) st ON st.family_id = f.id
    LEFT JOIN (
        SELECT s.family_id,
               SUM(ch.amount) AS total_charges,
               MIN(ch.due_date) AS earliest_due
        FROM charges ch
        JOIN students s ON s.id = ch.student_id
        WHERE ch.voided = 0 AND ch.school_year = @year
        GROUP BY s.family_id
    ) c ON c.family_id = f.id
    LEFT JOIN (
        SELECT family_id, SUM(amount) AS total_paid
        FROM payments WHERE school_year = @year
        GROUP BY family_id
    ) p ON p.family_id = f.id
    LEFT JOIN (
        SELECT family_id,
               COUNT(*) AS unendorsed_count,
               SUM(amount) AS unendorsed_amount
        FROM payments
        WHERE method = 'pctc' AND pctc_endorsed_on IS NULL AND school_year = @year
        GROUP BY family_id
    ) pctc ON pctc.family_id = f.id
    LEFT JOIN (
        SELECT DISTINCT family_id FROM payment_failures WHERE cleared = 0
    ) pf ON pf.family_id = f.id
    WHERE f.active = 1
      AND (@search = '' OR f.name LIKE @searchLike OR EXISTS (
            SELECT 1 FROM students s2
            WHERE s2.family_id = f.id
              AND (s2.first_name LIKE @searchLike OR s2.last_name LIKE @searchLike)
      ))
    ORDER BY balance DESC, f.name ASC;
    `,
    {
      year: { type: sql.NVarChar(9), value: year },
      search: { type: sql.NVarChar(200), value: search },
      searchLike: { type: sql.NVarChar(210), value: `%${search}%` },
    }
  );
  return r.recordset;
}

// Summary strip for the roster header (spec §6.1).
async function getRosterSummary({ year }) {
  const r = await query(
    `
    SELECT
      (SELECT ISNULL(SUM(ch.amount), 0)
         FROM charges ch WHERE ch.voided = 0 AND ch.school_year = @year)          AS total_billed,
      (SELECT ISNULL(SUM(amount), 0)
         FROM payments WHERE school_year = @year)                                 AS total_collected,
      (SELECT COUNT(*)
         FROM payments
         WHERE method = 'pctc' AND pctc_endorsed_on IS NULL AND school_year = @year) AS unendorsed_pctc_count,
      (SELECT ISNULL(SUM(amount), 0)
         FROM payments
         WHERE method = 'pctc' AND pctc_endorsed_on IS NULL AND school_year = @year) AS unendorsed_pctc_amount
    ;
    `,
    { year: { type: sql.NVarChar(9), value: year } }
  );
  const row = r.recordset[0];
  row.total_outstanding = Number(row.total_billed) - Number(row.total_collected);
  return row;
}

/* ------------------------------------------------------------------ */
/* Admin — family detail (spec §6.2)                                   */
/* ------------------------------------------------------------------ */

async function getFamily(familyId) {
  const r = await query('SELECT * FROM families WHERE id = @id;', {
    id: { type: sql.Int, value: familyId },
  });
  return r.recordset[0] || null;
}

async function getFamilyByEmail(email) {
  const r = await query(
    'SELECT * FROM families WHERE email = @email AND active = 1;',
    { email: { type: sql.NVarChar(255), value: email } }
  );
  return r.recordset[0] || null;
}

async function getStudentsForFamily(familyId, year = null) {
  const r = await query(
    `
    SELECT s.*,
           ISNULL((SELECT SUM(ch.amount) FROM charges ch
                   WHERE ch.student_id = s.id AND ch.voided = 0), 0) AS charged
    FROM students s
    WHERE s.family_id = @familyId
      AND (@year IS NULL OR s.school_year = @year)
    ORDER BY s.last_name, s.first_name;
    `,
    {
      familyId: { type: sql.Int, value: familyId },
      year: { type: sql.NVarChar(9), value: year },
    }
  );
  return r.recordset;
}

async function getChargesForFamily(familyId, year = null) {
  const r = await query(
    `
    SELECT ch.*, s.first_name, s.last_name
    FROM charges ch
    JOIN students s ON s.id = ch.student_id
    WHERE s.family_id = @familyId
      AND (@year IS NULL OR ch.school_year = @year)
    ORDER BY ch.voided ASC, ch.created_at DESC;
    `,
    {
      familyId: { type: sql.Int, value: familyId },
      year: { type: sql.NVarChar(9), value: year },
    }
  );
  return r.recordset;
}

async function getPaymentsForFamily(familyId, year = null) {
  const r = await query(
    `
    SELECT p.*
    FROM payments p
    WHERE p.family_id = @familyId
      AND (@year IS NULL OR p.school_year = @year)
    ORDER BY p.received_on DESC, p.id DESC;
    `,
    {
      familyId: { type: sql.Int, value: familyId },
      year: { type: sql.NVarChar(9), value: year },
    }
  );
  return r.recordset;
}

// Balance for a single family (all years, or one). Computed, never stored.
async function getFamilyBalance(familyId, year = null) {
  const r = await query(
    `
    SELECT
      ISNULL((SELECT SUM(ch.amount)
              FROM charges ch JOIN students s ON s.id = ch.student_id
              WHERE s.family_id = @familyId AND ch.voided = 0
                AND (@year IS NULL OR ch.school_year = @year)), 0) AS charged,
      ISNULL((SELECT SUM(amount) FROM payments
              WHERE family_id = @familyId
                AND (@year IS NULL OR school_year = @year)), 0)    AS paid;
    `,
    {
      familyId: { type: sql.Int, value: familyId },
      year: { type: sql.NVarChar(9), value: year },
    }
  );
  const row = r.recordset[0];
  return {
    charged: Number(row.charged),
    paid: Number(row.paid),
    balance: Number(row.charged) - Number(row.paid),
  };
}

/* ------------------------------------------------------------------ */
/* Admin — mutations                                                   */
/* ------------------------------------------------------------------ */

async function updateFamily(familyId, { name, email, phone, stripe_customer_id }) {
  await query(
    `UPDATE families
        SET name = @name, email = @email, phone = @phone,
            stripe_customer_id = @scid
      WHERE id = @id;`,
    {
      id: { type: sql.Int, value: familyId },
      name: { type: sql.NVarChar(200), value: name },
      email: { type: sql.NVarChar(255), value: email },
      phone: { type: sql.NVarChar(30), value: phone || null },
      scid: { type: sql.NVarChar(50), value: stripe_customer_id || null },
    }
  );
}

async function addCharge({ studentId, description, amount, dueDate, schoolYear, createdBy }) {
  const r = await query(
    `INSERT INTO charges (student_id, description, amount, due_date, school_year, created_by)
     OUTPUT INSERTED.id
     VALUES (@studentId, @description, @amount, @dueDate, @schoolYear, @createdBy);`,
    {
      studentId: { type: sql.Int, value: studentId },
      description: { type: sql.NVarChar(255), value: description },
      amount: { type: sql.Decimal(10, 2), value: amount },
      dueDate: { type: sql.Date, value: dueDate || null },
      schoolYear: { type: sql.NVarChar(9), value: schoolYear },
      createdBy: { type: sql.Int, value: createdBy || null },
    }
  );
  return r.recordset[0].id;
}

// Soft delete only — never hard-delete a charge (spec §6.2).
async function voidCharge(chargeId) {
  await query('UPDATE charges SET voided = 1 WHERE id = @id;', {
    id: { type: sql.Int, value: chargeId },
  });
}

async function recordPayment({
  familyId, amount, method, receivedOn, schoolYear, note,
  checkNumber, pctcEndorsedOn, createdBy,
}) {
  const r = await query(
    `INSERT INTO payments
        (family_id, amount, method, received_on, school_year, note,
         check_number, pctc_endorsed_on, created_by)
     OUTPUT INSERTED.id
     VALUES (@familyId, @amount, @method, @receivedOn, @schoolYear, @note,
             @checkNumber, @pctcEndorsedOn, @createdBy);`,
    {
      familyId: { type: sql.Int, value: familyId },
      amount: { type: sql.Decimal(10, 2), value: amount },
      method: { type: sql.NVarChar(20), value: method },
      receivedOn: { type: sql.Date, value: receivedOn },
      schoolYear: { type: sql.NVarChar(9), value: schoolYear },
      note: { type: sql.NVarChar(500), value: note || null },
      checkNumber: { type: sql.NVarChar(50), value: checkNumber || null },
      pctcEndorsedOn: { type: sql.Date, value: pctcEndorsedOn || null },
      createdBy: { type: sql.Int, value: createdBy || null },
    }
  );
  return r.recordset[0].id;
}

async function addStudent({ externalId, familyId, firstName, lastName, grade, schoolYear }) {
  const r = await query(
    `INSERT INTO students (external_id, family_id, first_name, last_name, grade, school_year)
     OUTPUT INSERTED.id
     VALUES (@externalId, @familyId, @firstName, @lastName, @grade, @schoolYear);`,
    {
      externalId: { type: sql.NVarChar(50), value: externalId },
      familyId: { type: sql.Int, value: familyId },
      firstName: { type: sql.NVarChar(100), value: firstName },
      lastName: { type: sql.NVarChar(100), value: lastName },
      grade: { type: sql.NVarChar(20), value: grade || null },
      schoolYear: { type: sql.NVarChar(9), value: schoolYear },
    }
  );
  return r.recordset[0].id;
}

// Record the result of a Stripe plan creation (spec §7.4). Called after the
// Stripe objects are created; the ledger itself was already committed earlier.
async function setPlan(familyId, { plan, subscriptionId, awaitingAuth }) {
  await query(
    `UPDATE families
        SET payment_plan = @plan,
            stripe_subscription_id = @sub,
            plan_created_at = SYSUTCDATETIME(),
            plan_awaiting_auth = @awaiting
      WHERE id = @id;`,
    {
      id: { type: sql.Int, value: familyId },
      plan: { type: sql.NVarChar(20), value: plan },
      sub: { type: sql.NVarChar(50), value: subscriptionId || null },
      awaiting: { type: sql.Bit, value: awaitingAuth ? 1 : 0 },
    }
  );
}

async function clearAwaitingAuth(familyId) {
  await query(
    `UPDATE families SET plan_awaiting_auth = 0 WHERE id = @id AND plan_awaiting_auth = 1;`,
    { id: { type: sql.Int, value: familyId } }
  );
}

/* ------------------------------------------------------------------ */
/* Admin — PCTC worklist (spec §6.3)                                   */
/* ------------------------------------------------------------------ */

async function getPctcWorklist() {
  const r = await query(`
    SELECT p.id, p.amount, p.received_on, p.school_year, p.note,
           f.id AS family_id, f.name AS family_name
    FROM payments p
    JOIN families f ON f.id = p.family_id
    WHERE p.method = 'pctc' AND p.pctc_endorsed_on IS NULL
    ORDER BY p.received_on ASC;
  `);
  return r.recordset;
}

async function endorsePctc(paymentId, endorsedOn) {
  const r = await query(
    `UPDATE payments SET pctc_endorsed_on = @date
      WHERE id = @id AND method = 'pctc' AND pctc_endorsed_on IS NULL;`,
    {
      id: { type: sql.Int, value: paymentId },
      date: { type: sql.Date, value: endorsedOn },
    }
  );
  return r.rowsAffected[0] > 0;
}

/* ------------------------------------------------------------------ */
/* Webhook error log / payment failures (spec §6.1, §7)               */
/* ------------------------------------------------------------------ */

async function getOpenWebhookErrors() {
  const r = await query(`
    SELECT TOP 100 * FROM webhook_errors WHERE resolved = 0 ORDER BY created_at DESC;
  `);
  return r.recordset;
}

module.exports = {
  PAYMENT_METHODS,
  listSchoolYears,
  getRoster,
  getRosterSummary,
  getFamily,
  getFamilyByEmail,
  getStudentsForFamily,
  getChargesForFamily,
  getPaymentsForFamily,
  getFamilyBalance,
  updateFamily,
  setPlan,
  clearAwaitingAuth,
  addCharge,
  voidCharge,
  recordPayment,
  addStudent,
  getPctcWorklist,
  endorsePctc,
  getOpenWebhookErrors,
};
