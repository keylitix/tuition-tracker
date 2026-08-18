'use strict';

// Stripe webhook processing (spec §7). Reconciliation is one-directional: Stripe
// events create rows here; this app NEVER writes money movement back to Stripe.
//
// Idempotency + atomicity: the claim (INSERT into stripe_events) and all row
// writes for an event run inside ONE transaction. A duplicate claim (PK
// violation) means "already handled" -> skip. If a handler throws, the whole
// transaction rolls back so the event is NOT marked processed and Stripe's retry
// re-processes it cleanly. iisnode cold starts + Stripe retries make duplicate
// delivery normal, not exceptional.

const { sql, query, withTransaction } = require('../db/pool');
const { currentSchoolYear, isValidSchoolYear } = require('./schoolYear');
const { CONVENIENCE_FEE_RATE } = require('./plans');

// Logged OUTSIDE any event transaction (so the log survives a rollback).
async function logWebhookError({ eventId, eventType, message, payload }) {
  await query(
    `INSERT INTO webhook_errors (event_id, event_type, message, payload)
     VALUES (@id, @type, @msg, @payload);`,
    {
      id: { type: sql.NVarChar(50), value: eventId || null },
      type: { type: sql.NVarChar(100), value: eventType || null },
      msg: { type: sql.NVarChar(1000), value: String(message).slice(0, 1000) },
      payload: { type: sql.NVarChar(sql.MAX), value: payload ? JSON.stringify(payload).slice(0, 8000) : null },
    }
  );
}

async function findFamilyByCustomer(run, customerId) {
  if (!customerId) return null;
  const r = await run(
    'SELECT TOP 1 * FROM families WHERE stripe_customer_id = @cid;',
    { cid: { type: sql.NVarChar(50), value: customerId } }
  );
  return r.recordset[0] || null;
}

// Match a Stripe customer to a family, robust to event ordering: first by the
// stored customer id, then (fallback) by the customer's email — and if matched
// that way, link the customer id so future events resolve directly. This closes
// the race where a payment event arrives before checkout.session.completed has
// linked the customer.
async function resolveFamily(run, stripeClient, customerId) {
  if (!customerId) return null;
  let fam = await findFamilyByCustomer(run, customerId);
  if (fam || !stripeClient) return fam;
  try {
    const cust = await stripeClient.customers.retrieve(customerId);
    const email = cust && !cust.deleted && cust.email ? cust.email.toLowerCase() : null;
    if (email) {
      const r = await run('SELECT TOP 1 * FROM families WHERE email = @e AND active = 1;',
        { e: { type: sql.NVarChar(255), value: email } });
      fam = r.recordset[0] || null;
      if (fam && !fam.stripe_customer_id) {
        await run('UPDATE families SET stripe_customer_id = @c WHERE id = @id AND stripe_customer_id IS NULL;',
          { c: { type: sql.NVarChar(50), value: customerId }, id: { type: sql.Int, value: fam.id } });
      }
    }
  } catch (_) { /* fall through to null */ }
  return fam;
}

function mapMethod(pmType) {
  if (pmType === 'us_bank_account' || pmType === 'ach_debit' || pmType === 'ach_credit_transfer') return 'ach';
  if (pmType === 'card') return 'card';
  return null;
}

// Best-effort ach vs card for a paid invoice. Tries several sources because the
// field that carries the payment method has moved across Stripe API versions
// (invoice.payment_intent was dropped in newer versions): the PaymentIntent if
// present, then the invoice's charge, then the customer's default payment method.
// A miss is a display-detail, not an admin-actionable error, so it is logged to
// the server only (never to the roster's webhook-issue banner). Defaults to 'ach'
// since that is this school's primary method.
async function detectMethod(stripeClient, invoice) {
  if (!stripeClient) return 'ach';
  try {
    let type = null;
    if (invoice.payment_intent) {
      const pi = await stripeClient.paymentIntents.retrieve(invoice.payment_intent, { expand: ['latest_charge'] });
      type = (pi.latest_charge && pi.latest_charge.payment_method_details && pi.latest_charge.payment_method_details.type)
        || (pi.payment_method_types && pi.payment_method_types[0]);
    }
    if (!mapMethod(type) && invoice.charge) {
      const ch = await stripeClient.charges.retrieve(invoice.charge);
      type = ch.payment_method_details && ch.payment_method_details.type;
    }
    if (!mapMethod(type) && invoice.customer) {
      const cust = await stripeClient.customers.retrieve(invoice.customer);
      const pmId = cust.invoice_settings && cust.invoice_settings.default_payment_method;
      if (pmId) { const pm = await stripeClient.paymentMethods.retrieve(pmId); type = pm.type; }
    }
    const mapped = mapMethod(type);
    if (mapped) return mapped;
  } catch (err) {
    console.warn(`detectMethod for invoice ${invoice.id}: ${err.message}`);
  }
  console.warn(`Could not determine payment method for invoice ${invoice.id}; defaulting to ach.`);
  return 'ach';
}

