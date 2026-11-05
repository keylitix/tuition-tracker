-- Remember when a family's autopay plan was canceled, so the family page can show
-- "Autopay canceled on <date>" instead of silently reverting to the create-plan
-- form. Cleared when a new plan is created. Append-only, nullable.

IF COL_LENGTH('dbo.families', 'plan_canceled_at') IS NULL
    ALTER TABLE families ADD plan_canceled_at DATETIME2 NULL;
GO
