'use strict';

// Parent magic-link login (spec §8). We never reveal whether an email is
// enrolled: the response is identical whether or not it matched.

const express = require('express');
const rateLimit = require('express-rate-limit');
const q = require('../lib/queries');
const magic = require('../lib/magicLink');
const { sendMagicLink } = require('../lib/mailer');
const config = require('../config');

const router = express.Router();

// Rate-limit magic-link requests by source IP as a coarse first line; a per-email
// cap (magicLink.recentRequestCount) is enforced below regardless of IP.
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many sign-in requests. Please try again later.',
});

router.get('/login', (req, res) => {
  if (req.session.family) return res.redirect('/portal');
  res.render('parent/login', { title: 'Parent sign in', sent: false });
});

router.post('/login', requestLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const family = email ? await q.getFamilyByEmail(email) : null;

    if (family) {
      const withinLimit = (await magic.recentRequestCount(family.id)) < config.magicLink.ratePerEmailPerHour;
      if (withinLimit) {
        const token = await magic.createToken(family.id);
        const url = `${config.baseUrl}/portal/verify?token=${token}`;
        await sendMagicLink(family.email, url);
      }
    }

    // Identical response in every case — do not reveal enrollment (spec §8).
    res.render('parent/login', { title: 'Parent sign in', sent: true });
  } catch (err) { next(err); }
});

router.get('/verify', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    const familyId = token ? await magic.consumeToken(token) : null;
    if (!familyId) {
      return res.status(400).render('parent/login-error', { title: 'Link expired' });
    }
    const family = await q.getFamily(familyId);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.family = { id: family.id, name: family.name };
      res.redirect('/portal');
    });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/portal/login'));
});

module.exports = router;
