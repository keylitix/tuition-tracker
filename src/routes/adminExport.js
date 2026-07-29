'use strict';

// CSV exports (spec §6.6), admin-only. All include external_id — the migration
// path to FACTS.

const express = require('express');
const csv = require('../lib/csv');

const router = express.Router();

function send(res, name, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(body);
}

router.get('/families.csv', async (req, res, next) => {
  try { send(res, 'families.csv', await csv.exportFamilies()); } catch (err) { next(err); }
});
router.get('/charges.csv', async (req, res, next) => {
  try { send(res, 'charges.csv', await csv.exportCharges()); } catch (err) { next(err); }
});
router.get('/payments.csv', async (req, res, next) => {
  try { send(res, 'payments.csv', await csv.exportPayments()); } catch (err) { next(err); }
});

module.exports = router;
