'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { sql, query } = require('../db/pool');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin sign in', error: null });
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

module.exports = router;
