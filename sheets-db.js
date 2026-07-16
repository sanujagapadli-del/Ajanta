// ══════════════════════════════════════════════════════════════════
// sheets-db.js — Google Sheets backed in-memory database adapter
// ──────────────────────────────────────────────────────────────────
// • Drop-in replacement for mysql2/promise pool: db.query / db.execute /
//   db.getConnection() — no changes needed in server.js.
// • Internally uses alasql (in-memory SQL engine) — all reads from
//   memory = microseconds (50-100x faster than MySQL).
// • Writes first to memory (instant response), then in the background
//   a debounced batchUpdate call to Google Sheets (after 1.5 sec).
// • Set the Sheet ID in `.env` as `GOOGLE_SHEET_ID` — on first run
//   with a blank sheet, all tabs (users, tasks, etc.) are auto-created
//   with headers, and a default admin user is seeded
//   (Vishal@gmail.com / pass123).
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const alasql = require('alasql');
const { google } = require('googleapis');

// ── Config ─────────────────────────────────────────────────────────
const FLUSH_DEBOUNCE_MS = 1500;
const MAX_CELL_CHARS = 45000;       // Sheets cell limit ~50k, leave room
const BLOB_DIR = path.join(__dirname, 'data', 'blobs');

// ── Schema (10 tables) ─────────────────────────────────────────────
// `cols` = authoritative column order (also used as sheet headers)
// `autoFill` = if a column is missing on INSERT, this default is filled in
// keyType: 'AUTO' = AUTOINCREMENT INT id, 'NONE' = no auto key

