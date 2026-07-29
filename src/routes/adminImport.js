'use strict';

// Bulk family/student/charge import (admin-only). Two front-ends share one engine
// (src/lib/import.js): this paste-a-CSV web page, and the `npm run import` CLI for
// large files.

const express = require('express');
const { importCsv } = require('../lib/import');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('admin/import', { title: 'Import CSV', result: null, csv: '' });
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
