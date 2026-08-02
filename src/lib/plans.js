'use strict';

// Payment-plan creation — the ONE write path to Stripe (spec §7.4).
//
// Rules baked in here:
//  - Amount is derived from the BALANCE, never gross tuition (PCTC is already a
//    payment row; billing gross would double-charge).
//  - Cents are split evenly across cycles with any remainder on the FINAL cycle,
//    so the billed total matches the balance exactly (no rounding delinquency).
//  - Every Stripe write carries a deterministic idempotency key
//    `plan-{familyId}-{schoolYear}` so a double-click is harmless.
//  - The local ledger is authoritative and already committed before we get here;
//    this only creates the Stripe billing objects and records their ids.
//
// The amount math (computePlan) is pure and unit-tested. createPlan performs the
// Stripe calls and needs a live (test-mode) Stripe account to exercise.

const PLAN_SPECS = {
  monthly: { object: 'subscription', intervalMonths: 1, cycles: 10, label: 'Monthly (10 payments)' },
  semester: { object: 'subscription', intervalMonths: 6, cycles: 2, label: 'Semester (2 payments)' },
  annual: { object: 'invoice', intervalMonths: 0, cycles: 1, label: 'Annual (paid in full)' },
};

function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLAN_SPECS, plan);
}

// balanceDollars -> { object, cycles, intervalMonths, amountsCents[], totalCents, label }
// Throws on a non-positive balance (nothing to bill) or unknown plan.
function computePlan(balanceDollars, plan) {
  if (!isValidPlan(plan)) throw new Error(`Unknown plan: ${plan}`);
  const totalCents = Math.round(Number(balanceDollars) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    throw new Error('Balance must be greater than zero to create a plan.');
  }
  const spec = PLAN_SPECS[plan];
  const base = Math.floor(totalCents / spec.cycles);
  const remainder = totalCents - base * spec.cycles;
  const amountsCents = Array.from({ length: spec.cycles }, () => base);
  amountsCents[spec.cycles - 1] += remainder; // remainder on the final cycle
  return {
    object: spec.object,
    cycles: spec.cycles,
    intervalMonths: spec.intervalMonths,
    label: spec.label,
    amountsCents,
    totalCents,
  };
}

// Does the Stripe customer have a payment method that a subscription can draft?
async function customerHasPaymentMethod(stripe, customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return false;
  if (customer.invoice_settings && customer.invoice_settings.default_payment_method) return true;
  if (customer.default_source) return true;
  // Fall back to listing attached methods (card or us_bank_account).
  const [cards, banks] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 }),
    stripe.paymentMethods.list({ customer: customerId, type: 'us_bank_account', limit: 1 }),
  ]);
  return (cards.data.length + banks.data.length) > 0;
}

// Create the Stripe billing objects for a family's plan.
//   ctx: { stripe, customerId, familyId, schoolYear, plan, balanceDollars }
// Returns { subscriptionId | invoiceId, awaitingAuth, computed }.
// Surfaces Stripe errors verbatim to the caller (do not swallow — spec §7.4).
async function createPlan({ stripe, customerId, familyId, schoolYear, plan, balanceDollars }) {
  const computed = computePlan(balanceDollars, plan);
  const idemKey = `plan-${familyId}-${schoolYear}`;
  const hasMethod = await customerHasPaymentMethod(stripe, customerId);

  if (computed.object === 'invoice') {
    // Annual: a single one-off invoice for the full balance. Create the invoice
    // FIRST, then attach the line item to it explicitly (a freshly created
    // invoice does not auto-pull pending invoice items in the current API), then
    // finalize so Stripe attempts the charge.
    const invoice = await stripe.invoices.create(
      {
        customer: customerId,
        collection_method: 'charge_automatically',
        auto_advance: true,
        metadata: { family_id: String(familyId), school_year: schoolYear, plan },
      },
      { idempotencyKey: `${idemKey}-invoice` }
    );
    await stripe.invoiceItems.create(
      {
        customer: customerId,
        invoice: invoice.id,
        amount: computed.amountsCents[0],
        currency: 'usd',
        description: `Tuition ${schoolYear} — paid in full`,
      },
      { idempotencyKey: `${idemKey}-item` }
    );
    await stripe.invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: `${idemKey}-finalize` });
    return { invoiceId: invoice.id, subscriptionId: null, awaitingAuth: !hasMethod, computed };
  }

  // monthly / semester: a subscription SCHEDULE so we can bill the remainder on
  // the final cycle exactly and stop after N cycles (end_behavior: cancel).
  //
  // Schedule phase price_data requires an existing Product id (unlike a plain
  // subscription, it does NOT accept inline product_data), so create one first.
  const product = await stripe.products.create(
    { name: `Tuition ${schoolYear}` },
    { idempotencyKey: `${idemKey}-product` }
  );
  const recurring = { interval: 'month', interval_count: computed.intervalMonths };
  const priceItem = (cents) => ({
    items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: cents, recurring }, quantity: 1 }],
  });
  const uniqueAmounts = new Set(computed.amountsCents);
  const phases = [];
  if (uniqueAmounts.size === 1) {
    phases.push({ ...priceItem(computed.amountsCents[0]), iterations: computed.cycles });
  } else {
    // First (cycles-1) cycles at the base amount, final cycle carries the remainder.
    phases.push({ ...priceItem(computed.amountsCents[0]), iterations: computed.cycles - 1 });
    phases.push({ ...priceItem(computed.amountsCents[computed.cycles - 1]), iterations: 1 });
  }

  const schedule = await stripe.subscriptionSchedules.create(
    {
      customer: customerId,
      start_date: 'now',
      end_behavior: 'cancel',
      phases,
      metadata: { family_id: String(familyId), school_year: schoolYear, plan },
    },
    { idempotencyKey: `${idemKey}-schedule` }
  );

  // The schedule creates/holds the subscription id once it starts.
  return {
    subscriptionId: schedule.subscription || schedule.id,
    scheduleId: schedule.id,
    invoiceId: null,
    awaitingAuth: !hasMethod,
    computed,
  };
}

module.exports = { PLAN_SPECS, isValidPlan, computePlan, customerHasPaymentMethod, createPlan };