const SCHEMA = {
  users: {
    cols: ['id','name','email','notification_email','password','role','phone','profile_image','department','week_off','extra_off','is_active'],
    autoFill: { is_active: 1 }
  },
  delegation_tasks: {
    cols: ['id','title','description','assigned_to','assigned_by','due_date','start_date','status','priority','approval','waiting_approval','remarks','link','revision_status','created_at','last_reminder_date','completed_at'],
    autoFill: { created_at: 'NOW' }
  },
  checklist_tasks: {
    cols: ['id','title','description','assigned_to','assigned_by','due_date','start_date','status','priority','remarks','frequency','created_at','completed_at'],
    autoFill: { created_at: 'NOW' }
  },
  task_approvals: {
    cols: ['id','task_id','task_type','requested_by','requested_to','action_type','status','note','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  task_transfers: {
    cols: ['id','task_id','task_type','from_user','to_user','requested_by','status','note','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  task_comments: {
    cols: ['id','task_id','task_type','user_id','comment','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  week_plans: {
    cols: ['id','employee_id','hod_id','start_date','target_count','improvement_pct','created_at','updated_at'],
    autoFill: { created_at: 'NOW', updated_at: 'NOW' }
  },
  fms_sheets: {
    cols: ['id','fms_name','sheet_name','sheet_id','header_row','total_steps','created_by','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  fms_steps: {
    cols: ['id','fms_id','step_order','step_name','plan_col','actual_col','extra_input','extra_col','show_cols','delay_reason_col','doer_name_col'],
    autoFill: {}
  },
  fms_step_doers: {
    cols: ['id','step_id','user_id'],
    autoFill: {}
  },
  fms_extra_rows: {
    cols: ['id','step_id','row_label','col_letter','field_type','dropdown_options'],
    autoFill: {}
  },
  holidays: {
    cols: ['id','date','name'],
    autoFill: {}
  },
  sales_targets: {
    cols: ['id','group_key','group_name','target_amount','month1_pct','month2_pct','month3_pct','updated_by','updated_at'],
    autoFill: { updated_at: 'NOW' }
  },
  sales_target_categories: {
    cols: ['id','year','category_name','codes','period_type','periods_json','target_amount','updated_by','updated_at'],
    autoFill: { updated_at: 'NOW' }
  }
};

const TABLE_NAMES = Object.keys(SCHEMA);

// Derived "display" columns — shown as extra columns in the sheet but not stored in alasql.
// For user-facing readability (e.g. YES/NO instead of 'completed'/'pending').
// Ignored at init-time (load only reads SCHEMA cols).
const SHEET_DERIVED = {
  delegation_tasks: {
    is_done: row => (row.status === 'completed') ? 'YES' : 'NO'
  },
  checklist_tasks: {
    is_done: row => (row.status === 'completed') ? 'YES' : 'NO'
  }
};

// Integer columns — values come from the sheet as strings, parsed before
// inserting into alasql so arithmetic/IN comparisons work correctly in SQL.
const INT_COLS = new Set([
  'id','assigned_to','assigned_by','user_id','task_id','requested_by','requested_to',
  'employee_id','hod_id','target_count','improvement_pct','fms_id','step_id','step_order',
  'total_steps','header_row','from_user','to_user','waiting_approval','created_by',
  'target_amount','month1_pct','month2_pct','month3_pct','year'
]);

// Date-only columns — stored as proper date cells in Sheets (USER_ENTERED write).
// When read back with UNFORMATTED_VALUE, Sheets returns these as date serial numbers
// (days since 1899-12-30). We convert them back to YYYY-MM-DD strings here.
const DATE_COLS = new Set(['due_date','start_date','date','last_reminder_date']);
// Datetime columns — serial may be fractional (fractional = time-of-day).
const DATETIME_COLS = new Set(['created_at','updated_at','completed_at','assigned_on']);

function _serialToDate(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function _serialToDatetime(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  return d.toISOString().slice(0, 19).replace('T', ' '); // YYYY-MM-DD HH:MM:SS
}

// ══════════════════════════════════════════════════════════════════
// ALASQL CUSTOM FUNCTIONS (MySQL compatibility)
// ══════════════════════════════════════════════════════════════════
function isoDate() { return new Date().toISOString().slice(0,10); }
function isoDateTime() { return new Date().toISOString().slice(0,19).replace('T',' '); }

alasql.fn.DATE_FORMAT = function (d, fmt) {
  if (d == null || d === '') return null;
  let s = String(d);
  // already YYYY-MM-DD or similar — slice
  if (fmt === '%Y-%m-%d') return s.length >= 10 ? s.slice(0,10) : s;
  // fallback generic
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return s.slice(0,10);
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const day = String(dt.getDate()).padStart(2,'0');
  return String(fmt).replace('%Y',y).replace('%m',m).replace('%d',day);
};
alasql.fn.CURDATE = isoDate;
alasql.fn.NOW = isoDateTime;
alasql.fn.CURRENT_TIMESTAMP = isoDateTime;
alasql.fn.YEAR = (d) => {
  if (!d) return null;
  const s = String(d);
  return parseInt(s.slice(0,4), 10) || null;
};

// ══════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════
let _api = null;
let _spreadsheetId = null;
let _tabIdByName = {};   // tabName -> sheetId (numeric, used for delete)
let _initialized = false;
let _initPromise = null;

const _dirtyTables = new Set();
let _flushTimer = null;
let _flushInProgress = false;
let _pendingFlushResolvers = [];

// Per-table next-auto-id counter (used for insertId result)
const _nextId = {};

// ══════════════════════════════════════════════════════════════════
// BLOB STORAGE (for large cells like profile images)
// ══════════════════════════════════════════════════════════════════
function ensureBlobDir() {
  if (!fs.existsSync(BLOB_DIR)) fs.mkdirSync(BLOB_DIR, { recursive: true });
}
function blobStore(value) {
  ensureBlobDir();
  const hash = crypto.createHash('md5').update(value).digest('hex');
  const file = path.join(BLOB_DIR, `${hash}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, value, 'utf8');
  return `blob:${hash}`;
}
function blobLoad(ref) {
  const hash = String(ref).slice(5);
  const file = path.join(BLOB_DIR, `${hash}.txt`);
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function serializeForSheet(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.length > MAX_CELL_CHARS) return blobStore(s);
  return s;
}
function deserializeFromSheet(v) {
  if (typeof v === 'string' && v.startsWith('blob:')) return blobLoad(v);
  return v;
}

function parseCellValue(col, raw) {
  let v = deserializeFromSheet(raw);
  if (v === undefined || v === null || v === '') {
    return INT_COLS.has(col) ? null : '';
  }
  if (INT_COLS.has(col)) {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  // Sheets returns date cells as serial numbers when read with UNFORMATTED_VALUE
  if (DATE_COLS.has(col) && typeof v === 'number' && v > 1) {
    return _serialToDate(v);
  }
  if (DATETIME_COLS.has(col) && typeof v === 'number' && v > 1) {
    return _serialToDatetime(v);
  }
  return v;
}

// ══════════════════════════════════════════════════════════════════
// GOOGLE SHEETS CLIENT
// ══════════════════════════════════════════════════════════════════
function parseCredsEnv(raw) {
  raw = raw.trim();
  try { return JSON.parse(raw); } catch(_) {}
  // Fallback: dashboard paste sometimes appends a stray char.
  // Extract the first balanced {...} block.
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('GOOGLE_CREDENTIALS does not contain a JSON object');
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error('GOOGLE_CREDENTIALS JSON is malformed (unbalanced braces)');
}

function loadCreds() {
  // Try multiple interpretations of the env vars and pick the first that yields
  // a usable service-account object. Dashboard paste can mangle long values, so
  // we are deliberately lenient.
  const candidates = [];
  const b64 = process.env.GOOGLE_CREDENTIALS_B64;
  if (b64) {
    const clean = b64.replace(/[^A-Za-z0-9+/=]/g, ''); // strip whitespace/junk
    try { candidates.push(Buffer.from(clean, 'base64').toString('utf8')); } catch(_) {}
    candidates.push(b64); // in case raw JSON was pasted into the _B64 field
  }
  if (process.env.GOOGLE_CREDENTIALS) candidates.push(process.env.GOOGLE_CREDENTIALS);

  for (const c of candidates) {
    try {
      const creds = parseCredsEnv(c);
      if (creds && creds.private_key && creds.client_email) return creds;
    } catch(_) {}
  }
  return require('./credentials.json');
}

async function getApiClient() {
  if (_api) return _api;
  let creds = loadCreds();
  // Env-var paste often turns real newlines in private_key into literal "\n"
  // (or worse, "\\n"). Normalize to real newlines so Google can verify the JWT.
  if (creds && creds.private_key) {
    creds.private_key = creds.private_key
      .replace(/\\\\n/g, '\n')
      .replace(/\\n/g, '\n');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  _api = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _api;
}

function getSpreadsheetId() {
  const raw = (process.env.GOOGLE_SHEET_ID || process.env.SHEET_ID || '').trim();
  if (!raw) throw new Error('GOOGLE_SHEET_ID env var not set — please set it to your Google Sheet ID');
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}

// ══════════════════════════════════════════════════════════════════
// INIT — load all tables from Sheets into alasql
// ══════════════════════════════════════════════════════════════════
async function init() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      _spreadsheetId = getSpreadsheetId();
      const api = await getApiClient();

      // 1. Create alasql tables (basic schema)
      for (const t of TABLE_NAMES) {
        const colsSql = SCHEMA[t].cols
          .map(c => `\`${c}\` ${c==='id' ? 'INT' : 'STRING'}`)
          .join(', ');
        alasql(`CREATE TABLE IF NOT EXISTS ${t} (${colsSql})`);
      }

      // 2. Optimistic fast path: try to bulk-load every expected tab directly, skipping
      // the separate metadata/tab-existence check that used to always run first. Every
      // tab already existing is by far the common case (true on every run except the
      // very first setup, or right after a new table is added to SCHEMA) — this cuts
      // Google Sheets API calls per init from 2 down to 1. That matters a lot more than
      // it used to: on an always-on process this only ran once per deployment, but on
      // Vercel's serverless model every cold start re-runs this whole init from scratch,
      // and enough of those within a minute can trip Google's per-minute read quota.
      let existingTables = TABLE_NAMES;
      let valueRanges;
      try {
        const batchResp = await api.spreadsheets.values.batchGet({
          spreadsheetId: _spreadsheetId,
          ranges: TABLE_NAMES.map(t => `${t}!A:ZZ`),
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER'
        });
        valueRanges = batchResp.data.valueRanges || [];
      } catch (fastPathErr) {
        // Almost always means a tab in TABLE_NAMES doesn't exist in the sheet yet — fall
        // back to the full metadata-check + auto-create flow (costs more API calls, but
        // only happens on first-ever setup or when a table is newly added to SCHEMA).
        console.log(`  📊 Fast bulk-load failed (${String(fastPathErr.message || fastPathErr).slice(0, 120)}) — checking for missing tabs`);
        const meta = await api.spreadsheets.get({
          spreadsheetId: _spreadsheetId,
          fields: 'sheets.properties'
        });
        _tabIdByName = {};
        for (const s of meta.data.sheets || []) {
          _tabIdByName[s.properties.title] = s.properties.sheetId;
        }

        const missing = TABLE_NAMES.filter(t => !(t in _tabIdByName));
        if (missing.length) {
          console.log(`  📊 Creating ${missing.length} missing tab(s): ${missing.join(', ')}`);
          try {
            const requests = missing.map(t => ({
              addSheet: { properties: { title: t } }
            }));
            const resp = await api.spreadsheets.batchUpdate({
              spreadsheetId: _spreadsheetId,
              requestBody: { requests }
            });
            for (const reply of resp.data.replies || []) {
              if (reply.addSheet) {
                _tabIdByName[reply.addSheet.properties.title] = reply.addSheet.properties.sheetId;
              }
            }
            // Write headers in newly created tabs (include derived cols)
            const headerData = missing.map(t => {
              const derivedCols = Object.keys(SHEET_DERIVED[t] || {});
              return { range: `${t}!A1`, values: [[...SCHEMA[t].cols, ...derivedCols]] };
            });
            await api.spreadsheets.values.batchUpdate({
              spreadsheetId: _spreadsheetId,
              requestBody: { valueInputOption: 'RAW', data: headerData }
            });
          } catch (createErr) {
            console.warn(`  ⚠️ Could not create missing tabs (${missing.join(', ')}): ${createErr.message} — continuing with empty tables`);
          }
        }

        existingTables = TABLE_NAMES.filter(t => t in _tabIdByName);
        const ranges = existingTables.map(t => `${t}!A:ZZ`);
        valueRanges = [];
        if (ranges.length) {
          const batchResp = await api.spreadsheets.values.batchGet({
            spreadsheetId: _spreadsheetId,
            ranges,
            valueRenderOption: 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'SERIAL_NUMBER'
          });
          valueRanges = batchResp.data.valueRanges || [];
        }
      }

      // 5. Populate alasql tables (only for tabs that exist in sheet)
      let totalRows = 0;
      for (let i = 0; i < existingTables.length; i++) {
        const table = existingTables[i];
        const cols = SCHEMA[table].cols;
        const rows = (valueRanges[i] && valueRanges[i].values) || [];
        if (rows.length <= 1) {
          // Either empty or only header. Ensure header row exists for clean future writes.
          _nextId[table] = 1;
          continue;
        }
        const headerRow = rows[0];
        // Map sheet column index -> schema column name (handles any order)
        const colIndex = {};
        for (let c = 0; c < headerRow.length; c++) {
          colIndex[String(headerRow[c]).trim()] = c;
        }
        let maxId = 0;
        const inserts = [];
        for (let r = 1; r < rows.length; r++) {
          const sheetRow = rows[r];
          if (!sheetRow || sheetRow.every(x => x === '' || x == null)) continue;
          const obj = {};
          for (const col of cols) {
            const idx = colIndex[col];
            obj[col] = parseCellValue(col, idx == null ? '' : sheetRow[idx]);
          }
          if (obj.id && typeof obj.id === 'number' && obj.id > maxId) maxId = obj.id;
          inserts.push(obj);
        }
        // Insert all rows in one alasql call (very fast)
        if (inserts.length) {
          alasql.tables[table].data = inserts; // direct injection (faster than INSERT loop)
        }
        _nextId[table] = maxId + 1;
        totalRows += inserts.length;
      }
      console.log(`  ✅ Sheets DB loaded: ${totalRows} rows across ${TABLE_NAMES.length} tables`);

      // 6. Seed default admin if users table is empty (PLAIN TEXT password)
      const userCount = alasql('SELECT COUNT(*) AS c FROM users')[0].c;
      if (userCount === 0) {
        alasql(
          'INSERT INTO users (id,name,email,notification_email,password,role,phone,profile_image,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [1, 'Admin', 'admin@rajkamal.com', '', 'Rajkamal@2024', 'admin', '', '', '', '', '']
        );
        _nextId.users = 2;
        markDirty('users');
        console.log('  🌱 Seeded default admin: admin@rajkamal.com / Rajkamal@2024');
      }

      _initialized = true;

      // Fix stale waiting_approval=1 with no matching pending task_approvals record.
      // Caused by previous PRIMARY KEY bug where task_approvals INSERT silently failed.
      try {
        const [staleRows] = await module.exports.query(`SELECT id FROM delegation_tasks WHERE waiting_approval=1`);
        for (const row of staleRows) {
          const [apprRows] = await module.exports.query(`SELECT id FROM task_approvals WHERE task_id=? AND status='pending'`, [row.id]);
          if (!apprRows.length) {
            await module.exports.query(`UPDATE delegation_tasks SET waiting_approval=0, revision_status='' WHERE id=?`, [row.id]);
            console.log(`  🔧 Fixed stale waiting_approval for delegation_tasks id=${row.id}`);
          }
        }
      } catch (e) { console.warn('  ⚠️ Stale-approval cleanup failed:', e.message); }

      // Mark derived-column tables dirty so existing sheets get the new
      // is_done column populated on first flush after deployment.
      for (const t of Object.keys(SHEET_DERIVED)) markDirty(t);

      // 7. Flush-on-exit — best-effort save before process exits
      const flushAndExit = async (sig) => {
        try { await flushNow(); } catch(_) {}
        process.exit(0);
      };
      process.on('SIGINT', flushAndExit);
      process.on('SIGTERM', flushAndExit);

    } catch (err) {
      _initPromise = null;
      throw err;
    }
  })();
  return _initPromise;
}

// ══════════════════════════════════════════════════════════════════
// SQL PREPROCESSING
// ══════════════════════════════════════════════════════════════════

// alasql has some reserved words (TOTAL, COUNT, etc.) that fail as aliases.
// Solution: wrap every `AS xxx` in backticks.
function escapeAliases(sql) {
  // Skip portions inside single-quoted strings
  return sql.replace(/'(?:[^'\\]|\\.)*'|\bAS\s+(\w+)\b/gi, (match, alias) => {
    if (!alias) return match; // string literal — leave as-is
    return `AS \`${alias}\``;
  });
}

