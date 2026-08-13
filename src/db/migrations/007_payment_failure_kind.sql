-- Distinguish an ACH setup that's still pending bank verification (parent must
-- finish micro-deposit verification) from a genuine payment decline. Append-only,
-- idempotent.

IF COL_LENGTH('dbo.payment_failures', 'kind') IS NULL
    ALTER TABLE payment_failures ADD kind NVARCHAR(20) NOT NULL DEFAULT 'failed'; -- 'failed' | 'pending'
GO
