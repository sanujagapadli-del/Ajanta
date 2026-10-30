// One-time import (2026-10-30): the team's old MECA Google Sheet
// "BMP_Unified_System_Rebuilt" → Form1_DailySales (one row per salesman per
// day: old clients met / ordered / ₹, new clients visited / ordered / ₹) into
// meca_sheet_daily, which /api/meca adds to its day rows. Read-only on the
// sheet; re-running updates the same rows (keyed by salesman + timestamp).
//   node scripts/import-meca-sheet.js            → dry run (prints totals)
//   node scripts/import-meca-sheet.js --write    → writes to MySQL
require('dotenv').config({ quiet: true });
const { google } = require('googleapis');
const mysql = require('mysql2/promise');

const SHEET_ID = '1M2aFZt2SWoYEgChUrNNzESrv9MSIDWbweTvENV7Cw7M';
const TAB = 'Form1_DailySales';
// Sheet "Salesperson Name" → ERP user id
const USER_BY_NAME = { girdhar: 8, rohit: 3, krishna: 15 };

const num = v => Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')) || 0;

(async () => {
  const write = process.argv.includes('--write');
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_CELESTILE_B64, 'base64').toString());
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TAB}'!A2:H1000` });

  const rows = [], skipped = [];
  for (const r of res.data.values || []) {
    const m = String(r[0] || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) continue;
    const uid = USER_BY_NAME[String(r[1] || '').trim().toLowerCase().split(/\s+/)[0]];
    if (!uid) { skipped.push(r[1]); continue; }
    // Counted on the day the form was filled — same as the sheet's own Dashboard_Daily.
    const day = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const ts = `${day} ${m[4].padStart(2, '0')}:${m[5]}:${m[6]}`;
    let oldOrdered = num(r[3]), oldAmount = num(r[4]);
    // Amount typed into the "who gave order" count (23-Oct Girdhar: 31600 / ₹0) — it is the ₹, one order.
    if (oldOrdered > 1000 && !oldAmount) { oldAmount = oldOrdered; oldOrdered = 1; }
    rows.push([uid, day, ts, num(r[2]), oldOrdered, oldAmount, num(r[5]), num(r[6]), num(r[7])]);
  }
  const t = rows.reduce((a, r) => ({ met: a.met + r[3], ordered: a.ordered + r[4], amount: a.amount + r[5] + r[8], nbd: a.nbd + r[6] }), { met: 0, ordered: 0, amount: 0, nbd: 0 });
  console.log(`${rows.length} rows, ${rows[0] && rows[0][1]} → ${rows.length && rows[rows.length - 1][1]}`, t, skipped.length ? `skipped names: ${[...new Set(skipped)]}` : '');
  if (!write) return console.log('Dry run — add --write to save.');

  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await db.query(`CREATE TABLE IF NOT EXISTS meca_sheet_daily (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, day DATE NOT NULL, sheet_ts DATETIME NOT NULL,
    old_met INT NOT NULL DEFAULT 0, old_ordered INT NOT NULL DEFAULT 0, old_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    new_visited INT NOT NULL DEFAULT 0, new_ordered INT NOT NULL DEFAULT 0, new_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_user_ts (user_id, sheet_ts), INDEX (day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [r] = await db.query(`INSERT INTO meca_sheet_daily (user_id, day, sheet_ts, old_met, old_ordered, old_amount, new_visited, new_ordered, new_amount) VALUES ?
    ON DUPLICATE KEY UPDATE day=VALUES(day), old_met=VALUES(old_met), old_ordered=VALUES(old_ordered), old_amount=VALUES(old_amount),
      new_visited=VALUES(new_visited), new_ordered=VALUES(new_ordered), new_amount=VALUES(new_amount)`, [rows]);
  console.log('written, affectedRows', r.affectedRows);
  await db.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
