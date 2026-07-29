'use strict';

// Dev seed (spec §10 step 1): a few fake families exercising every state —
// paid up, past due, and an unendorsed PCTC award the school is holding.
// Idempotent by external_id: re-running does not duplicate.
//
//   npm run seed
//
// Safe to run only against a dev database; it inserts obviously-fake data.

const bcrypt = require('bcryptjs');
const { sql, query } = require('../db/pool');

const YEAR = '2026-2027';

async function upsertFamily(f) {
  const r = await query(
    `MERGE families AS t
     USING (SELECT @ext AS external_id) AS s ON t.external_id = s.external_id
     WHEN MATCHED THEN UPDATE SET name=@name, email=@email, phone=@phone, stripe_customer_id=@scid
     WHEN NOT MATCHED THEN INSERT (external_id, name, email, phone, stripe_customer_id)
          VALUES (@ext, @name, @email, @phone, @scid)
     OUTPUT INSERTED.id;`,
    {
      ext: { type: sql.NVarChar(50), value: f.external_id },
      name: { type: sql.NVarChar(200), value: f.name },
      email: { type: sql.NVarChar(255), value: f.email },
      phone: { type: sql.NVarChar(30), value: f.phone || null },
      scid: { type: sql.NVarChar(50), value: f.stripe_customer_id || null },
    }
  );
  return r.recordset[0].id;
}

async function upsertStudent(s) {
  const r = await query(
    `MERGE students AS t
     USING (SELECT @ext AS external_id) AS s ON t.external_id = s.external_id
     WHEN MATCHED THEN UPDATE SET first_name=@fn, last_name=@ln, grade=@grade, school_year=@year, family_id=@fid
     WHEN NOT MATCHED THEN INSERT (external_id, family_id, first_name, last_name, grade, school_year)
          VALUES (@ext, @fid, @fn, @ln, @grade, @year)
     OUTPUT INSERTED.id;`,
    {
      ext: { type: sql.NVarChar(50), value: s.external_id },
      fid: { type: sql.Int, value: s.family_id },
      fn: { type: sql.NVarChar(100), value: s.first_name },
      ln: { type: sql.NVarChar(100), value: s.last_name },
      grade: { type: sql.NVarChar(20), value: s.grade || null },
      year: { type: sql.NVarChar(9), value: YEAR },
    }
  );
  return r.recordset[0].id;
}

// Insert a charge only if this student has none yet (keeps seed idempotent).
async function ensureCharge(studentId, description, amount, dueDate) {
  await query(
    `IF NOT EXISTS (SELECT 1 FROM charges WHERE student_id=@sid AND description=@desc)
       INSERT INTO charges (student_id, description, amount, due_date, school_year)
       VALUES (@sid, @desc, @amount, @due, @year);`,
    {
      sid: { type: sql.Int, value: studentId },
      desc: { type: sql.NVarChar(255), value: description },
      amount: { type: sql.Decimal(10, 2), value: amount },
      due: { type: sql.Date, value: dueDate || null },
      year: { type: sql.NVarChar(9), value: YEAR },
    }
  );
}

async function ensurePayment(familyId, p) {
  await query(
    `IF NOT EXISTS (SELECT 1 FROM payments WHERE family_id=@fid AND note=@note AND method=@method)
       INSERT INTO payments (family_id, amount, method, received_on, school_year, note, check_number, pctc_endorsed_on)
       VALUES (@fid, @amount, @method, @recv, @year, @note, @chk, @endorsed);`,
    {
      fid: { type: sql.Int, value: familyId },
      amount: { type: sql.Decimal(10, 2), value: p.amount },
      method: { type: sql.NVarChar(20), value: p.method },
      recv: { type: sql.Date, value: p.received_on },
      year: { type: sql.NVarChar(9), value: YEAR },
      note: { type: sql.NVarChar(500), value: p.note },
      chk: { type: sql.NVarChar(50), value: p.check_number || null },
      endorsed: { type: sql.Date, value: p.pctc_endorsed_on || null },
    }
  );
}

async function run() {
  // Paid-up family
  const smithId = await upsertFamily({
    external_id: 'FAM-0001', name: 'Smith Family', email: 'smith@example.com',
    phone: '405-555-0101', stripe_customer_id: 'cus_demoSmith',
  });
  const s1 = await upsertStudent({ external_id: 'STU-0001', family_id: smithId, first_name: 'Ava', last_name: 'Smith', grade: '3' });
  await ensureCharge(s1, 'Tuition 2026-2027', 6000.00, '2026-08-15');
  await ensureCharge(s1, 'Registration fee', 250.00, '2026-08-01');
  await ensurePayment(smithId, { amount: 6250.00, method: 'ach', received_on: '2026-08-10', note: 'Full year ACH' });

  // Past-due family (owes, past due date)
  const joBid = await upsertFamily({
    external_id: 'FAM-0002', name: 'Johnson Family', email: 'johnson@example.com', phone: '405-555-0102',
  });
  const s2 = await upsertStudent({ external_id: 'STU-0002', family_id: joBid, first_name: 'Liam', last_name: 'Johnson', grade: '6' });
  const s3 = await upsertStudent({ external_id: 'STU-0003', family_id: joBid, first_name: 'Noah', last_name: 'Johnson', grade: '8' });
  await ensureCharge(s2, 'Tuition 2026-2027', 6000.00, '2026-08-15');
  await ensureCharge(s3, 'Tuition 2026-2027', 6000.00, '2026-08-15');
  await ensurePayment(joBid, { amount: 2000.00, method: 'check', received_on: '2026-08-05', note: 'Partial', check_number: '1042' });

  // Family holding an UNENDORSED PCTC award (the flag that must be obvious)
  const garId = await upsertFamily({
    external_id: 'FAM-0003', name: 'Garcia Family', email: 'garcia@example.com', phone: '405-555-0103',
  });
  const s4 = await upsertStudent({ external_id: 'STU-0004', family_id: garId, first_name: 'Mia', last_name: 'Garcia', grade: '2' });
  await ensureCharge(s4, 'Tuition 2026-2027', 6000.00, '2026-08-15');
  await ensurePayment(garId, { amount: 4000.00, method: 'pctc', received_on: '2026-08-20', note: 'PCTC award — check held, awaiting endorsement', pctc_endorsed_on: null });

  console.log('Seed complete: FAM-0001 (paid up), FAM-0002 (past due), FAM-0003 (unendorsed PCTC).');
  console.log('Tip: create an admin with  npm run createadmin -- "you@school.org" "You" "password"');
  process.exit(0);
}

run().catch((err) => { console.error(err.message); process.exit(1); });