function pickSchoolYear(metadata) {
  if (metadata && isValidSchoolYear(metadata.school_year)) return metadata.school_year;
  return currentSchoolYear();
}

/* ------------------------- event handlers ------------------------- */
// Each handler receives (run, obj, ctx, deferred, stripeClient) where `run` is
// the transaction-bound query fn and `deferred` collects post-commit side effects
// (warning logs) that must not be rolled back.

async function handleInvoicePaid(run, invoice, ctx, deferred, stripeClient) {
  const family = await resolveFamily(run, stripeClient, invoice.customer);
  if (!family) {
    deferred.warnings.push({ ...ctx, message: `invoice.paid for unmatched customer ${invoice.customer} (invoice ${invoice.id}).`, payload: invoice });
    return;
  }
  const method = await detectMethod(stripeClient, invoice);
  // Card drafts include the 3% convenience fee; credit ONLY the tuition portion
  // so the fee never shows up as a tuition overpayment. (ACH carries no fee.)
  const paidCents = invoice.amount_paid || 0;
  const tuitionCents = method === 'card'
    ? Math.round(paidCents / (1 + CONVENIENCE_FEE_RATE))
    : paidCents;
  const amount = tuitionCents / 100;
  const schoolYear = pickSchoolYear(invoice.metadata);

  try {
    await run(
      `INSERT INTO payments
          (family_id, amount, method, received_on, school_year, note,
           stripe_payment_intent_id, stripe_invoice_id)
       VALUES (@familyId, @amount, @method, CAST(SYSUTCDATETIME() AS DATE), @year,
               @note, @pi, @inv);`,
      {
        familyId: { type: sql.Int, value: family.id },
        amount: { type: sql.Decimal(10, 2), value: amount },
        method: { type: sql.NVarChar(20), value: method },
        year: { type: sql.NVarChar(9), value: schoolYear },
        note: { type: sql.NVarChar(500), value: `Stripe invoice ${invoice.number || invoice.id}` },
        pi: { type: sql.NVarChar(50), value: invoice.payment_intent || null },
        inv: { type: sql.NVarChar(50), value: invoice.id || null },
      }
    );
  } catch (err) {
    // Duplicate PaymentIntent -> already recorded by an earlier delivery. Safe skip.
    if (err.number === 2627 || err.number === 2601) return;
    throw err;
  }

  await run(`UPDATE payment_failures SET cleared = 1 WHERE family_id = @fid AND cleared = 0;`, {
    fid: { type: sql.Int, value: family.id },
  });
  await clearProcessing(run, family.id); // the ACH draft cleared — no longer in flight
  // A successful draft proves a payment method is attached (spec §7.4).
  await run(`UPDATE families SET plan_awaiting_auth = 0 WHERE id = @fid AND plan_awaiting_auth = 1;`, {
    fid: { type: sql.Int, value: family.id },
  });
}

async function handleInvoicePaymentFailed(run, invoice, ctx, deferred, stripeClient) {
  const family = await resolveFamily(run, stripeClient, invoice.customer);
  // A failure on the FIRST invoice of a new subscription almost always means the
  // parent hasn't finished bank verification (ACH micro-deposits) — that's a
  // "pending setup", not a real decline. A failure on a recurring cycle is a
  // genuine decline (insufficient funds, closed account, etc.).
  const kind = invoice.billing_reason === 'subscription_create' ? 'pending' : 'failed';
  await run(
    `INSERT INTO payment_failures (family_id, stripe_invoice_id, amount, kind)
     VALUES (@fid, @inv, @amount, @kind);`,
    {
      fid: { type: sql.Int, value: family ? family.id : null },
      inv: { type: sql.NVarChar(50), value: invoice.id || null },
      amount: { type: sql.Decimal(10, 2), value: (invoice.amount_due || 0) / 100 },
      kind: { type: sql.NVarChar(20), value: kind },
    }
  );
  if (family) await clearProcessing(run, family.id); // it resolved (as a failure) — no longer in flight
  if (!family) {
    deferred.warnings.push({ ...ctx, message: `invoice.payment_failed for unmatched customer ${invoice.customer}.`, payload: invoice });
  }
  // No dunning/retry logic — Stripe Billing owns that (spec §2, §7).
}

