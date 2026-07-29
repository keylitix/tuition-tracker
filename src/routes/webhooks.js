'use strict';

// POST /webhooks/stripe — public, no session/CSRF, signature-verified (spec §7).
// Mounted with express.raw BEFORE the JSON body parser so the raw bytes are
// available for signature verification. Always responds 200 quickly (except on a
// failed signature check) so Stripe stops retrying; data problems are logged, not
// thrown.

const express = require('express');
const config = require('../config');
const stripe = require('../lib/stripeClient');
const { processEvent, logWebhookError } = require('../lib/stripeEvents');

const router = express.Router();

router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      const sig = req.get('stripe-signature');
      event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
    } catch (err) {
      // Bad signature -> reject. This is the ONLY non-200 path.
      console.error('Stripe signature verification failed:', err.message);
      return res.status(400).send(`Webhook signature verification failed`);
    }

    try {
      await processEvent(event, stripe);
    } catch (err) {
      // A processing error is a server problem; log it but still 200 so Stripe
      // does not hammer us. The event id is already claimed only if it committed;
      // on throw before claim it will be retried and re-attempted.
      try {
        await logWebhookError({
          eventId: event.id,
          eventType: event.type,
          message: `Processing error: ${err.message}`,
        });
      } catch (_) { /* best effort */ }
      console.error('Webhook processing error:', err.message);
    }

    res.status(200).json({ received: true });
  }
);

module.exports = router;
