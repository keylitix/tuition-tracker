'use strict';

// Parent self-serve ACH payments via Stripe Checkout. Stripe hosts the bank
// connection, the ACH mandate, and the debit — the app only launches Checkout and
// records the result via webhook, so it never touches bank details (PCI stays out
// of scope). Restricted to us_bank_account (ACH Direct Debit).

const { computePlan } = require('./plans');
const config = require('../config');

// Attach the family to the session: reuse their Stripe customer if we have one,
// otherwise let Checkout create/find one from their email. customer_creation is
// only valid in payment mode (subscription mode always creates a customer).
function customerFields(family, mode) {
  if (family.stripe_customer_id) return { customer: family.stripe_customer_id };
  if (mode === 'payment') return { customer_email: family.email, customer_creation: 'always' };
  return { customer_email: family.email };
}

// One-time ACH payment of the current balance.
async function createBalanceCheckout(stripe, { family, balanceDollars, schoolYear }) {
  const cents = Math.round(Number(balanceDollars) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('There is no balance to pay.');
  const metadata = { family_id: String(family.id), school_year: schoolYear, kind: 'balance' };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['us_bank_account'],
    ...customerFields(family, 'payment'),
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `Tuition balance — ${schoolYear}` },
        unit_amount: cents,
      },
      quantity: 1,
    }],
    // Metadata on the PaymentIntent so payment_intent.succeeded can map it back.
    payment_intent_data: { metadata },
    metadata,
    success_url: `${config.baseUrl}/portal?paid=1`,
    cancel_url: `${config.baseUrl}/portal?canceled=1`,
  });
  return session.url;
}

// Recurring ACH autopay for the balance (monthly = 9 cycles, semester = 2).
// Uses the same cents split as the office plan; the rounding remainder rides on a
// one-time line item (charged with the first payment) so the total is exact.
async function createAutopayCheckout(stripe, { family, plan, balanceDollars, schoolYear }) {
  if (plan !== 'monthly' && plan !== 'semester') {
    throw new Error('Autopay is available monthly or by semester.');
  }
  const computed = computePlan(balanceDollars, plan);
  const base = computed.amountsCents[0];
  const remainder = computed.totalCents - base * computed.cycles;
  const metadata = {
    family_id: String(family.id), school_year: schoolYear, kind: 'autopay',
    plan, cycles: String(computed.cycles), interval_months: String(computed.intervalMonths),
  };

  const line_items = [{
    price_data: {
      currency: 'usd',
      product_data: { name: `Tuition autopay — ${schoolYear}` },
      unit_amount: base,
      recurring: { interval: 'month', interval_count: computed.intervalMonths },
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
    payment_method_types: ['us_bank_account'],
    ...customerFields(family, 'subscription'),
    line_items,
    subscription_data: { metadata },
    metadata,
    success_url: `${config.baseUrl}/portal?autopay=1`,
    cancel_url: `${config.baseUrl}/portal?canceled=1`,
  });
  return session.url;
}

// Guard against a parent paying twice. Returns a message to show (and block) when
// the family already has an active plan or a payment in flight; null if it's safe
// to start a new checkout. Checks the ledger's plan flag first (no API call), then
// Stripe for active subscriptions or a processing/awaiting-verification payment.
async function existingPaymentBlock(stripe, family) {
  if (family.payment_plan) {
    return 'Your family is already set up on autopay — your bank is drafted automatically. To change how you pay, please contact the school office.';
  }
  if (!family.stripe_customer_id) return null;
  try {
    const subs = await stripe.subscriptions.list({ customer: family.stripe_customer_id, status: 'all', limit: 20 });
    if (subs.data.some((s) => ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'].includes(s.status))) {
      return 'You already have autopay set up (it may still be verifying your bank). No need to pay again — if you need to change it, contact the school office.';
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

// Deep-link into the family's Stripe Customer Portal (manage/replace bank details).
// Requires the Customer Portal to be activated once in the Stripe dashboard.
async function createBillingPortal(stripe, family) {
  if (!family.stripe_customer_id) throw new Error('No Stripe customer yet — make a payment first.');
  const session = await stripe.billingPortal.sessions.create({
    customer: family.stripe_customer_id,
    return_url: `${config.baseUrl}/portal`,
  });
  return session.url;
}

module.exports = { createBalanceCheckout, createAutopayCheckout, createBillingPortal, existingPaymentBlock };
