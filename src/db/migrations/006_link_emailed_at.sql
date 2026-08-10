-- Record when the office last emailed a parent their sign-in link. Append-only,
-- idempotent.

IF COL_LENGTH('dbo.families', 'link_emailed_at') IS NULL
    ALTER TABLE families ADD link_emailed_at DATETIME2 NULL;
GO
