-- Standard tuition rate (per student, per school year) and an optional-items
-- catalog (e.g. $10 device insurance). Registration fees are intentionally NOT
-- here — they are collected on a separate enrollment form.
-- Append-only, idempotent.

IF OBJECT_ID('dbo.tuition_rates', 'U') IS NULL
CREATE TABLE tuition_rates (
    school_year     NVARCHAR(9)   NOT NULL PRIMARY KEY,
    annual_tuition  DECIMAL(10,2) NOT NULL,          -- per student, per year
    updated_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Optional add-ons the office applies only to students who opt in. Adding one to
-- a family just creates an ordinary charge, so it flows through balance/plan math
-- like everything else.
IF OBJECT_ID('dbo.optional_items', 'U') IS NULL
CREATE TABLE optional_items (
    id          INT IDENTITY PRIMARY KEY,
    name        NVARCHAR(200) NOT NULL,               -- 'Device insurance'
    amount      DECIMAL(10,2) NOT NULL,
    active      BIT           NOT NULL DEFAULT 1,
    created_at  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
