'use strict';

const express = require('express');
const q = require('../lib/queries');
const { normalizeAmount } = require('../lib/money');
const { streamStatement } = require('../lib/pdf');
const plans = require('../lib/plans');
const stripe = require('../lib/stripeClient');
const magic = require('../lib/magicLink');
const { sendMagicLink } = require('../lib/mailer');
const { currentSchoolYear } = require('../lib/schoolYear');
const config = require('../config');

const router = express.Router();

// Preview per-cycle amounts for each plan at a given balance (null if not billable).
function planPreviews(balanceDollars) {
  const out = {};
  for (const plan of Object.keys(plans.PLAN_SPECS)) {
    try {
      out[plan] = plans.computePlan(balanceDollars, plan);
    } catch (_) {
      out[plan] = null; // balance <= 0
    }
  }
  return out;
}

// Load the family once for every /families/:id route.
async function loadFamily(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).send('Bad family id');
  const family = await q.getFamily(id);
  if (!family) return res.status(404).render('404', { title: 'Not found' });
  req.family = family;
  next();
}

async function detailViewModel(family, year) {
  const [students, charges, payments, balance] = await Promise.all([
    q.getStudentsForFamily(family.id, year),
    q.getChargesForFamily(family.id, year),
    q.getPaymentsForFamily(family.id, year),
    q.getFamilyBalance(family.id, year),
  ]);
  return { students, charges, payments, balance };
}

// New-family form. MUST be declared before '/:id' so "new" is not read as an id.
router.get('/new', (req, res) => {
  res.render('admin/family-new', {
    title: 'New family',
    defaultYear: currentSchoolYear(),
    error: null,
    values: {},
  });
});

// Create a family (+ optional first student), then go to its detail page.
router.post('/', async (req, res, next) => {
  const values = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    phone: String(req.body.phone || '').trim(),
    stripe_customer_id: String(req.body.stripe_customer_id || '').trim(),
    external_id: String(req.body.external_id || '').trim(),
    first_name: String(req.body.first_name || '').trim(),
    last_name: String(req.body.last_name || '').trim(),
    grade: String(req.body.grade || '').trim(),
    school_year: String(req.body.school_year || '').trim(),
  };
  const reshow = (msg) => res.status(400).render('admin/family-new', {
    title: 'New family', defaultYear: currentSchoolYear(), error: msg, values,
  });
  try {
    if (!values.name) return reshow('Family name is required.');
    if (!values.email) return reshow('Family email is required.');
    // If any student field is filled, require the essentials.
    const wantsStudent = values.first_name || values.last_name;
    if (wantsStudent && (!values.first_name || !values.last_name || !values.school_year)) {
      return reshow('To add a first student, enter first name, last name, and school year.');
    }

    const { id } = await q.createFamily({
      externalId: values.external_id,
      name: values.name,
      email: values.email,
      phone: values.phone,
      stripeCustomerId: values.stripe_customer_id,
    });

    let tuitionNote = '';
    if (wantsStudent) {
      await q.addStudent({
        externalId: '', // auto STU-####
        familyId: id,
        firstName: values.first_name,
        lastName: values.last_name,
        grade: values.grade,
        schoolYear: values.school_year,
      });
      // Start them at full standard tuition if a rate is configured for the year.
      const applied = await q.applyStandardTuition(id, values.school_year, req.session.admin.id);
      if (applied.added > 0) tuitionNote = ` — started at standard tuition (${'$'}${Number(applied.rate).toFixed(2)})`;
    }
    res.redirect(`/admin/families/${id}?ok=` + encodeURIComponent(`Family created${tuitionNote}`));
  } catch (err) {
    // Duplicate external_id -> friendly message rather than a 500.
    if (err.number === 2627 || err.number === 2601) {
      return reshow('That external ID is already in use. Leave it blank to auto-generate.');
    }
    next(err);
  }
});

