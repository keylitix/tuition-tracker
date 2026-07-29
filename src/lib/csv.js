'use strict';

// Admin-only CSV exports (spec §6.6): families, charges, payments — all include
// external_id, the migration path to FACTS. Uses csv-stringify for correct
// escaping of quotes/commas/newlines.

const { stringify } = require('csv-stringify/sync');
const { sql, query } = require('../db/pool');

function toCsv(columns, rows) {
  return stringify(rows, { header: true, columns });
}

async function exportFamilies() {
  const r = await query(`
    SELECT external_id, name, email, phone, stripe_customer_id, active, created_at
    FROM families ORDER BY name;
  `);
  return toCsv(
    ['external_id', 'name', 'email', 'phone', 'stripe_customer_id', 'active', 'created_at'],
    r.recordset
  );
}

async function exportCharges() {
  const r = await query(`
    SELECT f.external_id AS family_external_id,
           s.external_id AS student_external_id,
           s.first_name, s.last_name,
           ch.description, ch.amount, ch.due_date, ch.school_year, ch.voided, ch.created_at
    FROM charges ch
    JOIN students s ON s.id = ch.student_id
    JOIN families f ON f.id = s.family_id
    ORDER BY f.external_id, ch.created_at;
  `);
  return toCsv(
    ['family_external_id', 'student_external_id', 'first_name', 'last_name',
      'description', 'amount', 'due_date', 'school_year', 'voided', 'created_at'],
    r.recordset
  );
}

async function exportPayments() {
  const r = await query(`
    SELECT f.external_id AS family_external_id,
           p.amount, p.method, p.received_on, p.school_year, p.note,
           p.check_number, p.pctc_endorsed_on,
           p.stripe_payment_intent_id, p.stripe_invoice_id, p.created_at
    FROM payments p
    JOIN families f ON f.id = p.family_id
    ORDER BY f.external_id, p.received_on;
  `);
  return toCsv(
    ['family_external_id', 'amount', 'method', 'received_on', 'school_year', 'note',
      'check_number', 'pctc_endorsed_on', 'stripe_payment_intent_id', 'stripe_invoice_id', 'created_at'],
    r.recordset
  );
}

module.exports = { exportFamilies, exportCharges, exportPayments };