async function handleChargeRefunded(run, charge, ctx, deferred, stripeClient) {
  const latestRefund = charge.refunds && charge.refunds.data && charge.refunds.data[0];
  const refundAmount = latestRefund ? latestRefund.amount : charge.amount_refunded;
  const amount = -(refundAmount || 0) / 100;

  let family = null;
  let schoolYear = null;
  if (charge.payment_intent) {
    const orig = await run(
      `SELECT TOP 1 family_id, school_year FROM payments WHERE stripe_payment_intent_id = @pi AND method IN ('ach','card');`,
      { pi: { type: sql.NVarChar(50), value: charge.payment_intent } }
    );
    if (orig.recordset[0]) {
      family = { id: orig.recordset[0].family_id };
      schoolYear = orig.recordset[0].school_year;
    }
  }
  if (!family) family = await resolveFamily(run, stripeClient, charge.customer);
  if (!family) {
    deferred.warnings.push({ ...ctx, message: `charge.refunded for unmatched customer ${charge.customer} (charge ${charge.id}).`, payload: charge });
    return;
  }
  if (!schoolYear) schoolYear = currentSchoolYear();

  await run(
    `INSERT INTO payments (family_id, amount, method, received_on, school_year, note, stripe_payment_intent_id)
     VALUES (@fid, @amount, 'refund', CAST(SYSUTCDATETIME() AS DATE), @year, @note, @pi);`,
    {
      fid: { type: sql.Int, value: family.id },
      amount: { type: sql.Decimal(10, 2), value: amount },
      year: { type: sql.NVarChar(9), value: schoolYear },
      note: { type: sql.NVarChar(500), value: `Refund on charge ${charge.id}` },
      pi: { type: sql.NVarChar(50), value: charge.payment_intent || null },
    }
  );
}

async function findFamilyById(run, id) {
  if (!Number.isInteger(id)) return null;
  const r = await run('SELECT TOP 1 * FROM families WHERE id = @id;', { id: { type: sql.Int, value: id } });
  return r.recordset[0] || null;
}

function addMonthsUnix(unixSeconds, months) {
  const d = new Date(unixSeconds * 1000);
  d.setUTCMonth(d.getUTCMonth() + months);
  return Math.floor(d.getTime() / 1000);
}

// Parent finished Stripe Checkout (ACH). Link the Stripe customer to the family;
// for autopay (subscription mode) record the plan and schedule cancellation after
// the right number of cycles. The one-time balance payment itself is recorded on
// payment_intent.succeeded (below), once the ACH debit actually settles.
async function handleCheckoutCompleted(run, session, ctx, deferred, stripeClient) {
  const familyId = parseInt((session.metadata && session.metadata.family_id) || '', 10);
  const family = await findFamilyById(run, familyId);
  if (!family) {
    deferred.warnings.push({ ...ctx, message: `checkout.session.completed with no matching family (metadata.family_id=${session.metadata && session.metadata.family_id}).`, payload: session });
    return;
  }

  // Link the Stripe customer that Checkout created/used.
  if (session.customer && !family.stripe_customer_id) {
    await run(`UPDATE families SET stripe_customer_id = @cid WHERE id = @fid AND stripe_customer_id IS NULL;`, {
      cid: { type: sql.NVarChar(50), value: session.customer },
      fid: { type: sql.Int, value: family.id },
    });
  }

  const md = session.metadata || {};

  if (session.mode === 'subscription' && session.subscription) {
    const plan = md.plan || 'monthly';
    await run(
      `UPDATE families SET payment_plan = @plan, stripe_subscription_id = @sub,
              plan_created_at = SYSUTCDATETIME(), plan_awaiting_auth = 0
        WHERE id = @fid;`,
      {
        plan: { type: sql.NVarChar(20), value: plan },
        sub: { type: sql.NVarChar(50), value: session.subscription },
        fid: { type: sql.Int, value: family.id },
      }
    );
    // Stop the subscription after the right number of cycles (post-commit so the
    // DB transaction doesn't wait on a Stripe API call).
    const cycles = parseInt(md.cycles || '0', 10);
    const intervalMonths = parseInt(md.interval_months || '1', 10);
    if (stripeClient && cycles > 0) {
      deferred.actions.push(async () => {
        const sub = await stripeClient.subscriptions.retrieve(session.subscription);
        const start = sub.current_period_start || sub.start_date;
        if (start) {
          await stripeClient.subscriptions.update(session.subscription, {
            cancel_at: addMonthsUnix(start, cycles * intervalMonths),
          });
        }
      });
    }
    return;
  }

  // Semester (one-time "pay now" leg). Record the plan, then set up the SECOND
  // payment to draft on Jan 15 as its own subscription that trials until then and
  // cancels right after — using the payment method saved during this checkout.
  if (session.mode === 'payment' && md.plan === 'semester') {
    await run(
      `UPDATE families SET payment_plan = 'semester', plan_created_at = SYSUTCDATETIME(), plan_awaiting_auth = 0
        WHERE id = @fid;`,
      { fid: { type: sql.Int, value: family.id } }
    );
    scheduleSemesterSecondLeg(deferred, stripeClient, session, family, md);
  }
}

