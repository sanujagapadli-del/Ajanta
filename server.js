// ══════════════════════════════════════════════════════
// 🚀 AUTO-INSTALL BOOTSTRAP
// Automatically runs npm install if any dependency is missing
// (no SSH terminal needed on first deploy to Hostinger)
// ══════════════════════════════════════════════════════
(function autoInstallDependencies() {
  // Skip on Vercel/serverless — filesystem is read-only and deps are pre-installed during build.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return;

  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  const pkgPath = path.join(__dirname, 'package.json');
  const nodeModulesPath = path.join(__dirname, 'node_modules');

  if (!fs.existsSync(pkgPath)) return; // safety guard

  let needsInstall = false;
  let missingPkg = '';

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});

    // Check 1: node_modules folder exists?
    if (!fs.existsSync(nodeModulesPath)) {
      needsInstall = true;
    } else {
      // Check 2: Are all dependencies present in node_modules?
      for (const dep of deps) {
        if (!fs.existsSync(path.join(nodeModulesPath, dep))) {
          needsInstall = true;
          missingPkg = dep;
          break;
        }
      }
    }
  } catch (err) {
    console.error('  ⚠️  package.json read error:', err.message);
    return;
  }

  if (needsInstall) {
    console.log('  📦 Dependencies missing' + (missingPkg ? ` (${missingPkg})` : '') + ' — installing...');
    console.log('  ⏳ This may take 1-2 minutes, please wait...');
    try {
      execSync('npm install --production --no-audit --no-fund', {
        stdio: 'inherit',
        cwd: __dirname
      });
      console.log('  ✅ Dependencies installed successfully!');
    } catch (err) {
      console.error('  ❌ npm install failed:', err.message);
      console.error('  ⚠️  Please run "npm install" manually via SSH/Terminal');
      process.exit(1);
    }
  }
})();

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs'); // only for comparing legacy bcrypt hashes (auto-migrate)
const jwt = require('jsonwebtoken');
const path = require('path');
const nodemailer = require('nodemailer');

// Plain text password storage + legacy bcrypt migration.
// Passwords are stored as plain text so admins can see them in the sheet.
// Trade-off: only share the sheet with trusted users.
function checkPassword(plain, stored) {
  if (!stored || plain == null) return false;
  if (plain === stored) return { ok: true, legacy: false };
  if (/^\$2[aby]\$/.test(stored)) {
    try {
      if (bcrypt.compareSync(plain, stored)) return { ok: true, legacy: true };
    } catch(_) {}
  }
  return { ok: false };
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'taskmanager_secret_2026';

const cookieParser = require('cookie-parser');
app.use(cookieParser());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
// SHEETS DB — Google Sheets backed in-memory adapter
// (drop-in replacement for mysql2 — same db.query / db.execute / db.getConnection API)
// ══════════════════════════════════════════════════════
const db = require('./sheets-db');
// Schema is defined in sheets-db.js — no runtime migrations needed for Sheets.
// init() loads all tabs into in-memory store on boot.
const _dbReady = db.init()
  .then(() => console.log('  ✅ Sheets DB ready'))
  .catch(err => {
    console.error('  ❌ Sheets DB init failed:', err.message);
    console.error('  💡 Set GOOGLE_SHEET_ID in .env and share the sheet with the service account.');
  });

// ══════════════════════════════════════════════════════
// EMAIL CONFIGURATION (Gmail SMTP via Nodemailer)
// ══════════════════════════════════════════════════════
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

(async () => {
  try {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await mailTransporter.verify();
      console.log('  ✅ Gmail SMTP Ready');
    } else {
      console.log('  ⚠️  SMTP credentials missing — emails disabled');
    }
  } catch (err) {
    console.error('  ❌ SMTP verification failed:', err.message);
  }
})();

// Reusable email sender — never throws (failures are logged only)
async function sendMail(to, subject, html) {
  if (!to || !process.env.SMTP_USER) return;
  try {
    await mailTransporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'Task Manager'}" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
    console.log(`  📧 Email sent to ${to} — ${subject}`);
  } catch (err) {
    console.error(`  ❌ Email failed (${to}):`, err.message);
  }
}

// Helper: get user's notification email + name
async function getNotifyTarget(userId) {
  try {
    const [rows] = await db.query(
      'SELECT name, notification_email FROM users WHERE id=? LIMIT 1',
      [userId]
    );
    if (!rows[0] || !rows[0].notification_email) return null;
    return { name: rows[0].name, email: rows[0].notification_email };
  } catch { return null; }
}

