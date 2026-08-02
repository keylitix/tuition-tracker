-- Annual plans create a one-off invoice (no subscription), so families need a
-- place to record that reference. Mirrors payments.stripe_invoice_id.
-- Append-only, idempotent.

IF COL_LENGTH('dbo.families', 'stripe_invoice_id') IS NULL
    ALTER TABLE families ADD stripe_invoice_id NVARCHAR(50) NULL;
GO
