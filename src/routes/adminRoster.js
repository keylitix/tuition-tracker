'use strict';

const express = require('express');
const q = require('../lib/queries');
const { currentSchoolYear } = require('../lib/schoolYear');

const router = express.Router();

// Roster landing page (spec §6.1).
router.get('/', async (req, res, next) => {
  try {
    const years = await q.listSchoolYears();
    const year = req.query.year || years[0] || currentSchoolYear();
    const search = (req.query.q || '').trim();

    const [rows, summary, webhookErrors] = await Promise.all([
      q.getRoster({ year, search }),
      q.getRosterSummary({ year }),
      q.getOpenWebhookErrors(),
    ]);

    res.render('admin/roster', {
      title: 'Families',
      years,
      year,
      search,
      rows,
      summary,
      webhookErrorCount: webhookErrors.length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
