// One-time migration: read everything out of the Google Sheets DB
// (sheets-db.js) and insert it into the real MySQL database (mysql-db.js),
// preserving the original numeric ids so cross-table references
// (assigned_to, task_id, fms_id, step_id, etc.) stay intact.
//
// Usage: node migrate-to-mysql.js
// Requires .env to have both GOOGLE_SHEET_ID (+ credentials) and the
// DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME vars set.

require('dotenv').config();
const sheetsDb = require('./sheets-db');
const mysqlPool = require('./mysql-db');

const TABLES = [
  'users',
  'delegation_tasks',
  'checklist_tasks',
  'task_approvals',
  'task_transfers',
  'task_comments',
  'week_plans',
  'fms_sheets',
  'fms_steps',
  'fms_step_doers',
  'fms_extra_rows',
  'holidays'
];

async function migrateTable(table) {
  const [rows] = await sheetsDb.query(`SELECT * FROM ${table}`);
  if (!rows.length) {
    console.log(`  ${table}: 0 rows (skipped)`);
    return;
  }
  const cols = Object.keys(rows[0]);
  const placeholders = `(${cols.map(() => '?').join(',')})`;
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${rows.map(() => placeholders).join(',')}
    ON DUPLICATE KEY UPDATE id=id`; // idempotent — safe to re-run
  const params = rows.flatMap(r => cols.map(c => r[c] === undefined ? null : r[c]));
  await mysqlPool.query(sql, params);
  console.log(`  ${table}: ${rows.length} rows migrated`);
}

(async () => {
  console.log('Loading Google Sheets DB into memory...');
  await sheetsDb.init();
  console.log('Loaded. Migrating tables to MySQL:\n');
  for (const table of TABLES) {
    await migrateTable(table);
  }
  console.log('\nDone.');
  await mysqlPool.end();
  process.exit(0);
})().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