// Post-commit: create the Jan-15 subscription for semester's second payment. Kept
// out of the DB transaction (Stripe API call). Idempotency-keyed so a webhook
// retry can't create two. Requires a Product first (subscriptions reject inline
// product_data). trial_end pauses billing until Jan 15; cancel_at stops it after
// that single draft. Falls back to ~2 days out if Jan 15 is already past.
function scheduleSemesterSecondLeg(deferred, stripeClient, session, family, md) {
  if (!stripeClient) return;
  const amountCents = parseInt(md.second_tuition_cents || '0', 10) + parseInt(md.second_fee_cents || '0', 10);
  const jan15 = parseInt(md.jan15 || '0', 10);
  if (!amountCents || !jan15) return;

  deferred.actions.push(async () => {
    const customerId = session.customer;
    if (!customerId) return;
    // The method saved on the "pay now" PaymentIntent, reused off-session on Jan 15.
    let paymentMethodId = null;
    if (session.payment_intent) {
      const pi = await stripeClient.paymentIntents.retrieve(session.payment_intent);
      paymentMethodId = pi.payment_method || null;
    }
    const soon = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const trialEnd = Math.max(jan15, soon);
    const product = await stripeClient.products.create(
      { name: `Tuition — second semester payment (${md.school_year})` },
      { idempotencyKey: `sem2-product-${family.id}-${md.school_year}` }
    );
    const sub = await stripeClient.subscriptions.create(
      {
        customer: customerId,
        items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: amountCents, recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
        trial_end: trialEnd,
        cancel_at: trialEnd + 3 * 24 * 60 * 60,
        proration_behavior: 'none',
        collection_method: 'charge_automatically',
        ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
        metadata: { family_id: String(family.id), school_year: md.school_year, plan: 'semester', kind: 'autopay', method: md.method || '' },
      },
      { idempotencyKey: `sem2-sub-${family.id}-${md.school_year}` }
    );
    // Best-effort link (outside the event transaction).
    await query(`UPDATE families SET stripe_subscription_id = @sub WHERE id = @fid AND stripe_subscription_id IS NULL;`, {
      sub: { type: sql.NVarChar(50), value: sub.id },
      fid: { type: sql.Int, value: family.id },
    });
  });
}

