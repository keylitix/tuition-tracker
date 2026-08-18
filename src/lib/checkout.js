'use strict';

// Parent self-serve payments via Stripe Checkout. Stripe hosts the bank/card
// connection, the mandate, and the debit — the app only launches Checkout and
// records the result via webhook, so it never touches raw payment details (PCI
// stays out of scope).
//
// Method: 'bank' (ACH Direct Debit, no fee) or 'card' (+3% convenience fee).
// Plans (see plans.computeParentPlan):
//   - full:     one payment now.
//   - monthly:  first draft now, then monthly, LAST draft on/before May 1.
//   - semester: pay now, then again on Jan 15 (the 2nd leg is a trial-until-Jan-15
//               subscription created post-checkout in stripeEvents).

const { computeParentPlan } = require('./plans');
const config = require('../config');

const METHOD_TYPES = { bank: ['us_bank_account'], card: ['card'] };

function methodTypes(method) {
  const t = METHOD_TYPES[method];
  if (!t) throw new Error('Unknown payment method: ' + method);
  return t;
}

// Attach the family to the session: reuse their Stripe customer if we have one,
// otherwise let Checkout create/find one from their email. customer_creation is
// only valid in payment mode (subscription mode always creates a customer).
function customerFields(family, mode) {
  if (family.stripe_customer_id) return { customer: family.stripe_customer_id };
  if (mode === 'payment') return { customer_email: family.email, customer_creation: 'always' };
  return { customer_email: family.email };
}

function feeLine(feeCents) {
  return {
    price_data: {
      currency: 'usd',
      product_data: { name: 'Card convenience fee (3%)' },
      unit_amount: feeCents,
    },
    quantity: 1,
  };
}

// One-time full payment of the current balance (+3% if card).
async function createBalanceCheckout(stripe, { family, balanceDollars, schoolYear, method }) {
  const plan = computeParentPlan(balanceDollars, 'full', { now: new Date(), schoolYear, method });
  const tuitionCents = plan.tuitionCents[0];
  const feeCents = plan.feeCents[0];
  // tuition_cents lets the webhook credit ONLY tuition, never the fee.
  const metadata = {
    family_id: String(family.id), school_year: schoolYear, kind: 'balance',
    method, tuition_cents: String(tuitionCents), fee_cents: String(feeCents),
  };

  const line_items = [{
    price_data: {
      currency: 'usd',
      product_data: { name: `Tuition balance — ${schoolYear}` },
      unit_amount: tuitionCents,
    },
    quantity: 1,
  }];
  if (feeCents > 0) line_items.push(feeLine(feeCents));

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: methodTypes(method),
    ...customerFields(family, 'payment'),
    line_items,
    payment_intent_data: { metadata },
    metadata,
    success_url: `${config.baseUrl}/portal?paid=1`,
    cancel_url: `${config.baseUrl}/portal?canceled=1`,
  });
  return session.url;
}

// Monthly autopay: first draft now, then monthly, last draft on/before May 1.
// Checkout subscriptions bill one flat recurring amount, so the per-cycle base
// (tuition + its 3% fee if card) is the recurring price and any cents remainder
// rides on a one-time line item charged with the first payment. The subscription
// is stopped after `cycles` drafts by cancel_at (set in stripeEvents post-checkout).
async function createMonthlyCheckout(stripe, { family, balanceDollars, schoolYear, method }) {
  const plan = computeParentPlan(balanceDollars, 'monthly', { now: new Date(), schoolYear, method });
  const base = plan.tuitionCents[0] + plan.feeCents[0];
  const grandTotal = plan.totalWithFeeCents;
  const remainder = grandTotal - base * plan.cycles;
  const metadata = {
    family_id: String(family.id), school_year: schoolYear, kind: 'autopay',
    plan: 'monthly', method, cycles: String(plan.cycles), interval_months: '1',
  };

  const line_items = [{
    price_data: {
      currency: 'usd',
      product_data: { name: `Tuition autopay — ${schoolYear}` },
      unit_amount: base,
      recurring: { interval: 'month', interval_count: 1 },
    },
    quantity: 1,
  }];
  if (remainder > 0) {
    line_items.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'Balance adjustment (one-time, first payment)' },
        unit_amount: remainder,
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: methodTypes(method),
    ...customerFields(family, 'subscription'),
    line_items,
    subscription_data: { metadata },
    metadata,
    success_url: `${config.baseUrl}/portal?autopay=1`,
    cancel_url: `${config.baseUrl}/portal?canceled=1`,
  });
  return session.url;
}

