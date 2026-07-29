'use strict';

// Runs every .sql file in ./migrations in filename order. Idempotent SQL means
// re-running is safe. Creates the target database first if it does not exist.
//
//   npm run migrate
//
// No migration-tracking table yet (v1 has a single init file and idempotent
// guards); add one when migrations start to accumulate.

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const config = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function poolConfig(database) {
  return {
    server: config.db.server,
    port: config.db.port,
    database,
    user: config.db.user,
    password: config.db.password,
    options: config.db.options,
  };
}

// mssql sends one batch per query() call and does not understand the `GO`
// separator (that is a client tool directive). Split the file on standalone GO.
function splitBatches(text) {
  return text
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

// Create the target database if we can. On shared hosting (SmarterASP.NET) the
// login is scoped to a single, pre-created database and has NO access to master —
// that is expected, so a failure here is a warning, not an error. We use a
// dedicated ConnectionPool (not the global sql.connect) to avoid the mssql
// singleton returning the master pool when we later connect to the target DB.
async function tryEnsureDatabase() {
  if (!/^[A-Za-z0-9_]+$/.test(config.db.database)) {
    throw new Error(`Unsafe database name: ${config.db.database}`);
  }
  const master = new sql.ConnectionPool(poolConfig('master'));
  try {
    await master.connect();
    await master.request().query(
      `IF DB_ID(N'${config.db.database}') IS NULL CREATE DATABASE [${config.db.database}];`
    );
    console.log(`> Database "${config.db.database}" is present.`);
  } finally {
    await master.close().catch(() => {});
  }
}

async function run() {
  console.log(`> Checking database "${config.db.database}"...`);
  try {
    await tryEnsureDatabase();
  } catch (err) {
    console.warn(
      `> Could not create/verify via master (${err.message.split('\n')[0]}).`
    );
    console.warn(`> Assuming "${config.db.database}" already exists (normal on shared hosting).`);
  }

  const pool = new sql.ConnectionPool(poolConfig(config.db.database));
  await pool.connect();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Filtered indexes require these SET options ON. The pool may run each batch on
  // a different physical connection, so we prepend the options to EVERY batch
  // rather than relying on connection-scoped state carrying across batches.
  const SET_OPTS = 'SET QUOTED_IDENTIFIER ON; SET ANSI_NULLS ON;\n';

  for (const file of files) {
    console.log(`> Running ${file}...`);
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const batch of splitBatches(text)) {
      await pool.request().batch(SET_OPTS + batch);
    }
  }

  await pool.close();
  console.log('> Migrations complete.');
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
