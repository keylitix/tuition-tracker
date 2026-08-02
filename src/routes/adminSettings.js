'use strict';

// Admin settings: the standard per-student tuition rate (by school year) and the
// optional-items catalog (e.g. $10 device insurance). Registration fees are not
// here — they are collected on a separate enrollment form.

const express = require('express');
const q = require('../lib/queries');
const { normalizeAmount } = require('../lib/money');
const { currentSchoolYear } = require('../lib/schoolYear');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [rates, items] = await Promise.all([
      q.listTuitionRates(),
      q.listOptionalItems(false),
    ]);
    res.render('admin/settings', {
      title: 'Settings',
      rates,
      items,
      defaultYear: currentSchoolYear(),
      flash: req.query.ok || null,
      error: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// Set/update the standard tuition for a school year.
router.post('/tuition', async (req, res, next) => {
  try {
    const year = String(req.body.school_year || '').trim();
    const amount = normalizeAmount(req.body.annual_tuition);
    if (!/^\d{4}-\d{4}$/.test(year) || amount === null || amount < 0) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent('Enter a valid school year (YYYY-YYYY) and amount.'));
    }
    await q.upsertTuitionRate(year, amount);
    res.redirect('/admin/settings?ok=' + encodeURIComponent('Tuition rate saved.'));
  } catch (err) { next(err); }
});

// Re-price every active family to the current standard tuition for a year.
router.post('/tuition/apply-all', async (req, res, next) => {
  try {
    const year = String(req.body.school_year || '').trim();
    if (!/^\d{4}-\d{4}$/.test(year)) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent('Choose a valid school year.'));
    }
    const t = await q.applyStandardTuitionToAll(year, req.session.admin.id);
    if (t.noRate) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent(`Set a tuition rate for ${year} first.`));
    }
    const msg = `Synced ${year}: ${t.added} added, ${t.repriced} re-priced, ${t.unchanged} already current across ${t.families} families.`;
    res.redirect('/admin/settings?ok=' + encodeURIComponent(msg));
  } catch (err) { next(err); }
});

// Add an optional item to the catalog.
router.post('/items', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const amount = normalizeAmount(req.body.amount);
    if (!name || amount === null || amount < 0) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent('Enter an item name and a valid amount.'));
    }
    await q.createOptionalItem(name, amount);
    res.redirect('/admin/settings?ok=' + encodeURIComponent('Optional item added.'));
  } catch (err) { next(err); }
});

router.post('/items/:id/deactivate', async (req, res, next) => {
  try {
    await q.deactivateOptionalItem(parseInt(req.params.id, 10));
    res.redirect('/admin/settings?ok=' + encodeURIComponent('Optional item removed.'));
  } catch (err) { next(err); }
});

module.exports = router;