// Detect target table for mutation queries (for dirty tracking)
function detectMutationTable(sql) {
  const s = sql.replace(/^\s+/, '');
  let m;
  if (/^INSERT/i.test(s)) {
    m = s.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?/i);
  } else if (/^UPDATE/i.test(s)) {
    m = s.match(/UPDATE\s+`?(\w+)`?/i);
  } else if (/^DELETE/i.test(s)) {
    m = s.match(/DELETE\s+FROM\s+`?(\w+)`?/i);
  } else {
    return null;
  }
  return m ? m[1] : null;
}

// MySQL bulk INSERT: `INSERT INTO t (a,b) VALUES ?` with params=[[[v1,v2],[v3,v4]]]
function expandBulkInsert(sql, params) {
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]+)\)\s*VALUES\s*\?\s*$/i);
  if (!m) return null;
  if (!Array.isArray(params) || !Array.isArray(params[0]) || !Array.isArray(params[0][0])) return null;
  const [, table, colsStr] = m;
  const cols = colsStr.split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const rows = params[0];
  const placeholders = cols.map(() => '?').join(',');
  const valuesClause = rows.map(() => `(${placeholders})`).join(',');
  const flatParams = [];
  for (const r of rows) flatParams.push(...r);
  return {
    sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${valuesClause}`,
    params: flatParams,
    table,
    cols,
    rowCount: rows.length
  };
}

// MySQL ON DUPLICATE KEY UPDATE — translate to upsert
// Only supports the week_plans pattern (single VALUES tuple, key = employee_id+start_date)
function expandUpsert(sql, params) {
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*ON\s+DUPLICATE\s+KEY\s+UPDATE\s+(.+)$/is);
  if (!m) return null;
  const [, table, colsStr, valsStr, updateClause] = m;
  const cols = colsStr.split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const valTokens = valsStr.split(',').map(v => v.trim());
  return { table, cols, valTokens, updateClause: updateClause.trim(), params };
}

// Apply autoFill defaults for missing columns on simple INSERT
function applyInsertDefaults(table, sql, params) {
  const defaults = SCHEMA[table] && SCHEMA[table].autoFill;
  if (!defaults || !Object.keys(defaults).length) return { sql, params };
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?\w+`?\s*\(([^)]+)\)\s*VALUES\s*(\(.+\))\s*$/is);
  if (!m) return { sql, params };
  const cols = m[1].split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const valuesPart = m[2];
  // Single tuple (a,b,?) -> match
  const isSingleTuple = /^\([^)]*\)\s*$/.test(valuesPart);
  const newCols = [...cols];
  let extraValsSql = '';
  const extraParams = [];
  for (const [col, kind] of Object.entries(defaults)) {
    if (newCols.includes(col)) continue;
    newCols.push(col);
    const v = kind === 'NOW' ? isoDateTime() : null;
    extraValsSql += ',?';
    extraParams.push(v);
  }
  if (!extraValsSql) return { sql, params };
  let newValuesPart;
  if (isSingleTuple) {
    // Append before closing paren
    newValuesPart = valuesPart.replace(/\)\s*$/, extraValsSql + ')');
  } else {
    // Multi-tuple: append same extras to each tuple
    newValuesPart = valuesPart.replace(/\)(?=\s*(?:,|$))/g, extraValsSql + ')');
    // Multiply extra params per tuple
    const tuples = valuesPart.split(/\),\s*\(/).length;
    const repeated = [];
    for (let i = 0; i < tuples; i++) repeated.push(...extraParams);
    return {
      sql: sql.replace(valuesPart, newValuesPart).replace(/\(([^)]+)\)\s*VALUES/, `(${newCols.join(',')}) VALUES`),
      params: insertExtrasIntoMultiTupleParams(params, cols.length, extraParams, tuples)
    };
  }
  return {
    sql: sql.replace(valuesPart, newValuesPart).replace(/\(([^)]+)\)\s*VALUES/, `(${newCols.join(',')}) VALUES`),
    params: [...params, ...extraParams]
  };
}