// A PaymentIntent succeeded. We only act on our one-time balance payments
// (metadata.kind='balance'); subscription/invoice charges are recorded via
// invoice.paid instead, so this avoids double-counting.
async function handlePaymentIntentSucceeded(run, pi, ctx, deferred) {
  if (!pi.metadata || pi.metadata.kind !== 'balance') return;
  const family = await findFamilyById(run, parseInt(pi.metadata.family_id || '', 10));
  if (!family) {
    deferred.warnings.push({ ...ctx, message: `payment_intent.succeeded (balance) with no matching family (${pi.metadata.family_id}).`, payload: pi });
    return;
  }
  // Credit ONLY the tuition portion — the 3% card fee (if any) is not tuition and
  // must not push the family into a negative balance. tuition_cents is set at
  // checkout; fall back to the full amount for older payments without it.
  const tuitionCents = parseInt(pi.metadata.tuition_cents || '', 10);
  const amount = Number.isInteger(tuitionCents)
    ? tuitionCents / 100
    : (pi.amount_received || pi.amount || 0) / 100;
  const schoolYear = pickSchoolYear(pi.metadata);
  try {
    await run(
      `INSERT INTO payments (family_id, amount, method, received_on, school_year, note, stripe_payment_intent_id)
       VALUES (@fid, @amount, 'ach', CAST(SYSUTCDATETIME() AS DATE), @year, @note, @pi);`,
      {
        fid: { type: sql.Int, value: family.id },
        amount: { type: sql.Decimal(10, 2), value: amount },
        year: { type: sql.NVarChar(9), value: schoolYear },
        note: { type: sql.NVarChar(500), value: 'Online payment (bank/ACH)' },
        pi: { type: sql.NVarChar(50), value: pi.id },
      }
    );
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return; // already recorded
    throw err;
  }
  await clearProcessing(run, family.id); // the ACH debit settled — no longer in flight
}

// An ACH payment was submitted and is clearing (takes a few business days). Flag
// the family so the office can see money is on the way, even though it hasn't
// settled yet. Cleared when the payment settles (invoice.paid /
// payment_intent.succeeded) or fails. Applies to both one-time balance payments
// and the first draft of a new subscription (whose PI carries no metadata, so we
// resolve the family by customer).
async function handlePaymentIntentProcessing(run, pi, ctx, deferred, stripeClient) {
  let family = null;
  const metaFamily = parseInt((pi.metadata && pi.metadata.family_id) || '', 10);
  if (Number.isInteger(metaFamily)) family = await findFamilyById(run, metaFamily);
  if (!family) family = await resolveFamily(run, stripeClient, pi.customer);
  if (!family) return; // unmatched — no ledger record yet; nothing to flag
  await run(`UPDATE families SET payment_processing_at = SYSUTCDATETIME() WHERE id = @fid;`, {
    fid: { type: sql.Int, value: family.id },
  });
}

// Clear the "payment processing" flag once a payment settles or fails.
async function clearProcessing(run, familyId) {
  await run(`UPDATE families SET payment_processing_at = NULL WHERE id = @fid AND payment_processing_at IS NOT NULL;`, {
    fid: { type: sql.Int, value: familyId },
  });
}

// Dispatch table.
const HANDLERS = {
  'invoice.paid': handleInvoicePaid,
  'invoice.payment_failed': handleInvoicePaymentFailed,
  'charge.refunded': handleChargeRefunded,
  'checkout.session.completed': handleCheckoutCompleted,
  'payment_intent.succeeded': handlePaymentIntentSucceeded,
  'payment_intent.processing': handlePaymentIntentProcessing,
};

// Entry point. Claim + handle in one transaction; log warnings after commit.
async function processEvent(event, stripeClient) {
  const ctx = { eventId: event.id, eventType: event.type };
  const deferred = { warnings: [], actions: [] };

  const result = await withTransaction(async (run) => {
    // Claim first (spec §7). A duplicate PK means already processed -> skip.
    try {
      await run(`INSERT INTO stripe_events (event_id, event_type) VALUES (@id, @type);`, {
        id: { type: sql.NVarChar(50), value: event.id },
        type: { type: sql.NVarChar(100), value: event.type },
      });
    } catch (err) {
      if (err.number === 2627 || err.number === 2601) return { duplicate: true };
      throw err;
    }

    const handler = HANDLERS[event.type];
    if (handler) await handler(run, event.data.object, ctx, deferred, stripeClient);
    return { duplicate: false };
  });

  // Post-commit side effects: warnings must survive even a successful commit.
  for (const w of deferred.warnings) {
    try { await logWebhookError(w); } catch (_) { /* best effort */ }
  }
  // Post-commit Stripe calls (e.g. scheduling autopay cancellation) — never held
  // inside the DB transaction. Failures are logged, not fatal (event stays claimed).
  if (!result.duplicate) {
    for (const action of deferred.actions) {
      try { await action(); } catch (e) { console.error('Post-commit webhook action failed:', e.message); }
    }
  }
  return result;
}

module.exports = {
  processEvent,
  logWebhookError,
  // exported for tests
  mapMethod,
  pickSchoolYear,
};
