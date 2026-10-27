// ══════════════════════════════════════════════════════════════════
// mysql-db.js — real MySQL/MariaDB connection pool
// ──────────────────────────────────────────────────────────────────
// server.js was originally written against a real mysql2/promise pool
// (see sheets-db.js's own header comment: it's a drop-in stand-in for
// this exact interface). So this file needs no wrapper — mysql2's pool
// already implements .query / .execute / .getConnection natively.
// ══════════════════════════════════════════════════════════════════

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  // Every Vercel instance has its own pool, and the host's firewall blocks
  // AWS IPs that open too many MySQL connections (2026-10-22 outage) — so
  // keep each pool small and let idle connections close.
  connectionLimit: 4,
  maxIdle: 1,
  idleTimeout: 60000,
  enableKeepAlive: true,
  connectTimeout: 8000,
  queueLimit: 0,
  dateStrings: true, // DATE/DATETIME come back as 'YYYY-MM-DD[ HH:MM:SS]' strings, matching sheets-db.js's shape
  charset: 'utf8mb4_general_ci'
});

// sheets-db.js exposes a couple of extra methods (init/resync/flushNow) that
// only make sense for an in-memory-synced-from-a-sheet backend. A real MySQL
// pool is always live, so these are just no-ops — kept so server.js's calls
// to them don't need any special-casing between the two backends.
// The host caps connections per DB user across ALL Vercel instances. When
// they're all taken, MySQL refuses the new connection ("max_user_connections",
// 1203 / 1040) and every request in that moment failed — including /api/me,
// which logged people out (client list 2026-10-27 #18). The refusal happens
// before the query runs, so waiting a moment and trying again is safe.
const isDbBusy = e => !!e && (['ER_TOO_MANY_USER_CONNECTIONS', 'ER_USER_LIMIT_REACHED', 'ER_CON_COUNT_ERROR'].includes(e.code)
  || /max_user_connections|Too many connections/i.test(e.message || ''));
const withBusyRetry = fn => async (...args) => {
  for (let i = 0; ; i++) {
    try { return await fn(...args); } catch (e) {
      if (!isDbBusy(e) || i >= 3) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1) + Math.random() * 300));
    }
  }
};
pool.query = withBusyRetry(pool.query.bind(pool));
pool.execute = withBusyRetry(pool.execute.bind(pool));
pool.getConnection = withBusyRetry(pool.getConnection.bind(pool));

pool.init = async () => { await pool.query('SELECT 1'); }; // fails fast on bad creds at boot
pool.resync = async () => {}; // nothing to resync — MySQL is always the live source
pool.flushNow = async () => {};

module.exports = pool;