// Email template for delegation task
function delegationEmailHtml({ assigneeName, assignerName, desc, dueDate, priority, approval, remarks }) {
  const appUrl = process.env.APP_URL || '#';
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color:#1976d2;margin-top:0;">📋 New Task Assigned to You</h2>
      <p>Hi <b>${assigneeName || 'there'}</b>,</p>
      <p><b>${assignerName || 'Someone'}</b> has assigned you a new delegation task:</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px;background:#f0f4f8;width:140px;"><b>Task</b></td><td style="padding:8px;">${desc}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Due Date</b></td><td style="padding:8px;">${dueDate}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Priority</b></td><td style="padding:8px;text-transform:capitalize;">${priority}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Approval Required</b></td><td style="padding:8px;text-transform:capitalize;">${approval}</td></tr>
        ${remarks ? `<tr><td style="padding:8px;background:#f0f4f8;"><b>Remarks</b></td><td style="padding:8px;">${remarks}</td></tr>` : ''}
      </table>
      <a href="${appUrl}" style="display:inline-block;background:#1976d2;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Open Task Manager</a>
      <p style="color:#777;font-size:12px;margin-top:30px;">This is an automated email from Rajkamal Task Manager.</p>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════
// v16: DELEGATION REMINDER EMAILS (daily at 12:00 PM)
// Multiple employees may share the same email address — so tasks are grouped
// per user into a single combined email. Reminder window:
// due_date <= today+2 AND status='pending'. Reminders stop when a task is
// completed or deleted. A task is reminded at most once per day
// (tracked via last_reminder_date column).
// ══════════════════════════════════════════════════════

// Build the combined reminder email HTML for a single notification_email
// `byUser` = { "User Name": [task, task, ...], ... }
function reminderEmailHtml(byUser, todayStr) {
  const appUrl = process.env.APP_URL || '#';
  const userNames = Object.keys(byUser);
  const totalTasks = userNames.reduce((s, n) => s + byUser[n].length, 0);

  // Per-user blocks — user name at top, tasks table below
  const sections = userNames.map(name => {
    const tasks = byUser[name];
    const rows = tasks.map(t => {
      const isOverdue = t.due_date < todayStr;
      const dueLabel = isOverdue
        ? `<span style="color:#dc2626;font-weight:700">${t.due_date} ⏰ Overdue</span>`
        : (t.due_date === todayStr
            ? `<span style="color:#d97706;font-weight:700">${t.due_date} (Today)</span>`
            : `<b>${t.due_date}</b>`);
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:13px">${t.description||'—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:13px;white-space:nowrap">${dueLabel}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:12px;text-transform:capitalize;color:#64748b">${t.priority||'low'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:12px;color:#64748b">${t.assignerName||'—'}</td>
      </tr>`;
    }).join('');
    return `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <span style="background:#1976d2;color:#fff;width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:14px">${(name||'?').charAt(0).toUpperCase()}</span>
        <div>
          <div style="font-weight:700;font-size:15px;color:#1e293b">${name||'Unknown'}</div>
          <div style="font-size:12px;color:#64748b">${tasks.length} pending task${tasks.length>1?'s':''}</div>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fafbfc;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f1f5f9">
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Task</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Due Date</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Priority</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Assigned By</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:10px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.05)">
      <h2 style="color:#dc2626;margin:0 0 4px 0">⏰ Pending Task Reminder</h2>
      <p style="margin:0 0 18px 0;color:#475569;font-size:14px">
        Today is <b>${todayStr}</b> — the tasks below are due within 2 days. Please complete them on time.
        ${userNames.length > 1 ? `<br><span style="font-size:12px;color:#64748b">This email covers <b>${userNames.length} user${userNames.length>1?'s':''}</b> (same email account): ${userNames.join(', ')}</span>` : ''}
      </p>
      ${sections}
      <a href="${appUrl}" style="display:inline-block;background:#1976d2;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600;margin-top:6px">Open Task Manager</a>
      <p style="color:#94a3b8;font-size:11px;margin-top:18px;border-top:1px solid #eef2f7;padding-top:12px">
        Total <b>${totalTasks}</b> pending task${totalTasks>1?'s':''}. Reminders are sent daily at 12:00 PM until tasks are completed.
        To stop reminders, complete or delete the task.
      </p>
    </div>
  </div>`;
}

// Run the daily delegation reminder pass.
// Filter: status='pending' AND due_date <= (today + 2 days) AND last_reminder_date != today
async function runDelegationReminders() {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const cutoff = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];

    const [allUsr] = await db.query('SELECT id,name,notification_email FROM users');
    const uMapR = {};
    allUsr.forEach(u => { uMapR[u.id] = u; });

    const [rawTasks] = await db.query(`
      SELECT t.id, t.description, t.assigned_to, t.assigned_by, t.priority,
             COALESCE(t.approval,'no') AS approval, t.remarks,
             DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date
      FROM delegation_tasks t
      WHERE t.status = 'pending'
        AND t.due_date <= ?
        AND (t.last_reminder_date IS NULL OR t.last_reminder_date < ?)
      ORDER BY t.due_date ASC
    `, [cutoff, todayStr]);
    const tasks = rawTasks.map(t => ({
      ...t,
      assigneeName: uMapR[t.assigned_to]?.name || '',
      assigneeEmail: uMapR[t.assigned_to]?.notification_email || '',
      assignerName: uMapR[t.assigned_by]?.name || ''
    }));

    if (!tasks.length) {
      console.log(`  🔔 Reminder pass @ ${todayStr}: 0 pending tasks in window`);
      return { sent: 0, skipped: 0 };
    }

    // Group by notification_email — one email per inbox
    const groups = {};
    for (const t of tasks) {
      const email = (t.assigneeEmail || '').trim().toLowerCase();
      if (!email) continue; // skip users without notification_email
      if (!groups[email]) groups[email] = { byUser: {}, taskIds: [] };
      if (!groups[email].byUser[t.assigneeName]) groups[email].byUser[t.assigneeName] = [];
      groups[email].byUser[t.assigneeName].push(t);
      groups[email].taskIds.push(t.id);
    }

    let sent = 0, failed = 0;
    for (const email of Object.keys(groups)) {
      const { byUser, taskIds } = groups[email];
      const totalForEmail = taskIds.length;
      const userNames = Object.keys(byUser);
      const subject = userNames.length === 1
        ? `⏰ ${totalForEmail} pending task${totalForEmail>1?'s':''} for ${userNames[0]}`
        : `⏰ ${totalForEmail} pending task${totalForEmail>1?'s':''} (${userNames.length} users)`;
      try {
        await sendMail(email, subject, reminderEmailHtml(byUser, todayStr));
        // Mark all included tasks as reminded today (prevents same-day duplicates if pass re-runs)
        if (taskIds.length) {
          await db.query(
            `UPDATE delegation_tasks SET last_reminder_date=? WHERE id IN (${taskIds.map(()=>'?').join(',')})`,
            [todayStr, ...taskIds]
          );
        }
        sent++;
      } catch (e) {
        console.error('  ❌ Reminder failed for', email, e.message);
        failed++;
      }
    }
    console.log(`  🔔 Reminder pass @ ${todayStr}: ${sent} email(s) sent, ${failed} failed, ${tasks.length} tasks covered, ${Object.keys(groups).length} unique inbox(es)`);
    return { sent, failed };
  } catch (err) {
    console.error('  ❌ runDelegationReminders error:', err.message);
    return { error: err.message };
  }
}

// Scheduler — checks every minute, fires once at the first 12:00 onwards each day.
// Server restart-safe: if started after 12 PM and not yet run today,
// fires immediately (so a Hostinger restart does not miss the daily send).
let _lastReminderRunDate = ''; // YYYY-MM-DD of last successful run
function reminderScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const hour = now.getHours();
      // Fire any time at/after 12:00 PM — at most once per day
      if (hour >= 12 && _lastReminderRunDate !== todayStr) {
        _lastReminderRunDate = todayStr;
        console.log(`  🔔 Triggering daily delegation reminders (${now.toLocaleString()})`);
        await runDelegationReminders();
      }
    } catch(e) { console.error('  ❌ Scheduler tick error:', e.message); }
  }, 60 * 1000); // tick every 60 seconds
  console.log('  ✅ Delegation reminder scheduler started (fires daily at 12:00 PM)');
}

// Manual trigger endpoint for testing / catch-up (admin only)
app.post('/api/admin/run-reminders', requireAuth, requireAdmin, async (req, res) => {
  const r = await runDelegationReminders();
  res.json(r);
});

// Kick off scheduler after SMTP verify (deferred 5s so verify can finish first)
setTimeout(() => {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    reminderScheduler();
  } else {
    console.log('  ⚠️  Reminder scheduler skipped — SMTP credentials missing');
  }
}, 5000);

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ','');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.session = { userId: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}
function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}
function requireAdminOrHod(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'hod' || req.session.role === 'pc') return next();
  res.status(403).json({ error: 'Admin or HOD only' });
}
function requireAdminOrPC(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'pc') return next();
  res.status(403).json({ error: 'Admin or PC only' });
}
function getTable(type) {
  return type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
}

// ══════════════════════════════════════════════════════
// GOOGLE SHEETS HELPERS
// ══════════════════════════════════════════════════════
let _sheetsReadClient = null;
let _sheetsWriteClient = null;

async function getSheetsClient(scopes) {
  const { google } = require('googleapis');
  let creds;
  if (process.env.GOOGLE_CREDENTIALS_B64) {
    creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'));
  } else if (process.env.GOOGLE_CREDENTIALS) {
    creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } else {
    creds = require('./credentials.json');
  }
  if (creds && creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
  }
  const isWrite = scopes.some(s => !s.includes('readonly'));
  if (isWrite) {
    if (_sheetsWriteClient) return _sheetsWriteClient;
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    _sheetsWriteClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return _sheetsWriteClient;
  } else {
    if (_sheetsReadClient) return _sheetsReadClient;
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    _sheetsReadClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return _sheetsReadClient;
  }
}

// Pre-warm Google auth on startup (reduces cold start time)
(async () => {
  try {
    await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    console.log('  ✅ Google Auth pre-warmed');
  } catch(e) { console.log('  ⚠️ Google Auth pre-warm failed:', e.message); }
})();

function extractSpreadsheetId(raw) {
  const s = (raw || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

function colToIdx(col) {
  if (!col) return -1;
  col = col.toUpperCase().trim();
  let idx = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
  return idx - 1;
}

function idxToCol(idx) {
  let s = '', n = idx + 1;
  while (n > 0) { const r = (n-1) % 26; s = String.fromCharCode(65+r) + s; n = Math.floor((n-1)/26); }
  return s;
}

// ══════════════════════════════════════════════════════
// SHARED FMS STATS ENGINE  (single source of truth)
// ══════════════════════════════════════════════════════
// Previously /api/mis/all and /api/mis/fms each read Google Sheets independently
// — different filtering, different aggregation, silent error swallowing — causing
// "numbers sometimes differ" and "HOD sees a different total" bugs.
//
// Now both use the same function:
//   • Each sheet is read once per request + 60s cache
//     => numbers are STABLE on refresh (deterministic).
//   • Step-level pending/done is counted in one place => per-FMS overview and
//     per-user attribution never disagree.
//   • On read failure the sheet name goes into `errors[]` (not silently 0)
//     => totals don't shift unexpectedly; UI can show a warning.
//   • HOD department filter is applied identically in both places.

const _fmsSheetCache = new Map(); // key: spreadsheetId|range  -> { rows, ts }
const FMS_CACHE_TTL_MS = 60 * 1000;

async function fetchSheetRows(sheet) {
  const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
  const tabName = sheet.sheet_name || 'Sheet1';
  const headerRowIdx = (sheet.header_row || 1) - 1;

  // Range based on plan/actual columns
  const [steps] = await db.query('SELECT plan_col, actual_col FROM fms_steps WHERE fms_id=?', [sheet.id]);
  const allCols = steps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
  if (!allCols.length) return [];
  const lastCol = idxToCol(Math.max(...allCols));
  const range = `${tabName}!A:${lastCol}`;

  const cacheKey = `${spreadsheetId}|${range}`;
  const hit = _fmsSheetCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < FMS_CACHE_TTL_MS) return hit.rows;

  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
  const allRowsData = response.data.values || [];
  const rows = allRowsData.slice(headerRowIdx + 1);
  _fmsSheetCache.set(cacheKey, { rows, ts: Date.now() });
  return rows;
}

// Returns { perFms: [...], perUser: { uid: {pending,done,total} }, errors: [name] }
// hodDept '' => admin/pc (all steps). hodDept set => only steps where that dept has a doer.
async function computeFmsStats(hodDept = '', collectPending = false) {
  const result = { perFms: [], perUser: {}, errors: [] };
  if (collectPending) result.perUserPending = {}; // uid -> [ {fmsName, stepName, planValue, planDate, isLate} ]
  const _today = new Date().toISOString().split('T')[0];
  const [sheets] = await db.query('SELECT * FROM fms_sheets ORDER BY fms_name ASC');
  if (!sheets.length) return result;

  for (const sheet of sheets) {
    const fmsName = sheet.fms_name || sheet.sheet_name;
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [sheet.id]);

    // Doers per step (id + dept)
    for (const step of steps) {
      const [doers] = await db.query(
        `SELECT u.id, u.name, u.department FROM fms_step_doers fsd
         JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
    }

    // HOD filter: only steps where that department has a doer
    const activeSteps = hodDept
      ? steps.filter(s => s.doers.some(d => (d.department || '') === hodDept))
      : steps;
    if (!activeSteps.length) continue;

    let rows;
    try {
      rows = await fetchSheetRows(sheet);
    } catch (e) {
      // Do NOT silently return 0 — report the error so totals don't shift unexpectedly
      result.errors.push(fmsName);
      result.perFms.push({ fmsId: sheet.id, fmsName, pending: 0, done: 0, total: 0, steps: [], error: 'Sheet read failed (try again)' });
      continue;
    }

    let fmsPending = 0, fmsDone = 0;
    const perStep = [];

    for (const step of activeSteps) {
      const planIdx = colToIdx(step.plan_col);
      const actualIdx = colToIdx(step.actual_col);
      if (planIdx < 0 || actualIdx < 0) continue;

      let stepPending = 0, stepDone = 0;
      const stepPendingRows = []; // for collectPending — details of each pending row
      for (const row of rows) {
        const planVal = (row[planIdx] || '').trim();
        const actualVal = (row[actualIdx] || '').trim();
        if (planVal && !actualVal) {
          stepPending++;
          if (collectPending) {
            // plan date parse (same logic as /api/fms-dashboard)
            let planDate = '';
            const dateMatch = planVal.match(/(\d{4}-\d{2}-\d{2})|(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
            if (dateMatch) {
              const raw = dateMatch[0];
              if (raw.includes('-') && raw.length === 10 && raw[4] === '-') planDate = raw;
              else { const parts = raw.split(/[\/\-]/); if (parts.length === 3) planDate = `${parts[2]}-${parts[1]}-${parts[0]}`; }
            }
            stepPendingRows.push({
              fmsName, stepName: step.step_name, planValue: planVal,
              planDate, isLate: !!(planDate && planDate < _today)
            });
          }
        }
        else if (planVal && actualVal) stepDone++;
      }

      fmsPending += stepPending;
      fmsDone += stepDone;

      // Per-user attribution: in HOD view only credit dept-doers (consistency)
      const creditDoers = hodDept ? step.doers.filter(d => (d.department || '') === hodDept) : step.doers;
      for (const d of creditDoers) {
        if (!result.perUser[d.id]) result.perUser[d.id] = { pending: 0, done: 0, total: 0 };
        result.perUser[d.id].pending += stepPending;
        result.perUser[d.id].done    += stepDone;
        result.perUser[d.id].total   += stepPending + stepDone;
        if (collectPending && stepPendingRows.length) {
          if (!result.perUserPending[d.id]) result.perUserPending[d.id] = [];
          for (const pr of stepPendingRows) result.perUserPending[d.id].push(pr);
        }
      }

      perStep.push({
        stepName: step.step_name,
        stepOrder: step.step_order,
        doers: step.doers.map(d => d.name).join(', ') || '—',
        pending: stepPending,
        done: stepDone,
        total: stepPending + stepDone
      });
    }

    result.perFms.push({
      fmsId: sheet.id,
      fmsName,
      pending: fmsPending,
      done: fmsDone,
      total: fmsPending + fmsDone,
      steps: perStep
    });
  }

  return result;
}

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    let [rows] = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    let user = rows[0];

    // User not found in memory — resync from Sheet and retry
    if (!user) {
      try { await db.resync(); } catch(_) {}
      const [rows2] = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
      user = rows2[0];
    }

    const check = user ? checkPassword(password, user.password) : { ok: false };
    if (!check.ok) return res.status(401).json({ error: 'Invalid email or password' });

    // Legacy bcrypt hash → migrate to plain text (admin can now see in sheet)
    if (check.legacy) {
      try { await db.query('UPDATE users SET password=? WHERE id=?', [password, user.id]); } catch(_) {}
    }

    // Issue JWT token
    const token = jwt.sign(
      { userId: user.id, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.post('/api/sync-db', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin' && req.session.role !== 'pc') {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    await db.resync();
    res.json({ success: true, message: 'Database resynced from Google Sheets' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,name,email,notification_email,role,phone,profile_image,department,week_off FROM users WHERE id=?', [req.session.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    // extra_off fetch separately — safe if column not yet added
    try {
      const [ex] = await db.query('SELECT extra_off FROM users WHERE id=?', [req.session.userId]);
      rows[0].extra_off = ex[0]?.extra_off || '';
    } catch(e) { rows[0].extra_off = ''; }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const isHod = role === 'hod';
    const isPC = role === 'pc';
    const filterEmployee = req.query.employee;
    const hodDept = req.query.hodDept || '';
    // PC date range filter — default to today if not provided
    const dateFrom = req.query.dateFrom || '';
    const dateTo   = req.query.dateTo   || '';

    let userFilter, params;

    if (isAdmin && filterEmployee && filterEmployee !== 'all') {
      userFilter = 'AND t.assigned_to = ?'; params = [filterEmployee];
    } else if (isAdmin) {
      userFilter = ''; params = [];
    } else if (isHod) {
      if (filterEmployee && filterEmployee !== 'all') {
        userFilter = 'AND t.assigned_to = ?'; params = [filterEmployee];
      } else {
        // Fetch HOD's department from DB — do not rely on query param
        let resolvedDept = hodDept;
        if (!resolvedDept) {
          const [meRow] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
          resolvedDept = meRow[0]?.department || '';
        }
        if (!resolvedDept) {
          // No department set — show only own tasks
          userFilter = 'AND t.assigned_to = ?'; params = [uid];
        } else {
          const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [resolvedDept, 'admin','hod']);
          if (!deptUsers.length) {
            // No users in department — show only own tasks
            userFilter = 'AND t.assigned_to = ?'; params = [uid];
          } else {
            const ids = deptUsers.map(u=>u.id);
            // Also include the HOD themselves
            if (!ids.includes(uid)) ids.push(uid);
            userFilter = `AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
            params = ids;
          }
        }
      }
    } else {
      userFilter = 'AND t.assigned_to = ?'; params = [uid];
    }

    // PC: date range filter applied to both types
    // Regular users: delegation = no date filter (revised-to-future tasks show); checklist = today & past only
    const pcDateClause = isPC && dateFrom && dateTo ? `AND t.due_date BETWEEN '${dateFrom}' AND '${dateTo}'` : '';
    const delDateClause = pcDateClause; // delegation: no date cap for non-PC
    const chkDateClause = pcDateClause || `AND t.due_date <= CURDATE()`; // checklist: always cap at today

    const taskType = req.query.taskType || 'both';
    let pending = 0, revised = 0, completed = 0;

    if (taskType === 'delegation' || taskType === 'both') {
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM delegation_tasks t WHERE 1=1 ${userFilter} ${delDateClause}`, params);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM checklist_tasks t WHERE 1=1 ${userFilter} ${chkDateClause}`, params);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }

    // Load user names once — avoids alasql double-JOIN on same table (u1, u2)
    const [allUsers] = await db.query('SELECT id, name FROM users');
    const userMap = {};
    allUsers.forEach(u => { userMap[u.id] = u.name; });

    let delegationPending = [], checklistPending = [];
    if (taskType === 'delegation' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,t.link,COALESCE(t.revision_status,'') AS revision_status,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM delegation_tasks t WHERE t.status IN ('pending','revised') ${delDateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      delegationPending = rows.map(t => ({ ...t, type: 'delegation', assignedToName: userMap[t.assigned_to] || '', assignedByName: userMap[t.assigned_by] || '' }));
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,t.remarks,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM checklist_tasks t WHERE t.status IN ('pending','revised') ${chkDateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      checklistPending = rows.map(t => ({ ...t, type: 'checklist', approval: 'no', waiting_approval: 0, assignedToName: userMap[t.assigned_to] || '', assignedByName: userMap[t.assigned_by] || '' }));
    }
    res.json({ pending, revised, completed, todayPending: [...delegationPending, ...checklistPending] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin';
    const isHod = role === 'hod';
    const { type, mine } = req.query;
    const isMine = (mine === '1' || mine === 'true');
    const table = getTable(type || 'delegation');
    const isDeleg = (type || 'delegation') === 'delegation';
    let where = 'WHERE 1=1';
    const params = [];

    if (isMine) {
      // "Delegate by Me" mode — only tasks assigned BY the current user.
      // Role-based scoping is skipped — any role can view tasks they assigned.
      where += ' AND t.assigned_by = ?';
      params.push(uid);
    } else if (isAdmin || role === 'pc') {
      // Admin/PC — sees everything
    } else if (isHod) {
      // HOD — tasks for users in their department
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (!deptUsers.length) {
        return res.json({ grouped: [] });
      }
      const ids = deptUsers.map(u=>u.id);
      where += ` AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
      params.push(...ids);
    } else {
      // Regular user — only own tasks
      where += ' AND t.assigned_to = ?';
      params.push(uid);
    }

    // All Tasks — show upcoming/future delegation tasks so they're visible and transferable in advance.
    // Checklist: hide future tasks by default, BUT if includeFuture=1 query param is set (used by Transfer modal)
    // also show future checklist tasks so they can be transferred.
    const includeFuture = req.query.includeFuture === '1' || req.query.includeFuture === 'true';
    if (!isDeleg && !includeFuture) {
      where += ' AND t.due_date <= CURDATE()';
    }

    const [allUsers] = await db.query('SELECT id,name FROM users');
    const uMap = {};
    allUsers.forEach(u => { uMap[u.id] = u.name; });

    const [rawTasks] = await db.query(`SELECT t.id,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,${isDeleg?"COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,":"'no' AS approval,0 AS waiting_approval,t.remarks,"}DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.created_at,'%Y-%m-%d') AS assigned_on FROM ${table} t ${where} ORDER BY t.due_date ASC`, params);
    const tasks = rawTasks.map(t => ({ ...t, type: type||'delegation', assignedToName: uMap[t.assigned_to]||'', assignedByName: uMap[t.assigned_by]||'' }));

    // mine=1 mode always returns flat tasks (not grouped)
    if (isMine) {
      return res.json({ tasks });
    }
    if (isAdmin || isHod || role === 'pc') {
      const grouped = {};
      tasks.forEach(t => {
        if (!grouped[t.assigned_to]) grouped[t.assigned_to] = { userId: t.assigned_to, name: t.assignedToName, tasks: [] };
        grouped[t.assigned_to].tasks.push(t);
      });
      return res.json({ grouped: Object.values(grouped) });
    }
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { type, desc, assignedTo, approverEmail, date, priority, approval, remarks, link } = req.body;
    const isAdmin = req.session.role === 'admin';
    const isHod   = req.session.role === 'hod';
    const isUser  = req.session.role === 'user';
    // Admin, HOD and regular users can all assign to others; fallback to self if not specified
    const targetUser = (isAdmin || isHod || isUser) && assignedTo ? parseInt(assignedTo) : req.session.userId;
    if (!desc || !date) return res.status(400).json({ error: 'Description and date required' });
    if ((type||'checklist') === 'delegation') {
      // Approver: if approverEmail is provided look up that user, otherwise use logged-in user
      let assignedBy = req.session.userId;
      if (approverEmail) {
        const [aprRows] = await db.query('SELECT id FROM users WHERE email=? LIMIT 1', [approverEmail]);
        if (aprRows.length) assignedBy = aprRows[0].id;
      }
      await db.query(`INSERT INTO delegation_tasks (description,assigned_to,assigned_by,due_date,status,priority,approval,remarks,link) VALUES (?,?,?,?,?,?,?,?,?)`, [desc, targetUser, assignedBy, date, 'pending', priority||'low', approval||'no', remarks||'', link||'']);
      // 📧 Send delegation email (non-blocking — fire and forget)
      (async () => {
        const target = await getNotifyTarget(targetUser);
        if (!target) return;
        const [aprRows] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [assignedBy]);
        const assignerName = aprRows[0]?.name || 'Admin';
        await sendMail(
          target.email,
          `📋 New Task Assigned: ${(desc||'').slice(0,60)}`,
          delegationEmailHtml({
            assigneeName: target.name,
            assignerName,
            desc, dueDate: date,
            priority: priority||'low',
            approval: approval||'no',
            remarks: remarks||''
          })
        );
      })();
    } else {
      await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,status,priority,remarks) VALUES (?,?,?,?,?,?,?)`, [desc, targetUser, req.session.userId, date, 'pending', priority||'low', remarks||'']);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/bulk-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { desc, assignedTo, priority, remarks, dates, frequency } = req.body;
    if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
    const freq = (frequency || '').toLowerCase().trim();
    const values = dates.map(date => [desc, parseInt(assignedTo), req.session.userId, date, 'pending', priority||'low', remarks||'', freq]);
    await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,status,priority,remarks,frequency) VALUES ?`, [values]);
    res.json({ success: true, count: dates.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, type, newDate, reason } = req.body;
    const table = getTable(type||'delegation');
    const isAdmin = req.session.role === 'admin';
    const isPC = req.session.role === 'pc';
    const uid = req.session.userId;
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    if (!isAdmin && !isPC && task.assigned_to !== uid) return res.status(403).json({ error: 'Not allowed' });
    // Timestamp: set to NOW() on completed; otherwise NULL (cleared on un-complete).
    const nowTs = new Date().toISOString().slice(0,19).replace('T',' ');
    const completedAt = status === 'completed' ? nowTs : null;
    if (status === 'completed' && task.waiting_approval) {
      await db.query(`DELETE FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [req.params.id, type]);
      if (type === 'checklist') await db.query(`UPDATE ${table} SET status='completed',completed_at=? WHERE id=?`, [nowTs, req.params.id]);
      else await db.query(`UPDATE ${table} SET status='completed',waiting_approval=0,revision_status='',completed_at=? WHERE id=?`, [nowTs, req.params.id]);
      return res.json({ success: true, needsApproval: false });
    }
    // Revision request: always requires approval (task.approval field is only for completion)
    // Completion: requires approval only when task.approval='yes'
    const needsApproval = type === 'delegation' && !isAdmin && !isPC &&
      (status === 'revised' || task.approval === 'yes');
    if (needsApproval) {
      const [existing] = await db.query(`SELECT id FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [req.params.id, type]);
      if (existing[0]) return res.status(400).json({ error: 'Approval already pending' });
      await db.query(`INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,status,note) VALUES (?,?,?,?,?,'pending',?)`, [req.params.id, type, uid, task.assigned_by, status, reason||'']);
      if (newDate && status === 'revised') await db.query(`UPDATE ${table} SET waiting_approval=1,revision_status='pending',due_date=? WHERE id=?`, [newDate, req.params.id]);
      else await db.query(`UPDATE ${table} SET waiting_approval=1,revision_status='pending' WHERE id=?`, [req.params.id]);
      return res.json({ success: true, needsApproval: true });
    }
    if (newDate && status === 'revised') await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,revision_status='pending',due_date=?,completed_at=? WHERE id=?`, [status, newDate, completedAt, req.params.id]);
    else {
      // checklist_tasks does not have a waiting_approval column
      if (type === 'checklist') await db.query(`UPDATE ${table} SET status=?,completed_at=? WHERE id=?`, [status, completedAt, req.params.id]);
      else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,revision_status='',completed_at=? WHERE id=?`, [status, completedAt, req.params.id]);
    }
    res.json({ success: true, needsApproval: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type||'delegation');
    const [rows] = await db.query(`SELECT t.*,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM ${table} t WHERE t.id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, desc, date, priority, approval, remarks } = req.body;
    const table = getTable(type||'delegation');
    if (type === 'delegation') await db.query(`UPDATE ${table} SET description=?,due_date=?,priority=?,approval=?,remarks=? WHERE id=?`, [desc, date, priority||'low', approval||'no', remarks||'', req.params.id]);
    else await db.query(`UPDATE ${table} SET description=?,due_date=?,remarks=? WHERE id=?`, [desc, date, remarks||'', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, skipCompleted } = req.query;
    const table = getTable(type||'delegation');
    // v16: bulk-delete flows pass skipCompleted=1 — refuse to delete completed tasks
    if (skipCompleted === '1' || skipCompleted === 'true') {
      const [rows] = await db.query(`SELECT status FROM ${table} WHERE id=?`, [req.params.id]);
      if (rows[0] && rows[0].status === 'completed') {
        return res.status(400).json({ error: 'Completed tasks cannot be deleted in bulk', skipped: true });
      }
    }
    await db.query(`DELETE FROM ${table} WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk delete by user — v16: completed tasks excluded
app.delete('/api/tasks/user/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    await db.query(`DELETE FROM ${table} WHERE assigned_to = ? AND status != 'completed'`, [req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transfer pending tasks to today
app.put('/api/tasks/user/:userId/transfer-today', requireAuth, requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    await db.query(`UPDATE ${table} SET due_date=? WHERE assigned_to=? AND status='pending'`,
      [today, req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// HOLIDAYS  (stored in Google Sheets → holidays tab)
// ══════════════════════════════════════════════════════

// Helper: given a date string and Set of holiday dates, find next non-holiday day
function nextWorkingDay(dateStr, holidaySet) {
  let d = new Date(dateStr + 'T00:00:00');
  for (let i = 0; i < 365; i++) {
    d.setDate(d.getDate() + 1);
    const s = d.toISOString().slice(0, 10);
    if (!holidaySet.has(s)) return s;
  }
  return dateStr; // fallback (should never happen)
}

app.get('/api/holidays', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,date,name FROM holidays ORDER BY date ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/holidays', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { date, name } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'Date and name required' });

    // Save holiday
    await db.query('INSERT INTO holidays (date,name) VALUES (?,?)', [date, name]);

    // Build full holiday set for next-working-day calculation
    const [allH] = await db.query('SELECT date FROM holidays');
    const holidaySet = new Set(allH.map(h => h.date));

    const target = nextWorkingDay(date, holidaySet);

    // Shift ALL pending/revised tasks (delegation + checklist) on this date
    const [dr] = await db.query(
      "UPDATE delegation_tasks SET due_date=? WHERE due_date=? AND status IN ('pending','revised')",
      [target, date]
    );
    const [cr] = await db.query(
      "UPDATE checklist_tasks SET due_date=? WHERE due_date=? AND status IN ('pending','revised')",
      [target, date]
    );
    const shifted = (dr.affectedRows || 0) + (cr.affectedRows || 0);

    res.json({ success: true, shifted, shiftedTo: target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/holidays/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    await db.query('DELETE FROM holidays WHERE id=?', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// kept for backward compat — now a no-op (tasks shift instead of delete)
app.delete('/api/tasks/delete-by-date', requireAuth, requireAdmin, async (req, res) => {
  res.json({ success: true, deleted: 0 });
});

// Count checklist tasks for a user (all time or by year, optionally filtered by frequency).
// v16: completed tasks are EXCLUDED — bulk delete only applies to pending/revised tasks.
app.get('/api/tasks/checklist-year-count', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, year, frequency } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const where = ['assigned_to=?', "status!='completed'"];
    const params = [userId];
    if (year && year !== 'all') { where.push('YEAR(due_date)=?'); params.push(year); }
    if (frequency && frequency !== 'all') { where.push('frequency=?'); params.push(frequency); }
    const [rows] = await db.query(
      `SELECT COUNT(*) AS count FROM checklist_tasks WHERE ${where.join(' AND ')}`, params);
    res.json({ count: rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete checklist tasks for a user — optionally filtered by frequency.
// v16: completed tasks NEVER deleted in bulk; frequency filter respected.
app.post('/api/tasks/checklist-year-delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, frequency } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const where = ['assigned_to=?', "status!='completed'"];
    const params = [userId];
    if (frequency && frequency !== 'all') { where.push('frequency=?'); params.push(frequency); }
    const [result] = await db.query(
      `DELETE FROM checklist_tasks WHERE ${where.join(' AND ')}`, params);
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// APPROVALS
// ══════════════════════════════════════════════════════
app.get('/api/approvals', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    // Admin/PC sees all pending approvals; others see only theirs
    const whereClause = isAdminOrPC
      ? `WHERE ta.status='pending'`
      : `WHERE ta.requested_to=? AND ta.status='pending'`;
    const params = isAdminOrPC ? [] : [req.session.userId];
    const [allUA] = await db.query('SELECT id,name FROM users');
    const uMapA = {};
    allUA.forEach(u => { uMapA[u.id] = u.name; });

    const [rawRows] = await db.query(`SELECT ta.*,dt.description,dt.approval AS taskApproval,DATE_FORMAT(dt.due_date,'%Y-%m-%d') AS new_due_date FROM task_approvals ta LEFT JOIN delegation_tasks dt ON ta.task_id=dt.id AND ta.task_type='delegation' ${whereClause} ORDER BY ta.created_at DESC`, params);
    const rows = rawRows.map(r => ({ ...r, requestedByName: uMapA[r.requested_by]||'', requestedToName: uMapA[r.requested_to]||'' }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/approvals/count', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    const [rows] = isAdminOrPC
      ? await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE status='pending'`)
      : await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE requested_to=? AND status='pending'`, [req.session.userId]);
    res.json({ count: rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/approvals/:id', requireAuth, async (req, res) => {
  try {
    const { action, note } = req.body;
    const role = req.session.role;
    const [rows] = await db.query('SELECT * FROM task_approvals WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Approval not found' });
    const appr = rows[0];
    // PC and admin can approve any; others only their own
    const canApprove = role === 'admin' || role === 'pc' || appr.requested_to === req.session.userId;
    if (!canApprove) return res.status(403).json({ error: 'Not allowed' });
    await db.query('UPDATE task_approvals SET status=?,note=? WHERE id=?', [action, note||'', req.params.id]);
    const table = getTable(appr.task_type);
    if (action === 'approved') {
      const completedAt = appr.action_type === 'completed' ? new Date().toISOString().slice(0,19).replace('T',' ') : null;
      if (appr.action_type === 'revised') {
        // Revision granted — task goes back to pending with new date, mark revision approved
        await db.query(`UPDATE ${table} SET status='pending',waiting_approval=0,revision_status='approved',completed_at=? WHERE id=?`, [completedAt, appr.task_id]);
      } else {
        await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,revision_status='',completed_at=? WHERE id=?`, [appr.action_type, completedAt, appr.task_id]);
      }
    } else {
      // Rejected — task goes back to pending, mark revision rejected
      if (appr.action_type === 'revised') {
        await db.query(`UPDATE ${table} SET status='pending',waiting_approval=0,revision_status='rejected' WHERE id=?`, [appr.task_id]);
      } else {
        await db.query(`UPDATE ${table} SET waiting_approval=0 WHERE id=?`, [appr.task_id]);
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// MIS
// ══════════════════════════════════════════════════════
app.get('/api/mis', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const role = req.session.role;
    const uid  = req.session.userId;
    const isHod  = role === 'hod';
    const isUser = role === 'user';

    let userFilter = '';
    let deptParams = [start, end];
    if (isUser) {
      // Regular user: own data only
      userFilter = 'AND u.id=?';
      deptParams = [start, end, uid];
    } else if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      userFilter = 'AND u.department=?';
      deptParams = [start, end, dept];
    } else if (role !== 'admin' && role !== 'pc') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const calc = rows => rows.map(r => {
      const total=parseInt(r.total)||0, pending=parseInt(r.pending)||0, overdue=parseInt(r.overdue)||0, revised=parseInt(r.revised)||0;
      let score = total > 0 ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10) : 0;
      return { ...r, delayed: overdue, score };
    });
    const [delRows] = await db.query(`SELECT u.id AS userId,u.name,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${userFilter} GROUP BY u.id,u.name ORDER BY u.name`, deptParams);
    const [chlRows] = await db.query(`SELECT u.id AS userId,u.name,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,0 AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${userFilter} GROUP BY u.id,u.name ORDER BY u.name`, deptParams);
    res.json({ delegation: calc(delRows), checklist: calc(chlRows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FMS Dashboard — row-level pending tasks (like delegation/checklist) ──
app.get('/api/fms-dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const isHod = role === 'hod';
    const filterEmployee = req.query.employee;

    const today = new Date().toISOString().split('T')[0];

    // Determine which user IDs to show
    let targetUserIds = null; // null = all (admin)
    if (isAdmin && filterEmployee && filterEmployee !== 'all') {
      targetUserIds = [parseInt(filterEmployee)];
    } else if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      if (filterEmployee && filterEmployee !== 'all') {
        targetUserIds = [parseInt(filterEmployee)];
      } else {
        const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [dept, 'admin', 'hod']);
        targetUserIds = deptUsers.map(u => u.id);
        if (!targetUserIds.length) return res.json({ rows: [], pendingCount: 0 });
      }
    } else {
      // Regular employee — only their own steps
      targetUserIds = [uid];
    }

    // Get FMS sheets
    let fmsList;
    if (isAdmin && !filterEmployee || (isAdmin && filterEmployee === 'all')) {
      [fmsList] = await db.query('SELECT * FROM fms_sheets ORDER BY fms_name ASC');
    } else {
      // Get FMS where targetUserIds are doers
      [fmsList] = await db.query(
        `SELECT DISTINCT fs.* FROM fms_sheets fs
         JOIN fms_steps fst ON fst.fms_id=fs.id
         JOIN fms_step_doers fsd ON fsd.step_id=fst.id
         WHERE fsd.user_id IN (${targetUserIds.map(()=>'?').join(',')})
         ORDER BY fs.fms_name ASC`, targetUserIds);
    }

    if (!fmsList.length) return res.json({ rows: [], pendingCount: 0 });

    const allRows = [];

    for (const sheet of fmsList) {
      const fmsName = sheet.fms_name || sheet.sheet_name;

      // Get steps for this FMS that are assigned to targetUserIds
      let steps;
      if (isAdmin && (!filterEmployee || filterEmployee === 'all')) {
        [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [sheet.id]);
      } else {
        [steps] = await db.query(
          `SELECT DISTINCT fst.* FROM fms_steps fst
           JOIN fms_step_doers fsd ON fsd.step_id=fst.id
           WHERE fst.fms_id=? AND fsd.user_id IN (${targetUserIds.map(()=>'?').join(',')})
           ORDER BY fst.step_order ASC`, [sheet.id, ...targetUserIds]);
      }
      if (!steps.length) continue;

      // Get doer names for each step
      for (const step of steps) {
        const [doers] = await db.query(
          `SELECT u.id, u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
        step.doerNames = doers.map(d => d.name).join(', ');
        step.doerIds = doers.map(d => d.id);
      }

      try {
        const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
        const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
        const tabName = sheet.sheet_name || 'Sheet1';
        const headerRowIdx = (sheet.header_row || 1) - 1;

        const filteredSteps = steps; // fix: was undefined, use steps array
        const allCols = filteredSteps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
        if (!allCols.length) continue;
        const maxCol = Math.max(...allCols);
        const lastCol = idxToCol(maxCol);
        const range = `${tabName}!A:${lastCol}`;

        const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
        const sheetData = response.data.values || [];
        const headers = sheetData[headerRowIdx] || [];
        const dataRows = sheetData.slice(headerRowIdx + 1);

        for (const step of steps) {
          const planIdx = colToIdx(step.plan_col);
          const actualIdx = colToIdx(step.actual_col);
          if (planIdx < 0 || actualIdx < 0) continue;

          dataRows.forEach((row, i) => {
            const planVal = (row[planIdx] || '').trim();
            const actualVal = (row[actualIdx] || '').trim();
            if (!planVal || actualVal) return; // skip if no plan or already done

            // Parse plan date — try to extract date from value
            // planVal might be a date string like "2026-04-07" or "07/04/2026" or just text
            let planDate = '';
            const dateMatch = planVal.match(/(\d{4}-\d{2}-\d{2})|(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
            if (dateMatch) {
              const raw = dateMatch[0];
              if (raw.includes('-') && raw.length === 10 && raw[4] === '-') {
                planDate = raw; // already YYYY-MM-DD
              } else {
                // DD/MM/YYYY → YYYY-MM-DD
                const parts = raw.split(/[\/\-]/);
                if (parts.length === 3) planDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
              }
            }

            // isLate: plan date is in the past and still pending
            const isLate = planDate && planDate < today;

            allRows.push({
              fmsName,
              fmsId: sheet.id,
              stepName: step.step_name,
              stepId: step.id,
              doer: step.doerNames || '—',
              planValue: planVal,
              planDate: planDate || '',
              isLate,
              rowNumber: headerRowIdx + 1 + i + 1
            });
          });
        }
      } catch(e) {
        // Skip sheet on error, don't fail whole request
      }
    }

    res.json({ rows: allRows, pendingCount: allRows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis/detail', requireAuth, async (req, res) => {
  try {
    const { userId, type, start, end } = req.query;
    if (!userId || !start || !end) return res.status(400).json({ error: 'Missing params' });
    // Regular users can only view their own detail
    if (req.session.role === 'user' && parseInt(userId) !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const table = type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
    const [allUC] = await db.query('SELECT id,name FROM users');
    const uMapC = {};
    allUC.forEach(u => { uMapC[u.id] = u.name; });
    const [rawCal] = await db.query(`SELECT t.id,t.description,t.status,t.assigned_by,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM ${table} t WHERE t.assigned_to=? AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date ASC`, [userId, start, end]);
    const tasks = rawCal.map(t => ({ ...t, assigned_by_name: uMapC[t.assigned_by]||'' }));
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All MIS — per employee combined score ──
app.get('/api/mis/all', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // Fetch HOD's department once (used for both FMS and task filters)
    let hodDept = '';
    if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      hodDept = me[0]?.department || '';
    }

    // Same deptFilter logic as /api/mis — tasks JOIN users se filter
    let deptFilter = '';
    let deptParams = [start, end];
    if (isHod) {
      deptFilter = 'AND u.department=?';
      deptParams = [start, end, hodDept];
    }

    const calc = (total, pending, overdue, revised) => {
      total = parseInt(total)||0; pending = parseInt(pending)||0;
      overdue = parseInt(overdue)||0; revised = parseInt(revised)||0;
      const score = total > 0 ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10) : 0;
      return { total, pending, overdue, revised, score };
    };

    // Fetch delegation + checklist stats per user (same style as /api/mis)
    const [delRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department ORDER BY u.name`, deptParams);

    const [chlRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        0 AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department ORDER BY u.name`, deptParams);

    // Merge by userId
    const userMap = {};
    for (const r of delRows) {
      userMap[r.userId] = { userId: r.userId, name: r.name, department: r.department||'',
        delegation: calc(r.total, r.pending, r.overdue, r.revised),
        delegationCompleted: parseInt(r.completed)||0,
        checklist: calc(0,0,0,0), checklistCompleted: 0 };
      userMap[r.userId].delegation.completed = parseInt(r.completed)||0;
    }
    for (const r of chlRows) {
      if (!userMap[r.userId]) {
        userMap[r.userId] = { userId: r.userId, name: r.name, department: r.department||'',
          delegation: calc(0,0,0,0), delegationCompleted: 0,
          checklist: calc(0,0,0,0), checklistCompleted: 0 };
        userMap[r.userId].delegation.completed = 0;
      }
      userMap[r.userId].checklist = calc(r.total, r.pending, r.overdue, 0);
      userMap[r.userId].checklist.completed = parseInt(r.completed)||0;
      userMap[r.userId].checklistCompleted = parseInt(r.completed)||0;
    }

    // Fetch week plan for each user — DATE_FORMAT gives clean YYYY-MM-DD (not ISO timestamp)
    let planMap = {};
    try {
      const [plans] = await db.query(
        `SELECT employee_id, target_count, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, improvement_pct FROM week_plans WHERE start_date BETWEEN ? AND ? ORDER BY start_date DESC`, [start, end]);
      for (const p of plans) {
        if (!planMap[p.employee_id]) planMap[p.employee_id] = p;
      }
    } catch(e) { /* week_plans table may not exist yet */ }

    // ── FMS contribution per user (shared engine — deterministic + cached) ──
    // /api/mis/fms also uses computeFmsStats(), so per-employee FMS numbers and
    // FMS Overview always match. The same dept-filter applies for both HOD and admin.
    // On read failure the sheet name goes into fmsErrors.
    let fmsUserMap = {};
    let fmsErrors = [];
    try {
      // ROLE-INDEPENDENT: always credit all doers (hodDept='') so each employee's
      // FMS total/score is identical for both admin and HOD views. Dept filter only
      // affects which employees are listed — not the numbers themselves.
      const fmsStats = await computeFmsStats('');
      fmsUserMap = fmsStats.perUser || {};
      fmsErrors = fmsStats.errors || [];
    } catch (e) { fmsErrors = ['FMS data unavailable']; }

    // Also include users who only have FMS work (0 delegation/checklist tasks).
    if (Object.keys(fmsUserMap).length) {
      const fmsUserIds = Object.keys(fmsUserMap).map(x => parseInt(x)).filter(x => !userMap[x]);
      if (fmsUserIds.length) {
        let userQ = `SELECT id, name, department FROM users WHERE id IN (${fmsUserIds.map(()=>'?').join(',')})`;
        const userQParams = [...fmsUserIds];
        if (isHod) { userQ += ' AND department=?'; userQParams.push(hodDept); }
        const [extraUsers] = await db.query(userQ, userQParams);
        for (const u of extraUsers) {
          userMap[u.id] = { userId: u.id, name: u.name, department: u.department||'',
            delegation: calc(0,0,0,0), delegationCompleted: 0,
            checklist: calc(0,0,0,0), checklistCompleted: 0 };
          userMap[u.id].delegation.completed = 0;
        }
      }
    }

    const rows = Object.values(userMap).map(u => {
      const d = u.delegation, c = u.checklist;
      const fms = fmsUserMap[u.userId] || { total: 0, pending: 0, done: 0 };
      // FMS total = done + pending (both should count toward the Total column)
      const fmsRealTotal = fms.done + fms.pending;
      const totalAll = d.total + c.total + fmsRealTotal;
      const pendingAll = d.pending + c.pending + fms.pending;
      const overdueAll = d.overdue + c.overdue;
      const revisedAll = d.revised;
      const completedAll = (d.completed||0) + (c.completed||0) + fms.done;
      const overallScore = totalAll > 0
        ? Math.max(-100, Math.round((0-(pendingAll/totalAll)*100-(overdueAll/totalAll)*50-(revisedAll/totalAll)*25)*10)/10)
        : null;
      const plan = planMap[u.userId] || null;
      const fmsScore = fmsRealTotal > 0
        ? Math.round((fms.done / fmsRealTotal) * 100 * 10) / 10  // 0-100% completion
        : null;
      return { ...u, fms: { total: fmsRealTotal, pending: fms.pending, done: fms.done, score: fmsScore },
        totalAll, pendingAll, overdueAll, revisedAll, completedAll, overallScore, plan };
    }).filter(u => u.totalAll > 0).sort((a,b) => a.name.localeCompare(b.name));

    // Backward compatible: if no errors, return plain array (as before).
    // On error, return an object so the frontend can show a warning.
    if (fmsErrors.length) return res.json({ rows, fmsErrors });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FMS MIS ──
app.get('/api/mis/fms', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // HOD's department (for FMS dept-filter)
    let hodDept = '';
    if (isHod) {
      const [meRow] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      hodDept = meRow[0]?.department || '';
    }

    // Same shared engine as /api/mis/all => numbers always match
    const fmsStats = await computeFmsStats(hodDept);
    res.json(fmsStats.perFms);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// EMPLOYEE RECORDS  (Admin / HOD / PC) — Plan vs Done
// ──────────────────────────────────────────────────────
// Single CANONICAL source. An employee's numbers (total / done / pending /
// score / committed plan) do NOT depend on the viewer's role. Role only
// controls which employees are visible:
//   • admin / pc  → all employees
//   • hod         → only employees in their department
// Therefore admin and HOD always see the EXACT same total/score for a given employee.
// Each employee row includes their committed plan inline, plus the full list of
// pending tasks (delegation + checklist + FMS).
// ══════════════════════════════════════════════════════
app.get('/api/employee-records', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // HOD's department (visibility only)
    let hodDept = '';
    if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      hodDept = me[0]?.department || '';
    }

    // Score formula — identical to the one used in MIS (consistency)
    const calcScore = (total, pending, overdue, revised) => {
      total = parseInt(total)||0; pending = parseInt(pending)||0;
      overdue = parseInt(overdue)||0; revised = parseInt(revised)||0;
      return total > 0
        ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10)
        : null;
    };

    // Dept filter for visibility only (does not affect numbers)
    let deptFilter = '';
    let deptParams = [start, end];
    if (isHod) { deptFilter = 'AND u.department=?'; deptParams = [start, end, hodDept]; }

    // ── Delegation + Checklist aggregate per user ──
    const [delRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department`, deptParams);

    const [chlRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department`, deptParams);

    const map = {};
    const ensure = (r) => {
      if (!map[r.userId]) map[r.userId] = {
        userId: r.userId, name: r.name, department: r.department || '',
        del: { total:0, pending:0, completed:0, revised:0, overdue:0 },
        chl: { total:0, pending:0, completed:0, overdue:0 },
        fms: { total:0, pending:0, done:0 }
      };
      return map[r.userId];
    };
    for (const r of delRows) {
      const e = ensure(r);
      e.del = { total:+r.total||0, pending:+r.pending||0, completed:+r.completed||0, revised:+r.revised||0, overdue:+r.overdue||0 };
    }
    for (const r of chlRows) {
      const e = ensure(r);
      e.chl = { total:+r.total||0, pending:+r.pending||0, completed:+r.completed||0, overdue:+r.overdue||0 };
    }

    // ── FMS (ROLE-INDEPENDENT: always credit all doers) + pending detail ──
    let fmsPerUser = {}, fmsPerUserPending = {}, fmsErrors = [];
    try {
      const fmsStats = await computeFmsStats('', true);
      fmsPerUser = fmsStats.perUser || {};
      fmsPerUserPending = fmsStats.perUserPending || {};
      fmsErrors = fmsStats.errors || [];
    } catch (e) { fmsErrors = ['FMS data unavailable']; }

    // Also add FMS-only users to the list (respecting dept visibility)
    const fmsOnlyIds = Object.keys(fmsPerUser).map(x => parseInt(x)).filter(x => !map[x]);
    if (fmsOnlyIds.length) {
      let q = `SELECT id, name, department FROM users WHERE id IN (${fmsOnlyIds.map(()=>'?').join(',')})`;
      const qp = [...fmsOnlyIds];
      if (isHod) { q += ' AND department=?'; qp.push(hodDept); }
      const [extra] = await db.query(q, qp);
      for (const u of extra) ensure({ userId: u.id, name: u.name, department: u.department });
    }
    for (const e of Object.values(map)) {
      const f = fmsPerUser[e.userId] || { pending:0, done:0 };
      e.fms = { pending: f.pending||0, done: f.done||0, total: (f.pending||0)+(f.done||0) };
    }

    // ── Committed plans (week_plans) for range ──
    let planMap = {};
    try {
      const [plans] = await db.query(
        `SELECT employee_id, target_count, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, improvement_pct
         FROM week_plans WHERE start_date BETWEEN ? AND ? ORDER BY start_date DESC`, [start, end]);
      for (const p of plans) if (!planMap[p.employee_id]) planMap[p.employee_id] = p;
    } catch (e) { /* table may not exist */ }

    // Also include employees who have a committed plan but no tasks or FMS work
    // (so every employee's plan is always visible). HOD dept visibility is respected.
    const planOnlyIds = Object.keys(planMap).map(x => parseInt(x)).filter(x => !map[x]);
    if (planOnlyIds.length) {
      let pq = `SELECT id, name, department FROM users WHERE id IN (${planOnlyIds.map(()=>'?').join(',')})`;
      const pqp = [...planOnlyIds];
      if (isHod) { pq += ' AND department=?'; pqp.push(hodDept); }
      const [pu] = await db.query(pq, pqp);
      for (const u of pu) ensure({ userId: u.id, name: u.name, department: u.department });
    }

    // ── Pending task lists (delegation + checklist) for visible users ──
    const visibleIds = Object.keys(map).map(x => parseInt(x));
    let delPending = {}, chlPending = {};
    if (visibleIds.length) {
      const ph = visibleIds.map(()=>'?').join(',');
      const [dp] = await db.query(
        `SELECT t.assigned_to AS uid, t.description, t.status,
                DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date
         FROM delegation_tasks t
         WHERE t.assigned_to IN (${ph}) AND t.due_date BETWEEN ? AND ?
           AND t.status IN ('pending','revised')
         ORDER BY t.due_date ASC`, [...visibleIds, start, end]);
      for (const r of dp) { (delPending[r.uid] = delPending[r.uid] || []).push(r); }
      const [cp] = await db.query(
        `SELECT t.assigned_to AS uid, t.description, t.status,
                DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date
         FROM checklist_tasks t
         WHERE t.assigned_to IN (${ph}) AND t.due_date BETWEEN ? AND ?
           AND t.status='pending'
         ORDER BY t.due_date ASC`, [...visibleIds, start, end]);
      for (const r of cp) { (chlPending[r.uid] = chlPending[r.uid] || []).push(r); }
    }

    // ── Assemble canonical rows ──
    const rows = Object.values(map).map(e => {
      const total   = e.del.total + e.chl.total + e.fms.total;
      const pending = e.del.pending + e.chl.pending + e.fms.pending;
      const done    = e.del.completed + e.chl.completed + e.fms.done;
      const overdue = e.del.overdue + e.chl.overdue;
      const revised = e.del.revised;
      const score   = calcScore(total, pending, overdue, revised);
      const plan    = planMap[e.userId] || null;
      return {
        userId: e.userId, name: e.name, department: e.department,
        committed: plan ? {
          start_date: plan.start_date,
          target_count: plan.target_count,
          improvement_pct: (plan.improvement_pct === null || plan.improvement_pct === undefined) ? null : plan.improvement_pct
        } : null,
        total, done, pending, overdue, revised, score,
        breakdown: {
          delegation: { total: e.del.total, done: e.del.completed, pending: e.del.pending },
          checklist:  { total: e.chl.total, done: e.chl.completed, pending: e.chl.pending },
          fms:        { total: e.fms.total, done: e.fms.done,       pending: e.fms.pending }
        },
        pendingTasks: {
          delegation: delPending[e.userId] || [],
          checklist:  chlPending[e.userId] || [],
          fms:        fmsPerUserPending[e.userId] || []
        }
      };
    }).filter(r => r.total > 0 || r.committed)
      .sort((a,b) => a.name.localeCompare(b.name));

    res.json({ rows, fmsErrors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PC: Users with pending tasks (for smart dropdown) ──
app.get('/api/users/with-pending-tasks', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    let dateFilter = 'AND t.due_date <= CURDATE()';
    if (dateFrom && dateTo) dateFilter = `AND t.due_date BETWEEN '${dateFrom}' AND '${dateTo}'`;
    const [rows] = await db.query(`
      SELECT DISTINCT u.id, u.name FROM users u
      WHERE u.id IN (
        SELECT DISTINCT assigned_to FROM delegation_tasks t WHERE status='pending' ${dateFilter}
        UNION
        SELECT DISTINCT assigned_to FROM checklist_tasks t WHERE status='pending' ${dateFilter}
      ) AND u.role NOT IN ('admin','pc')
      ORDER BY u.name ASC`);
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,name,email,notification_email,role,phone,department,week_off,extra_off FROM users ORDER BY role DESC,name ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, password, role, phone, department, week_off, extra_off } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const [ex] = await db.query('SELECT id FROM users WHERE email=?', [email]);
    if (ex[0]) return res.status(400).json({ error: 'Email already exists' });
    await db.query('INSERT INTO users (name,email,notification_email,password,role,phone,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, email, notification_email||'', password, role||'user', phone||null, department||'', week_off||'', extra_off||'']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, role, password, phone, department, week_off, extra_off } = req.body;
    if (password) await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,password=?,phone=?,department=?,week_off=?,extra_off=? WHERE id=?',
      [name,email,notification_email||'',role,password,phone||null,department||'',week_off||'',extra_off||'',req.params.id]);
    else await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,phone=?,department=?,week_off=?,extra_off=? WHERE id=?',
      [name,email,notification_email||'',role,phone||null,department||'',week_off||'',extra_off||'',req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    await db.query('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk add users via CSV
app.post('/api/users/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { users } = req.body;
    if (!users || !users.length) return res.status(400).json({ error: 'No users provided' });
    let added = 0, skipped = 0, errors = [];
    for (const u of users) {
      if (!u.name || !u.email || !u.password) { errors.push(`${u.email||'?'}: missing fields`); continue; }
      const [ex] = await db.query('SELECT id FROM users WHERE email=?', [u.email]);
      if (ex[0]) { skipped++; continue; }
      await db.query('INSERT INTO users (name,email,password,role,phone,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?)',
        [u.name, u.email, u.password, u.role||'user', u.phone||null, u.department||'', u.week_off||'', u.extra_off||'']);
      added++;
    }
    res.json({ success: true, added, skipped, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { name, email, notification_email, phone, currentPassword, newPassword, profileImage } = req.body;
    if (currentPassword) {
      const [rows] = await db.query('SELECT password FROM users WHERE id=?', [uid]);
      const check = rows[0] ? checkPassword(currentPassword, rows[0].password) : { ok: false };
      if (!check.ok) return res.status(400).json({ error: 'Current password is incorrect' });
      if (newPassword) await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=?,password=? WHERE id=?', [name,email,notification_email||'',phone||null,newPassword,uid]);
      else await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    } else {
      await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    }
    if (profileImage !== undefined) await db.query('UPDATE users SET profile_image=? WHERE id=?', [profileImage||null, uid]);
    req.session.name = name;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profile/image', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE users SET profile_image=? WHERE id=?', [req.body.image||null, req.session.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════
app.get('/api/comments/:type/:taskId', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT tc.id,tc.comment,tc.created_at,u.name AS userName FROM task_comments tc JOIN users u ON tc.user_id=u.id WHERE tc.task_id=? AND tc.task_type=? ORDER BY tc.created_at ASC`, [req.params.taskId, req.params.type]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/comments', requireAuth, async (req, res) => {
  try {
    const { taskId, taskType, comment } = req.body;
    if (!comment || !taskId || !taskType) return res.status(400).json({ error: 'All fields required' });
    await db.query('INSERT INTO task_comments (task_id,task_type,user_id,comment) VALUES (?,?,?,?)', [taskId, taskType, req.session.userId, comment]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM task_comments WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].user_id !== req.session.userId && req.session.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
    await db.query('DELETE FROM task_comments WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// FMS ADMIN APIs
// ══════════════════════════════════════════════════════

app.get('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query(`SELECT f.*,u.name AS createdByName FROM fms_sheets f JOIN users u ON f.created_by=u.id ORDER BY f.created_at DESC`);
    res.json(sheets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [req.params.id]);
    for (const step of steps) {
      const [doers] = await db.query(`SELECT fsd.user_id,u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
      const [extraRows] = await db.query('SELECT * FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC', [step.id]);
      step.extraRows = extraRows;
      try { step.show_cols_parsed = JSON.parse(step.show_cols || '[]'); } catch(e) { step.show_cols_parsed = []; }
    }
    res.json({ sheet: sheets[0], steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, totalSteps, steps } = req.body;
    const [result] = await conn.query(
      `INSERT INTO fms_sheets (fms_name,sheet_name,sheet_id,header_row,total_steps,created_by) VALUES (?,?,?,?,?,?)`,
      [fmsName||sheetName, sheetName, sheetId, headerRow||1, totalSteps||1, req.session.userId]
    );
    const fmsId = result.insertId;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const [sr] = await conn.query(
        `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [fmsId,i+1,s.stepName,s.planCol||'',s.actualCol||'',s.extraInput||'no',s.extraCol||'',JSON.stringify(s.showCols||[]),s.delayReasonCol||'',s.doerNameCol||'']
      );
      const stepId = sr.insertId;
      if (s.doers?.length) for (const uid of s.doers) await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES (?,?)', [stepId, uid]);
      if (s.extraInput==='yes' && s.extraRows?.length) for (const row of s.extraRows) await conn.query('INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options) VALUES (?,?,?,?,?)', [stepId, row.label||row.col_letter||'', row.col_letter||'', row.field_type||'text', row.dropdown_options||'']);
    }
    await conn.commit();
    res.json({ success: true, id: fmsId });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); } finally { conn.release(); }
});

app.put('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, steps } = req.body;
    await conn.query(`UPDATE fms_sheets SET fms_name=?,sheet_name=?,sheet_id=?,header_row=?,total_steps=? WHERE id=?`, [fmsName||sheetName, sheetName, sheetId, headerRow||1, steps.length, req.params.id]);
    const [oldSteps] = await conn.query('SELECT id FROM fms_steps WHERE fms_id=?', [req.params.id]);
    for (const os of oldSteps) {
      await conn.query('DELETE FROM fms_step_doers WHERE step_id=?', [os.id]);
      await conn.query('DELETE FROM fms_extra_rows WHERE step_id=?', [os.id]);
    }
    await conn.query('DELETE FROM fms_steps WHERE fms_id=?', [req.params.id]);
    for (let i=0; i<steps.length; i++) {
      const s = steps[i];
      const [sr] = await conn.query(
        `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id,i+1,s.stepName,s.planCol||'',s.actualCol||'',s.extraInput||'no',s.extraCol||'',JSON.stringify(s.showCols||[]),s.delayReasonCol||'',s.doerNameCol||'']
      );
      const stepId = sr.insertId;
      if (s.doers?.length) for (const uid of s.doers) await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES (?,?)', [stepId, uid]);
      if (s.extraInput==='yes' && s.extraRows?.length) for (const row of s.extraRows) await conn.query('INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options) VALUES (?,?,?,?,?)', [stepId, row.label||row.col_letter||'', row.col_letter||'', row.field_type||'text', row.dropdown_options||'']);
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); } finally { conn.release(); }
});

app.delete('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM fms_sheets WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fetch headers ONLY (fast — just one row from sheet) ──
app.post('/api/fms/fetch-headers', requireAuth, async (req, res) => {
  try {
    const { sheetId, sheetName, headerRow } = req.body;
    if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheetId);
    const hRow = parseInt(headerRow) || 1;
    // Fetch ONLY the header row — very fast even for 10000-row sheets
    const range = sheetName ? `${sheetName}!${hRow}:${hRow}` : `${hRow}:${hRow}`;
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId, range,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rawHeaders = (response.data.values || [[]])[0] || [];
    const headers = rawHeaders
      .map((h, i) => ({
        name: String(h ?? '').trim() || `COL_${idxToCol(i)}`,
        col: idxToCol(i),
        index: i
      }))
      .filter(h => String(h.name).trim().length > 0);
    res.json({ headers });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Share sheet with service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check Sheet ID.' });
    res.status(500).json({ error: err.message });
  }
});

// ── Sync data (full) — FIX: now uses sheet.sheet_name as tab name ──
app.get('/api/fms/:id/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const headerRowIdx = (sheet.header_row || 1) - 1;
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    // ✅ FIXED: use sheet.sheet_name (actual tab name) instead of hardcoded 'Sheet1'
    const tabName = sheet.sheet_name || 'Sheet1';
    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: tabName });
    const allRows = response.data.values || [];
    if (allRows.length <= headerRowIdx) {
      return res.status(400).json({ error: `Sheet has only ${allRows.length} rows but header row is set to ${sheet.header_row}` });
    }
    const headers = allRows[headerRowIdx].filter(h => h && h.trim());
    const dataRows = allRows.slice(headerRowIdx + 1);
    // Return ALL data rows
    res.json({ success: true, headers, totalRows: dataRows.length, headerRow: sheet.header_row, sample: dataRows });
  } catch (err) {
    if (err.message?.includes('ENOENT') || err.message?.includes('credentials')) return res.status(500).json({ error: 'credentials.json not found.' });
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Share sheet with service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check Sheet ID.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// FMS TASKS APIs (all users)
// ══════════════════════════════════════════════════════

// List FMS visible to user
app.get('/api/fms-tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    let list;
    if (isAdmin) {
      [list] = await db.query('SELECT * FROM fms_sheets ORDER BY created_at DESC');
    } else {
      [list] = await db.query(`SELECT DISTINCT fs.* FROM fms_sheets fs JOIN fms_steps fst ON fst.fms_id=fs.id JOIN fms_step_doers fsd ON fsd.step_id=fst.id WHERE fsd.user_id=? ORDER BY fs.created_at DESC`, [uid]);
    }
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get FMS steps for tasks view
app.get('/api/fms-tasks/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [req.params.id]);
    for (const step of steps) {
      const [doers] = await db.query(`SELECT fsd.user_id,u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
      step.isMyStep = isAdmin || doers.some(d => d.user_id === uid);
      try { step.show_cols_parsed = JSON.parse(step.show_cols||'[]'); } catch(e) { step.show_cols_parsed = []; }
      const [extraRows] = await db.query('SELECT * FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC', [step.id]);
      step.extraRows = extraRows;
    }
    res.json({ sheet: sheets[0], steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get pending rows for a step (plan filled, actual empty)
app.get('/api/fms-tasks/:fmsId/steps/:stepId/rows', requireAuth, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]);
    if (!steps[0]) return res.status(404).json({ error: 'Step not found' });
    const step = steps[0];

    const planIdx = colToIdx(step.plan_col);
    const actualIdx = colToIdx(step.actual_col);
    let showCols = [];
    try { showCols = JSON.parse(step.show_cols||'[]'); } catch(e) {}

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    const tabName = sheet.sheet_name || 'Sheet1';

    // Optimized: fetch only up to the furthest needed column
    const maxIdx = Math.max(planIdx, actualIdx, ...(showCols.length ? showCols : [0]));
    const lastCol = maxIdx >= 0 ? idxToCol(maxIdx) : 'Z';
    const range = `${tabName}!A:${lastCol}`;

    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
    const allRows = response.data.values || [];
    const headerRowIdx = (sheet.header_row || 1) - 1;
    const headers = allRows[headerRowIdx] || [];
    const dataRows = allRows.slice(headerRowIdx + 1);

    const matchedRows = [];
    dataRows.forEach((row, i) => {
      const planVal = planIdx >= 0 ? (row[planIdx]||'').trim() : '';
      const actualVal = actualIdx >= 0 ? (row[actualIdx]||'').trim() : '';
      if (planVal && !actualVal) {
        const rowData = {};
        let colsToShow = showCols.length ? showCols : headers.map((_,hi) => hi);
        // Always show the plan column — mandatory
        if (planIdx >= 0 && !colsToShow.includes(planIdx)) colsToShow = [planIdx, ...colsToShow];
        colsToShow.forEach(ci => {
          const h = headers[ci] || `COL ${idxToCol(ci)}`;
          rowData[h] = row[ci] || '';
        });
        matchedRows.push({
          sheetRowNumber: headerRowIdx + 1 + i + 1,
          planValue: planVal,
          actualValue: actualVal,
          data: rowData
        });
      }
    });

    res.json({ rows: matchedRows, headers, total: matchedRows.length });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

// Mark row as done — writes actual (date only) + delay reason to sheet
app.post('/api/fms-tasks/:fmsId/steps/:stepId/done', requireAuth, async (req, res) => {
  try {
    const { rowNumber, actualValue, delayReason, extraInputs } = req.body;
    if (!rowNumber || !actualValue) return res.status(400).json({ error: 'rowNumber and actualValue required' });
    // Save full timestamp (date + time) — explicitly requested by user
    const dateOnlyValue = actualValue;

    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]);
    if (!steps[0]) return res.status(404).json({ error: 'Step not found' });
    const step = steps[0];

    const actualCol = (step.actual_col||'').toUpperCase();
    if (!actualCol) return res.status(400).json({ error: 'Actual column not configured for this step' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    const tabName = sheet.sheet_name || 'Sheet1';

    // ── BATCH WRITE: write all columns in one API call ──
    // Fetch doer name first (DB call) so the sheet write is a single call
    let doerName = '';
    if (step.doer_name_col) {
      const [userRows] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [req.session.userId]);
      doerName = userRows[0]?.name || '';
    }

    // Build all ranges
    const batchData = [];

    // 1. Actual date column (mandatory)
    batchData.push({ range: `${tabName}!${actualCol}${rowNumber}`, values: [[dateOnlyValue]] });

    // 2. Delay reason column (optional)
    if (delayReason && step.delay_reason_col) {
      batchData.push({ range: `${tabName}!${step.delay_reason_col.toUpperCase()}${rowNumber}`, values: [[delayReason]] });
    }

    // 3. Extra input columns (optional)
    if (extraInputs && extraInputs.length) {
      for (const ei of extraInputs) {
        if (ei.colLetter && ei.value !== undefined && ei.value !== '') {
          batchData.push({ range: `${tabName}!${ei.colLetter.toUpperCase()}${rowNumber}`, values: [[ei.value]] });
        }
      }
    }

    // 4. Doer name column (optional)
    if (doerName && step.doer_name_col) {
      batchData.push({ range: `${tabName}!${step.doer_name_col.toUpperCase()}${rowNumber}`, values: [[doerName]] });
    }

    // Single batchUpdate API call — replaces N sequential calls
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: batchData
      }
    });

    res.json({ success: true });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Sheet write permission needed.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// TASK TRANSFERS
// ══════════════════════════════════════════════════════

// POST — Create transfer request (user/hod/admin)
app.post('/api/transfers', requireAuth, async (req, res) => {
  try {
    const { tasks, toUserId } = req.body;
    // tasks = [{taskId, taskType}]
    if (!tasks || !tasks.length || !toUserId)
      return res.status(400).json({ error: 'Tasks and target user required' });

    const uid = req.session.userId;
    const role = req.session.role;

    // Validate each task — user can only transfer their own, HOD dept, admin any
    for (const t of tasks) {
      const table = getTable(t.taskType);
      const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [t.taskId]);
      if (!rows[0]) return res.status(404).json({ error: `Task ${t.taskId} not found` });
      const task = rows[0];

      if (role === 'user' && task.assigned_to !== uid)
        return res.status(403).json({ error: 'You can only transfer your own tasks' });

      if (role === 'hod') {
        const [taskUser] = await db.query('SELECT department FROM users WHERE id=?', [task.assigned_to]);
        const [hodUser] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
        if (taskUser[0]?.department !== hodUser[0]?.department)
          return res.status(403).json({ error: 'HOD can only transfer tasks of their department' });
      }
    }

    // Insert transfer requests — skip if already pending
    let inserted = 0, skipped = 0;
    for (const t of tasks) {
      const table = getTable(t.taskType);
      const [rows] = await db.query(`SELECT assigned_to FROM ${table} WHERE id=?`, [t.taskId]);
      const fromUser = rows[0].assigned_to;
      const [existing] = await db.query(
        `SELECT id FROM task_transfers WHERE task_id=? AND task_type=? AND status='pending'`,
        [t.taskId, t.taskType]
      );
      if (existing[0]) { skipped++; continue; }
      await db.query(
        `INSERT INTO task_transfers (task_id, task_type, from_user, to_user, requested_by, status) VALUES (?,?,?,?,?,'pending')`,
        [t.taskId, t.taskType, fromUser, toUserId, uid]
      );
      inserted++;
    }

    res.json({ success: true, count: inserted, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Task IDs that already have a pending transfer (for current user's tasks)
app.get('/api/transfers/pending-tasks', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT task_id, task_type FROM task_transfers WHERE status='pending' AND requested_by=?`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Pending transfers for approval (admin sees all, HOD sees dept)
app.get('/api/transfers', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    let deptFilter = '';
    let params = [];

    if (role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      // HOD sees transfers of users in their department
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (!deptUsers.length) return res.json([]);
      const ids = deptUsers.map(u=>u.id);
      deptFilter = `AND (tt.from_user IN (${ids.map(()=>'?').join(',')}) OR tt.to_user IN (${ids.map(()=>'?').join(',')}))`;
      params = [...ids, ...ids];
    }

    const [allUT] = await db.query('SELECT id,name,department FROM users');
    const uMapT = {};
    allUT.forEach(u => { uMapT[u.id] = u; });

    const [rawTr] = await db.query(`SELECT tt.* FROM task_transfers tt WHERE tt.status = 'pending' ${deptFilter} ORDER BY tt.created_at DESC`, params);
    const rows = rawTr.map(tt => ({
      ...tt,
      fromUserName: uMapT[tt.from_user]?.name || '',
      toUserName: uMapT[tt.to_user]?.name || '',
      requestedByName: uMapT[tt.requested_by]?.name || '',
      fromDept: uMapT[tt.from_user]?.department || ''
    }));

    // Attach task description
    for (const r of rows) {
      const table = getTable(r.task_type);
      const [t] = await db.query(`SELECT description, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM ${table} WHERE id=?`, [r.task_id]);
      r.description = t[0]?.description || '—';
      r.due_date = t[0]?.due_date || '—';
    }

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Transfer count for badge
app.get('/api/transfers/count', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    let count = 0;
    if (role === 'admin') {
      const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending'`);
      count = r[0].c;
    } else {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (deptUsers.length) {
        const ids = deptUsers.map(u=>u.id);
        const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending' AND (from_user IN (${ids.map(()=>'?').join(',')}) OR to_user IN (${ids.map(()=>'?').join(',')}))`, [...ids,...ids]);
        count = r[0].c;
      }
    }
    res.json({ count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT — Approve or reject transfer
app.put('/api/transfers/:id', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { action, note } = req.body; // action: 'approved' | 'rejected'
    const [rows] = await db.query('SELECT * FROM task_transfers WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Transfer not found' });
    const tr = rows[0];

    await db.query('UPDATE task_transfers SET status=?, note=? WHERE id=?', [action, note||'', req.params.id]);

    if (action === 'approved') {
      const table = getTable(tr.task_type);
      await db.query(`UPDATE ${table} SET assigned_to=? WHERE id=?`, [tr.to_user, tr.task_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — My sent transfer requests (for users to track)
app.get('/api/transfers/my', requireAuth, async (req, res) => {
  try {
    const [allUMy] = await db.query('SELECT id,name FROM users');
    const uMapMy = {};
    allUMy.forEach(u => { uMapMy[u.id] = u.name; });

    const [rawMy] = await db.query(`SELECT tt.* FROM task_transfers tt WHERE tt.requested_by=? ORDER BY tt.created_at DESC LIMIT 20`, [req.session.userId]);
    const rows = rawMy.map(tt => ({ ...tt, fromUserName: uMapMy[tt.from_user]||'', toUserName: uMapMy[tt.to_user]||'' }));
    for (const r of rows) {
      const table = getTable(r.task_type);
      const [t] = await db.query(`SELECT description FROM ${table} WHERE id=?`, [r.task_id]);
      r.description = t[0]?.description || '—';
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// WEEK PLAN
// ══════════════════════════════════════════════════════
app.post('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
    if (!employeeId || !startDate) {
      return res.json({ error: 'employeeId and startDate required' });
    }
    const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
    const tCount = (targetCount !== undefined && targetCount !== null && targetCount !== '') ? parseInt(targetCount) : 0;
    const finalHodId = hodId || req.session.userId;
    // Upsert: insert or update if same employee+startDate exists.
    // IMPORTANT: created_at is only set on insert (DEFAULT CURRENT_TIMESTAMP); preserved on update.
    // updated_at is auto-updated by the schema (ON UPDATE CURRENT_TIMESTAMP).
    const [result] = await db.execute(
      `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct)`,
      [employeeId, finalHodId, startDate, tCount, impPct]
    );
    // affectedRows: 1 = inserted, 2 = updated existing row
    const action = result.affectedRows === 1 ? 'INSERTED' : 'UPDATED';
    console.log(`  📅 Week Plan ${action}: employee=${employeeId}, week=${startDate}, improvement_pct=${impPct}, by_hod=${finalHodId}`);
    res.json({ success: true, action: action.toLowerCase() });
  } catch (e) {
    // If table doesn't exist (shouldn't happen post-migration, but safety net), create it + retry
    if (e.code === 'ER_NO_SUCH_TABLE') {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS week_plans (
          id INT AUTO_INCREMENT PRIMARY KEY,
          employee_id INT NOT NULL,
          hod_id INT NOT NULL,
          start_date DATE NOT NULL,
          target_count INT DEFAULT 0,
          improvement_pct INT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_emp_week (employee_id, start_date),
          INDEX idx_start_date (start_date),
          INDEX idx_employee (employee_id)
        )
      `);
      const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
      const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
      const tCount = (targetCount !== undefined && targetCount !== null && targetCount !== '') ? parseInt(targetCount) : 0;
      await db.execute(
        `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct)`,
        [employeeId, hodId || req.session.userId, startDate, tCount, impPct]
      );
      console.log(`  📅 Week Plan saved (after table create): employee=${employeeId}, week=${startDate}`);
      return res.json({ success: true });
    }
    // If improvement_pct column missing (old table), add it then retry
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        await db.execute(`ALTER TABLE week_plans ADD COLUMN improvement_pct INT DEFAULT NULL`);
      } catch(ae) { /* already exists */ }
      try {
        await db.execute(`ALTER TABLE week_plans ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at`);
      } catch(ae) { /* already exists */ }
      const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
      const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
      const tCount = (targetCount !== undefined && targetCount !== null && targetCount !== '') ? parseInt(targetCount) : 0;
      await db.execute(
        `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct)`,
        [employeeId, hodId || req.session.userId, startDate, tCount, impPct]
      );
      console.log(`  📅 Week Plan saved (after column add): employee=${employeeId}, week=${startDate}`);
      return res.json({ success: true });
    }
    console.error('  ❌ Week Plan save failed:', e);
    res.json({ error: 'Failed to save plan' });
  }
});

// GET week-plan list — supports filters for Reports tab (next update)
// Query params (all optional):
//   ?employeeId=123      → history for a specific employee
//   ?from=YYYY-MM-DD     → start_date >= from
//   ?to=YYYY-MM-DD       → start_date <= to
//   ?limit=N             → default 500 (sufficient for Reports tab; pagination future)
app.get('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { employeeId, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const where = [];
    const params = [];
    if (employeeId) { where.push('wp.employee_id = ?'); params.push(parseInt(employeeId)); }
    if (from) { where.push('wp.start_date >= ?'); params.push(from); }
    if (to)   { where.push('wp.start_date <= ?'); params.push(to); }
    // HOD should only see users in their department (admin sees all)
    // Department is not in the JWT, so it must be fetched fresh from the DB
    if (req.session.role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      where.push('u.department = ?');
      params.push((me[0] && me[0].department) || '');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [allUW] = await db.query('SELECT id,name,department FROM users');
    const uMapW = {};
    allUW.forEach(u => { uMapW[u.id] = u; });

    const [rawWP] = await db.execute(
      `SELECT wp.id, wp.employee_id, wp.hod_id,
              DATE_FORMAT(wp.start_date,'%Y-%m-%d') AS start_date,
              wp.target_count, wp.improvement_pct,
              wp.created_at, wp.updated_at
       FROM week_plans wp
       ${whereSql}
       ORDER BY wp.start_date DESC, wp.employee_id ASC
       LIMIT ${limit}`,
      params
    );
    const rows = rawWP.map(wp => ({
      ...wp,
      employee_name: uMapW[wp.employee_id]?.name || '',
      employee_department: uMapW[wp.employee_id]?.department || '',
      hod_name: uMapW[wp.hod_id]?.name || ''
    }));
    res.json(rows);
  } catch (e) {
    console.error('  ❌ Week Plan fetch failed:', e.message);
    res.json([]);
  }
});

// GET history endpoint — dedicated for Reports tab:
//   /api/week-plan/history/:employeeId
// Returns all weeks (newest first) for a single employee, with HOD name and timestamps.
app.get('/api/week-plan/history/:employeeId', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const empId = parseInt(req.params.employeeId);
    if (!empId) return res.json({ error: 'Invalid employeeId' });
    // HOD can only view history for users in their own department
    if (req.session.role === 'hod') {
      const [me]  = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      const [chk] = await db.execute('SELECT department FROM users WHERE id=?', [empId]);
      const myDept = (me[0] && me[0].department) || '';
      if (!chk.length || chk[0].department !== myDept) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }
    const [allUH] = await db.query('SELECT id,name FROM users');
    const uMapH = {};
    allUH.forEach(u => { uMapH[u.id] = u.name; });

    const [rawHist] = await db.execute(
      `SELECT wp.id,
              DATE_FORMAT(wp.start_date,'%Y-%m-%d') AS start_date,
              wp.target_count, wp.improvement_pct,
              wp.created_at, wp.updated_at,
              wp.hod_id
       FROM week_plans wp
       WHERE wp.employee_id = ?
       ORDER BY wp.start_date DESC`,
      [empId]
    );
    const rows = rawHist.map(wp => ({ ...wp, hod_name: uMapH[wp.hod_id]||'' }));
    const [emp] = await db.execute('SELECT id, name, department FROM users WHERE id=?', [empId]);
    res.json({
      employee: emp[0] || null,
      plans: rows,
      total: rows.length
    });
  } catch (e) {
    console.error('  ❌ Week Plan history fetch failed:', e.message);
    res.json({ error: 'Failed to fetch history', plans: [] });
  }
});

// ══════════════════════════════════════════════════════
// DEBUG ENDPOINT (remove after fixing)
// ══════════════════════════════════════════════════════
app.get('/api/debug', async (req, res) => {
  const result = { time: new Date().toISOString(), env: {}, db: {}, tables: {} };
  result.env = {
    NODE_ENV: process.env.NODE_ENV || '(not set)',
    DB_HOST: process.env.DB_HOST || 'localhost (default)',
    DB_USER: process.env.DB_USER || 'root (default)',
    DB_NAME: process.env.DB_NAME || 'task_manager (default)',
    PORT: process.env.PORT || '3000 (default)',
  };
  try {
    await db.query('SELECT 1');
    result.db.connected = true;
    const counts = ['users','delegation_tasks','checklist_tasks','fms_sheets'];
    for (const t of counts) {
      try {
        const [[row]] = await db.query(`SELECT COUNT(*) AS c FROM ${t}`);
        result.tables[t] = row.c;
      } catch(e) { result.tables[t] = 'ERROR: ' + e.message; }
    }
    // Show users with their roles and departments
    try {
      const [users] = await db.query('SELECT id, name, role, department FROM users ORDER BY role, name');
      result.users = users;
    } catch(e) { result.users = 'ERROR: ' + e.message; }
  } catch(e) {
    result.db.connected = false;
    result.db.error = e.message;
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════
// MIS REPORT IMPORT → GOOGLE SHEET
// ══════════════════════════════════════════════════════
const STOCK_SHEET_ID = process.env.STOCK_SHEET_ID || '1UrIu9HeNabJ1XUqdyivZadTm6e8NH4ogVPdK_IqWv-s';
const XLSX = require('xlsx');
const multer = require('multer');
const misUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Report type config: tab name + header row detect keywords (lowercase)
const REPORT_CONFIG = {
  stock: { tab: 'In Stock', keywords: ['supplier name', 'cost price', 'ops qty'] },
  sales: { tab: 'Out Stock', keywords: ['xn date', 'xn no', 'sls qty'] },
  bills: { tab: 'Bills', keywords: ['pur invdate', 'pur qty', 'pur costvalue'] }
};

// Scan first 25 rows — the row containing all keywords is the header
function findHeaderRowIndex(rows, keywords) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const text = rows[i].join('|').toLowerCase();
    if (keywords.every(kw => text.includes(kw))) return i;
  }
  return -1;
}

// Exponential backoff retry on quota errors
async function withRetry(fn, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (err) {
      const isQuota = err.code === 429 || (err.message && err.message.toLowerCase().includes('quota'));
      if (!isQuota || i === retries) throw err;
      const wait = (Math.pow(2, i) * 1000) + Math.floor(Math.random() * 500);
      console.log('Quota limit — retry', i + 1, 'in', wait + 'ms');
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// Ensure tab exists, creating it if needed — returns { sheetId, isNew }
async function ensureTab(sheetsApi, spreadsheetId, tabName) {
  const meta = await withRetry(() => sheetsApi.spreadsheets.get({ spreadsheetId }));
  const found = meta.data.sheets.find(s => s.properties.title === tabName);
  if (found) return { sheetId: found.properties.sheetId, isNew: false };
  const r = await withRetry(() => sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
  }));
  return { sheetId: r.data.replies[0].addSheet.properties.sheetId, isNew: true };
}

// Header row ko dark blue + white bold text
async function colorHeaderRow(sheetsApi, spreadsheetId, sheetId, rowIndex0) {
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: rowIndex0, endRowIndex: rowIndex0 + 1, startColumnIndex: 0, endColumnIndex: 50 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.071, green: 0.216, blue: 0.376 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 }
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      }]
    }
  });
}

// IMS Stats — row count + last upload date for each tab
app.get('/api/ims-stats', requireAuth, async (req, res) => {
  try {
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const tabs = [
      { key: 'stock', tab: 'In Stock' },
      { key: 'sales', tab: 'Out Stock' }
    ];
    const out = {};
    for (const { key, tab } of tabs) {
      try {
        // Single-quote tab names with spaces — required by Sheets API A1 notation
        const quotedTab = "'" + tab.replace(/'/g, "''") + "'";
        const colAResp = await withRetry(() => sheetsApi.spreadsheets.values.get({
          spreadsheetId: STOCK_SHEET_ID,
          range: quotedTab + '!A:A'
        }));
        const colA = colAResp.data.values || [];
        const totalRows = Math.max(0, colA.length - 1); // minus header row
        console.log('[IMS Stats]', tab, '→ colA rows:', colA.length, '→ totalRows:', totalRows);

        let lastUpload = null;
        if (totalRows > 0) {
          const headerResp = await withRetry(() => sheetsApi.spreadsheets.values.get({
            spreadsheetId: STOCK_SHEET_ID,
            range: quotedTab + '!1:1'
          }));
          const header = ((headerResp.data.values || [[]])[0] || []).map(h => String(h).trim().toLowerCase());
          const uploadColIdx = header.indexOf('upload date');
          if (uploadColIdx >= 0) {
            const colLetter = idxToCol(uploadColIdx);
            const cellResp = await withRetry(() => sheetsApi.spreadsheets.values.get({
              spreadsheetId: STOCK_SHEET_ID,
              range: quotedTab + '!' + colLetter + (totalRows + 1)
            }));
            lastUpload = ((cellResp.data.values || [[]])[0] || [])[0] || null;
          }
        }
        out[key] = { totalRows, lastUpload };
      } catch(e) {
        console.error('[IMS Stats] tab error:', tab, e.message);
        out[key] = { totalRows: null, lastUpload: null }; // null = error, don't overwrite cache
      }
    }
    res.json(out);
  } catch (err) {
    console.error('[IMS Stats] fatal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// IMS raw sheet cache — avoids re-fetching on every date change
const _imsRawCache = { outRows: null, inRows: null, ts: 0 };
const IMS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// IMS Reports — all 8 report types from Out Stock + In Stock tabs
app.get('/api/ims-reports', requireAuth, async (req, res) => {
  try {
    const { from, to, sync } = req.query;
    const now = Date.now();
    const needsFresh = sync === 'true' || !_imsRawCache.outRows || (now - _imsRawCache.ts) > IMS_CACHE_TTL_MS;

    let outRows, inRows;
    if (needsFresh) {
      const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
      const safeGet = (range) => withRetry(() => sheetsApi.spreadsheets.values.get({ spreadsheetId: STOCK_SHEET_ID, range })).catch(() => ({ data: { values: [] } }));
      const [outResp, inResp] = await Promise.all([
        safeGet("'Out Stock'!A:AH"),
        safeGet("'In Stock'!A:AH")
      ]);
      outRows = outResp.data.values || [];
      inRows  = inResp.data.values  || [];
      _imsRawCache.outRows = outRows;
      _imsRawCache.inRows  = inRows;
      _imsRawCache.ts      = now;
    } else {
      outRows = _imsRawCache.outRows;
      inRows  = _imsRawCache.inRows;
    }

    const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    function parseSheetDate(str) {
      const m = String(str||'').trim().match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{4})$/);
      // Use UTC to match fromDate/toDate which are also UTC (new Date('YYYY-MM-DD'))
      if (m) return new Date(Date.UTC(parseInt(m[3]), MONTHS[m[2].toLowerCase()]??0, parseInt(m[1])));
      const d = new Date(str); return isNaN(d.getTime()) ? null : d;
    }
    function getNum(row, idx) {
      if (idx < 0 || row[idx] == null || row[idx] === '') return 0;
      return parseFloat(String(row[idx]).replace(/[^\d.-]/g,'')) || 0;
    }
    function findC(hdr, regex) { return hdr.findIndex(h => regex.test(h)); }
    function r2(n) { return Math.round(n * 100) / 100; }

    const fromDate = from ? new Date(from) : null;
    const toDate   = to   ? (() => { const d = new Date(to); d.setUTCHours(23,59,59,999); return d; })() : null;

    // ── OUT STOCK ────────────────────────────────────────────
    const outHeader = outRows.length ? outRows[0].map(h => String(h).trim().toLowerCase()) : [];

    const oXnDate    = findC(outHeader, /^xn[\s._-]?date$/i);
    const oXnNo      = findC(outHeader, /^xn[\s._-]?no$/i);
    const oCategory  = findC(outHeader, /^category$/i);
    const oSP        = findC(outHeader, /^salesperson$/i);
    const oNetQty    = findC(outHeader, /netsls[\s._-]?qty/i);
    const oNetAmt    = findC(outHeader, /netsls[\s._-]?net|netsls[\s._-]?amount/i);
    const oSupplier  = findC(outHeader, /^supplier[\s._-]?name$/i);
    const oCity      = findC(outHeader, /^supplier[\s._-]?city$/i);
    const oState     = findC(outHeader, /^supplier[\s._-]?state$/i);
    const oSKU       = findC(outHeader, /sku[\s._-]?code|^sku$|item[\s._-]?code|product[\s._-]?code|article[\s._-]?no|articleno|^itemid$|item[\s._-]?id/i);
    const oStyle     = findC(outHeader, /^style$/i);

    console.log('[IMS Reports] Out Stock cols:', { oXnDate, oXnNo, oCategory, oSP, oNetQty, oNetAmt, oSupplier, oCity, oState, oSKU });

    const byDate={}, byCat={}, bySP={}, bySupplier={}, byCityState={}, bySKU={}, bySupStyleSales={}, byStyleSales={};
    let totalAmt=0, totalQty=0;
    const allXns = new Set();

    (outRows.slice(1)).forEach(row => {
      const dateStr = (row[oXnDate]||'').trim();
      if (!dateStr) return;
      if (fromDate || toDate) {
        const d = parseSheetDate(dateStr);
        if (!d || (fromDate && d < fromDate) || (toDate && d > toDate)) return;
      }
      const amt  = getNum(row, oNetAmt);
      const qty  = getNum(row, oNetQty);
      const cat  = (row[oCategory]||'').trim() || 'Unknown';
      const sp   = (row[oSP]||'').trim() || 'Unknown';
      const sup  = (row[oSupplier]||'').trim() || 'Unknown';
      const sty  = oStyle >= 0 ? ((row[oStyle]||'').trim() || 'Unknown') : 'Unknown';
      const city = (row[oCity]||'').trim() || '—';
      const state= (row[oState]||'').trim() || '—';
      const xnNo = (row[oXnNo]||'').trim();
      const sku  = oSKU >= 0 ? ((row[oSKU]||'').trim() || 'Unknown') : null;
      const csKey= city + '||' + state;
      const ssKey= sup + '||' + sty;
      if (!bySupStyleSales[ssKey]) bySupStyleSales[ssKey] = { supName: sup, style: sty, cat, qty: 0 };
      bySupStyleSales[ssKey].qty += qty;
      if (!byStyleSales[sty]) byStyleSales[sty] = { qty: 0 };
      byStyleSales[sty].qty += qty;

      totalAmt += amt; totalQty += qty;
      if (xnNo) allXns.add(xnNo);

      const push = (map, key) => {
        if (!map[key]) map[key] = { amt:0, qty:0, xns:new Set() };
        map[key].amt += amt; map[key].qty += qty;
        if (xnNo) map[key].xns.add(xnNo);
      };
      push(byDate, dateStr);
      push(byCat, cat);
      push(bySP, sp);
      push(bySupplier, sup);
      if (sku !== null) push(bySKU, sku);
      if (!byCityState[csKey]) byCityState[csKey] = { city, state, amt:0, qty:0, xns:new Set() };
      byCityState[csKey].amt += amt; byCityState[csKey].qty += qty;
      if (xnNo) byCityState[csKey].xns.add(xnNo);
    });

    const sortAmt = arr => arr.sort((a,b) => b.amount - a.amount);
    const ser = (map, keyField='name') => sortAmt(Object.entries(map).map(([k,d]) => ({
      [keyField]: k, transactions: d.xns.size, qty: r2(d.qty), amount: Math.round(d.amt)
    })));

    const fmtByDate = Object.entries(byDate)
      .map(([date,d]) => ({ date, transactions:d.xns.size, qty:r2(d.qty), amount:Math.round(d.amt) }))
      .sort((a,b) => { const da=parseSheetDate(a.date),db=parseSheetDate(b.date); return (da||0)-(db||0); });

    const cityStateSales = sortAmt(Object.values(byCityState).map(d => ({
      city: d.city, state: d.state, transactions: d.xns.size, qty: r2(d.qty), amount: Math.round(d.amt)
    })));

    // ── IN STOCK ─────────────────────────────────────────────
    const inHeader = inRows.length ? inRows[0].map(h => String(h).trim().toLowerCase()) : [];

    const iSupplier = findC(inHeader, /^supplier[\s._-]?name$/i);
    const iCostPrice= findC(inHeader, /^cost[\s._-]?price$/i);
    const iOpsQty   = findC(inHeader, /^ops[\s._-]?qty$/i);
    const iCategory = findC(inHeader, /^category$/i);
    const iDept     = findC(inHeader, /^department$/i);
    const iStyle    = findC(inHeader, /^style$/i);

    console.log('[IMS Reports] In Stock cols:', { iSupplier, iCostPrice, iOpsQty, iCategory, iDept, iStyle });

    const bySupStock={}, byCatStock={}, bySupStyleStock={}, byStyleStock={};
    let totalStockQty=0, totalStockValue=0;

    (inRows.slice(1)).forEach(row => {
      if (!row.length || !row.join('').trim()) return;
      const sup  = (row[iSupplier]||'').trim() || 'Unknown';
      const cat  = (row[iCategory]||'').trim() || 'Unknown';
      const sty  = iStyle >= 0 ? ((row[iStyle]||'').trim() || 'Unknown') : 'Unknown';
      const ssKey= sup + '||' + sty;
      if (!bySupStyleStock[ssKey]) bySupStyleStock[ssKey] = { supName: sup, style: sty, cat, qty: 0 };
      bySupStyleStock[ssKey].qty += getNum(row, iOpsQty);
      if (!byStyleStock[sty]) byStyleStock[sty] = { qty: 0 };
      byStyleStock[sty].qty += getNum(row, iOpsQty);
      const cost = getNum(row, iCostPrice);
      const qty  = getNum(row, iOpsQty);
      const val  = qty * cost;
      totalStockQty += qty; totalStockValue += val;
      if (!bySupStock[sup]) bySupStock[sup] = { qty:0, value:0 };
      bySupStock[sup].qty += qty; bySupStock[sup].value += val;
      if (!byCatStock[cat]) byCatStock[cat] = { qty:0, value:0 };
      byCatStock[cat].qty += qty; byCatStock[cat].value += val;
    });

    const sortVal = arr => arr.sort((a,b) => b.value - a.value);
    const supplierStock = sortVal(Object.entries(bySupStock).map(([name,d]) => ({ name, qty:r2(d.qty), value:Math.round(d.value) })));
    const categoryStock = sortVal(Object.entries(byCatStock).map(([category,d]) => ({ category, qty:r2(d.qty), value:Math.round(d.value) })));

    const skuSales = sortAmt(Object.entries(bySKU).map(([sku,d]) => ({ sku, transactions:d.xns.size, qty:r2(d.qty), amount:Math.round(d.amt) })));

    // ── SP Analytics: current period + Last Year same period ──────────────────
    // LY comparison is only meaningful when a date filter is applied
    const hasDateFilter = !!(fromDate || toDate);
    const lyFrom = (hasDateFilter && fromDate) ? new Date(fromDate.getFullYear()-1, fromDate.getMonth(), fromDate.getDate()) : null;
    const lyTo   = (hasDateFilter && toDate)   ? (() => { const d=new Date(toDate); d.setFullYear(d.getFullYear()-1); return d; })() : null;
    const bySPcur={}, bySPly={}, byMoncur={}, byMonLY={};
    let lyTotQty=0, lyTotAmt=0;
    const lyXns = new Set();
    const MON_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    outRows.slice(1).forEach(row => {
      const dateStr = (row[oXnDate]||'').trim();
      if (!dateStr) return;
      const d = parseSheetDate(dateStr);
      if (!d) return;
      const isCur = (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
      const isLY  = hasDateFilter && (!lyFrom || d >= lyFrom) && (!lyTo || d <= lyTo);
      if (!isCur && !isLY) return;
      const qty  = getNum(row, oNetQty);
      const amt  = getNum(row, oNetAmt);
      const sp   = (row[oSP]||'').trim() || 'Unknown';
      const xnNo = (row[oXnNo]||'').trim();
      const monKey   = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const monLabel = `${MON_ABBR[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
      const pushSP  = (map) => { if (!map[sp])     map[sp]     = {amt:0,qty:0,xns:new Set()}; map[sp].amt+=amt;     map[sp].qty+=qty;     if(xnNo) map[sp].xns.add(xnNo); };
      const pushMon = (map) => { if (!map[monKey]) map[monKey] = {label:monLabel,amt:0,qty:0,xns:new Set()}; map[monKey].amt+=amt; map[monKey].qty+=qty; if(xnNo) map[monKey].xns.add(xnNo); };
      if (isCur) { pushSP(bySPcur); pushMon(byMoncur); }
      if (isLY)  { pushSP(bySPly);  pushMon(byMonLY);  lyTotQty+=qty; lyTotAmt+=amt; if(xnNo) lyXns.add(xnNo); }
    });

    const curBillsTot = allXns.size, lyBillsTot = lyXns.size;
    const curUPT = curBillsTot ? r2(totalQty/curBillsTot) : 0;
    const lyUPT  = lyBillsTot  ? r2(lyTotQty/lyBillsTot)  : 0;
    const curATV = curBillsTot ? Math.round(totalAmt/curBillsTot) : 0;
    const lyATV  = lyBillsTot  ? Math.round(lyTotAmt/lyBillsTot)  : 0;
    const pct = (a,b) => b ? r2((a-b)/b*100) : null;

    const allSPKeys = new Set([...Object.keys(bySPcur), ...Object.keys(bySPly)]);
    const spTable = [...allSPKeys].map(sp => {
      const c = bySPcur[sp] || {amt:0,qty:0,xns:new Set()};
      const l = bySPly[sp]  || {amt:0,qty:0,xns:new Set()};
      const cB=c.xns.size, lB=l.xns.size;
      const cUPT=cB?r2(c.qty/cB):0, lUPT=lB?r2(l.qty/lB):0;
      const cATV=cB?Math.round(c.amt/cB):0, lATV=lB?Math.round(l.amt/lB):0;
      return { name:sp, bills:cB, qty:r2(c.qty), amount:Math.round(c.amt), upt:cUPT, atv:cATV,
               lyBills:lB, lyQty:r2(l.qty), lyAmount:Math.round(l.amt), lyUpt:lUPT, lyAtv:lATV,
               uptGrowth:pct(cUPT,lUPT), atvGrowth:pct(cATV,lATV), billsGrowth:pct(cB,lB) };
    }).sort((a,b) => b.amount-a.amount);

    // Monthly comparison: align by calendar month, not position
    // For each month in the current period range, look up the same calendar month -1 year in LY data
    let monthlyCmp = [];
    if (fromDate && toDate) {
      const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
      const end   = new Date(toDate.getFullYear(),   toDate.getMonth(),   1);
      for (let d = new Date(start); d <= end; d.setMonth(d.getMonth()+1)) {
        const curKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const lyKey  = `${d.getFullYear()-1}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const c = byMoncur[curKey] || null;
        const l = byMonLY[lyKey]   || null;
        monthlyCmp.push({
          month: `${MON_ABBR[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`,
          curAmt: c?Math.round(c.amt):0, curQty: c?r2(c.qty):0, curBills: c?c.xns.size:0,
          lyAmt:  l?Math.round(l.amt):0, lyQty:  l?r2(l.qty):0, lyBills:  l?l.xns.size:0,
        });
      }
    } else {
      // No date filter — show all available months side by side (no alignment guarantee)
      const allCurMons = Object.entries(byMoncur).sort(([a],[b])=>a.localeCompare(b));
      const allLYMons  = Object.entries(byMonLY).sort(([a],[b])=>a.localeCompare(b));
      const monLen = Math.max(allCurMons.length, allLYMons.length);
      monthlyCmp = Array.from({length:monLen}, (_,i) => {
        const [,c] = allCurMons[i]||[null,null];
        const [,l] = allLYMons[i] ||[null,null];
        return { month: c?c.label:l?l.label:`M${i+1}`,
                 curAmt:c?Math.round(c.amt):0, curQty:c?r2(c.qty):0, curBills:c?c.xns.size:0,
                 lyAmt: l?Math.round(l.amt):0, lyQty: l?r2(l.qty):0, lyBills: l?l.xns.size:0 };
      });
    }

    res.json({
      salesSummary: { totalAmount:Math.round(totalAmt), totalQty:r2(totalQty), totalTransactions:allXns.size, byDate:fmtByDate },
      topCategories: sortAmt(Object.entries(byCat).map(([cat,d]) => ({ category:cat, transactions:d.xns.size, qty:r2(d.qty), amount:Math.round(d.amt) }))).slice(0,15),
      supplierSales: ser(bySupplier, 'name'),
      salespersons:  ser(bySP, 'name'),
      cityStateSales,
      skuSales,
      currentStock: { totalItems: Math.max(0, inRows.length-1), totalQty:r2(totalStockQty), totalValue:Math.round(totalStockValue) },
      supplierStock,
      categoryStock,
      supplierStyleSales: Object.entries(bySupStyleSales).map(([k,d]) => ({ key: k, supName: d.supName, style: d.style, cat: d.cat, qty: r2(d.qty) })),
      supplierStyleStock: Object.entries(bySupStyleStock).map(([k,d]) => ({ key: k, supName: d.supName, style: d.style, cat: d.cat, qty: r2(d.qty) })),
      styleSales: Object.entries(byStyleSales).map(([style, d]) => ({ style, qty: r2(d.qty) })),
      styleStock: Object.entries(byStyleStock).map(([style, d]) => ({ style, qty: r2(d.qty) })),
      spAnalytics: {
        hasDateFilter,
        summary: { curUPT, lyUPT, uptGrowth:pct(curUPT,lyUPT), curATV, lyATV, atvGrowth:pct(curATV,lyATV),
                   curBills:curBillsTot, lyBills:lyBillsTot, billsGrowth:pct(curBillsTot,lyBillsTot),
                   curQty:r2(totalQty), lyQty:r2(lyTotQty), curAmount:Math.round(totalAmt), lyAmount:Math.round(lyTotAmt) },
        spTable,
        monthlyCmp
      }
    });
  } catch (err) {
    console.error('[IMS Reports] error:', err.message);
    const msg = (err.message || 'Failed to load').replace(/[^\x20-\x7E]/g, '?').slice(0, 200);
    res.status(500).json({ error: msg });
  }
});

// ── Generate Unique Codes: Supplier_Style column in InStock + OutStock ──
app.post('/api/generate-unique-codes', requireAuth, async (req, res) => {
  try {
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);

    const norm = s => String(s || '').trim().toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNKNOWN';
    const makeCode = (sup, style) => `${norm(sup)}_${norm(style)}`;

    const results = [];

    for (const tabName of ['In Stock', 'Out Stock']) {
      const resp = await withRetry(() => sheetsApi.spreadsheets.values.get({
        spreadsheetId: STOCK_SHEET_ID, range: `'${tabName}'!A1:AH1`
      }));
      const headerRow = (resp.data.values || [[]])[0].map(h => String(h).trim());
      const headerLow = headerRow.map(h => h.toLowerCase());

      // Find supplier and style columns
      const supIdx   = headerLow.findIndex(h => /supplier[\s._-]?name/i.test(h) || h === 'supplier');
      const styleIdx = headerLow.findIndex(h => /^style$/i.test(h));

      if (supIdx < 0 || styleIdx < 0) {
        results.push({ tab: tabName, error: `Columns not found — Supplier:${supIdx} Style:${styleIdx}` });
        continue;
      }

      // Find or decide column for "Unique Code"
      let codeIdx = headerLow.findIndex(h => h === 'unique code' || h === 'uniquecode');
      const colLetter = n => {
        let s = '';
        for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
        return s;
      };

      if (codeIdx < 0) {
        // Append header in new column
        codeIdx = headerRow.length;
        await withRetry(() => sheetsApi.spreadsheets.values.update({
          spreadsheetId: STOCK_SHEET_ID,
          range: `'${tabName}'!${colLetter(codeIdx)}1`,
          valueInputOption: 'RAW',
          requestBody: { values: [['Unique Code']] }
        }));
      }

      // Read all rows (supplier + style columns)
      const dataResp = await withRetry(() => sheetsApi.spreadsheets.values.get({
        spreadsheetId: STOCK_SHEET_ID, range: `'${tabName}'!A:AH`
      }));
      const allRows = dataResp.data.values || [];
      if (allRows.length <= 1) { results.push({ tab: tabName, updated: 0 }); continue; }

      const codes = allRows.slice(1).map(row => [makeCode(row[supIdx], row[styleIdx])]);
      const startRow = 2;
      const endRow   = startRow + codes.length - 1;
      const colL     = colLetter(codeIdx);

      await withRetry(() => sheetsApi.spreadsheets.values.update({
        spreadsheetId: STOCK_SHEET_ID,
        range: `'${tabName}'!${colL}${startRow}:${colL}${endRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: codes }
      }));

      results.push({ tab: tabName, updated: codes.length, col: colL });
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error('[GenerateCodes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── IMS Drilldown — click on chart bar/slice to see raw transactions ──
app.get('/api/ims-drilldown', requireAuth, async (req, res) => {
  try {
    const { type, value, from, to } = req.query;
    if (!type || !value) return res.status(400).json({ error: 'type and value required' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const isStock = type.startsWith('stock_');
    const tabName = isStock ? "'In Stock'!A:AH" : "'Out Stock'!A:AH";

    let resp;
    try {
      resp = await withRetry(() => sheetsApi.spreadsheets.values.get({ spreadsheetId: STOCK_SHEET_ID, range: tabName }));
    } catch(e) { return res.json({ rows: [] }); }

    const allRows = resp.data.values || [];
    if (!allRows.length) return res.json({ rows: [] });

    const hdr = allRows[0].map(h => String(h).trim().toLowerCase());
    const findC = rx => hdr.findIndex(h => rx.test(h));
    const MONS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    function parseD(str) {
      const m = String(str||'').trim().match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{4})$/);
      if (m) return new Date(Date.UTC(+m[3], MONS[m[2].toLowerCase()]??0, +m[1]));
      const d = new Date(str); return isNaN(d) ? null : d;
    }
    const fromDate = from ? new Date(from) : null;
    const toDate   = to   ? (() => { const d=new Date(to); d.setUTCHours(23,59,59,999); return d; })() : null;
    const getNum = (row, idx) => idx < 0 ? 0 : parseFloat(String(row[idx]||'0').replace(/[^\d.-]/g,''))||0;

    if (!isStock) {
      const oDate = findC(/^xn[\s._-]?date$/i), oXn = findC(/^xn[\s._-]?no$/i);
      const oCat  = findC(/^category$/i),        oSP = findC(/^salesperson$/i);
      const oSup  = findC(/^supplier[\s._-]?name$/i), oCity = findC(/^supplier[\s._-]?city$/i);
      const oSty  = findC(/^style$/i);
      const oQty  = findC(/netsls[\s._-]?qty/i), oAmt = findC(/netsls[\s._-]?net|netsls[\s._-]?amount/i);
      const filterCol = { category:oCat, supplier:oSup, salesperson:oSP, city:oCity, item:oSty, style:oSty }[type] ?? -1;

      const rows = allRows.slice(1).filter(row => {
        if (filterCol >= 0 && String(row[filterCol]||'').trim() !== value) return false;
        if (fromDate||toDate) { const d=parseD(row[oDate]||''); if (!d||(fromDate&&d<fromDate)||(toDate&&d>toDate)) return false; }
        return true;
      }).slice(0, 500).map(row => ({
        date: row[oDate]||'', bill: row[oXn]||'',
        category: row[oCat]||'', style: oSty >= 0 ? (row[oSty]||'') : '',
        supplier: row[oSup]||'', salesperson: row[oSP]||'',
        qty: getNum(row, oQty), amount: getNum(row, oAmt)
      }));
      return res.json({ rows, type, value });
    } else {
      const iSup  = findC(/^supplier[\s._-]?name$/i), iCat  = findC(/^category$/i);
      const iDesc = findC(/description|item[\s._-]?name/i);
      const iQty  = findC(/ops[\s._-]?qty|opening[\s._-]?qty/i), iCost = findC(/cost[\s._-]?price/i);
      const filterCol = { stock_supplier:iSup, stock_category:iCat }[type] ?? -1;

      const rows = allRows.slice(1).filter(row =>
        filterCol < 0 || String(row[filterCol]||'').trim() === value
      ).slice(0, 500).map(row => ({
        supplier: row[iSup]||'', category: row[iCat]||'',
        description: row[iDesc]||'', qty: getNum(row, iQty), cost: getNum(row, iCost)
      }));
      return res.json({ rows, type, value });
    }
  } catch(err) {
    console.error('[IMS Drilldown]', err.message);
    res.status(500).json({ error: err.message.slice(0,200) });
  }
});

app.post('/api/stock-csv-import', requireAuth, misUpload.single('file'), async (req, res) => {
  try {
    const reportType = (req.body && req.body.reportType) || '';
    const buffer = req.file && req.file.buffer;
    if (!buffer) return res.status(400).json({ error: 'File data missing' });

    const config = REPORT_CONFIG[reportType];
    if (!config) return res.status(400).json({ error: 'Invalid report type. Please select In Stock or Out Stock.' });

    const tabName = config.tab;

    // File parse + Sheets auth in PARALLEL (CPU + I/O overlap)
    const GARBAGE_RE = /[\u25A0-\u25FF\u2580-\u259F\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

    const [parsedRows, sheetsApi] = await Promise.all([
      Promise.resolve().then(() => {
        let workbook;
        try {
          workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
        } catch (e1) {
          // Some old .xls files fail with cellDates — retry without it
          try {
            workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
          } catch (e2) {
            const isOle2 = buffer[0] === 0xD0 && buffer[1] === 0xCF;
            throw new Error(
              isOle2
                ? 'Old .xls format could not be parsed. Please open in Excel → Save As → Excel Workbook (.xlsx) or CSV, then import that file.'
                : 'File format not supported. Please use .xlsx or .csv format.'
            );
          }
        }
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        // raw:true = no currency/format symbols; cellDates:true keeps dates as JS Date objects
        const allRows = XLSX.utils.sheet_to_json(firstSheet, {
          header: 1, defval: '', blankrows: false, raw: true,
          range: firstSheet['!ref'] || undefined
        });
        return allRows.filter(row => {
          const text = row.join('').trim();
          return text && !GARBAGE_RE.test(text);
        });
      }),
      getSheetsClient(['https://www.googleapis.com/auth/spreadsheets'])
    ]);

    if (!parsedRows.length) return res.status(400).json({ error: 'File is empty or could not be parsed' });

    // Ensure tab exists and check if it's new (determines append vs fresh)
    const { sheetId, isNew } = await ensureTab(sheetsApi, STOCK_SHEET_ID, tabName);
    // If tab exists but is empty (user deleted all data), treat as fresh — write header
    let isAppend = !isNew;
    if (isAppend) {
      const existCheck = await withRetry(() => sheetsApi.spreadsheets.values.get({
        spreadsheetId: STOCK_SHEET_ID,
        range: tabName + '!A1'
      }));
      if (!existCheck.data.values || !existCheck.data.values.length) isAppend = false;
    }
    const now = new Date();
    const dateStr = String(now.getDate()).padStart(2,'0') + '-'
      + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getMonth()]
      + '-' + now.getFullYear();

    console.log('[IMS] reportType:', reportType, '| totalRows:', parsedRows.length, '| first3:', parsedRows.slice(0,3).map(r=>r.slice(0,3).join('|')));

    const headerIdx = findHeaderRowIndex(parsedRows, config.keywords);
    console.log('[IMS] headerIdx:', headerIdx, '| keywords:', config.keywords);
    if (headerIdx === -1) {
      return res.status(400).json({
        error: 'Column headers not found. Please make sure you selected the correct report type (' + reportType + ').'
      });
    }

    // Extract print date from metadata rows (before header)
    const TOTAL_RE = /^(gross\s*total|grand\s*total|sub\s*total|net\s*total|total)$/i;
    const metaRows = parsedRows.slice(0, headerIdx);
    let printDate = '';
    for (const row of metaRows) {
      const text = row.join(' ');
      if (/printed\s+on/i.test(text)) {
        const m = text.match(/printed\s+on\s+([\d\-\/]+(?:\s+[\d:]+)?)/i);
        printDate = m ? m[1].trim() : text.replace(/printed\s+on\s*/i, '').split('By')[0].trim();
        break;
      }
    }

    const dataRows = parsedRows
      .slice(headerIdx)
      .map(row => row.map(cell => {
        if (cell === null || cell === undefined) return '';
        if (cell instanceof Date) {
          const dd = String(cell.getDate()).padStart(2, '0');
          const mm = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][cell.getMonth()];
          return dd + '-' + mm + '-' + cell.getFullYear();
        }
        return String(cell);
      }));

    const headerRow = dataRows[0];

    // Filter out Gross Total, Grand Total, Printed On footer rows
    const bodyRows = dataRows.slice(1).filter(row => {
      const rowText = row.join(' ').trim();
      if (!rowText) return false;
      const firstCell = String(row[0] || '').trim().toLowerCase();
      if (/gross\s*total|grand\s*total|sub\s*total|net\s*total/i.test(firstCell)) return false;
      if (/gross\s*total|grand\s*total/i.test(rowText)) return false;
      if (/printed\s+on/i.test(rowText)) return false;
      return true;
    });

    console.log('[IMS] bodyRows:', bodyRows.length, '| isAppend:', isAppend, '| tab:', tabName);

    const appendRows = [];
    if (isAppend) {
      bodyRows.forEach(r => appendRows.push([...r, printDate, dateStr]));
    } else {
      appendRows.push([...headerRow, 'Print Date', 'Upload Date']);
      bodyRows.forEach(r => appendRows.push([...r, printDate, dateStr]));
    }

    const appendResp = await withRetry(() => sheetsApi.spreadsheets.values.append({
      spreadsheetId: STOCK_SHEET_ID,
      range: tabName + '!A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appendRows }
    }));

    // Parse total rows from updatedRange e.g. 'In Stock'!A1:P4662 → 4661 data rows
    let totalRows = bodyRows.length;
    try {
      const updatedRange = appendResp.data.updates && appendResp.data.updates.updatedRange;
      if (updatedRange) {
        const m = updatedRange.match(/:(?:[A-Z]+)(\d+)$/);
        if (m) totalRows = parseInt(m[1], 10) - 1; // minus header row
      }
    } catch {}

    if (!isAppend) {
      await withRetry(() => colorHeaderRow(sheetsApi, STOCK_SHEET_ID, sheetId, 0));
    }

    res.json({ success: true, rowsAdded: bodyRows.length, totalRows, isAppend, tab: tabName, uploadDate: dateStr });
  } catch (err) {
    console.error('MIS import error:', err.message);
    if (err.code === 403) return res.status(400).json({ error: 'Sheet access denied. Grant the service account Editor access.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check the Sheet ID in .env.' });
    // Strip non-printable / binary chars from error message before sending to client
    const safeMsg = (err.message || 'Unknown error').replace(/[^\x20-\x7E -￿]/g, '?').slice(0, 300);
    res.status(500).json({ error: safeMsg });
  }
});

// ──────────────────────────────────────────────────────
// /api/stock-rows-import  — accepts pre-parsed rows from browser
// Used when the XLS file exceeds Vercel's 4.5 MB body limit.
// Client parses XLS in-browser via SheetJS, then sends rows
// as JSON in chunks of ~1500 rows so each request is small.
// ──────────────────────────────────────────────────────
app.post('/api/stock-rows-import', requireAuth, async (req, res) => {
  try {
    const { reportType, headerRow, rows, isFirst, isLast,
            isAppend: clientIsAppend, sheetId: clientSheetId, uploadDate } = req.body;

    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });
    const config = REPORT_CONFIG[reportType];
    if (!config) return res.status(400).json({ error: 'Invalid report type' });

    const tabName  = config.tab;
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);

    if (isFirst) {
      // Initialise tab; determine whether this is append or fresh
      const { sheetId, isNew } = await ensureTab(sheetsApi, STOCK_SHEET_ID, tabName);
      let isAppend = !isNew;
      if (isAppend) {
        const existCheck = await withRetry(() => sheetsApi.spreadsheets.values.get({
          spreadsheetId: STOCK_SHEET_ID, range: tabName + '!A1'
        }));
        if (!existCheck.data.values || !existCheck.data.values.length) isAppend = false;
      }

      // If fresh import, prepend header row; if append, skip it
      const rowsToWrite = isAppend
        ? rows.map(r => r.map(c => (c === null || c === undefined) ? '' : String(c)))
        : [
            headerRow.map(c => String(c || '')),
            ...rows.map(r => r.map(c => (c === null || c === undefined) ? '' : String(c)))
          ];

      await withRetry(() => sheetsApi.spreadsheets.values.append({
        spreadsheetId: STOCK_SHEET_ID, range: tabName + '!A1',
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rowsToWrite }
      }));

      if (isLast && !isAppend) {
        await withRetry(() => colorHeaderRow(sheetsApi, STOCK_SHEET_ID, sheetId, 0));
      }

      return res.json({ batchOk: true, success: !!isLast, isAppend, sheetId, rowsAdded: rows.length, tab: tabName, uploadDate });

    } else {
      // Subsequent chunk — just append rows
      const rowsToWrite = rows.map(r => r.map(c => (c === null || c === undefined) ? '' : String(c)));
      await withRetry(() => sheetsApi.spreadsheets.values.append({
        spreadsheetId: STOCK_SHEET_ID, range: tabName + '!A1',
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rowsToWrite }
      }));

      if (isLast && !clientIsAppend && clientSheetId != null) {
        await withRetry(() => colorHeaderRow(sheetsApi, STOCK_SHEET_ID, clientSheetId, 0));
      }

      return res.json({ batchOk: true, success: !!isLast, isAppend: clientIsAppend, rowsAdded: rows.length, tab: tabName, uploadDate });
    }

  } catch (err) {
    console.error('MIS rows import error:', err.message);
    if (err.code === 403) return res.status(400).json({ error: 'Sheet access denied. Grant the service account Editor access.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check the Sheet ID in .env.' });
    res.status(500).json({ error: (err.message || 'Unknown error').slice(0, 300) });
  }
});

// ══════════════════════════════════════════════════════
// PAGES
// ══════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Auth check is handled client-side via /api/me in init() — removing server-side
// requireAuth here prevents app.html from loading if cookie has any timing/domain issue
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

if (process.env.VERCEL) {
  module.exports = async (req, res) => {
    await _dbReady;
    return app(req, res);
  };
} else {
  _dbReady.finally(() => app.listen(PORT, () => {
    console.log(`\n  ✦ Task Manager: http://localhost:${PORT}`);
    console.log(`  Login: Vishal@gmail.com / pass123\n`);
  }));
}