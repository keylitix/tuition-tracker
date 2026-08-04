'use strict';

// Bulk family/student/charge import (admin-only). Two front-ends share one engine
// (src/lib/import.js): this paste-a-CSV web page, and the `npm run import` CLI for
// large files.

const express = require('express');
const { importCsv } = require('../lib/import');
const { currentSchoolYear } = require('../lib/schoolYear');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('admin/import', { title: 'Import families', result: null, csv: '' });
});

// A blank template the office fills in and uploads. Friendly column headers (the
// importer normalizes them), with two example rows showing how siblings share a
// family. Only the columns the office actually types — IDs/tuition are handled
// by the app (apply standard tuition after import).
router.get('/template.csv', (req, res) => {
  const year = currentSchoolYear();
  const rows = [
    'Family Name,Family Email,Family Phone,Student First Name,Student Last Name,Grade,School Year',
    `Example Family (replace this row),parent1@example.com,405-555-0100,Ava,Example,3,${year}`,
    `Example Family (replace this row),parent1@example.com,405-555-0100,Ben,Example,5,${year}`,
    `Second Family (replace this row),parent2@example.com,405-555-0101,Mia,Sample,K,${year}`,
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="family-import-template.csv"');
  res.send(rows.join('\r\n') + '\r\n');
});

router.post('/', async (req, res, next) => {
  try {
    const csv = String(req.body.csv || '');
    if (!csv.trim()) {
      return res.status(400).render('admin/import', {
        title: 'Import CSV', result: null, csv, error: 'Paste some CSV first.',
      });
    }
    const result = await importCsv(csv);
    res.render('admin/import', { title: 'Import CSV', result, csv: '' });
  } catch (err) { next(err); }
});

module.exports = router;
