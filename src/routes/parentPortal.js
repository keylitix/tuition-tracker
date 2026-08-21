'use strict';

// Read-only parent portal (spec §6.4) + self-serve ACH payments. CRITICAL: every
// query is scoped to req.familyId (from the session, set by requireParent) — never
// to a route or query parameter. A parent must never see another family's data
// (see test/parent-scope.test.js). All payment collection is hosted by Stripe
// Checkout — the app never touches bank details.

const express = require('express');
const q = require('../lib/queries');
const { streamStatement } = require('../lib/pdf');
const { normalizeAmount } = require('../lib/money');
const checkout = require('../lib/checkout');
const plans = require('../lib/plans');
const stripe = require('../lib/stripeClient');
const { currentSchoolYear } = require('../lib/schoolYear');
const config = require('../config');

// Date-based rules for the "Other amount" option, in dollars for the view.
function customPolicyView(balance, schoolYear) {
  try {
    const p = plans.customPaymentPolicy(balance.balance, balance.charged, balance.paid, { now: new Date(), schoolYear });
    return {
      minDollars: p.minCents / 100,
      defaultDollars: p.defaultCents / 100,
      balanceDollars: p.balanceCents / 100,
      remainingHalfDollars: p.remainingHalfCents / 100,
      halfDollars: p.halfCents / 100,
      afterJan15: p.afterJan15,
      afterMay1: p.afterMay1,
    };
  } catch (_) { return null; }
}

// Preview each plan for a given method (bank/card): the first payment amount, the
// number of payments, and the total incl. any card fee. Drives the portal picker.
function planPreviews(balanceDollars, method, schoolYear) {
  const now = new Date();
  const out = {};
  for (const p of ['full', 'monthly', 'semester']) {
    try {
      const c = plans.computeParentPlan(balanceDollars, p, { now, schoolYear, method });
      out[p] = {
        cycles: c.cycles,
        firstPayment: (c.tuitionCents[0] + c.feeCents[0]) / 100,
        feeTotal: c.feeTotalCents / 100,
        total: c.totalWithFeeCents / 100,
      };
    } catch (_) { out[p] = null; }
  }
  return out;
}

const router = express.Router();

function portalFlash(query) {
  if (query.paid) return 'Payment started. Bank (ACH) debits take a few business days to clear — it will appear here once it settles.';
  if (query.autopay) return 'Autopay is set up. Your payment method will be drafted automatically each cycle.';
  if (query.semester) return 'First semester payment started. Your second payment will draft automatically on January 15.';
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
    const schoolYear = currentSchoolYear();
    res.render('parent/portal', {
      title: 'Your tuition',
      family,
      students,
      charges,
      payments,
      balance,
      hasStripeCustomer: !!family.stripe_customer_id,
      hasPlan: !!family.payment_plan,
      planLabel: family.payment_plan ? (plans.PLAN_SPECS[family.payment_plan] || {}).label || family.payment_plan : null,
      feeRatePct: Math.round(plans.CONVENIENCE_FEE_RATE * 100),
      previews: {
        bank: planPreviews(balance.balance, 'bank', schoolYear),
        card: planPreviews(balance.balance, 'card', schoolYear),
      },
      custom: customPolicyView(balance, schoolYear),
      flash: portalFlash(req.query),
      error: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// One payment picker: pay in full now, or set up monthly / semester autopay.
// Everything is collected on Stripe's hosted Checkout (ACH), so the app never
// touches bank details.
router.post('/checkout', async (req, res, next) => {
  try {
    const plan = String(req.body.choice || '').trim();       // full | monthly | semester | other
    const method = String(req.body.method || 'bank').trim();  // bank | card
    if (!['full', 'monthly', 'semester', 'other'].includes(plan)) {
      return res.redirect('/portal?err=' + encodeURIComponent('Please choose a payment option.'));
    }
    if (!['bank', 'card'].includes(method)) {
      return res.redirect('/portal?err=' + encodeURIComponent('Please choose how you\'d like to pay.'));
    }
    const family = await q.getFamily(req.familyId);
    const bal = await q.getFamilyBalance(req.familyId);
    if (bal.balance <= 0) {
      return res.redirect('/portal?err=' + encodeURIComponent('Your balance is already paid in full.'));
    }

    // "Other amount": validate the entered amount against the date-based floor
    // (at least the remaining half in January, the full balance on/after May 1).
    let amountDollars = null;
    if (plan === 'other') {
      const schoolYear = currentSchoolYear();
      const policy = plans.customPaymentPolicy(bal.balance, bal.charged, bal.paid, { now: new Date(), schoolYear });
      amountDollars = normalizeAmount(req.body.amount);
      const cents = Math.round(Number(amountDollars) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        return res.redirect('/portal?err=' + encodeURIComponent('Enter a valid amount to pay.'));
      }
      if (cents > policy.balanceCents) {
        return res.redirect('/portal?err=' + encodeURIComponent(`That's more than your balance of $${(policy.balanceCents / 100).toFixed(2)}.`));
      }
      if (cents < policy.minCents) {
        const msg = policy.afterMay1
          ? `Your full balance of $${(policy.balanceCents / 100).toFixed(2)} is now due — please pay it in full.`
          : `At least $${(policy.minCents / 100).toFixed(2)} is due by January 15. Please enter that amount or more.`;
        return res.redirect('/portal?err=' + encodeURIComponent(msg));
      }
    }

    // Don't let a parent pay twice — block if a plan or payment is already in flight.
    const block = await checkout.existingPaymentBlock(stripe, family);
    if (block) return res.redirect('/portal?err=' + encodeURIComponent(block));
    let url;
    try {
      url = await checkout.createCheckout(stripe, {
        family, balanceDollars: bal.balance, schoolYear: currentSchoolYear(), plan, method, amountDollars,
      });
    } catch (e) {
      console.error('Checkout failed:', e.message);
      return res.redirect('/portal?err=' + encodeURIComponent('Online payment is temporarily unavailable. Please try again later or contact the office.'));
    }
    res.redirect(url); // -> Stripe Checkout (external)
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
    const year = (await q.familyLatestSchoolYear(req.familyId)) || currentSchoolYear();
    const [students, charges, payments, balance] = await Promise.all([
      q.getStudentsForFamily(req.familyId, year),
      q.getChargesForFamily(req.familyId, year),
      q.getPaymentsForFamily(req.familyId, year),
      q.getFamilyBalance(req.familyId, year),
    ]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="statement.pdf"`);
    streamStatement(res, { family, schoolYear: year, students, charges, payments, balance });
  } catch (err) { next(err); }
});

module.exports = router;
