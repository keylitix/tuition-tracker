-- Payment-plan write path (spec §5 + §7.4). Adds the plan columns to families.
-- Append-only migration; idempotent via COL_LENGTH guards.

IF COL_LENGTH('dbo.families', 'payment_plan') IS NULL
    ALTER TABLE families ADD payment_plan NVARCHAR(20) NULL;   -- 'monthly' | 'semester' | 'annual'
GO
IF COL_LENGTH('dbo.families', 'stripe_subscription_id') IS NULL
    ALTER TABLE families ADD stripe_subscription_id NVARCHAR(50) NULL;
GO
IF COL_LENGTH('dbo.families', 'plan_created_at') IS NULL
    ALTER TABLE families ADD plan_created_at DATETIME2 NULL;
GO
-- Operational flag (not in the spec data model, but needed to surface the
-- "awaiting authorization" state on the roster, spec §7.4): set when a plan is
-- created for a family with no payment method on file; cleared when a payment
-- lands (invoice.paid) proving a method was attached.
IF COL_LENGTH('dbo.families', 'plan_awaiting_auth') IS NULL
    ALTER TABLE families ADD plan_awaiting_auth BIT NOT NULL DEFAULT 0;
GO
