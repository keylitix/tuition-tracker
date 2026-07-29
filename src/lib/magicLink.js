'use strict';

// Parent magic-link auth (spec §8). We store only the SHA-256 hash of the token;
// the raw token exists only in the emailed URL. Tokens are single-use and expire.

const crypto = require('crypto');
const { sql, query } = require('../db/pool');
const config = require('../config');

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 256 bits of entropy
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Rate-limit per email (spec §8): count tokens issued to this family in the last hour.
async function recentRequestCount(familyId) {
  const r = await query(
    `SELECT COUNT(*) AS n FROM magic_tokens
      WHERE family_id = @familyId
        AND created_at > DATEADD(hour, -1, SYSUTCDATETIME());`,
    { familyId: { type: sql.Int, value: familyId } }
  );
  return r.recordset[0].n;
}

async function createToken(familyId) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  await query(
    `INSERT INTO magic_tokens (token_hash, family_id, expires_at)
     VALUES (@hash, @familyId, DATEADD(minute, @ttl, SYSUTCDATETIME()));`,
    {
      hash: { type: sql.NVarChar(128), value: tokenHash },
      familyId: { type: sql.Int, value: familyId },
      ttl: { type: sql.Int, value: config.magicLink.ttlMinutes },
    }
  );
  return token;
}

// Atomically consume a token: valid + unexpired + unused. Marks it used and
// returns the family_id, or null. The UPDATE...OUTPUT is the single point of
// truth so two concurrent clicks cannot both succeed.
async function consumeToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const r = await query(
    `UPDATE magic_tokens
        SET used_at = SYSUTCDATETIME()
      OUTPUT INSERTED.family_id
      WHERE token_hash = @hash
        AND used_at IS NULL
        AND expires_at > SYSUTCDATETIME();`,
    { hash: { type: sql.NVarChar(128), value: tokenHash } }
  );
  return r.recordset[0] ? r.recordset[0].family_id : null;
}

module.exports = { generateToken, hashToken, recentRequestCount, createToken, consumeToken };
