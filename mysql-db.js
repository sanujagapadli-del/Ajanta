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
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true, // DATE/DATETIME come back as 'YYYY-MM-DD[ HH:MM:SS]' strings, matching sheets-db.js's shape
  charset: 'utf8mb4_general_ci'
});

// sheets-db.js exposes a couple of extra methods (init/resync/flushNow) that
// only make sense for an in-memory-synced-from-a-sheet backend. A real MySQL
// pool is always live, so these are just no-ops — kept so server.js's calls
// to them don't need any special-casing between the two backends.
pool.init = async () => { await pool.query('SELECT 1'); }; // fails fast on bad creds at boot
pool.resync = async () => {}; // nothing to resync — MySQL is always the live source
pool.flushNow = async () => {};

module.exports = pool;
