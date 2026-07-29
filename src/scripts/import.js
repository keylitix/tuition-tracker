'use strict';

// CLI bulk import for large rosters:
//   node src/scripts/import.js path/to/families.csv
// Idempotent — safe to re-run. See src/lib/import.js for the column format.

const fs = require('fs');
const { importCsv } = require('../lib/import');

async function run() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/scripts/import.js <path-to-csv>');
    process.exit(1);
  }
  const text = fs.readFileSync(file, 'utf8');
  const r = await importCsv(text);
  console.log(`Rows processed:   ${r.rowsProcessed}`);
  console.log(`Families created: ${r.familiesCreated}  (matched: ${r.familiesMatched})`);
  console.log(`Students created: ${r.studentsCreated}  (skipped: ${r.studentsSkipped})`);
  console.log(`Charges created:  ${r.chargesCreated}  (skipped: ${r.chargesSkipped})`);
  if (r.errors.length) {
    console.log(`\n${r.errors.length} row issue(s):`);
    for (const e of r.errors) console.log(`  row ${e.row}: ${e.message}`);
  }
  process.exit(0);
}

run().catch((err) => { console.error(err.message); process.exit(1); });
