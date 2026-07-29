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

function mapMethod(pmType) {
  if (pmType === 'us_bank_account' || pmType === 'ach_debit' || pmType === 'ach_credit_transfer') return 'ach';
  if (pmType === 'card') return 'card';
  return null;
}

// Best-effort ach vs card. Uses the live Stripe client to expand the
// PaymentIntent; falls back to 'card' and queues a deferred warning when unknown.
// Deferred warnings are logged after commit so they aren't rolled back.
async function detectMethod(stripeClient, invoice, ctx, warnings) {
  const piId = invoice.payment_intent;
  if (stripeClient && piId) {
    try {
      const pi = await stripeClient.paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
      const type = pi.latest_charge && pi.latest_charge.payment_method_details
        ? pi.latest_charge.payment_method_details.type
        : (pi.payment_method_types && pi.payment_method_types[0]);
      const mapped = mapMethod(type);
      if (mapped) return mapped;
    } catch (err) {
      warnings.push({ ...ctx, message: `Could not retrieve PaymentIntent ${piId}: ${err.message}` });
    }
  }
  warnings.push({ ...ctx, message: `Payment method type unknown for invoice ${invoice.id}; recorded as card.` });
  return 'card';
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
  const family = await findFamilyByCustomer(run, invoice.customer);
  if (!family) {
    deferred.warnings.push({ ...ctx, message: `invoice.paid for unmatched customer ${invoice.customer} (invoice ${invoice.id}).`, payload: invoice });
    return;
  }
  const method = await detectMethod(stripeClient, invoice, ctx, deferred.warnings);
  const amount = (invoice.amount_paid || 0) / 100;
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
  // A successful draft proves a payment method is attached (spec §7.4).
  await run(`UPDATE families SET plan_awaiting_auth = 0 WHERE id = @fid AND plan_awaiting_auth = 1;`, {
    fid: { type: sql.Int, value: family.id },
  });
}

async function handleInvoicePaymentFailed(run, invoice, ctx, deferred) {
  const family = await findFamilyByCustomer(run, invoice.customer);
  await run(
    `INSERT INTO payment_failures (family_id, stripe_invoice_id, amount)
     VALUES (@fid, @inv, @amount);`,
    {
      fid: { type: sql.Int, value: family ? family.id : null },
      inv: { type: sql.NVarChar(50), value: invoice.id || null },
      amount: { type: sql.Decimal(10, 2), value: (invoice.amount_due || 0) / 100 },
    }
  );
  if (!family) {
    deferred.warnings.push({ ...ctx, message: `invoice.payment_failed for unmatched customer ${invoice.customer}.`, payload: invoice });
  }
  // No dunning/retry logic — Stripe Billing owns that (spec §2, §7).
}

async function handleChargeRefunded(run, charge, ctx, deferred) {
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
  if (!family) family = await findFamilyByCustomer(run, charge.customer);
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

// Dispatch table.
const HANDLERS = {
  'invoice.paid': handleInvoicePaid,
  'invoice.payment_failed': handleInvoicePaymentFailed,
  'charge.refunded': handleChargeRefunded,
};

// Entry point. Claim + handle in one transaction; log warnings after commit.
async function processEvent(event, stripeClient) {
  const ctx = { eventId: event.id, eventType: event.type };
  const deferred = { warnings: [] };

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
  return result;
}

module.exports = {
  processEvent,
  logWebhookError,
  // exported for tests
  mapMethod,
  pickSchoolYear,
};