function insertExtrasIntoMultiTupleParams(params, colsPerTuple, extraParams, tuples) {
  // params is flat array: [t1c1,t1c2,...,t2c1,t2c2,...]
  // After expansion each tuple has colsPerTuple + extraParams.length values
  const out = [];
  for (let t = 0; t < tuples; t++) {
    const start = t * colsPerTuple;
    out.push(...params.slice(start, start + colsPerTuple));
    out.push(...extraParams);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// QUERY API
// ══════════════════════════════════════════════════════════════════
// Coerce pure-integer string params to numbers (Express req.params.id is
// always a string, but alasql does strict comparison — number 1 vs string '1'
// won't match. This fix is required for WHERE/JOIN comparisons to work.)
const INT_STR_RE = /^(?:0|-?[1-9]\d*)$/;
function coerceParams(params) {
  if (!Array.isArray(params)) return params;
  return params.map(p => {
    if (typeof p === 'string' && p.length > 0 && p.length < 16 && INT_STR_RE.test(p)) {
      return parseInt(p, 10);
    }
    return p;
  });
}

async function query(sql, params = []) {
  if (!_initialized) await init();
  if (params == null) params = [];
  if (!Array.isArray(params)) params = [params];
  params = coerceParams(params);

  const sqlTrim = sql.trim();
  // No-ops — schema management calls (CREATE TABLE / ALTER TABLE / DROP)
  if (/^\s*(ALTER|CREATE\s+TABLE|DROP|CREATE\s+INDEX)/i.test(sqlTrim)) {
    return [[], []];
  }
  // Health check
  if (/^\s*SELECT\s+1\s*$/i.test(sqlTrim)) {
    return [[{ '1': 1 }], []];
  }

  // Bulk insert: INSERT ... VALUES ?
  const bulk = expandBulkInsert(sqlTrim, params);
  if (bulk) {
    const withDefaults = applyInsertDefaults(bulk.table, bulk.sql, bulk.params);
    return executeMutation(withDefaults.sql, withDefaults.params, bulk.table);
  }

  // Upsert: ON DUPLICATE KEY UPDATE
  const upsert = expandUpsert(sqlTrim, params);
  if (upsert) {
    return executeUpsert(upsert);
  }

  // Mutation
  const mutationTable = detectMutationTable(sqlTrim);
  if (mutationTable) {
    let processedSql = sqlTrim;
    let processedParams = params;
    if (/^INSERT/i.test(sqlTrim)) {
      const withDefaults = applyInsertDefaults(mutationTable, processedSql, processedParams);
      processedSql = withDefaults.sql;
      processedParams = withDefaults.params;
    }
    return executeMutation(processedSql, processedParams, mutationTable);
  }

  // SELECT (or anything else readable)
  try {
    const safeSql = escapeAliases(sqlTrim);
    const rows = alasql(safeSql, params);
    return [rows, []];
  } catch (err) {
    err.sql = sqlTrim;
    throw err;
  }
}

function executeMutation(sqlIn, params, table) {
  let sql = sqlIn;
  // For INSERT without explicit id, generate one and inject — gives us insertId
  let injectedId = null;
  if (/^\s*INSERT/i.test(sql)) {
    injectedId = injectAutoId(table, sql, params);
    if (injectedId) {
      sql = injectedId.sql;
      params = injectedId.params;
    }
  }
  let affected;
  try {
    affected = alasql(sql, params);
  } catch (err) {
    err.sql = sql;
    throw err;
  }
  // Re-coerce int columns on the affected rows (alasql treats params as strings sometimes)
  if (/^\s*(INSERT|UPDATE)/i.test(sql) && alasql.tables[table]) {
    const data = alasql.tables[table].data;
    if (data && data.length) {
      const lastN = /^\s*INSERT/i.test(sql) ? (injectedId ? injectedId.insertedCount : 1) : data.length;
      const startIdx = Math.max(0, data.length - lastN);
      for (let i = startIdx; i < data.length; i++) {
        const row = data[i];
        for (const c of Object.keys(row)) {
          if (INT_COLS.has(c) && typeof row[c] === 'string' && row[c] !== '') {
            const n = parseInt(row[c], 10);
            if (!Number.isNaN(n)) row[c] = n;
          }
        }
      }
    }
  }
  if (table) markDirty(table);
  const result = {
    affectedRows: typeof affected === 'number' ? affected : 0,
    insertId: injectedId ? injectedId.insertId : null
  };
  return [result, []];
}

// For INSERT statements, if `id` is NOT in the column list, prepend it with auto-generated id.
// Returns { sql, params, insertId, insertedCount } or null if no change needed.
function injectAutoId(table, sql, params) {
  if (!SCHEMA[table]) return null;
  // Match: INSERT INTO table (cols) VALUES (vals)[,(vals)...]
  const m = sql.match(/^(\s*INSERT\s+INTO\s+`?\w+`?\s*\()([^)]+)(\)\s*VALUES\s*)(.+)$/is);
  if (!m) return null;
  const colsList = m[2].split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  if (colsList.includes('id')) {
    // id explicitly given — bump counter if needed
    return null;
  }
  // Parse tuples in VALUES
  const valuesPart = m[4].trim().replace(/;$/, '');
  const tupleStarts = [];
  let depth = 0;
  for (let i = 0; i < valuesPart.length; i++) {
    const ch = valuesPart[i];
    if (ch === '(') { if (depth === 0) tupleStarts.push(i); depth++; }
    else if (ch === ')') depth--;
  }
  const tuples = tupleStarts.length || 1;
  const startId = _nextId[table] || 1;
  const newColsList = ['id', ...colsList];

  // Build new VALUES with id prepended in each tuple
  let newValues = valuesPart;
  let idAdded = 0;
  newValues = newValues.replace(/\(/g, () => {
    if (depth >= 0) {
      const thisId = startId + idAdded;
      idAdded++;
      return `(${thisId},`;
    }
    return '(';
  });
  // Reset depth (just used for replace closure — fine)

  _nextId[table] = startId + tuples;
  const newSql = `${m[1].replace(/\(\s*$/, '(')}${newColsList.join(',')}${m[3]}${newValues}`;
  return {
    sql: newSql,
    params,
    insertId: startId,         // first inserted id (mysql2 returns the first for bulk)
    insertedCount: tuples
  };
}

// ON DUPLICATE KEY UPDATE — manual upsert
// Key detection: known schemas (week_plans: employee_id + start_date)
const UNIQUE_KEYS = {
  week_plans: ['employee_id', 'start_date'],
  sales_targets: ['group_key']
};
function executeUpsert({ table, cols, valTokens, updateClause, params }) {
  const keys = UNIQUE_KEYS[table];
  if (!keys || !keys.length) {
    // Fallback: plain INSERT
    const insertSql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${valTokens.join(',')})`;
    return executeMutation(insertSql, params, table);
  }
  // Build key-WHERE from incoming params (need column->value mapping)
  // Each token is either `?` (positional) or a literal
  const colValMap = {};
  let pIdx = 0;
  for (let i = 0; i < cols.length; i++) {
    if (valTokens[i] === '?') {
      colValMap[cols[i]] = params[pIdx++];
    } else {
      colValMap[cols[i]] = unquoteSqlLiteral(valTokens[i]);
    }
  }
  // Lookup existing row by unique key
  const whereSql = keys.map(k => `${k} = ?`).join(' AND ');
  const whereVals = keys.map(k => colValMap[k]);
  const existing = alasql(`SELECT id FROM ${table} WHERE ${whereSql}`, whereVals);

  if (existing.length === 0) {
    // INSERT
    const insertSql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${valTokens.join(',')})`;
    const [res] = executeMutation(insertSql, params, table);
    return [{ affectedRows: 1, insertId: res.insertId }, []];
  }
  // UPDATE — translate `col = VALUES(col)` into actual values
  const id = existing[0].id;
  // Parse SET clauses
  const setParts = updateClause.split(',').map(s => s.trim());
  const setSql = [];
  const setParams = [];
  for (const part of setParts) {
    const mm = part.match(/^`?(\w+)`?\s*=\s*VALUES\s*\(\s*`?(\w+)`?\s*\)$/i);
    if (mm) {
      const target = mm[1];
      const source = mm[2];
      setSql.push(`${target} = ?`);
      setParams.push(colValMap[source]);
    } else {
      // Literal assignment like `col = ?` or `col = 5`
      const mm2 = part.match(/^`?(\w+)`?\s*=\s*(.+)$/i);
      if (mm2) {
        setSql.push(`${mm2[1]} = ${mm2[2]}`);
      }
    }
  }
  // Also update updated_at if column exists in schema
  if (SCHEMA[table].cols.includes('updated_at')) {
    setSql.push(`updated_at = ?`);
    setParams.push(isoDateTime());
  }
  alasql(`UPDATE ${table} SET ${setSql.join(', ')} WHERE id = ?`, [...setParams, id]);
  markDirty(table);
  // MySQL semantics: affectedRows=2 for an updated row (so caller distinguishes insert vs update)
  return [{ affectedRows: 2, insertId: id }, []];
}

function unquoteSqlLiteral(token) {
  const t = token.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.toUpperCase() === 'NULL') return null;
  return t;
}