// Semester: pay HALF now (one-time), and set up a second HALF to draft on Jan 15.
// The "now" leg is a one-time Checkout that ALSO saves the payment method
// (setup_future_usage) so the Jan-15 leg can be drafted off-session. stripeEvents
// creates that second, trial-until-Jan-15 subscription once this checkout completes.
async function createSemesterCheckout(stripe, { family, balanceDollars, schoolYear, method }) {
  const plan = computeParentPlan(balanceDollars, 'semester', { now: new Date(), schoolYear, method });
  const firstTuition = plan.tuitionCents[0];
  const firstFee = plan.feeCents[0];
  const jan15Unix = Math.floor(plan.secondChargeDate.getTime() / 1000);
  const metadata = {
    family_id: String(family.id), school_year: schoolYear, kind: 'balance',
    plan: 'semester', method,
    tuition_cents: String(firstTuition), fee_cents: String(firstFee),
    second_tuition_cents: String(plan.tuitionCents[1]),
    second_fee_cents: String(plan.feeCents[1]),
    jan15: String(jan15Unix),
  };

  const line_items = [{
    price_data: {
      currency: 'usd',
      product_data: { name: `Tuition — first semester payment (${schoolYear})` },
      unit_amount: firstTuition,
    },
    quantity: 1,
  }];
  if (firstFee > 0) line_items.push(feeLine(firstFee));

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: methodTypes(method),
    ...customerFields(family, 'payment'),
    line_items,
    // Save the method + mandate so the Jan-15 leg can draft off-session.
    payment_intent_data: { metadata, setup_future_usage: 'off_session' },
    metadata,
    success_url: `${config.baseUrl}/portal?semester=1`,
    cancel_url: `${config.baseUrl}/portal?canceled=1`,
  });
  return session.url;
}

// Dispatch by plan choice.
async function createCheckout(stripe, { family, balanceDollars, schoolYear, plan, method }) {
  if (plan === 'full') return createBalanceCheckout(stripe, { family, balanceDollars, schoolYear, method });
  if (plan === 'monthly') return createMonthlyCheckout(stripe, { family, balanceDollars, schoolYear, method });
  if (plan === 'semester') return createSemesterCheckout(stripe, { family, balanceDollars, schoolYear, method });
  throw new Error('Please choose a payment option.');
}

// Guard against a parent paying twice. Returns a message to show (and block) when
// the family already has an active plan or a payment in flight; null if it's safe
// to start a new checkout. Checks the ledger's plan flag first (no API call), then
// Stripe for active subscriptions or a processing/awaiting-verification payment.
async function existingPaymentBlock(stripe, family) {
  if (family.payment_plan) {
    return 'Your family is already set up on a payment plan — no need to pay again. To change how you pay, please contact the school office.';
  }
  if (!family.stripe_customer_id) return null;
  try {
    const subs = await stripe.subscriptions.list({ customer: family.stripe_customer_id, status: 'all', limit: 20 });
    if (subs.data.some((s) => ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'].includes(s.status))) {
      return 'You already have a payment plan set up (it may still be verifying your bank). No need to pay again — if you need to change it, contact the school office.';
    }
    const pis = await stripe.paymentIntents.list({ customer: family.stripe_customer_id, limit: 20 });
    if (pis.data.some((pi) => ['processing', 'requires_action'].includes(pi.status))) {
      return 'You already have a payment in progress. Bank (ACH) payments take a few business days to clear — please wait for it to finish before paying again. If you think this is a mistake, contact the office.';
    }
  } catch (e) {
    // If the check itself fails, don't block a legitimate payment — just log.
    console.error('existingPaymentBlock check failed:', e.message);
  }
  return null;
}

// Deep-link into the family's Stripe Customer Portal (manage/replace payment method).
// Requires the Customer Portal to be activated once in the Stripe dashboard.
async function createBillingPortal(stripe, family) {
  if (!family.stripe_customer_id) throw new Error('No Stripe customer yet — make a payment first.');
  const session = await stripe.billingPortal.sessions.create({
    customer: family.stripe_customer_id,
    return_url: `${config.baseUrl}/portal`,
  });
  return session.url;
}

module.exports = {
  createCheckout, createBalanceCheckout, createMonthlyCheckout, createSemesterCheckout,
  createBillingPortal, existingPaymentBlock,
};
