'use strict';

// Seed or update an admin user (spec §8 — no self-registration).
//   node src/scripts/create-admin.js "office@school.org" "Office Admin" "s3cret-pw"
// Re-running with an existing email updates the password and name.

const bcrypt = require('bcryptjs');
const { sql, query } = require('../db/pool');

async function run() {
  const [email, displayName, password] = process.argv.slice(2);
  if (!email || !displayName || !password) {
    console.error('Usage: node src/scripts/create-admin.js "<email>" "<display name>" "<password>"');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  await query(
    `MERGE admin_users AS t
     USING (SELECT @email AS email) AS s ON t.email = s.email
     WHEN MATCHED THEN UPDATE SET password_hash = @hash, display_name = @name, active = 1
     WHEN NOT MATCHED THEN INSERT (email, password_hash, display_name)
          VALUES (@email, @hash, @name);`,
    {
      email: { type: sql.NVarChar(255), value: email.toLowerCase() },
      hash: { type: sql.NVarChar(255), value: hash },
      name: { type: sql.NVarChar(100), value: displayName },
    }
  );
  console.log(`Admin ready: ${email}`);
  process.exit(0);
}

run().catch((err) => { console.error(err.message); process.exit(1); });