// ══════════════════════════════════════════════════════════════════
// CONNECTION (transaction mock — alasql is in-memory, transactions
// are best-effort no-ops; commit/rollback don't truly isolate)
// ══════════════════════════════════════════════════════════════════
function getConnection() {
  return {
    query: (sql, params) => query(sql, params),
    execute: (sql, params) => query(sql, params),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {}
  };
}

// ══════════════════════════════════════════════════════════════════
// FLUSH — debounced batch write to Sheets
// ══════════════════════════════════════════════════════════════════
function markDirty(table) {
  _dirtyTables.add(table);
  scheduleFlush();
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushNow().catch(err => console.error('  ❌ Sheets flush error:', err.message));
  }, FLUSH_DEBOUNCE_MS);
}

let _testMode = false;
async function flushNow() {
  if (!_initialized) return;
  if (_testMode) { _dirtyTables.clear(); return; }
  if (_flushInProgress) {
    return new Promise(resolve => _pendingFlushResolvers.push(resolve));
  }
  _flushInProgress = true;
  try {
    while (_dirtyTables.size > 0) {
      const snapshot = Array.from(_dirtyTables);
      _dirtyTables.clear();
      await writeTablesToSheet(snapshot);
    }
  } finally {
    _flushInProgress = false;
    const resolvers = _pendingFlushResolvers.splice(0);
    for (const r of resolvers) r();
  }
}

