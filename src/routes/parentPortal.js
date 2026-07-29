'use strict';

// Read-only parent portal (spec §6.4). CRITICAL: every query is scoped to
// req.familyId (from the session, set by requireParent) — never to a route or
// query parameter. A parent must never see another family's data (see the test
// in test/parent-scope.test.js).

const express = require('express');
const q = require('../lib/queries');
const { streamStatement } = require('../lib/pdf');
const config = require('../config');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const family = await q.getFamily(req.familyId);
    const [students, charges, payments, balance] = await Promise.all([
      q.getStudentsForFamily(req.familyId),
      q.getChargesForFamily(req.familyId),
      q.getPaymentsForFamily(req.familyId),
      q.getFamilyBalance(req.familyId),
    ]);
    res.render('parent/portal', {
      title: 'Your tuition',
      family,
      students,
      charges,
      payments,
      balance,
      stripePortalUrl: config.stripe.customerPortalUrl,
    });
  } catch (err) { next(err); }
});

router.get('/statement.pdf', async (req, res, next) => {
  try {
    const family = await q.getFamily(req.familyId);
    const [students, charges, payments, balance] = await Promise.all([
      q.getStudentsForFamily(req.familyId),
      q.getChargesForFamily(req.familyId),
      q.getPaymentsForFamily(req.familyId),
      q.getFamilyBalance(req.familyId),
    ]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="statement.pdf"`);
    streamStatement(res, { family, schoolYear: null, students, charges, payments, balance });
  } catch (err) { next(err); }
});

module.exports = router;
