'use strict';

// Read-only parent portal (spec §6.4) + self-serve ACH payments. CRITICAL: every
// query is scoped to req.familyId (from the session, set by requireParent) — never
// to a route or query parameter. A parent must never see another family's data
// (see test/parent-scope.test.js). All payment collection is hosted by Stripe
// Checkout — the app never touches bank details.

const express = require('express');
const q = require('../lib/queries');
const { streamStatement } = require('../lib/pdf');
const checkout = require('../lib/checkout');
const stripe = require('../lib/stripeClient');
const { currentSchoolYear } = require('../lib/schoolYear');
const config = require('../config');

const router = express.Router();

function portalFlash(query) {
  if (query.paid) return 'Payment started. Bank (ACH) debits take a few business days to clear — it will appear here once it settles.';
  if (query.autopay) return 'Autopay is set up. Your bank will be drafted automatically each cycle.';
  if (query.canceled) return null; // silent — parent backed out of checkout
  return null;
}

router.get('/', async (req, res, next) => {
  try {
    const family = await q.getFamily(req.familyId);
    const [students, charges, payments, balance] = await Promise.all([
      q.getStudentsForFamily(req.familyId),
      q.getChargesForFamily(req.familyId),
      q.getPaymentsForFamily(req.familyId),
      q.getFamilyBalance(req.familyId),
    ]);
    res.render('parent/portal', {
      title: 'Your tuition',
      family,
      students,
      charges,
      payments,
      balance,
      hasStripeCustomer: !!family.stripe_customer_id,
      hasPlan: !!family.payment_plan,
      flash: portalFlash(req.query),
      error: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// Pay the full current balance now (one-time ACH).
router.post('/pay', async (req, res, next) => {
  try {
    const family = await q.getFamily(req.familyId);
    const bal = await q.getFamilyBalance(req.familyId);
    if (bal.balance <= 0) {
      return res.redirect('/portal?err=' + encodeURIComponent('Your balance is already paid in full.'));
    }
    let url;
    try {
      url = await checkout.createBalanceCheckout(stripe, {
        family, balanceDollars: bal.balance, schoolYear: currentSchoolYear(),
      });
    } catch (e) {
      console.error('Balance checkout failed:', e.message);
      return res.redirect('/portal?err=' + encodeURIComponent('Online payment is temporarily unavailable. Please try again later or contact the office.'));
    }
    res.redirect(url); // -> Stripe Checkout (external)
  } catch (err) { next(err); }
});

// Set up recurring ACH autopay (monthly or semester).
router.post('/autopay', async (req, res, next) => {
  try {
    const plan = String(req.body.plan || '').trim();
    const family = await q.getFamily(req.familyId);
    const bal = await q.getFamilyBalance(req.familyId);
    if (bal.balance <= 0) {
      return res.redirect('/portal?err=' + encodeURIComponent('Your balance is already paid in full.'));
    }
    let url;
    try {
      url = await checkout.createAutopayCheckout(stripe, {
        family, plan, balanceDollars: bal.balance, schoolYear: currentSchoolYear(),
      });
    } catch (e) {
      console.error('Autopay checkout failed:', e.message);
      return res.redirect('/portal?err=' + encodeURIComponent('Could not start autopay. Please try again later or contact the office.'));
    }
    res.redirect(url);
  } catch (err) { next(err); }
});

// Manage bank details via the Stripe Customer Portal (deep-link, no re-login).
router.get('/billing', async (req, res, next) => {
  try {
    const family = await q.getFamily(req.familyId);
    let url;
    try {
      url = await checkout.createBillingPortal(stripe, family);
    } catch (e) {
      console.error('Billing portal failed:', e.message);
      return res.redirect('/portal?err=' + encodeURIComponent('Bank management is unavailable until you\'ve made a payment. Please use "Pay now" or "Set up autopay" first.'));
    }
    res.redirect(url);
  } catch (err) { next(err); }
});

router.get('/statement.pdf', async (req, res, next) => {
  try {
    const family = await q.getFamily(req.familyId);
    const [students, charges, payments, balance] = await Promise.all([
      q.getStudentsForFamily(req.familyId),
      q.getChargesForFamily(req.familyId),
      q.getPaymentsForFamily(req.familyId),
      q.getFamilyBalance(req.familyId),
    ]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="statement.pdf"`);
    streamStatement(res, { family, schoolYear: null, students, charges, payments, balance });
  } catch (err) { next(err); }
});

module.exports = router;
