'use strict';

const sql = require('mssql');
const config = require('../config');

// iisnode may recycle the app pool at any time. We keep a lazily-created,
// per-process connection pool: cheap to re-create on a cold start, and never
// relied on to persist state between requests. All money math happens in SQL
// (spec §4), so the pool is just a conduit for parameterized queries.

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    const cfg = {
      server: config.db.server,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      options: config.db.options,
      pool: config.db.pool,
    };
    poolPromise = sql.connect(cfg).catch((err) => {
      // Reset so the next request retries a fresh connection after a cold start.
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

// Run a parameterized query. `params` is an object of { name: value } or
// { name: { type, value } }. NEVER interpolate user input into `text`.
async function query(text, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [name, val] of Object.entries(params)) {
    if (val && typeof val === 'object' && 'type' in val) {
      request.input(name, val.type, val.value);
    } else {
      request.input(name, val);
    }
  }
  return request.query(text);
}

// Convenience: run several statements inside one transaction. `work` receives a
// helper with the same (text, params) signature bound to the transaction.
async function withTransaction(work) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  const txQuery = (text, params = {}) => {
    const request = new sql.Request(tx);
    for (const [name, val] of Object.entries(params)) {
      if (val && typeof val === 'object' && 'type' in val) {
        request.input(name, val.type, val.value);
      } else {
        request.input(name, val);
      }
    }
    return request.query(text);
  };
  try {
    const result = await work(txQuery);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

module.exports = { sql, getPool, query, withTransaction };
