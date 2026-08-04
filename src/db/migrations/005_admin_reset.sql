-- Self-service admin password reset. Single-use, short-lived, HASH stored (never
-- the raw token) — same discipline as parent magic links. Append-only, idempotent.

IF OBJECT_ID('dbo.admin_reset_tokens', 'U') IS NULL
CREATE TABLE admin_reset_tokens (
    token_hash  NVARCHAR(128) PRIMARY KEY,   -- SHA-256 of the token
    admin_id    INT       NOT NULL REFERENCES admin_users(id),
    expires_at  DATETIME2 NOT NULL,
    used_at     DATETIME2 NULL,
    created_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
