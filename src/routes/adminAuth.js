'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { sql, query } = require('../db/pool');
const q = require('../lib/queries');
const reset = require('../lib/adminReset');
const { sendPasswordReset } = require('../lib/mailer');
const config = require('../config');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', {
    title: 'Admin sign in',
    error: null,
    notice: req.query.reset ? 'Your password has been reset. Sign in with your new password.' : null,
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const r = await query(
      'SELECT * FROM admin_users WHERE email = @email AND active = 1;',
      { email: { type: sql.NVarChar(255), value: email } }
    );
    const user = r.recordset[0];
    // Always run a compare to keep timing uniform whether or not the user exists.
    const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) {
      return res.status(401).render('admin/login', { title: 'Admin sign in', error: 'Invalid email or password.' });
    }
    // Prevent session fixation: regenerate before storing identity.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.admin = { id: user.id, email: user.email, displayName: user.display_name };
      res.redirect('/admin');
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

/* ---------------- Password reset ---------------- */

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many reset requests. Please try again later.',
});

// Request a reset link.
router.get('/forgot', (req, res) => {
  res.render('admin/forgot', { title: 'Reset password', sent: false });
});

router.post('/forgot', forgotLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const admin = email ? await q.getAdminByEmail(email) : null;
    if (admin) {
      const within = (await reset.recentRequestCount(admin.id)) < config.adminReset.ratePerEmailPerHour;
      if (within) {
        const token = await reset.createToken(admin.id);
        const url = `${config.baseUrl}/admin/reset?token=${token}`;
        try { await sendPasswordReset(admin.email, url); }
        catch (e) { console.error('Admin reset email failed:', e.message); }
      }
    }
    // Identical response whether or not the email matched — don't reveal admins.
    res.render('admin/forgot', { title: 'Reset password', sent: true });
  } catch (err) { next(err); }
});

// Set a new password from a reset link.
router.get('/reset', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    const adminId = token ? await reset.peekToken(token) : null;
    if (!adminId) return res.status(400).render('admin/reset-error', { title: 'Link expired' });
    res.render('admin/reset', { title: 'Set a new password', token, error: null });
  } catch (err) { next(err); }
});

router.post('/reset', async (req, res, next) => {
  try {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirm || '');
    const rerender = (error) => res.status(400).render('admin/reset', { title: 'Set a new password', token, error });

    if (password.length < 8) return rerender('Password must be at least 8 characters.');
    if (password !== confirm) return rerender('Passwords do not match.');

    // Consume the token atomically (single-use) and update the password.
    const adminId = await reset.consumeToken(token);
    if (!adminId) return res.status(400).render('admin/reset-error', { title: 'Link expired' });

    const hash = await bcrypt.hash(password, 12);
    await q.setAdminPassword(adminId, hash);
    res.redirect('/admin/login?reset=1');
  } catch (err) { next(err); }
});

module.exports = router;