async function writeTablesToSheet(tables) {
  if (!tables.length) return;
  const api = await getApiClient();

  // Build batchUpdate data — full table overwrite (header + rows)
  const data = [];
  const clearRanges = [];
  for (const table of tables) {
    const cols = SCHEMA[table].cols;
    const derived = SHEET_DERIVED[table] || {};
    const derivedCols = Object.keys(derived);
    const allCols = [...cols, ...derivedCols];
    const rows = alasql.tables[table] ? alasql.tables[table].data : [];
    const dataRows = rows.map(r => {
      const base = cols.map(c => serializeForSheet(r[c]));
      const extra = derivedCols.map(d => derived[d](r));
      return [...base, ...extra];
    });
    const values = [allCols, ...dataRows];
    data.push({ range: `${table}!A1`, values });
    clearRanges.push(`${table}!A${values.length + 1}:ZZ`);
  }

  // Single batchUpdate call — USER_ENTERED so Sheets interprets dates as date cells
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: _spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data }
  });
  // Clear excess (only if there's any chance of leftover; quick API call)
  try {
    await api.spreadsheets.values.batchClear({
      spreadsheetId: _spreadsheetId,
      requestBody: { ranges: clearRanges }
    });
  } catch (_) { /* non-critical */ }
}

// ══════════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════════
// Test-only: skip Sheets init and just create tables in-memory
async function _testInit() {
  for (const t of TABLE_NAMES) {
    const colsSql = SCHEMA[t].cols
      .map(c => `\`${c}\` ${c==='id' ? 'INT' : 'STRING'}`)
      .join(', ');
    alasql(`CREATE TABLE IF NOT EXISTS ${t} (${colsSql})`);
    _nextId[t] = 1;
  }
  // Prevent any auto Sheets write attempts
  _testMode = true;
  _initialized = true;
}

async function resync() {
  _initialized = false;
  _initPromise = null;
  TABLE_NAMES.forEach(t => { alasql.tables[t].data = []; });
  await init();
}

module.exports = {
  init,
  resync,
  query,
  execute: query,
  getConnection,
  flushNow,
  // Test / debug helpers
  _alasql: alasql,
  _schema: SCHEMA,
  _testInit
};
