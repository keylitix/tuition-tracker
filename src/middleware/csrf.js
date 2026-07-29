'use strict';

// Minimal synchronizer-token CSRF protection. A per-session random token is
// embedded in every form and compared on unsafe methods. sameSite=lax cookies
// already block cross-site form posts in modern browsers; this is defence in depth.
// The Stripe webhook route is mounted before this and uses signature verification
// instead, so it is never subject to CSRF checks.

const crypto = require('crypto');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE.has(req.method)) return next();

  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!sent || sent !== req.session.csrfToken) {
    return res.status(403).send('Invalid or missing CSRF token. Go back and try again.');
  }
  next();
}

module.exports = { csrf };
