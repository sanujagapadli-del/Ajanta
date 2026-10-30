// One-time import (2026-10-30): the team's beat Google Sheet "Dealer Database"
// → monthly "Counter Visit" tabs per salesman into beat_counters / beat_entries
// (the Beat page; MECA reads it). Fixed columns: Firm Name (B), Beat Days (C),
// AREA (D), CITY (E); then per day "N\nVisit | Order | Collection | New Counter
// | Reference | Enquiry" (Krishna / Rohit tabs skip some, so headers decide).
// Read-only on the sheet; re-running updates the same rows.
//   node scripts/import-beat-sheet.js            → dry run (prints per-tab totals)
//   node scripts/import-beat-sheet.js --write    → writes to MySQL
require('dotenv').config({ quiet: true });
const { google } = require('googleapis');
const mysql = require('mysql2/promise');

const SHEET_ID = '1kXQo0vaqSWwLeMDJqn5g0MkBAtsNq-Jl-8cEp2v8TWI';
// tab → [ERP user id, YYYY-MM]
const TABS = {
  'September Girdhar ji': [8, '2026-09'], 'Oct Girdhar ji Visit': [8, '2026-10'],
  'September Krishna ji': [15, '2026-09'], 'OCT Krishna ji Visit': [15, '2026-10'],
  'September Rohit': [3, '2026-09'], 'OCT Rohit ji': [3, '2026-10']
};
const FIELD = { visit: 'visit', order: 'order_amt', collection: 'collection_amt', collaction: 'collection_amt', 'new counter': 'new_counter', reference: 'reference', enquiry: 'enquiry' };

const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const amount = v => { const s = String(v).replace(/[^\d.]/g, ''); return s ? Number(s) : null; };

(async () => {
  const write = process.argv.includes('--write');
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_CELESTILE_B64, 'base64').toString());
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const counters = new Map(); // `${uid}|${name lower}` → { uid, name, beatDay, area, city, sort, month }
  const entries = new Map();  // `${uid}|${name lower}|${date}` → row
  const odd = [];
  for (const [tab, [uid, month]] of Object.entries(TABS)) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${tab}'!A1:FZ1200` });
    const [head, ...rows] = r.data.values || [];
    const cols = head.map((h, i) => {
      const m = String(h || '').match(/^\s*(\d{1,2})\s*\n\s*([a-z ]+?)\s*$/i);
      const f = m && FIELD[m[2].toLowerCase()];
      return f ? { i, day: Number(m[1]), f } : null;
    }).filter(Boolean);
    const daysIn = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
    let n = 0, filled = 0;
    rows.forEach((row, ri) => {
      const name = clean(row[1]);
      if (!name) return;
      const key = `${uid}|${name.toLowerCase()}`;
      const c = counters.get(key);
      // October's list wins over September's for beat day / area.
      if (!c || month > c.month) counters.set(key, { uid, name, beatDay: clean(row[2]), area: clean(row[3]) || null, city: clean(row[4]) && clean(row[4]) !== '--' ? clean(row[4]) : null, sort: ri + 1, month });
      n++;
      for (const col of cols) {
        const v = clean(row[col.i]);
        if (!v || col.day > daysIn) continue;
        const date = `${month}-${String(col.day).padStart(2, '0')}`;
        const ek = `${key}|${date}`;
        const e = entries.get(ek) || { key, date, visit: null, order_amt: null, collection_amt: null, new_counter: null, reference: null, enquiry: null };
        if (col.f === 'order_amt' || col.f === 'collection_amt') {
          const a = amount(v);
          if (a != null && a > 0) e[col.f] = a;
          else if (/^(yes|y)$/i.test(v)) e.visit = e.visit || 'yes';   // "yes" typed in the Order box = visited
          else if (a == null) odd.push(`${tab} ${name} ${date} ${col.f}=${v}`);
        } else if (col.f === "visit") { if (/^(yes|y|no|nahi|out|sir|visit|haan)/i.test(v)) e.visit = v.slice(0, 40); else odd.push(`${tab} ${name} ${date} visit=${v}`); }
        else e[col.f] = v.slice(0, 255);
        entries.set(ek, e);
        filled++;
      }
    });
    console.log(`${tab}: ${n} counters, ${filled} cells`);
  }
  // A cell skipped above ("Jaipur", "Sunday" …) can leave an all-empty day — not saved.
  const ents = [...entries.values()].filter(e => e.visit || e.order_amt || e.collection_amt || e.new_counter || e.reference || e.enquiry);
  const visited = ents.filter(e => e.order_amt > 0 || e.collection_amt > 0 || (e.visit && !/^(no|nahi|out)/i.test(e.visit))).length;
  console.log(`counters ${counters.size}, entries ${ents.length}, visited ${visited}, order ₹${ents.reduce((a, e) => a + (e.order_amt || 0), 0)}, collection ₹${ents.reduce((a, e) => a + (e.collection_amt || 0), 0)}`);
  if (odd.length) console.log(`skipped (not yes/no/₹) (${odd.length}):`, Object.entries(odd.reduce((a, o) => { const k = o.split("=").slice(1).join("=").slice(0, 40); a[k] = (a[k] || 0) + 1; return a; }, {})).sort((x, y) => y[1] - x[1]).slice(0, 25));
  if (!write) return console.log('Dry run — add --write to save.');

  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await db.query(`CREATE TABLE IF NOT EXISTS beat_counters (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, counter_name VARCHAR(255) NOT NULL,
    beat_day VARCHAR(30) NOT NULL DEFAULT '', area VARCHAR(120), city VARCHAR(80), sort_no INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_counter (user_id, counter_name), INDEX (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS beat_entries (
    id INT AUTO_INCREMENT PRIMARY KEY, counter_id INT NOT NULL, entry_date DATE NOT NULL,
    visit VARCHAR(40), order_amt DECIMAL(12,2), collection_amt DECIMAL(12,2),
    new_counter VARCHAR(255), reference VARCHAR(255), enquiry VARCHAR(255),
    updated_by INT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_counter_date (counter_id, entry_date), INDEX (entry_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const c of counters.values()) {
    await db.query(`INSERT INTO beat_counters (user_id, counter_name, beat_day, area, city, sort_no) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE beat_day=VALUES(beat_day), area=VALUES(area), city=VALUES(city), sort_no=VALUES(sort_no)`,
      [c.uid, c.name.slice(0, 255), c.beatDay.slice(0, 30), c.area && c.area.slice(0, 120), c.city && c.city.slice(0, 80), c.sort]);
  }
  const [ids] = await db.query('SELECT id, user_id, counter_name FROM beat_counters');
  const idOf = Object.fromEntries(ids.map(r => [`${r.user_id}|${r.counter_name.toLowerCase()}`, r.id]));
  const vals = ents.map(e => [idOf[e.key], e.date, e.visit, e.order_amt, e.collection_amt, e.new_counter, e.reference, e.enquiry]).filter(v => v[0]);
  for (let i = 0; i < vals.length; i += 500) {
    await db.query(`INSERT INTO beat_entries (counter_id, entry_date, visit, order_amt, collection_amt, new_counter, reference, enquiry) VALUES ?
      ON DUPLICATE KEY UPDATE visit=VALUES(visit), order_amt=VALUES(order_amt), collection_amt=VALUES(collection_amt),
        new_counter=VALUES(new_counter), reference=VALUES(reference), enquiry=VALUES(enquiry)`, [vals.slice(i, i + 500)]);
  }
  console.log(`written: ${counters.size} counters, ${vals.length} entries`);
  await db.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
