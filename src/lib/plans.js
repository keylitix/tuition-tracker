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
  monthly: { object: 'subscription', intervalMonths: 1, cycles: 9, label: 'Monthly (through May 1)' },
  semester: { object: 'subscription', intervalMonths: 6, cycles: 2, label: 'Semester (now + Jan 15)' },
  annual: { object: 'invoice', intervalMonths: 0, cycles: 1, label: 'Annual (paid in full)' },
};

function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLAN_SPECS, plan);
}

// ---------------------------------------------------------------------------
// Parent self-serve plans (portal). These are DATE-ANCHORED to the school year,
// unlike the office PLAN_SPECS above:
//   - monthly:  first draft now, then monthly, LAST draft on/before May 1 of the
//               school year's spring. The number of payments is however many
//               monthly drafts fit before May 1, and the balance is split evenly.
//   - semester: two equal payments — one now, one on Jan 15 of the spring.
//   - full:     one payment now.
// Card payers also owe a 3% convenience fee ON TOP of tuition (bank/ACH is free).
// The fee is charged in Stripe but is NOT tuition — the ledger only ever credits
// the tuition portion, so a family's balance still zeroes out exactly.
const CONVENIENCE_FEE_RATE = 0.03;

// UTC month add that clamps to the last valid day (Jan 31 + 1mo -> Feb 28/29).
function addUTCMonths(date, months) {
  const d = new Date(date.getTime());
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDay));
  return d;
}

// "2026-2027" -> 2027 (the calendar year that holds Jan 15 / May 1).
function springYear(schoolYear) {
  const m = /^(\d{4})-(\d{4})$/.exec(String(schoolYear || ''));
  if (!m) throw new Error('Invalid school year: ' + schoolYear);
  return parseInt(m[2], 10);
}

// Fixed spring anchor dates (noon UTC to stay clear of DST/timezone edges).
function may1Of(schoolYear) { return new Date(Date.UTC(springYear(schoolYear), 4, 1, 12)); }
function jan15Of(schoolYear) { return new Date(Date.UTC(springYear(schoolYear), 0, 15, 12)); }

// How many monthly drafts (first = now) land on or before May 1. Always >= 1, so
// a family enrolling after May 1 still gets a single "pay now" cycle.
function monthlyCyclesUntilMay1(start, schoolYear) {
  const may1 = may1Of(schoolYear);
  let count = 0;
  let d = new Date(start.getTime());
  while (d.getTime() <= may1.getTime() && count < 24) { count += 1; d = addUTCMonths(d, 1); }
  return Math.max(1, count);
}

// Even cents split with the rounding remainder on the FINAL cycle.
function splitCents(totalCents, n) {
  const base = Math.floor(totalCents / n);
  const arr = Array.from({ length: n }, () => base);
  arr[n - 1] += totalCents - base * n;
  return arr;
}

function feeCentsFor(tuitionCents, method) {
  return method === 'card' ? Math.round(tuitionCents * CONVENIENCE_FEE_RATE) : 0;
}

// Build a parent plan from the balance + choices. Pure and unit-tested.
//   plan:   'full' | 'monthly' | 'semester'
//   method: 'bank' | 'card'
//   now:    Date (the enrollment moment; defaults handled by caller)
// Returns per-cycle tuition + fee (cents), the total incl. fee, and any anchor
// date the caller needs (semester's 2nd charge).
function computeParentPlan(balanceDollars, plan, { now, schoolYear, method }) {
  const totalCents = Math.round(Number(balanceDollars) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    throw new Error('Balance must be greater than zero to pay.');
  }
  if (method !== 'bank' && method !== 'card') throw new Error('Unknown method: ' + method);
  const start = new Date(now);

  let cycles; let tuitionCents; let intervalMonths = null; let secondChargeDate = null;
  if (plan === 'full') {
    cycles = 1; tuitionCents = [totalCents];
  } else if (plan === 'monthly') {
    cycles = monthlyCyclesUntilMay1(start, schoolYear);
    tuitionCents = splitCents(totalCents, cycles);
    intervalMonths = 1;
  } else if (plan === 'semester') {
    cycles = 2; tuitionCents = splitCents(totalCents, 2);
    secondChargeDate = jan15Of(schoolYear);
  } else {
    throw new Error('Unknown plan: ' + plan);
  }

  const feeCents = tuitionCents.map((t) => feeCentsFor(t, method));
  const feeTotalCents = feeCents.reduce((a, b) => a + b, 0);
  return {
    plan, method, cycles, tuitionCents, feeCents, intervalMonths, secondChargeDate,
    tuitionTotalCents: totalCents,
    feeTotalCents,
    totalWithFeeCents: totalCents + feeTotalCents,
  };
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
  const idemKey = `plan-${familyId}-${schoolYear}`;
  const hasMethod = await customerHasPaymentMethod(stripe, customerId);

  if (plan === 'annual') {
    // Annual: a single one-off invoice for the full balance. Create the invoice
    // FIRST, then attach the line item to it explicitly (a freshly created
    // invoice does not auto-pull pending invoice items in the current API), then
    // finalize so Stripe attempts the charge.
    const computed = computePlan(balanceDollars, plan);
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

  // monthly / semester: a subscription SCHEDULE, date-anchored to the school year
  // (the SAME rules parents see in the portal, minus the card fee — office plans
  // draft whatever method is on file). Schedule phase price_data requires an
  // existing Product id (it rejects inline product_data), so create one first.
  const computed = computeParentPlan(balanceDollars, plan, { now: new Date(), schoolYear, method: 'bank' });
  const product = await stripe.products.create(
    { name: `Tuition ${schoolYear}` },
    { idempotencyKey: `${idemKey}-product` }
  );

  let phases;
  if (plan === 'semester') {
    // Two equal payments: one now, one on Jan 15. A yearly interval makes each
    // phase bill exactly once (at its start); the phase boundary places the
    // second charge on Jan 15 (or ~2 days out if Jan 15 is already past).
    const recurring = { interval: 'year', interval_count: 1 };
    const priceItem = (cents) => ({
      items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: cents, recurring }, quantity: 1 }],
    });
    const secondUnix = Math.max(
      Math.floor(computed.secondChargeDate.getTime() / 1000),
      Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60
    );
    phases = [
      { ...priceItem(computed.tuitionCents[0]), end_date: secondUnix, proration_behavior: 'none' },
      { ...priceItem(computed.tuitionCents[1]), iterations: 1, proration_behavior: 'none' },
    ];
  } else {
    // monthly: N drafts (first now), last on/before May 1; even split, remainder
    // rides on the final cycle.
    const recurring = { interval: 'month', interval_count: 1 };
    const priceItem = (cents) => ({
      items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: cents, recurring }, quantity: 1 }],
    });
    const amounts = computed.tuitionCents;
    phases = [];
    if (new Set(amounts).size === 1) {
      phases.push({ ...priceItem(amounts[0]), iterations: computed.cycles });
    } else {
      phases.push({ ...priceItem(amounts[0]), iterations: computed.cycles - 1 });
      phases.push({ ...priceItem(amounts[amounts.length - 1]), iterations: 1 });
    }
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

module.exports = {
  PLAN_SPECS, isValidPlan, computePlan, customerHasPaymentMethod, createPlan,
  CONVENIENCE_FEE_RATE, computeParentPlan, monthlyCyclesUntilMay1, may1Of, jan15Of,
  springYear, addUTCMonths,
};
