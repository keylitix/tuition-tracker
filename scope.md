# Tuition Tracker — Scope Document

**Client:** Private school (Oklahoma) · **Vendor:** Keylitix · **Status:** Greenfield build
**Target:** Usable by September 2026; office runs August manually

> This is the authoritative brief the implementation follows. The three design
> principles in §4 resolve most questions; when in doubt, prefer them.

## 1. Purpose
A lightweight tuition ledger. It tracks what each family **owes** and what they
have **paid**, from any source — Stripe ACH, paper check, or Oklahoma Parental
Choice Tax Credit (PCTC) award. Not a payment processor, not an SIS. Stripe owns
money movement; this app owns the obligation record and the reporting views.

No off-the-shelf product handles the PCTC workflow: the state mails a check made
payable to the *taxpayer* but sends it to the *school*, so the school holds funds
it cannot deposit until the parent physically endorses it.

## 2. Non-goals
No checkout/payment form; no bank/card/routing storage (Stripe customer id only —
keeps out of PCI scope); no retry/dunning; no email receipts (Stripe sends them);
no payment-method UI (link to Stripe Customer Portal); no subscription-creation UI
in v1; no grades/attendance/transcripts/enrollment.

## 3. Stack & hosting
Node/Express · SmarterASP.NET (Windows, iisnode) · SQL Server · server-side
session cookie (admin) · magic-link (parent) · server-side PDF · Let's Encrypt TLS.

iisnode recycles the app pool on idle: **no in-memory state between requests, no
in-process schedulers/caches/workers.** Everything request- or webhook-driven.
Cold starts can time out webhooks — Stripe retries, which is safe only because of
idempotency (§7). Secrets in `web.config` appSettings or env vars, never in the repo.

## 4. Design principles
1. **Never store a computed balance.** `SUM(charges) − SUM(payments)` at read time.
2. **Every source of money is the same shape** — one `payments` table, by `method`.
3. **Stripe = source of truth for money; this app = source of truth for obligation.**
   Payment rows are created here only by webhook, never by optimistic local writes.
   There is exactly **one** write path to Stripe — plan creation (§7.4) — and it is
   tightly constrained (explicit admin action, idempotent, ledger written first).
   If the two disagree about whether a payment happened, Stripe wins.

## 5. Data model
See [`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql) for the
implemented schema: `families`, `students`, `charges`, `payments`,
`stripe_events`, `admin_users`, `magic_tokens`, plus operational tables
(`sessions`, `webhook_errors`, `payment_failures`).

`payments.method` ∈ `ach | card | check | pctc | adjustment | refund`
(refund amount is negative). `pctc_endorsed_on IS NULL` = held, unendorsed.

## 6. Features
- **6.1 Roster (landing):** per-family charged/paid/balance for a year; flags for
  past-due, **unendorsed PCTC (money held, cannot deposit)**, failed payment;
  search; summary strip.
- **6.2 Family detail:** editable info; charges (add/void, never hard-delete);
  payments (newest first); record-payment form; running balance; Stripe link.
- **6.3 PCTC worklist:** every `pctc` payment with `pctc_endorsed_on IS NULL`,
  one-click endorse. The office's daily driver in Aug/Sep.
- **6.4 Parent portal (read-only, magic link):** own students/charges, payment
  history, prominent balance, PDF statement, Stripe portal link. **A parent must
  never see another family's data — scope every query by session `family_id`;
  tested in `test/parent-scope.test.js`.**
- **6.5 PDF statement:** server-side, same data as the parent screen.
- **6.6 CSV export (admin):** families, charges, payments — all include
  `external_id` (migration path to FACTS).

## 7. Stripe integration
`POST /webhooks/stripe` — public, signature-verified on the raw body. Idempotent:
claim the event id before processing (duplicate = skip). Handles `invoice.paid`
(→ `ach`/`card` payment), `invoice.payment_failed` (flag only), `charge.refunded`
(→ negative `refund` payment). Always 200 except on failed signature; unmatched
customers are logged to an admin-visible error log, not thrown.

**§7.4 Plan creation — the one write path.** From the family detail page the office
selects a plan and clicks **Create plan in Stripe**. The amount is derived from the
**balance** (not gross tuition — PCTC is already a payment, so gross would double-charge):
`monthly` → subscription, `balance/10`, 10 cycles; `semester` → subscription (6-month),
`balance/2`, 2 cycles; `annual` → one-off invoice, `balance`, 1 cycle. Cents split with
the remainder on the **final** cycle so the total matches exactly. Guardrails: deterministic
idempotency key `plan-{family_id}-{school_year}`; ledger committed before the Stripe call;
button disabled once `stripe_subscription_id` is set; if no payment method is on file, create
anyway and flag the family **"awaiting authorization"** with a portal link; Stripe errors are
surfaced verbatim. See [`src/lib/plans.js`](src/lib/plans.js).

## 8. Authentication
- **Admin:** email + password (bcrypt), server-side session cookie
  (httpOnly, secure, sameSite=lax). No self-registration.
- **Parent magic link:** random token, store **SHA-256 hash only**, 15-min expiry,
  single-use. Identical "check your email" response regardless of match.
  Rate-limited per email.

## 9. Security
Parameterized queries everywhere · parent queries scoped by session `family_id` ·
webhook signature verified before processing · tokens hashed/single-use/short TTL ·
secrets in config only · HTTPS enforced · no bank/card data anywhere.

## 10. Build order
1 schema/migrations/seed · 2 admin auth · 3 roster + family detail · 4 webhook ·
5 plan-creation write path (§7.4, after the webhook so drafts can be verified in the
ledger) · 6 parent portal · 7 PDF · 8 CSV · 9 PCTC worklist. Steps 1–3 ship first.

## 11. Operational notes
Let's Encrypt before registering the webhook · offsite SQL backup + test a restore
once · Stripe test mode + `stripe listen --forward-to` for local webhooks.

## 12. Future (out of scope for v1)
PCTC → Stripe credit-balance draw-down (adds a write path back to Stripe —
deferred to keep one-direction reconciliation) · subscription creation in admin UI ·
sibling-discount automation · FACTS export (CSV exports are the foundation).