// Family detail (spec §6.2)
router.get('/:id', loadFamily, async (req, res, next) => {
  try {
    const year = req.query.year || null;
    const vm = await detailViewModel(req.family, year);
    const years = await q.listSchoolYears();

    // Plan context: bill the balance for a specific year (spec §7.4).
    const planYear = year || years[0] || currentSchoolYear();
    const [planBalance, tuitionRate, tuitionStatus, optionalItems] = await Promise.all([
      q.getFamilyBalance(req.family.id, planYear),
      q.getTuitionRate(planYear),
      q.tuitionApplyStatus(req.family.id, planYear),
      q.listOptionalItems(true),
    ]);
    res.render('admin/family', {
      title: req.family.name,
      family: req.family,
      year,
      years,
      methods: q.PAYMENT_METHODS,
      tuitionRate: tuitionRate ? tuitionRate.annual_tuition : null,
      tuitionStatus,
      optionalItems,
      planSpecs: plans.PLAN_SPECS,
      planYear,
      planBalance: planBalance.balance,
      planPreviews: planPreviews(planBalance.balance),
      customerPortalUrl: config.stripe.customerPortalUrl,
      stripePortalBase: config.stripe.customerPortalUrl,
      ...vm,
      flash: req.query.ok || null,
      error: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// Edit family info
router.post('/:id/edit', loadFamily, async (req, res, next) => {
  try {
    await q.updateFamily(req.family.id, {
      name: String(req.body.name || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      phone: String(req.body.phone || '').trim(),
      stripe_customer_id: String(req.body.stripe_customer_id || '').trim(),
    });
    res.redirect(`/admin/families/${req.family.id}?ok=Family+updated`);
  } catch (err) { next(err); }
});

// Email the parent a magic sign-in link (office-initiated).
router.post('/:id/send-link', loadFamily, async (req, res, next) => {
  try {
    if (!req.family.email) {
      return res.redirect(`/admin/families/${req.family.id}?err=` + encodeURIComponent('This family has no email on file.'));
    }
    // Office-sent links don't expire (single-use) so a parent can click whenever
    // they get to their inbox.
    const token = await magic.createToken(req.family.id, config.magicLink.adminSentTtlMinutes);
    const url = `${config.baseUrl}/portal/verify?token=${token}`;
    try {
      await sendMagicLink(req.family.email, url, { expiring: false });
    } catch (e) {
      console.error('Admin send-link failed:', e.message);
      return res.redirect(`/admin/families/${req.family.id}?err=` + encodeURIComponent('Could not send the email. Check the mail settings.'));
    }
    await q.setLinkEmailedAt(req.family.id);
    res.redirect(`/admin/families/${req.family.id}?ok=` + encodeURIComponent(`Sign-in link emailed to ${req.family.email}.`));
  } catch (err) { next(err); }
});

// Add a student
router.post('/:id/students', loadFamily, async (req, res, next) => {
  try {
    const schoolYear = String(req.body.school_year || '').trim();
    await q.addStudent({
      externalId: String(req.body.external_id || '').trim() || `s-${Date.now()}`,
      familyId: req.family.id,
      firstName: String(req.body.first_name || '').trim(),
      lastName: String(req.body.last_name || '').trim(),
      grade: String(req.body.grade || '').trim(),
      schoolYear,
    });
    res.redirect(`/admin/families/${req.family.id}?ok=Student+added`);
  } catch (err) { next(err); }
});

// Start the family at full standard tuition (per student, idempotent).
router.post('/:id/apply-tuition', loadFamily, async (req, res, next) => {
  try {
    const year = String(req.body.school_year || '').trim() || currentSchoolYear();
    const r = await q.applyStandardTuition(req.family.id, year, req.session.admin.id);
    const back = `/admin/families/${req.family.id}?year=${encodeURIComponent(year)}`;
    if (r.noRate) {
      return res.redirect(back + '&err=' + encodeURIComponent(`No standard tuition set for ${year}. Set it under Settings first.`));
    }
    const parts = [];
    if (r.added) parts.push(`${r.added} added`);
    if (r.repriced) parts.push(`${r.repriced} re-priced to ${'$'}${Number(r.rate).toFixed(2)}`);
    if (r.unchanged) parts.push(`${r.unchanged} already current`);
    const msg = parts.length ? `Standard tuition: ${parts.join(', ')}.` : 'No students to apply tuition to.';
    res.redirect(back + '&ok=' + encodeURIComponent(msg));
  } catch (err) { next(err); }
});

// Add an optional catalog item (e.g. device insurance) to one student.
router.post('/:id/optional-item', loadFamily, async (req, res, next) => {
  try {
    const itemId = parseInt(req.body.item_id, 10);
    const studentId = parseInt(req.body.student_id, 10);
    const schoolYear = String(req.body.school_year || '').trim() || currentSchoolYear();
    const item = Number.isInteger(itemId) ? await q.getOptionalItem(itemId) : null;
    if (!item || !Number.isInteger(studentId)) {
      return res.status(400).send('Pick an item and a student.');
    }
    await q.addCharge({
      studentId,
      description: item.name,
      amount: item.amount,
      dueDate: null,
      schoolYear,
      createdBy: req.session.admin.id,
    });
    res.redirect(`/admin/families/${req.family.id}?ok=` + encodeURIComponent(`Added ${item.name}.`));
  } catch (err) { next(err); }
});

// Add a charge
router.post('/:id/charges', loadFamily, async (req, res, next) => {
  try {
    const amount = normalizeAmount(req.body.amount);
    const studentId = parseInt(req.body.student_id, 10);
    if (amount === null || !Number.isInteger(studentId)) {
      return res.status(400).send('Amount and student are required.');
    }
    await q.addCharge({
      studentId,
      description: String(req.body.description || '').trim(),
      amount,
      dueDate: req.body.due_date || null,
      schoolYear: String(req.body.school_year || '').trim(),
      createdBy: req.session.admin.id,
    });
    res.redirect(`/admin/families/${req.family.id}?ok=Charge+added`);
  } catch (err) { next(err); }
});

// Void a charge (soft delete)
router.post('/:id/charges/:chargeId/void', loadFamily, async (req, res, next) => {
  try {
    await q.voidCharge(parseInt(req.params.chargeId, 10));
    res.redirect(`/admin/families/${req.family.id}?ok=Charge+voided`);
  } catch (err) { next(err); }
});

// Record a payment (spec §6.2). One shape for every method.
router.post('/:id/payments', loadFamily, async (req, res, next) => {
  try {
    const method = String(req.body.method || '').trim();
    if (!q.PAYMENT_METHODS.includes(method)) return res.status(400).send('Invalid method.');

    const amount = normalizeAmount(req.body.amount);
    if (amount === null) return res.status(400).send('Amount is required.');

    const receivedOn = req.body.received_on || new Date().toISOString().slice(0, 10);
    await q.recordPayment({
      familyId: req.family.id,
      amount,
      method,
      receivedOn,
      schoolYear: String(req.body.school_year || '').trim(),
      note: String(req.body.note || '').trim(),
      checkNumber: method === 'check' ? String(req.body.check_number || '').trim() : null,
      pctcEndorsedOn: method === 'pctc' ? (req.body.pctc_endorsed_on || null) : null,
      createdBy: req.session.admin.id,
    });
    res.redirect(`/admin/families/${req.family.id}?ok=Payment+recorded`);
  } catch (err) { next(err); }
});

// Create a Stripe payment plan — the one write path to Stripe (spec §7.4).
router.post('/:id/plan', loadFamily, async (req, res, next) => {
  const back = (params) => `/admin/families/${req.family.id}?${params}`;
  try {
    const plan = String(req.body.plan || '').trim();
    const schoolYear = String(req.body.school_year || '').trim() || currentSchoolYear();

    if (!plans.isValidPlan(plan)) {
      return res.redirect(back('err=' + encodeURIComponent('Choose a valid payment plan.')));
    }
    // Guardrail: never silently replace an existing plan (subscription or annual
    // invoice — payment_plan is set for both).
    if (req.family.payment_plan) {
      return res.redirect(back('err=' + encodeURIComponent('This family already has a plan. Changing it is a separate, explicit action.')));
    }

    // Ledger is authoritative and already committed; derive the amount from the
    // balance for this year (never gross tuition).
    const bal = await q.getFamilyBalance(req.family.id, schoolYear);
    if (bal.balance <= 0) {
      return res.redirect(back('err=' + encodeURIComponent('Balance must be greater than zero to create a plan.')));
    }

    // Auto-create the Stripe customer if the family doesn't have one — no need to
    // create it in the Stripe dashboard first.
    let customerId = req.family.stripe_customer_id;
    if (!customerId) {
      try {
        const customer = await stripe.customers.create({
          name: req.family.name,
          email: req.family.email,
          metadata: { family_id: String(req.family.id), external_id: req.family.external_id },
        });
        customerId = customer.id;
        await q.setStripeCustomerId(req.family.id, customerId);
      } catch (e) {
        return res.redirect(back('err=' + encodeURIComponent(`Stripe (creating customer): ${e.message}`)));
      }
    }

    let result;
    try {
      result = await plans.createPlan({
        stripe,
        customerId,
        familyId: req.family.id,
        schoolYear,
        plan,
        balanceDollars: bal.balance,
      });
    } catch (stripeErr) {
      // Surface Stripe errors verbatim (spec §7.4). The ledger is untouched.
      return res.redirect(back('err=' + encodeURIComponent(`Stripe: ${stripeErr.message}`)));
    }

    await q.setPlan(req.family.id, {
      plan,
      subscriptionId: result.subscriptionId,
      invoiceId: result.invoiceId,
      awaitingAuth: result.awaitingAuth,
    });

    const msg = result.awaitingAuth
      ? 'Plan created — awaiting payment authorization. Send the parent the portal link to add their bank details.'
      : 'Payment plan created in Stripe.';
    res.redirect(back('ok=' + encodeURIComponent(msg)));
  } catch (err) { next(err); }
});

// PDF statement for this family (admins may view any family — spec §6.5)
router.get('/:id/statement.pdf', loadFamily, async (req, res, next) => {
  try {
    // Scope the statement to a real school year — the one asked for, else the
    // family's most recent, else the current year (never "all years").
    const year = req.query.year
      || (await q.familyLatestSchoolYear(req.family.id))
      || currentSchoolYear();
    const vm = await detailViewModel(req.family, year);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="statement-${req.family.external_id}.pdf"`);
    streamStatement(res, { family: req.family, schoolYear: year, ...vm });
  } catch (err) { next(err); }
});

module.exports = router;
