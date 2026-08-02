'use strict';

// Admin settings: the standard per-student tuition rate (by school year) and the
// optional-items catalog (e.g. $10 device insurance). Registration fees are not
// here — they are collected on a separate enrollment form.

const express = require('express');
const bcrypt = require('bcryptjs');
const q = require('../lib/queries');
const { normalizeAmount } = require('../lib/money');
const { currentSchoolYear } = require('../lib/schoolYear');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [rates, items, admins] = await Promise.all([
      q.listTuitionRates(),
      q.listOptionalItems(false),
      q.listAdmins(),
    ]);
    res.render('admin/settings', {
      title: 'Settings',
      rates,
      items,
      admins,
      currentAdminId: req.session.admin.id,
      defaultYear: currentSchoolYear(),
      flash: req.query.ok || null,
      error: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// Add a new admin, or reset an existing one's password (spec §8).
router.post('/admins', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const displayName = String(req.body.display_name || '').trim();
    const password = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !displayName) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent('Enter a valid email and name.'));
    }
    if (password.length < 8) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent('Password must be at least 8 characters.'));
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await q.upsertAdmin({ email, displayName, passwordHash });
    res.redirect('/admin/settings?ok=' + encodeURIComponent(`Admin saved: ${email}`));
  } catch (err) { next(err); }
});

// Deactivate an admin. Guards: can't remove yourself or the last active admin.
router.post('/admins/:id/deactivate', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.admin.id) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent('You cannot remove your own admin account.'));
    }
    if ((await q.countActiveAdmins()) <= 1) {
      return res.redirect('/admin/settings?err=' + encodeURIComponent('Cannot remove the last active admin.'));
    }
    await q.deactivateAdmin(id);
    res.redirect('/admin/settings?ok=' + encodeURIComponent('Admin removed.'));
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
