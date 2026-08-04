'use strict';

// Admin password-reset tokens. We store only the SHA-256 hash of the token; the
// raw token exists only in the emailed link. Tokens are single-use and expire.
// Same discipline as parent magic links (spec §8).

const crypto = require('crypto');
const { sql, query } = require('../db/pool');
const config = require('../config');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Rate-limit reset requests per admin.
async function recentRequestCount(adminId) {
  const r = await query(
    `SELECT COUNT(*) AS n FROM admin_reset_tokens
      WHERE admin_id = @adminId AND created_at > DATEADD(hour, -1, SYSUTCDATETIME());`,
    { adminId: { type: sql.Int, value: adminId } }
  );
  return r.recordset[0].n;
}

async function createToken(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO admin_reset_tokens (token_hash, admin_id, expires_at)
     VALUES (@hash, @adminId, DATEADD(minute, @ttl, SYSUTCDATETIME()));`,
    {
      hash: { type: sql.NVarChar(128), value: hashToken(token) },
      adminId: { type: sql.Int, value: adminId },
      ttl: { type: sql.Int, value: config.adminReset.ttlMinutes },
    }
  );
  return token;
}

// Validate a token without consuming it (used to render the set-password form).
async function peekToken(rawToken) {
  const r = await query(
    `SELECT admin_id FROM admin_reset_tokens
      WHERE token_hash = @hash AND used_at IS NULL AND expires_at > SYSUTCDATETIME();`,
    { hash: { type: sql.NVarChar(128), value: hashToken(rawToken) } }
  );
  return r.recordset[0] ? r.recordset[0].admin_id : null;
}

// Atomically consume a token (single-use). Returns the admin_id or null.
async function consumeToken(rawToken) {
  const r = await query(
    `UPDATE admin_reset_tokens
        SET used_at = SYSUTCDATETIME()
      OUTPUT INSERTED.admin_id
      WHERE token_hash = @hash AND used_at IS NULL AND expires_at > SYSUTCDATETIME();`,
    { hash: { type: sql.NVarChar(128), value: hashToken(rawToken) } }
  );
  return r.recordset[0] ? r.recordset[0].admin_id : null;
}

module.exports = { hashToken, recentRequestCount, createToken, peekToken, consumeToken };
