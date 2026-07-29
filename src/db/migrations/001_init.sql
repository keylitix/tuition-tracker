-- Tuition Tracker — initial schema (spec §5).
-- Idempotent: guarded with IF NOT EXISTS so re-running migrate is safe.
-- Money is never stored as a computed balance; balance = SUM(charges) - SUM(payments).

/* ---------- families ---------- */
IF OBJECT_ID('dbo.families', 'U') IS NULL
CREATE TABLE families (
    id                  INT IDENTITY PRIMARY KEY,
    external_id         NVARCHAR(50)  NOT NULL UNIQUE,   -- stable, for future export
    name                NVARCHAR(200) NOT NULL,
    email               NVARCHAR(255) NOT NULL,
    phone               NVARCHAR(30)  NULL,
    stripe_customer_id  NVARCHAR(50)  NULL,
    active              BIT           NOT NULL DEFAULT 1,
    created_at          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
-- Webhook lookups match a family by stripe_customer_id (spec §7).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_families_stripe_customer')
    CREATE INDEX IX_families_stripe_customer ON families(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
GO
-- Parent magic-link login matches an active family by email.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_families_email')
    CREATE INDEX IX_families_email ON families(email);
GO

/* ---------- admin_users (before charges/payments FKs) ---------- */
IF OBJECT_ID('dbo.admin_users', 'U') IS NULL
CREATE TABLE admin_users (
    id            INT IDENTITY PRIMARY KEY,
    email         NVARCHAR(255) NOT NULL UNIQUE,
    password_hash NVARCHAR(255) NOT NULL,
    display_name  NVARCHAR(100) NOT NULL,
    active        BIT           NOT NULL DEFAULT 1
);
GO

/* ---------- students ---------- */
IF OBJECT_ID('dbo.students', 'U') IS NULL
CREATE TABLE students (
    id            INT IDENTITY PRIMARY KEY,
    external_id   NVARCHAR(50)  NOT NULL UNIQUE,
    family_id     INT           NOT NULL REFERENCES families(id),
    first_name    NVARCHAR(100) NOT NULL,
    last_name     NVARCHAR(100) NOT NULL,
    grade         NVARCHAR(20)  NULL,
    school_year   NVARCHAR(9)   NOT NULL,               -- e.g. '2026-2027'
    active        BIT           NOT NULL DEFAULT 1
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_students_family')
    CREATE INDEX IX_students_family ON students(family_id);
GO

/* ---------- charges (what is owed) ---------- */
IF OBJECT_ID('dbo.charges', 'U') IS NULL
CREATE TABLE charges (
    id           INT IDENTITY PRIMARY KEY,
    student_id   INT            NOT NULL REFERENCES students(id),
    description  NVARCHAR(255)  NOT NULL,
    amount       DECIMAL(10,2)  NOT NULL,
    due_date     DATE           NULL,
    school_year  NVARCHAR(9)    NOT NULL,
    voided       BIT            NOT NULL DEFAULT 0,       -- soft delete only
    created_at   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    created_by   INT            NULL REFERENCES admin_users(id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_charges_student')
    CREATE INDEX IX_charges_student ON charges(student_id);
GO

/* ---------- payments (what has been paid, from any source) ---------- */
IF OBJECT_ID('dbo.payments', 'U') IS NULL
CREATE TABLE payments (
    id                       INT IDENTITY PRIMARY KEY,
    family_id                INT            NOT NULL REFERENCES families(id),
    amount                   DECIMAL(10,2)  NOT NULL,    -- negative for refunds
    method                   NVARCHAR(20)   NOT NULL,    -- ach|card|check|pctc|adjustment|refund
    received_on              DATE           NOT NULL,
    school_year              NVARCHAR(9)    NOT NULL,
    note                     NVARCHAR(500)  NULL,
    check_number             NVARCHAR(50)   NULL,
    pctc_endorsed_on         DATE           NULL,        -- PCTC only; NULL = held, unendorsed
    stripe_payment_intent_id NVARCHAR(50)   NULL,
    stripe_invoice_id        NVARCHAR(50)   NULL,
    created_at               DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    created_by               INT            NULL REFERENCES admin_users(id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_payments_family')
    CREATE INDEX IX_payments_family ON payments(family_id);
GO
-- PCTC worklist: unendorsed awards the school is holding but cannot deposit.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_payments_pctc_unendorsed')
    CREATE INDEX IX_payments_pctc_unendorsed ON payments(family_id)
        WHERE method = 'pctc' AND pctc_endorsed_on IS NULL;
GO
-- A Stripe payment maps to at most one payments row (idempotency backstop).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_payments_stripe_pi')
    CREATE UNIQUE INDEX UX_payments_stripe_pi ON payments(stripe_payment_intent_id)
        WHERE stripe_payment_intent_id IS NOT NULL;
GO

/* ---------- stripe_events (webhook idempotency, spec §7) ---------- */
IF OBJECT_ID('dbo.stripe_events', 'U') IS NULL
CREATE TABLE stripe_events (
    event_id     NVARCHAR(50) PRIMARY KEY,
    event_type   NVARCHAR(100) NOT NULL,
    processed_at DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

/* ---------- magic_tokens (parent login; store the HASH only) ---------- */
IF OBJECT_ID('dbo.magic_tokens', 'U') IS NULL
CREATE TABLE magic_tokens (
    token_hash  NVARCHAR(128) PRIMARY KEY,
    family_id   INT       NOT NULL REFERENCES families(id),
    expires_at  DATETIME2 NOT NULL,
    used_at     DATETIME2 NULL,
    created_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

/* ---------- webhook_errors (admin-visible log for unmatched/failed events) ---------- */
IF OBJECT_ID('dbo.webhook_errors', 'U') IS NULL
CREATE TABLE webhook_errors (
    id          INT IDENTITY PRIMARY KEY,
    event_id    NVARCHAR(50)   NULL,
    event_type  NVARCHAR(100)  NULL,
    message     NVARCHAR(1000) NOT NULL,
    payload     NVARCHAR(MAX)  NULL,
    resolved    BIT            NOT NULL DEFAULT 0,
    created_at  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

/* ---------- payment_failures (roster flag for invoice.payment_failed) ---------- */
IF OBJECT_ID('dbo.payment_failures', 'U') IS NULL
CREATE TABLE payment_failures (
    id                INT IDENTITY PRIMARY KEY,
    family_id         INT            NULL REFERENCES families(id),
    stripe_invoice_id NVARCHAR(50)   NULL,
    amount            DECIMAL(10,2)  NULL,
    cleared           BIT            NOT NULL DEFAULT 0,
    failed_at         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

/* ---------- sessions (connect-mssql-v2 store; no in-memory session state) ---------- */
IF OBJECT_ID('dbo.sessions', 'U') IS NULL
CREATE TABLE sessions (
    sid     NVARCHAR(255) NOT NULL PRIMARY KEY,
    session NVARCHAR(MAX) NOT NULL,
    expires DATETIME      NOT NULL
);
GO
