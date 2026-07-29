'use strict';

// Bulk importer for existing rosters. Accepts CSV text (from a pasted textarea or
// a file) and upserts families, students, and optional per-row charges. Idempotent:
// re-running the same file does not create duplicates. Never overwrites an existing
// family's contact fields — matched families are reused as-is.
//
// Expected header columns (case-insensitive, order-independent, extras ignored):
//   family_external_id   optional — match/create key; auto FAM-#### if blank
//   family_name          required for new families
//   family_email         required for new families
//   family_phone         optional
//   stripe_customer_id   optional
//   student_external_id  optional — match key; auto STU-#### if blank
//   student_first_name   \
//   student_last_name     } a student is created when any of these is present
//   grade                /
//   school_year          required when a student is present
//   charge_description   optional — one charge per row
//   charge_amount        optional — dollars; created unless a same-named charge exists
//   charge_due_date      optional — YYYY-MM-DD

const { parse } = require('csv-parse/sync');
const q = require('./queries');
const { normalizeAmount } = require('./money');

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
}
const val = (row, key) => String(row[key] == null ? '' : row[key]).trim();

function emptyResult() {
  return {
    rowsProcessed: 0,
    familiesCreated: 0, familiesMatched: 0,
    studentsCreated: 0, studentsSkipped: 0,
    chargesCreated: 0, chargesSkipped: 0,
    errors: [],
  };
}

async function importCsv(text) {
  const res = emptyResult();
  let rows;
  try {
    rows = parse(text, {
      columns: (hdr) => hdr.map(normHeader),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });
  } catch (err) {
    res.errors.push({ row: 0, message: `Could not parse CSV: ${err.message}` });
    return res;
  }

  let rowNum = 1; // header is line 1
  for (const row of rows) {
    rowNum++;
    try {
      const famExt = val(row, 'family_external_id');
      const familyName = val(row, 'family_name');
      const familyEmail = val(row, 'family_email').toLowerCase();

      if (!famExt && !familyName && !familyEmail) continue; // blank line

      // --- resolve or create family ---
      let family = null;
      if (famExt) family = await q.findFamilyByExternalId(famExt);
      if (!family && familyEmail) family = await q.getFamilyByEmail(familyEmail);
      if (!family) {
        if (!familyName || !familyEmail) {
          res.errors.push({ row: rowNum, message: 'New family needs family_name and family_email.' });
          continue;
        }
        const created = await q.createFamily({
          externalId: famExt,
          name: familyName,
          email: familyEmail,
          phone: val(row, 'family_phone'),
          stripeCustomerId: val(row, 'stripe_customer_id'),
        });
        family = { id: created.id };
        res.familiesCreated++;
      } else {
        res.familiesMatched++;
      }

      // --- optional student ---
      const sExt = val(row, 'student_external_id');
      const sFirst = val(row, 'student_first_name');
      const sLast = val(row, 'student_last_name');
      const schoolYear = val(row, 'school_year');
      let studentId = null;

      if (sExt || sFirst || sLast) {
        if (sExt) {
          const existing = await q.findStudentByExternalId(sExt);
          if (existing) { studentId = existing.id; res.studentsSkipped++; }
        }
        if (!studentId) {
          if (!sFirst || !sLast || !schoolYear) {
            res.errors.push({ row: rowNum, message: 'Student needs student_first_name, student_last_name, and school_year.' });
          } else {
            const siblings = await q.getStudentsForFamily(family.id);
            const dup = siblings.find((s) =>
              s.first_name.toLowerCase() === sFirst.toLowerCase() &&
              s.last_name.toLowerCase() === sLast.toLowerCase() &&
              s.school_year === schoolYear);
            if (dup) { studentId = dup.id; res.studentsSkipped++; }
            else {
              studentId = await q.addStudent({
                externalId: sExt, familyId: family.id,
                firstName: sFirst, lastName: sLast, grade: val(row, 'grade'), schoolYear,
              });
              res.studentsCreated++;
            }
          }
        }
      }

      // --- optional charge (one per row) ---
      const cDesc = val(row, 'charge_description');
      const cAmtRaw = val(row, 'charge_amount');
      if (cDesc && cAmtRaw) {
        const cYear = schoolYear || val(row, 'charge_school_year');
        if (!studentId) {
          res.errors.push({ row: rowNum, message: 'charge_amount given but no student on this row.' });
        } else if (!cYear) {
          res.errors.push({ row: rowNum, message: 'Charge needs a school_year.' });
        } else {
          const amount = normalizeAmount(cAmtRaw);
          if (amount === null) {
            res.errors.push({ row: rowNum, message: `Invalid charge_amount "${cAmtRaw}".` });
          } else {
            const existing = await q.getChargesForFamily(family.id);
            const dup = existing.find((c) =>
              c.student_id === studentId && !c.voided &&
              c.description.toLowerCase() === cDesc.toLowerCase());
            if (dup) { res.chargesSkipped++; }
            else {
              await q.addCharge({
                studentId, description: cDesc, amount,
                dueDate: val(row, 'charge_due_date') || null, schoolYear: cYear, createdBy: null,
              });
              res.chargesCreated++;
            }
          }
        }
      }

      res.rowsProcessed++;
    } catch (err) {
      // Duplicate external_id or any row error: record and keep going.
      res.errors.push({ row: rowNum, message: err.message });
    }
  }
  return res;
}

module.exports = { importCsv, normHeader };
