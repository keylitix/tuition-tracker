'use strict';

// PCTC worklist (spec §6.3): the office's daily driver in Aug/Sep. Lists every
// PCTC payment the school is holding but cannot deposit (endorsement date NULL),
// with one-click endorsement.

const express = require('express');
const q = require('../lib/queries');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await q.getPctcWorklist();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    res.render('admin/pctc', { title: 'PCTC worklist', rows, total, flash: req.query.ok || null });
  } catch (err) { next(err); }
});

router.post('/:paymentId/endorse', async (req, res, next) => {
  try {
    const paymentId = parseInt(req.params.paymentId, 10);
    const endorsedOn = req.body.pctc_endorsed_on || new Date().toISOString().slice(0, 10);
    await q.endorsePctc(paymentId, endorsedOn);
    res.redirect('/admin/pctc?ok=Endorsement+recorded');
  } catch (err) { next(err); }
});

module.exports = router;
