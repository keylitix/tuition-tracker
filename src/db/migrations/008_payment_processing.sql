-- Track when a family has an ACH payment in flight (submitted, clearing) so the
-- office knows money is on the way. Set on payment_intent.processing, cleared when
-- it settles (invoice.paid / payment_intent.succeeded) or fails. Append-only.

IF COL_LENGTH('dbo.families', 'payment_processing_at') IS NULL
    ALTER TABLE families ADD payment_processing_at DATETIME2 NULL;
GO
