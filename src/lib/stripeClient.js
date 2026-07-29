'use strict';

// Single shared Stripe client, configured from secrets. Used by both the webhook
// handler (read side) and the plan-creation write path (spec §7.4).

const Stripe = require('stripe');
const config = require('../config');

// In production the key is required (config.js throws if missing). In dev without
// a key, fall back to a placeholder so the app still boots — any real Stripe call
// will fail loudly, which is fine locally. The Stripe SDK does not validate the
// key format until a request is actually made.
const stripe = new Stripe(config.stripe.secretKey || 'sk_test_placeholder_dev_only');

module.exports = stripe;
