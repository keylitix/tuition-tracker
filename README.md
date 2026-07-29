# Tuition Tracker

A lightweight tuition ledger for a small private school (Keylitix build for
**The Farm Academy**, Oklahoma). It tracks what each family **owes** and what
they have **paid**, from any source — Stripe ACH, paper check, or Oklahoma
Parental Choice Tax Credit (PCTC) award.

**This is not a payment processor and not a student information system.** Stripe
owns all money movement; this app owns the obligation record and the reporting
views the office and parents need. See [`scope.md`](scope.md) for the full brief.

## Core rules (do not violate)

1. **Never store a computed balance.** Balance is always `SUM(charges) − SUM(payments)`, computed at read time.
2. **Every source of money is the same shape** — one `payments` table, distinguished by `method`.
3. **Stripe is the source of truth for money; this app is the source of truth for obligation.** Reconciliation is one-directional (Stripe events → payment rows here). The app never writes money movement back to Stripe.
4. **No bank/card data, ever.** The app stores a Stripe customer id and nothing else financial-instrument-related. This keeps the project out of PCI scope.

## Stack

Node.js / Express · SQL Server · server-rendered EJS · session-cookie admin auth ·
magic-link parent auth · server-side PDF (pdfkit). Hosted on SmarterASP.NET
(Windows shared hosting, iisnode). All dependencies are pure JS — no native
compilation — so they install on shared hosting.

Because iisnode recycles the app pool on idle, the app holds **no in-memory state
between requests**: sessions live in SQL Server and everything is request- or
webhook-driven.

## Local development

Prerequisites: Node 18+ and Docker (for a local SQL Server).

```bash
cp .env.example .env          # then edit if needed (defaults match docker-compose)
npm install
npm run db:up                 # start SQL Server 2022 in Docker
# wait ~30s for the container to become healthy on first run
npm run migrate               # create the database + schema
npm run seed                  # a few fake families (paid-up, past-due, unendorsed PCTC)
npm run createadmin -- "you@school.org" "Your Name" "a-password"
npm run dev                   # http://localhost:3000
```

- Admin: <http://localhost:3000/admin/login>
- Parent portal: <http://localhost:3000/portal/login> — with SMTP unset, the
  magic link is printed to the server console instead of emailed.

### Tests

```bash
npm test
```

`test/units.test.js` runs without a database. `test/parent-scope.test.js`
includes the required cross-family isolation test (spec §6.4); its behavioural
half runs when a seeded DB is reachable and skips otherwise.

## Stripe webhooks (local)

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET in .env
```

Handled events: `invoice.paid`, `invoice.payment_failed`, `charge.refunded`.
The endpoint verifies the signature on the raw body, is idempotent (claim +
row writes share one transaction), and always returns `200` except on a failed
signature check.

## Deploy (SmarterASP.NET / iisnode)

1. Provision SQL Server and note the connection details.
2. Copy `web.config.example` → `web.config` and fill in `<appSettings>`
   (secrets live here or in environment variables — **never in the repo**).
3. Deploy the repository (without `node_modules`; run `npm install --omit=dev`
   on the host, or deploy `node_modules`).
4. Run migrations against the production DB (`npm run migrate`) and create the
   first admin (`npm run createadmin`).
5. Configure Let's Encrypt **before** registering the webhook URL in Stripe —
   Stripe will not deliver to an invalid certificate.
6. Register `https://<host>/webhooks/stripe` in the Stripe dashboard and set the
   webhook signing secret.

Operational reminders: schedule an offsite SQL backup and **test a restore
once** — this is a school's financial record.

## Feature status (spec §10 build order)

| # | Feature | Status |
|---|---------|--------|
| 1 | Schema, migrations, seed | ✅ |
| 2 | Admin auth + sessions | ✅ |
| 3 | Roster + family detail (manual entry) | ✅ |
| 4 | Stripe webhook (verify + idempotent) | ✅ |
| 5 | Plan-creation write path (§7.4) | ✅ code-complete — needs a Stripe **test** key + a DB to exercise end-to-end |
| 6 | Parent magic-link portal (read-only) | ✅ |
| 7 | PDF statement | ✅ |
| 8 | CSV exports (families / charges / payments) | ✅ |
| 9 | PCTC worklist | ✅ |

> **Plan creation (§7.4)** is the single write path to Stripe. The amount math is
> pure and unit-tested (`test/plans.test.js`); the Stripe calls (subscription
> schedules for monthly/semester, a one-off invoice for annual, all with
> idempotency keys) require a Stripe test account and a live DB to verify — do this
> as build-order step 5, after the webhook, so you can confirm the resulting drafts
> land back in the ledger.

## Project layout

```
src/
  server.js            Express app (module.exports for iisnode + listen)
  config.js            Env/appSettings loader
  db/
    pool.js            mssql pool + query() + withTransaction()
    migrate.js         Runs migrations/*.sql
    migrations/        001_init.sql (schema)
    seed.js            Fake dev data
  lib/
    queries.js         All data access — parameterized, family-scoped reads
    stripeEvents.js    Webhook event processing (idempotent, one-directional)
    plans.js           Plan-creation write path (§7.4) — amount math + Stripe calls
    stripeClient.js    Shared configured Stripe client
    magicLink.js       Hashed, single-use parent tokens
    pdf.js  csv.js  money.js  schoolYear.js  mailer.js
  middleware/          auth (admin/parent guards), csrf
  routes/              adminAuth, adminRoster, adminFamily, adminPctc,
                       adminExport, parentAuth, parentPortal, webhooks
  views/               EJS templates
  public/              css + a tiny CSP-safe form script
  scripts/create-admin.js
test/                  units + parent-scope isolation
```
