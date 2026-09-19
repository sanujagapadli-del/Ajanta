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
const crypto = require('crypto');

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
if (!process.env.SESSION_SECRET) {
  console.warn('  ⚠️  SESSION_SECRET is not set — falling back to a hardcoded secret that is visible in the source. Set SESSION_SECRET in the environment so JWTs (including admin logins) can\'t be forged by anyone with repo access.');
}
const JWT_SECRET = process.env.SESSION_SECRET || 'taskmanager_secret_2026';

const cookieParser = require('cookie-parser');
app.use(cookieParser());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
// DATABASE — real MySQL when DB_HOST is set, else the Google Sheets
// backed in-memory adapter (sheets-db.js is a drop-in stand-in for the
// same mysql2/promise db.query / db.execute / db.getConnection API).
// ══════════════════════════════════════════════════════
const _usingMysql = !!process.env.DB_HOST;
const db = _usingMysql ? require('./mysql-db') : require('./sheets-db');
const _dbReady = db.init()
  .then(async () => {
    console.log(_usingMysql ? '  ✅ MySQL DB ready' : '  ✅ Sheets DB ready');
    // Migration: set is_active=1 for users where it is null/empty (added after initial deploy)
    try {
      const [rows] = await db.query('SELECT id, is_active FROM users');
      for (const u of rows) {
        if (u.is_active === '' || u.is_active === null || u.is_active === undefined) {
          await db.query('UPDATE users SET is_active=1 WHERE id=?', [u.id]);
        }
      }
    } catch(e) { console.warn('  ⚠️ is_active migration skipped:', e.message); }
  })
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
      <p style="color:#777;font-size:12px;margin-top:30px;">This is an automated email from Ajanta Electronics Task Manager.</p>
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

// Separate credentials for the O2D intake sheet only — that sheet is owned/
// shared under a different Google identity (celestile-fms) than the rest of
// the app's sheets, so it gets its own cached client instead of overwriting
// GOOGLE_CREDENTIALS_B64 (which would break every other sheet using it).
let _celestileSheetsClient = null;
async function getCelestileSheetsClient() {
  if (_celestileSheetsClient) return _celestileSheetsClient;
  const { google } = require('googleapis');
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_CELESTILE_B64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'));
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  _celestileSheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _celestileSheetsClient;
}

// Pre-warm Google auth on startup (reduces cold start time)
(async () => {
  try {
    await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    console.log('  ✅ Google Auth pre-warmed');
  } catch(e) { console.log('  ⚠️ Google Auth pre-warm failed:', e.message); }
})();

// ══════════════════════════════════════════════════════
// GOOGLE DRIVE — photo uploads (Service FMS bill/product photos)
// Service accounts have no storage quota of their own, so uploads only work
// inside a Shared Drive the account has been added to as a member.
// ══════════════════════════════════════════════════════
const SFMS_PHOTOS_DRIVE_ID = '0APU6dyk7HwhXUk9PVA';
let _driveClient = null;
async function getDriveClient() {
  if (_driveClient) return _driveClient;
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
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive'] });
  _driveClient = google.drive({ version: 'v3', auth: await auth.getClient() });
  return _driveClient;
}

// Uploads a data-URI (e.g. "data:image/jpeg;base64,...") to the Shared Drive,
// makes it viewable by anyone with the link, and returns that link — same
// format already used by older complaints' Drive-based photo links.
async function uploadPhotoToDrive(dataUri, filename) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!match) throw new Error('Invalid image data');
  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, 'base64');

  const { Readable } = require('stream');
  const drive = await getDriveClient();
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [SFMS_PHOTOS_DRIVE_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    supportsAllDrives: true,
    fields: 'id'
  });
  const fileId = created.data.id;

  await drive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/open?id=${fileId}`;
}

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

    // Load user names + departments once
    const [allUsers] = await db.query('SELECT id, name, department FROM users');
    const userMap = {};
    allUsers.forEach(u => { userMap[u.id] = { name: u.name||'', dept: u.department||'' }; });

    let delegationPending = [], checklistPending = [];
    if (taskType === 'delegation' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,COALESCE(t.title,'') AS title,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,t.link,COALESCE(t.revision_status,'') AS revision_status,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date FROM delegation_tasks t WHERE t.status IN ('pending','revised') ${delDateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      delegationPending = rows.map(t => ({ ...t, type: 'delegation', frequency: '', assignedToName: userMap[t.assigned_to]?.name||'', assignedToDept: userMap[t.assigned_to]?.dept||'', assignedByName: userMap[t.assigned_by]?.name||'' }));
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,COALESCE(t.title,'') AS title,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,COALESCE(t.frequency,'') AS frequency,t.remarks,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date FROM checklist_tasks t WHERE t.status IN ('pending','revised') ${chkDateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      checklistPending = rows.map(t => ({ ...t, type: 'checklist', approval: 'no', waiting_approval: 0, assignedToName: userMap[t.assigned_to]?.name||'', assignedToDept: userMap[t.assigned_to]?.dept||'', assignedByName: userMap[t.assigned_by]?.name||'' }));
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

    const [allUsers] = await db.query('SELECT id,name,department FROM users');
    const uMap = {};
    allUsers.forEach(u => { uMap[u.id] = { name: u.name||'', dept: u.department||'' }; });

    const freqCol = isDeleg ? "'' AS frequency" : "COALESCE(t.frequency,'') AS frequency";
    const [rawTasks] = await db.query(`SELECT t.id,COALESCE(t.title,'') AS title,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,${freqCol},${isDeleg?"COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,":"'no' AS approval,0 AS waiting_approval,t.remarks,"}DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date,DATE_FORMAT(t.created_at,'%Y-%m-%d') AS assigned_on FROM ${table} t ${where} ORDER BY t.due_date ASC`, params);
    const tasks = rawTasks.map(t => ({ ...t, type: type||'delegation', assignedToName: uMap[t.assigned_to]?.name||'', assignedToDept: uMap[t.assigned_to]?.dept||'', assignedByName: uMap[t.assigned_by]?.name||'' }));

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
    const { type, title, desc, assignedTo, approverEmail, startDate, date, priority, approval, remarks, link } = req.body;
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
      await db.query(`INSERT INTO delegation_tasks (title,description,assigned_to,assigned_by,start_date,due_date,status,priority,approval,remarks,link) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [title||'', desc, targetUser, assignedBy, startDate||'', date, 'pending', priority||'low', approval||'no', remarks||'', link||'']);
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
      await db.query(`INSERT INTO checklist_tasks (title,description,assigned_to,assigned_by,start_date,due_date,status,priority,remarks) VALUES (?,?,?,?,?,?,?,?,?)`, [title||'', desc, targetUser, req.session.userId, startDate||'', date, 'pending', priority||'low', remarks||'']);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/bulk-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, desc, assignedTo, priority, remarks, dates, frequency, startDate } = req.body;
    if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
    const freq = (frequency || '').toLowerCase().trim();
    // Normalize & validate dates: accept YYYY-MM-DD and DD/MM/YYYY; reject NaN/invalid
    const normalizeDates = (dates || []).map(d => {
      if (!d || String(d).includes('NaN')) return null;
      const s = String(d).trim();
      // DD/MM/YYYY or D/M/YYYY → YYYY-MM-DD
      const mDMY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mDMY) return `${mDMY[3]}-${mDMY[2].padStart(2,'0')}-${mDMY[1].padStart(2,'0')}`;
      // Must be YYYY-MM-DD
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    }).filter(Boolean);
    if (!normalizeDates.length) return res.status(400).json({ error: 'No valid dates generated — check start_date format (use DD/MM/YYYY or YYYY-MM-DD)' });
    const values = normalizeDates.map((date, i) => [title||'', desc, parseInt(assignedTo), req.session.userId, i===0 ? (startDate||date) : date, date, 'pending', priority||'low', remarks||'', freq]);
    await db.query(`INSERT INTO checklist_tasks (title,description,assigned_to,assigned_by,start_date,due_date,status,priority,remarks,frequency) VALUES ?`, [values]);
    res.json({ success: true, count: normalizeDates.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, type, newDate, reason } = req.body;
    const table = getTable(type||'delegation');
    const isAdmin = req.session.role === 'admin';
    const isPC = req.session.role === 'pc';
    const uid = req.session.userId;
    const taskId = parseInt(req.params.id, 10);
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [taskId]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    if (!isAdmin && !isPC && task.assigned_to !== uid) return res.status(403).json({ error: 'Not allowed' });
    // Timestamp: set to NOW() on completed; otherwise NULL (cleared on un-complete).
    const nowTs = new Date().toISOString().slice(0,19).replace('T',' ');
    const completedAt = status === 'completed' ? nowTs : null;
    if (status === 'completed' && task.waiting_approval) {
      await db.query(`DELETE FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [taskId, type]);
      if (type === 'checklist') await db.query(`UPDATE ${table} SET status='completed',completed_at=? WHERE id=?`, [nowTs, taskId]);
      else await db.query(`UPDATE ${table} SET status='completed',waiting_approval=0,revision_status='',completed_at=? WHERE id=?`, [nowTs, taskId]);
      return res.json({ success: true, needsApproval: false });
    }
    // Revision request: always requires approval (task.approval field is only for completion)
    // Completion: requires approval only when task.approval='yes'
    const needsApproval = type === 'delegation' && !isAdmin && !isPC &&
      (status === 'revised' || task.approval === 'yes');
    if (needsApproval) {
      const [existing] = await db.query(`SELECT id FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [taskId, type]);
      if (existing[0]) return res.status(400).json({ error: 'Approval already pending' });
      await db.query(`INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,status,note) VALUES (?,?,?,?,?,'pending',?)`, [taskId, type, uid, task.assigned_by, status, reason||'']);
      if (newDate && status === 'revised') await db.query(`UPDATE ${table} SET waiting_approval=1,revision_status='pending',due_date=? WHERE id=?`, [newDate, taskId]);
      else await db.query(`UPDATE ${table} SET waiting_approval=1,revision_status='pending' WHERE id=?`, [taskId]);
      return res.json({ success: true, needsApproval: true });
    }
    if (newDate && status === 'revised') await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,revision_status='pending',due_date=?,completed_at=? WHERE id=?`, [status, newDate, completedAt, taskId]);
    else {
      // checklist_tasks does not have a waiting_approval column
      if (type === 'checklist') await db.query(`UPDATE ${table} SET status=?,completed_at=? WHERE id=?`, [status, completedAt, taskId]);
      else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,revision_status='',completed_at=? WHERE id=?`, [status, completedAt, taskId]);
    }
    res.json({ success: true, needsApproval: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type||'delegation');
    const [rows] = await db.query(`SELECT t.*,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date FROM ${table} t WHERE t.id=?`, [parseInt(req.params.id, 10)]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, title, desc, startDate, date, priority, approval, remarks } = req.body;
    const table = getTable(type||'delegation');
    const taskId = parseInt(req.params.id, 10);
    if (type === 'delegation') await db.query(`UPDATE ${table} SET title=?,description=?,start_date=?,due_date=?,priority=?,approval=?,remarks=? WHERE id=?`, [title||'', desc, startDate||'', date, priority||'low', approval||'no', remarks||'', taskId]);
    else await db.query(`UPDATE ${table} SET title=?,description=?,start_date=?,due_date=?,remarks=? WHERE id=?`, [title||'', desc, startDate||'', date, remarks||'', taskId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, skipCompleted } = req.query;
    const table = getTable(type||'delegation');
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) return res.status(400).json({ error: 'Invalid task id' });
    // v16: bulk-delete flows pass skipCompleted=1 — refuse to delete completed tasks
    if (skipCompleted === '1' || skipCompleted === 'true') {
      const [rows] = await db.query(`SELECT status FROM ${table} WHERE id=?`, [taskId]);
      if (rows[0] && rows[0].status === 'completed') {
        return res.status(400).json({ error: 'Completed tasks cannot be deleted in bulk', skipped: true });
      }
    }
    await db.query(`DELETE FROM ${table} WHERE id=?`, [taskId]);
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
    const approvalId = parseInt(req.params.id, 10);
    const [rows] = await db.query('SELECT * FROM task_approvals WHERE id=?', [approvalId]);
    if (!rows[0]) return res.status(404).json({ error: 'Approval not found' });
    const appr = rows[0];
    // PC and admin can approve any; others only their own
    const canApprove = role === 'admin' || role === 'pc' || appr.requested_to === req.session.userId;
    if (!canApprove) return res.status(403).json({ error: 'Not allowed' });
    await db.query('UPDATE task_approvals SET status=?,note=? WHERE id=?', [action, note||'', approvalId]);
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
    const [delRows] = await db.query(`SELECT u.id AS userId,u.name,u.department,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${userFilter} GROUP BY u.id,u.name,u.department ORDER BY u.name`, deptParams);
    const [chlRows] = await db.query(`SELECT u.id AS userId,u.name,u.department,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,0 AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${userFilter} GROUP BY u.id,u.name,u.department ORDER BY u.name`, deptParams);
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

        const allCols = steps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
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
    const [rows] = await db.query('SELECT id,name,email,notification_email,role,phone,department,week_off,extra_off,is_active FROM users ORDER BY role DESC,name ASC');
    // Treat null/empty string as active (1) — existing users before is_active column had '' in sheet
    res.json(rows.map(r => ({ ...r, is_active: (r.is_active === '' || r.is_active === null || r.is_active === undefined) ? 1 : +r.is_active })));
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

// Check pending checklist tasks before deactivating
app.get('/api/users/:id/pending-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [tasks] = await db.query(
      `SELECT id, COALESCE(title,'') AS title, description, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM checklist_tasks WHERE assigned_to=? AND status IN ('pending','revised')`,
      [req.params.id]
    );
    res.json(tasks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deactivate user (with per-task checklist reassignment)
app.put('/api/users/:id/deactivate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const uid = req.params.id;
    if (parseInt(uid) === req.session.userId) return res.status(400).json({ error: 'Cannot deactivate yourself' });
    const { taskAssignments } = req.body;
    if (Array.isArray(taskAssignments) && taskAssignments.length) {
      for (const { taskIds, assignTo } of taskAssignments) {
        if (Array.isArray(taskIds) && assignTo) {
          for (const tid of taskIds) {
            await db.query('UPDATE checklist_tasks SET assigned_to=? WHERE id=?', [assignTo, tid]);
          }
        }
      }
    }
    await db.query('UPDATE users SET is_active=0 WHERE id=?', [uid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reactivate user
app.put('/api/users/:id/activate', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('UPDATE users SET is_active=1 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// One-time migration: set is_active=1 for all users where it is null/empty
app.post('/api/users/fix-active', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, is_active FROM users');
    let fixed = 0;
    for (const u of rows) {
      if (u.is_active === '' || u.is_active === null || u.is_active === undefined) {
        await db.query('UPDATE users SET is_active=1 WHERE id=?', [u.id]);
        fixed++;
      }
    }
    res.json({ success: true, fixed });
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
// SERVICE FMS — live-connected to the real "Complain FMS" Google Sheet
// (Sheet: "Service FMS-AE" — this is the customer's own production sheet,
// not our app's Google Sheet DB. We read/write specific cells directly.)
// ══════════════════════════════════════════════════════
const SFMS_SHEET_ID = '1sim5xXi7uKiUdLh_O1NjWbB9b047p9VVW-Z8oAG1gSE';
const SFMS_TAB = 'Complain FMS';
const SFMS_HEADER_ROW = 6;
const SFMS_DATA_START_ROW = 7;
const SFMS_LAST_COL = 'BJ';
const SFMS_PHOTO_MAX_CHARS = 40000; // stays under the 45k Sheets cell limit
const SFMS_OTP_CODE_COL = 'AN';
const SFMS_OTP_SENT_COL = 'AO';
const SFMS_OTP_TTL_MS = 30 * 60 * 1000; // OTP valid for 30 minutes after send
const SFMS_ITEMS_TAB = 'Items';
const SFMS_MECHANICS_TAB = 'Mechanics';

// NOTE: 2026-07-20 — reordered so the OTP/location-confirmation step now comes
// right after the mechanic is assigned (step 5), and the field spare in/out
// entry comes after that (step 6), with a new "Complaint Solved?" step 7 that
// repeats (via requireValue) until answered "Yes" before Evening Review (step 8).
// Column letters below were verified directly against the live sheet's header
// row (an earlier version of this file had them wrong — AH-AM+AN/AO is step 5,
// AP-AU is step 6, confirmed by reading row 6 directly rather than assuming).
// Step 6 is a single actual/status pair here, not two-stage — the sheet tracks
// only how many pieces came back plus a reason if short, not a separate
// out-then-in pair of events. Six brand-new columns were appended at the end
// (BE-BJ) for Step 3's item name and the new Step 7. BC/BD (old Final
// Status/Holidays) and BF/BH (unused now that Step 6 isn't two-stage) are
// left in place, just no longer read or written.
const SFMS_STEPS = [
  { n: 1, label: 'Check Product in Warranty', planned: 'O', actual: 'P', status: 'Q', timeDelay: 'R', extra: [] },
  { n: 2, label: 'Spare Available?', planned: 'S', actual: 'T', status: 'U', timeDelay: 'V', extra: [] },
  { n: 3, label: 'Takeout Spare', planned: 'W', actual: 'X', status: 'Y',
    extra: [
      { key: 'itemName', col: 'BE', label: 'Item Name' },
      { key: 'spareTaken', col: 'Z', label: 'Qty' },
      { key: 'spareReturned', col: 'AA', label: 'Spares Returned' }
    ],
    timeDelay: 'AB' },
  { n: 4, label: 'Assign Complaint to Mechanic After Batching', planned: 'AC', actual: 'AD', status: 'AE',
    extra: [{ key: 'mechanic', col: 'AF', label: 'Mechanic Name' }], timeDelay: 'AG' },
  // Mechanic reaching the customer's location — OTP-gated, plus a repair-status answer.
  { n: 5, label: "Mechanic's Complaint Solve", planned: 'AH', actual: 'AI', status: 'AJ',
    extra: [{ key: 'repairStatus', col: 'AK', label: 'Repair Status' }],
    timeDelay: 'AM', otpRequired: true },
  // Spare in/out for the field visit — how many pieces came back, and why if short.
  { n: 6, label: 'Spare In/Out Entry (in the field)', planned: 'AP', actual: 'AQ', status: 'AT',
    extra: [
      { key: 'qtyReturned', col: 'AR', label: 'Item Qty (Returned)' },
      { key: 'reasonIfShort', col: 'AS', label: 'Reason (if Short)' }
    ],
    timeDelay: 'AU' },
  // Repeats until answered "Yes" — a "No" is recorded (so there's a check-in trail) but
  // does not advance currentStep, so this stays the next action every time it's revisited.
  { n: 7, label: 'Complaint Solved?', actual: 'BJ', status: 'BI', extra: [], requireValue: 'Yes' },
  { n: 8, label: 'Evening Review', planned: 'AV', actual: 'AW', status: 'AX', timeDelay: 'AY',
    extra: [
      { key: 'distanceChargesAgree', col: 'AZ', label: 'Distance Charges Agreed by Customer' },
      { key: 'amount', col: 'BA', label: 'Amount' },
      { key: 'remark', col: 'BB', label: 'Remark' }
    ] }
];

function sfmsSerialToDate(n) {
  if (n === '' || n === null || n === undefined) return '';
  if (typeof n !== 'number') return String(n);
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
// Inverse of sfmsSerialToDate — write real numeric date-serial values (matching
// how every existing row already stores dates), never date-like strings. A
// plain string here can silently break the sheet's own TIMEVALUE()-based
// automation for "Planned" dates if its format doesn't match the sheet locale.
function sfmsDateToSerial(date) {
  return (date.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
}

// WhatsApp sending — via the user's own self-hosted "MYAPI" WhatsApp gateway
// (a QR-linked-device session, connected once via MYAPI's own /api/sessions
// flow; not re-established here). Was Maytapi before; kept the same
// mobile-normalizing helper and call shape so nothing else had to change.
function sfmsNormalizeMobile(mobile) {
  const digits = String(mobile || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return last10.length === 10 ? `91${last10}` : null;
}

async function sendWhatsApp(mobile, text) {
  const baseUrl = process.env.MYAPI_BASE_URL;
  const apiKey = process.env.MYAPI_API_KEY;
  const sessionId = process.env.MYAPI_SESSION_ID;
  if (!baseUrl || !apiKey || !sessionId) throw new Error('WhatsApp (MYAPI) is not configured (missing base URL, API key or session ID)');
  const to = sfmsNormalizeMobile(mobile);
  if (!to) throw new Error('Invalid mobile number on file');

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ to, message: text })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') throw new Error((data.message || data.error) || `WhatsApp send failed (HTTP ${res.status})`);
  return data;
}

app.get('/api/service-fms', requireAuth, async (req, res) => {
  try {
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const result = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SFMS_SHEET_ID,
      range: `'${SFMS_TAB}'!A${SFMS_DATA_START_ROW}:${SFMS_LAST_COL}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rows = result.data.values || [];
    const complaints = rows.map((r, i) => {
      const rowNum = SFMS_DATA_START_ROW + i;
      const get = col => r[colToIdx(col)];
      if (!get('B')) return null; // skip blank rows
      const c = {
        row: rowNum,
        timestamp: sfmsSerialToDate(get('A')),
        complainNo: get('B') || '',
        filledByName: get('C') || '',
        mobile: get('D') || '',
        customerType: get('E') || '',
        dealerName: get('F') || '',
        productName: get('G') || '',
        purchaseDate: sfmsSerialToDate(get('H')),
        problemDescription: get('I') || '',
        billPhoto: get('J') || '',
        productPhoto: get('K') || '',
        productLocation: get('L') || '',
        address: get('M') || '',
        area: get('N') || ''
      };
      c.steps = SFMS_STEPS.map(sd => {
        const step = {
          n: sd.n, label: sd.label,
          planned: sd.planned ? sfmsSerialToDate(get(sd.planned)) : '',
          status: get(sd.status) || ''
        };
        if (sd.twoStage) {
          step.out = sfmsSerialToDate(get(sd.out));
          step.in = sfmsSerialToDate(get(sd.in));
        } else {
          step.actual = sfmsSerialToDate(get(sd.actual));
        }
        sd.extra.forEach(e => { step[e.key] = get(e.col) || ''; });
        return step;
      });
      let currentStep = 0;
      for (let i = 0; i < SFMS_STEPS.length; i++) {
        const sd = SFMS_STEPS[i], s = c.steps[i];
        if (s.status && (!sd.requireValue || s.status === sd.requireValue)) currentStep = sd.n;
        else break;
      }
      c.currentStep = currentStep;
      c.closed = currentStep === SFMS_STEPS.length;
      return c;
    }).filter(Boolean);

    complaints.reverse(); // newest first
    res.json(complaints);
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/service-fms', requireAuth, async (req, res) => {
  try {
    const {
      filledByName, mobile, customerType, dealerName, productName, purchaseDate,
      problemDescription, billPhoto, productPhoto, productLocation, address, area
    } = req.body;
    if (!filledByName || !mobile || !productName || !problemDescription) {
      return res.status(400).json({ error: 'Name, mobile, product name and problem description are required' });
    }
    if (billPhoto && billPhoto.length > SFMS_PHOTO_MAX_CHARS) return res.status(400).json({ error: 'Bill photo is too large — try a smaller/compressed image' });
    if (productPhoto && productPhoto.length > SFMS_PHOTO_MAX_CHARS) return res.status(400).json({ error: 'Product photo is too large — try a smaller/compressed image' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);

    const colB = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SFMS_SHEET_ID, range: `'${SFMS_TAB}'!B${SFMS_DATA_START_ROW}:B`, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const bRows = colB.data.values || [];
    let maxNum = 0;
    bRows.forEach(r => { const m = String(r[0] || '').match(/C-(\d+)/); if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10)); });
    const complainNo = `C-${maxNum + 1}`;
    const timestamp = sfmsDateToSerial(new Date());
    const purchaseDateSerial = purchaseDate ? sfmsDateToSerial(new Date(purchaseDate + 'T00:00:00Z')) : '';

    // Photos are uploaded to Drive (never stored as raw base64 in the sheet) —
    // the sheet cell only ever holds the resulting share link.
    let billPhotoLink = '', productPhotoLink = '';
    if (billPhoto) billPhotoLink = await uploadPhotoToDrive(billPhoto, `${complainNo}-bill.jpg`);
    if (productPhoto) productPhotoLink = await uploadPhotoToDrive(productPhoto, `${complainNo}-product.jpg`);

    // append (not a computed-row update) so a stale/short bRows read can never
    // overwrite an existing row — Sheets itself finds the true last row.
    const appendRes = await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SFMS_SHEET_ID,
      range: `'${SFMS_TAB}'!A${SFMS_DATA_START_ROW}:N`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        timestamp, complainNo, filledByName, mobile, customerType || '', dealerName || '',
        productName, purchaseDateSerial, problemDescription, billPhotoLink, productPhotoLink,
        productLocation || '', address || '', area || ''
      ]] }
    });
    const writtenRange = appendRes.data.updates.updatedRange; // e.g. "'Complain FMS'!A195:N195"
    const nextRow = parseInt(writtenRange.match(/![A-Z]+(\d+)/)[1], 10);

    // The sheet's own row-creation flow only ever copied down the "Planned" date
    // formulas for the first 3 steps (O/S/W) — every complaint made through this
    // app was silently missing them for steps 4/5/6/8 (AC/AH/AP/AV). Write the
    // exact same per-row formula pattern every older row already has, so newly
    // created complaints behave identically.
    const r = nextRow;
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: SFMS_SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `'${SFMS_TAB}'!O${r}`, values: [[`=IF(A${r}<>"",IFS(HOUR(A${r}+O$5)>$D$1,workday.intl(A${r},1,"0000001")+$C$1/24+O$5,HOUR(A${r}+O$5)<$C$1,Datevalue(A${r})+$C$1/24+O$5,and(hour(A${r}+O$5)>=$C$1,hour(A${r}+O$5)<=$D$1),A${r}+O$5),"")`]] },
          { range: `'${SFMS_TAB}'!S${r}`, values: [[`=IF(P${r}<>"",IFS(HOUR(P${r}+S$5)>$D$1,workday.intl(P${r},1,"0000001")+$C$1/24+S$5,HOUR(P${r}+S$5)<$C$1,Datevalue(P${r})+$C$1/24+S$5,and(hour(P${r}+S$5)>=$C$1,hour(P${r}+S$5)<=$D$1),P${r}+S$5),"")`]] },
          { range: `'${SFMS_TAB}'!W${r}`, values: [[`=if(T${r},workday.intl(int(T${r}),0,"0000001",Holidays!A:A)+"17:00","")`]] },
          { range: `'${SFMS_TAB}'!AC${r}`, values: [[`=if(X${r},workday.intl(int(X${r}),0,"0000001",Holidays!A:A)+"18:00","")`]] },
          { range: `'${SFMS_TAB}'!AH${r}`, values: [[`=if(AD${r},workday.intl(int(AD${r}),0,"0000001",Holidays!A:A)+"18:00","")`]] },
          { range: `'${SFMS_TAB}'!AP${r}`, values: [[`=if(AI${r},WORKDAY.INTL(AI${r},AN$5,"0000001",Holidays!A:A)+hour(AI${r})/24+MINUTE(AI${r})/1440,"")`]] },
          { range: `'${SFMS_TAB}'!AV${r}`, values: [[`=if(AO${r},workday.intl(int(AO${r}),0,"0000001",Holidays!A:A)+"19:30","")`]] }
        ]
      }
    });

    res.json({ success: true, row: nextRow, complainNo });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    res.status(500).json({ error: err.message });
  }
});

// Sends a 6-digit OTP to the customer's WhatsApp; the mechanic must read it
// from the customer and enter it to mark Step 6 (Complaint Solve) done.
app.post('/api/service-fms/:row/step/:stepNum/send-otp', requireAuth, async (req, res) => {
  try {
    const row = parseInt(req.params.row, 10);
    const stepNum = parseInt(req.params.stepNum, 10);
    const stepDef = SFMS_STEPS.find(s => s.n === stepNum);
    if (!row || !stepDef || !stepDef.otpRequired) return res.status(400).json({ error: 'Invalid row or step number' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const rowRes = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SFMS_SHEET_ID,
      range: `'${SFMS_TAB}'!D${row}:D${row}`
    });
    const mobile = (rowRes.data.values && rowRes.data.values[0] && rowRes.data.values[0][0]) || '';
    if (!mobile) return res.status(400).json({ error: 'No customer mobile number on file for this complaint' });

    const otp = String(crypto.randomInt(100000, 1000000));
    const sentAtIso = new Date().toISOString();

    await sendWhatsApp(mobile, `Ajanta Electronics Service: Your OTP to confirm the technician's visit is ${otp}. Please share this with the technician. Valid for 30 minutes.`);

    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: SFMS_SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `'${SFMS_TAB}'!${SFMS_OTP_CODE_COL}${row}`, values: [[otp]] },
          { range: `'${SFMS_TAB}'!${SFMS_OTP_SENT_COL}${row}`, values: [[sentAtIso]] }
        ]
      }
    });

    res.json({ success: true, otp: req.session.role === 'admin' ? otp : undefined });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    res.status(500).json({ error: err.message });
  }
});

// Master lists (Items, Mechanics) — single-column tabs in the same spreadsheet,
// backing the dropdown + "add new" fields on Steps 3, 4 and 6.
async function sfmsGetList(tab) {
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SFMS_SHEET_ID,
    range: `'${tab}'!A2:A`
  });
  return (result.data.values || []).map(r => r[0]).filter(Boolean);
}
async function sfmsAddToList(tab, name) {
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SFMS_SHEET_ID,
    range: `'${tab}'!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[name]] }
  });
}

app.get('/api/service-fms/items', requireAuth, async (req, res) => {
  try { res.json(await sfmsGetList(SFMS_ITEMS_TAB)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/service-fms/items', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Item name is required' });
    await sfmsAddToList(SFMS_ITEMS_TAB, name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mechanics tab has a second column (B = Mobile) so the Mechanic-Wise report
// can WhatsApp a mechanic directly via the WhatsApp API instead of opening wa.me.
async function sfmsGetMechanics() {
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SFMS_SHEET_ID,
    range: `'${SFMS_MECHANICS_TAB}'!A2:B`
  });
  return (result.data.values || [])
    .filter(r => r[0])
    .map(r => ({ name: r[0], mobile: r[1] || '' }));
}
async function sfmsSetMechanicMobile(name, mobile) {
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SFMS_SHEET_ID,
    range: `'${SFMS_MECHANICS_TAB}'!A2:A`
  });
  const names = (result.data.values || []).map(r => r[0]);
  const idx = names.indexOf(name);
  if (idx === -1) throw new Error('Mechanic not found');
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SFMS_SHEET_ID,
    range: `'${SFMS_MECHANICS_TAB}'!B${idx + 2}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[mobile]] }
  });
}

app.get('/api/service-fms/mechanics', requireAuth, async (req, res) => {
  try { res.json(await sfmsGetMechanics()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/service-fms/mechanics', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    if (!name) return res.status(400).json({ error: 'Mechanic name is required' });
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SFMS_SHEET_ID,
      range: `'${SFMS_MECHANICS_TAB}'!A:B`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[name, mobile]] }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/service-fms/mechanics/mobile', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    if (!name || !mobile) return res.status(400).json({ error: 'Mechanic name and mobile are required' });
    await sfmsSetMechanicMobile(name, mobile);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generic WhatsApp send used by the Mechanic-Wise report's "Send via WhatsApp"
// button — sends straight through the WhatsApp API instead of opening wa.me.
app.post('/api/service-fms/send-whatsapp', requireAuth, async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').trim();
    const message = String(req.body.message || '').trim();
    if (!mobile || !message) return res.status(400).json({ error: 'Mobile and message are required' });
    await sendWhatsApp(mobile, message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/service-fms/:row/step/:stepNum', requireAuth, async (req, res) => {
  try {
    const row = parseInt(req.params.row, 10);
    const stepNum = parseInt(req.params.stepNum, 10);
    const stepDef = SFMS_STEPS.find(s => s.n === stepNum);
    if (!row || !stepDef) return res.status(400).json({ error: 'Invalid row or step number' });

    const nowVal = sfmsDateToSerial(new Date());
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    let batchData;

    if (stepDef.otpRequired) {
      const otpRes = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: SFMS_SHEET_ID,
        range: `'${SFMS_TAB}'!${SFMS_OTP_CODE_COL}${row}:${SFMS_OTP_SENT_COL}${row}`
      });
      const otpRow = (otpRes.data.values && otpRes.data.values[0]) || [];
      const storedOtp = otpRow[0] || '';
      const sentAt = otpRow[1] ? new Date(otpRow[1]) : null;
      if (!storedOtp || !sentAt) return res.status(400).json({ error: 'Send the OTP to the customer first' });
      if (Date.now() - sentAt.getTime() > SFMS_OTP_TTL_MS) return res.status(400).json({ error: 'OTP expired — please send a new one' });
      if (String(req.body.otp || '').trim() !== String(storedOtp).trim()) return res.status(400).json({ error: 'Incorrect OTP' });
    }

    if (stepDef.twoStage) {
      const stage = req.body.stage;
      if (stage === 'out') {
        batchData = [{ range: `'${SFMS_TAB}'!${stepDef.out}${row}`, values: [[nowVal]] }];
        for (const e of stepDef.extra) {
          if (e.stage === 'out' && req.body[e.key] !== undefined && req.body[e.key] !== '') {
            batchData.push({ range: `'${SFMS_TAB}'!${e.col}${row}`, values: [[req.body[e.key]]] });
          }
        }
      } else if (stage === 'in') {
        batchData = [
          { range: `'${SFMS_TAB}'!${stepDef.in}${row}`, values: [[nowVal]] },
          { range: `'${SFMS_TAB}'!${stepDef.status}${row}`, values: [['Yes']] }
        ];
        for (const e of stepDef.extra) {
          if (e.stage === 'in' && req.body[e.key] !== undefined && req.body[e.key] !== '') {
            batchData.push({ range: `'${SFMS_TAB}'!${e.col}${row}`, values: [[req.body[e.key]]] });
          }
        }
      } else {
        return res.status(400).json({ error: "stage must be 'out' or 'in' for this step" });
      }
    } else {
      // status defaults to 'Yes' for plain completion steps; steps with a dropdown
      // answer (warranty Yes/No, spare Available/Need to Purchase, Complaint Solved
      // Yes/No) send their actual selected value instead.
      batchData = [
        { range: `'${SFMS_TAB}'!${stepDef.actual}${row}`, values: [[nowVal]] },
        { range: `'${SFMS_TAB}'!${stepDef.status}${row}`, values: [[req.body.status || 'Yes']] }
      ];
      for (const e of stepDef.extra) {
        if (req.body[e.key] !== undefined && req.body[e.key] !== '') {
          batchData.push({ range: `'${SFMS_TAB}'!${e.col}${row}`, values: [[req.body[e.key]]] });
        }
      }
      if (stepDef.otpRequired) {
        // One-time use — clear so the same OTP can't be replayed.
        batchData.push({ range: `'${SFMS_TAB}'!${SFMS_OTP_CODE_COL}${row}:${SFMS_OTP_SENT_COL}${row}`, values: [['', '']] });
      }
    }

    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: SFMS_SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: batchData }
    });

    res.json({ success: true });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// O2D FMS — live-connected to the real "Order To Dispatch Fms" Google
// Sheet (tab "Master." — trailing dot; this is the customer's own
// production sheet, not our app's Google Sheet DB). The sheet also has a
// "Master" tab (no dot) with a fuller 21-step layout, but its data shows
// ~92% of orders never progressing past step 1 — it's a stalled/unused
// redesign. "Master." is the one actually driving the business: 77% of
// its orders (1803/2341) run all the way through step 9.
//
// Columns were verified two ways: reading the header row directly, and
// (because the header disagreed with itself for step 9 — its own labels
// call BE "Status" and BF "Loader Name") sampling hundreds of real data
// rows per column to see which one actually holds Yes/No values versus
// names. BF holds "Yes"/"No" and BE holds names — the header is wrong,
// the mapping below follows the data.
// ══════════════════════════════════════════════════════
// "Order To Dispatch Fms Erp" — this replaced the old '1pWxyrbDF...' workbook.
// Master. used to be a QUERY(IMPORTRANGE(...)) pulling live from a separate
// intake spreadsheet; that formula has been flattened to static values so
// this sheet is now self-contained (New Order appends straight into it, no
// other spreadsheet involved). Only accessible via the celestile-fms
// service account (getCelestileSheetsClient), not the app's default one.
const O2D_SHEET_ID = '1UWGXIuB4Igl4siTzbSP9RmtV5EcnubkW2-MJtMu4lbY';
const O2D_TAB = 'Master.';
const O2D_HEADER_ROW = 6;
const O2D_DATA_START_ROW = 7;
const O2D_LAST_COL = 'BM';

// doer + tat (the "Who"/"When" rows in Master.'s own header, rows 3 & 5)
const O2D_STEPS = [
  { n: 1, label: 'Accounts is ok or not', doer: 'Accountant', tat: '10 min', planned: 'T', actual: 'U', status: 'V',
    extra: [ { key: 'reason', col: 'W', label: 'Reason' } ] },
  { n: 2, label: 'Good Check', doer: 'Rajesh (Warehouse Manager)', tat: '10 min', planned: 'X', actual: 'Y', status: 'Z', timeDelay: 'AA', extra: [] },
  { n: 3, label: 'Call Made By CRM When Add More Order', doer: 'Kavita', tat: '10 min', planned: 'AB', actual: 'AC', status: 'AD', timeDelay: 'AE', extra: [] },
  { n: 4, label: 'Make Bill', doer: 'Accountant', tat: '10 min', planned: 'AF', actual: 'AG', status: 'AH', timeDelay: 'AI', extra: [] },
  { n: 5, label: 'Goods Takeout and Photo', doer: 'Rajesh (Warehouse Manager)', tat: '30 min', planned: 'AJ', actual: 'AK', status: 'AL', timeDelay: 'AO',
    extra: [
      { key: 'doerName', col: 'AM', label: 'Doer Name' },
      { key: 'photo', col: 'AN', label: 'Photo (link)' }
    ] },
  { n: 6, label: 'Check physical stock with bill', doer: 'Aziz', tat: '10 min', planned: 'AP', actual: 'AQ', status: 'AR', timeDelay: 'AT',
    extra: [ { key: 'doerName', col: 'AS', label: 'Doer Name' } ] },
  { n: 7, label: 'Arrange Loader', doer: 'Kavita', tat: '10 min', planned: 'AU', actual: 'AV', status: 'AW', timeDelay: 'AX', extra: [] },
  { n: 8, label: 'In/ Out Entry', doer: 'Priyanka (SCCRR)', tat: '10 min', planned: 'AY', actual: 'AZ', status: 'BA', timeDelay: 'BB', extra: [] },
  { n: 9, label: 'Load Goods', doer: 'Rajesh (Warehouse Manager)', tat: '30 min', planned: 'BC', actual: 'BD', status: 'BF', timeDelay: 'BG',
    extra: [ { key: 'loaderName', col: 'BE', label: 'Loader Name' } ] }
];

// ── O2D step doers — who's actually assigned to each of the 9 fixed steps.
// O2D_STEPS' own `doer` field is just a static role label ("Accountant",
// "Kavita"...); this layers real user assignments on top, same shape as the
// generic FMS system's fms_step_doers table.
async function ensureO2dStepDoersTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS o2d_step_doers (
      step_n INT NOT NULL,
      user_id INT NOT NULL,
      PRIMARY KEY (step_n, user_id)
    )
  `);
}
async function withO2dStepDoersTable(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; await ensureO2dStepDoersTable(); return await fn(); }
}

let _o2dStepDoersCache = null; // { map, ts } — step_n -> [{id,name}]
const O2D_STEP_DOERS_CACHE_TTL_MS = 60 * 1000;
async function getO2dStepDoersMap() {
  if (_o2dStepDoersCache && (Date.now() - _o2dStepDoersCache.ts) < O2D_STEP_DOERS_CACHE_TTL_MS) return _o2dStepDoersCache.map;
  const [rows] = await withO2dStepDoersTable(() => db.query(
    `SELECT osd.step_n, u.id, u.name FROM o2d_step_doers osd JOIN users u ON osd.user_id=u.id ORDER BY u.name`
  ));
  const map = {};
  rows.forEach(r => { (map[r.step_n] = map[r.step_n] || []).push({ id: r.id, name: r.name }); });
  _o2dStepDoersCache = { map, ts: Date.now() };
  return map;
}

app.get('/api/o2d-fms/step-doers', requireAuth, async (req, res) => {
  try {
    const map = await getO2dStepDoersMap();
    const assignments = {};
    O2D_STEPS.forEach(s => { assignments[s.n] = map[s.n] || []; });
    res.json({ assignments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/o2d-fms/step-doers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { assignments } = req.body; // { "1": [userId,...], "2": [...], ... }
    await ensureO2dStepDoersTable();
    await db.query('DELETE FROM o2d_step_doers');
    const rows = [];
    Object.entries(assignments || {}).forEach(([stepN, userIds]) => {
      (userIds || []).forEach(uid => rows.push([Number(stepN), Number(uid)]));
    });
    if (rows.length) await db.query('INSERT INTO o2d_step_doers (step_n, user_id) VALUES ?', [rows]);
    _o2dStepDoersCache = null;
    _o2dCache = null; // orders embed doers — force a fresh merge on next read
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The Master. tab is 2300+ rows wide (A:BM) — reading it straight from Sheets
// takes ~10-15s, so cache the parsed result briefly. A completed step-write
// (below) clears this so "Mark Done" is reflected immediately, not after TTL.
let _o2dCache = null; // { orders, ts }
const O2D_CACHE_TTL_MS = 60 * 1000;

async function getO2dOrders() {
  {
    if (_o2dCache && (Date.now() - _o2dCache.ts) < O2D_CACHE_TTL_MS) {
      return _o2dCache.orders;
    }
    const stepDoersMap = await getO2dStepDoersMap();
    const sheetsApi = await getCelestileSheetsClient();
    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await sheetsApi.spreadsheets.values.get({
          spreadsheetId: O2D_SHEET_ID,
          range: `'${O2D_TAB}'!A${O2D_DATA_START_ROW}:${O2D_LAST_COL}`,
          valueRenderOption: 'UNFORMATTED_VALUE'
        });
        break;
      } catch (e) {
        const isRateLimit = e.code === 429 || (e.message || '').includes('Quota exceeded');
        if (!isRateLimit || attempt >= 2) {
          if (_o2dCache) return _o2dCache.orders; // serve stale rather than a hard failure
          throw e;
        }
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    const rows = result.data.values || [];
    const orders = rows.map((r, i) => {
      const rowNum = O2D_DATA_START_ROW + i;
      const get = col => r[colToIdx(col)];
      if (!get('R')) return null; // skip blank rows (Order Id is the unique key column)
      const o = {
        row: rowNum,
        timestamp: sfmsSerialToDate(get('A')),
        counterType: get('B') || '',
        counterName: get('C') || '',
        area: get('D') || '',
        orderBy: get('J') || '',
        paymentTerms: get('K') || '',
        productName: get('M') || '',
        qty: get('O') || '',
        isSample: get('P') || '',
        orderNo: get('Q') || '',
        orderId: get('R') || '',
        billNo: get('BJ') || '',
        amount: get('BK') || ''
      };
      o.steps = O2D_STEPS.map(sd => {
        const step = {
          n: sd.n, label: sd.label, doer: sd.doer, tat: sd.tat, doers: stepDoersMap[sd.n] || [],
          planned: sd.planned ? sfmsSerialToDate(get(sd.planned)) : '',
          actual: sd.actual ? sfmsSerialToDate(get(sd.actual)) : '',
          status: get(sd.status) || ''
        };
        sd.extra.forEach(e => { step[e.key] = get(e.col) || ''; });
        return step;
      });
      let currentStep = 0;
      for (let i = 0; i < O2D_STEPS.length; i++) {
        const s = o.steps[i];
        if (s.status) currentStep = s.n;
        else break;
      }
      o.currentStep = currentStep;
      o.closed = currentStep === O2D_STEPS.length;
      return o;
    }).filter(Boolean);

    orders.reverse(); // newest first
    _o2dCache = { orders, ts: Date.now() };
    return orders;
  }
}

app.get('/api/o2d-fms', requireAuth, async (req, res) => {
  try {
    res.json(await getO2dOrders());
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    res.status(500).json({ error: err.message });
  }
});

// ── New Order ── used to append to a separate intake spreadsheet that fed
// Master. via IMPORTRANGE; that formula is now flattened to static values
// (see O2D_SHEET_ID comment above), so new orders append straight into
// Master. itself — no other spreadsheet involved, and no import lag.

// ── Customer outstanding lookup (Tally debtors report sheet) ──
// Sheet has just [Party Name, Debit/Outstanding] rows — no credit limit column.
const O2D_DEBTORS_SHEET_ID = '1oCGFCvCwuZRLHa_OV3Ae9PMjiaBr9VpAxCi3uMjqb-k';
const O2D_DEBTORS_TAB = 'Sheet1';
let _debtorsCache = null; // { map, ts }
const DEBTORS_CACHE_TTL_MS = 10 * 60 * 1000; // sheet is a daily Tally export, no need to re-read often

async function getDebtorsMap() {
  if (_debtorsCache && (Date.now() - _debtorsCache.ts) < DEBTORS_CACHE_TTL_MS) return _debtorsCache.map;
  try {
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    let resp;
    for (let attempt = 0; ; attempt++) {
      try {
        resp = await sheetsApi.spreadsheets.values.get({
          spreadsheetId: O2D_DEBTORS_SHEET_ID,
          range: `${O2D_DEBTORS_TAB}!A1:B1000`
        });
        break;
      } catch (e) {
        const isRateLimit = e.code === 429 || (e.message || '').includes('Quota exceeded');
        if (!isRateLimit || attempt >= 2) throw e;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    const rows = resp.data.values || [];
    const map = {};
    let started = false; // rows before the ["", "Debit", "Credit"] header are report title/metadata, not data
    for (const row of rows) {
      if (!started) {
        if (row[1] === 'Debit') started = true;
        continue;
      }
      const name = (row[0] || '').trim();
      if (!name || name === 'Grand Total') continue;
      const num = parseFloat(String(row[1] || '').replace(/,/g, ''));
      if (!isNaN(num)) map[name.toLowerCase()] = { name, outstanding: num };
    }
    _debtorsCache = { map, ts: Date.now() };
    return map;
  } catch (e) {
    // Sheets API hiccup (rate limit etc.) — serve stale cache rather than failing outright, if we have one
    if (_debtorsCache) return _debtorsCache.map;
    throw e;
  }
}

app.get('/api/o2d-fms/customer-lookup', requireAuth, async (req, res) => {
  try {
    const q = (req.query.name || '').trim().toLowerCase();
    if (!q) return res.json({ found: false });
    const map = await getDebtorsMap();
    if (map[q]) return res.json({ found: true, ...map[q] });
    const match = Object.values(map).find(v => v.name.toLowerCase().includes(q) || q.includes(v.name.toLowerCase()));
    if (match) return res.json({ found: true, ...match, fuzzy: true });
    res.json({ found: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/o2d-fms/customer-names', requireAuth, async (req, res) => {
  try {
    const map = await getDebtorsMap();
    const names = Object.values(map).map(v => v.name).sort((a, b) => a.localeCompare(b));
    res.json({ names });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// O2D DEALERS — profile (city/phone/credit limit/location/KYC) +
// payment-history rating, layered on top of the debtors sheet and
// the live order data. Both tables are lazily created on first write
// (mirrors the week_plans/app_settings self-healing pattern).
// ══════════════════════════════════════════════════════
async function ensureDealerTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS o2d_dealers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      counter_name VARCHAR(255) NOT NULL UNIQUE,
      city VARCHAR(255),
      phone VARCHAR(50),
      credit_limit DECIMAL(12,2),
      location_lat DECIMAL(10,7),
      location_lng DECIMAL(10,7),
      location_address VARCHAR(500),
      kyc_aadhar_url VARCHAR(1000),
      kyc_pan_url VARCHAR(1000),
      kyc_gst_url VARCHAR(1000),
      kyc_shop_url VARCHAR(1000),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS o2d_dealer_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      counter_name VARCHAR(255) NOT NULL,
      amount DECIMAL(12,2),
      due_date DATE,
      paid_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_counter (counter_name)
    )
  `);
}

async function withDealerTables(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    await ensureDealerTables();
    return await fn();
  }
}

function computeDealerRating(payments) {
  if (!payments.length) return { stars: 0, label: null, total: 0, late: 0, avgLateDays: 0 };
  let late = 0, lateDaysSum = 0;
  for (const p of payments) {
    if (p.due_date && p.paid_date && p.paid_date > p.due_date) {
      late++;
      lateDaysSum += Math.round((new Date(p.paid_date) - new Date(p.due_date)) / 86400000);
    }
  }
  const total = payments.length;
  const onTimeRatio = (total - late) / total;
  const stars = Math.max(1, Math.round(onTimeRatio * 5));
  const label = stars >= 4 ? 'Good' : stars === 3 ? 'OK' : 'Risky';
  return { stars, label, total, late, avgLateDays: late > 0 ? Math.round(lateDaysSum / late) : 0 };
}

app.get('/api/o2d-fms/dealers', requireAuth, async (req, res) => {
  try {
    const [debtorsMap, dealerRows, paymentRows, orders] = await Promise.all([
      getDebtorsMap(),
      withDealerTables(() => db.query('SELECT * FROM o2d_dealers')).then(([r]) => r),
      withDealerTables(() => db.query('SELECT * FROM o2d_dealer_payments ORDER BY due_date')).then(([r]) => r),
      getO2dOrders().catch(() => []) // dealer directory shouldn't 500 just because the orders sheet hiccups
    ]);

    const byKey = {}; // lowercased counter name -> merged dealer record
    const ensure = (name) => {
      const key = name.trim().toLowerCase();
      if (!key) return null;
      if (!byKey[key]) byKey[key] = { name: name.trim(), city: '', phone: '', creditLimit: null, outstanding: null,
        locationLat: null, locationLng: null, locationAddress: '', kyc: { aadhar: null, pan: null, gst: null, shop: null },
        lastOrder: null, payments: [] };
      return byKey[key];
    };

    Object.values(debtorsMap).forEach(v => { const d = ensure(v.name); if (d) d.outstanding = v.outstanding; });

    dealerRows.forEach(row => {
      const d = ensure(row.counter_name);
      if (!d) return;
      d.name = row.counter_name; // profile row is the authoritative display name/casing
      d.city = row.city || '';
      d.phone = row.phone || '';
      d.creditLimit = row.credit_limit !== null && row.credit_limit !== undefined ? Number(row.credit_limit) : null;
      d.locationLat = row.location_lat !== null ? Number(row.location_lat) : null;
      d.locationLng = row.location_lng !== null ? Number(row.location_lng) : null;
      d.locationAddress = row.location_address || '';
      d.kyc = { aadhar: row.kyc_aadhar_url || null, pan: row.kyc_pan_url || null, gst: row.kyc_gst_url || null, shop: row.kyc_shop_url || null };
    });

    paymentRows.forEach(p => { const d = ensure(p.counter_name); if (d) d.payments.push(p); });

    // group orders by counterName+orderId for a per-order qty/amount total, then take each dealer's most recent
    const orderGroups = {};
    orders.forEach(o => {
      if (!o.counterName) return;
      const gKey = o.counterName.trim().toLowerCase() + '::' + o.orderId;
      if (!orderGroups[gKey]) orderGroups[gKey] = { counterName: o.counterName, timestamp: o.timestamp, orderNo: o.orderNo, qty: 0, amount: 0 };
      orderGroups[gKey].qty += Number(o.qty) || 0;
      orderGroups[gKey].amount += Number(o.amount) || 0;
      if (o.timestamp > orderGroups[gKey].timestamp) orderGroups[gKey].timestamp = o.timestamp;
    });
    Object.values(orderGroups).forEach(g => {
      const d = ensure(g.counterName);
      if (!d) return;
      if (!d.lastOrder || g.timestamp > d.lastOrder.timestamp) {
        d.lastOrder = { timestamp: g.timestamp, orderNo: g.orderNo, qty: g.qty, amount: g.amount };
      }
    });

    const dealers = Object.values(byKey).map(d => {
      const rating = computeDealerRating(d.payments);
      const kycCount = Object.values(d.kyc).filter(Boolean).length;
      delete d.payments;
      return { ...d, kycCount, rating };
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ dealers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/o2d-fms/dealers', requireAuth, async (req, res) => {
  try {
    const { name, city, phone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Dealer name is required' });
    await withDealerTables(() => db.query(
      'INSERT INTO o2d_dealers (counter_name, city, phone) VALUES (?,?,?) ON DUPLICATE KEY UPDATE city=VALUES(city), phone=VALUES(phone)',
      [name.trim(), city || null, phone || null]
    ));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/o2d-fms/dealers/:name', requireAuth, async (req, res) => {
  try {
    const name = req.params.name.trim();
    const { city, phone, creditLimit } = req.body;
    await withDealerTables(() => db.query(
      `INSERT INTO o2d_dealers (counter_name, city, phone, credit_limit) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE
         city = COALESCE(VALUES(city), city),
         phone = COALESCE(VALUES(phone), phone),
         credit_limit = VALUES(credit_limit)`,
      [name, city || null, phone || null, (creditLimit === '' || creditLimit === undefined || creditLimit === null) ? null : Number(creditLimit)]
    ));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/o2d-fms/dealers/:name/kyc', requireAuth, async (req, res) => {
  try {
    const name = req.params.name.trim();
    const { docType, image } = req.body;
    const colMap = { aadhar: 'kyc_aadhar_url', pan: 'kyc_pan_url', gst: 'kyc_gst_url', shop: 'kyc_shop_url' };
    const col = colMap[docType];
    if (!col) return res.status(400).json({ error: 'Invalid KYC document type' });
    if (!image) return res.status(400).json({ error: 'No image provided' });
    const link = await uploadPhotoToDrive(image, `${name}-kyc-${docType}-${Date.now()}.jpg`);
    await withDealerTables(() => db.query(
      `INSERT INTO o2d_dealers (counter_name, ${col}) VALUES (?,?) ON DUPLICATE KEY UPDATE ${col}=VALUES(${col})`,
      [name, link]
    ));
    res.json({ success: true, link });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/o2d-fms/dealers/:name/location', requireAuth, async (req, res) => {
  try {
    const name = req.params.name.trim();
    const { lat, lng, address } = req.body;
    await withDealerTables(() => db.query(
      `INSERT INTO o2d_dealers (counter_name, location_lat, location_lng, location_address) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE location_lat=VALUES(location_lat), location_lng=VALUES(location_lng), location_address=VALUES(location_address)`,
      [name, lat ?? null, lng ?? null, address || null]
    ));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/o2d-fms/dealers/:name/payments', requireAuth, async (req, res) => {
  try {
    const name = req.params.name.trim();
    const { amount, dueDate, paidDate } = req.body;
    if (!dueDate || !paidDate) return res.status(400).json({ error: 'Due date and paid date are required' });
    await withDealerTables(() => db.query(
      'INSERT INTO o2d_dealer_payments (counter_name, amount, due_date, paid_date) VALUES (?,?,?,?)',
      [name, amount || null, dueDate, paidDate]
    ));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/o2d-fms/new-order', requireAuth, async (req, res) => {
  try {
    const {
      counterType, counterName, area, orderBy, paymentTerms, channel, remark,
      deliverByTransport, makePerformaInvoice, whenToSend, dateToSend, products
    } = req.body;
    if (!counterName || !Array.isArray(products) || !products.length) {
      return res.status(400).json({ error: 'Counter name and at least one product are required' });
    }
    for (const p of products) {
      if (!p.productName || !p.qty) return res.status(400).json({ error: 'Each product needs a name and quantity' });
    }

    const sheetsApi = await getCelestileSheetsClient();

    // Order No. and Order Id are sequential ("Ord-1435", "Order-3074") —
    // read both key columns once, take the current max of each.
    const keyCols = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: O2D_SHEET_ID, range: `'${O2D_TAB}'!Q${O2D_DATA_START_ROW}:R`, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const keyRows = keyCols.data.values || [];
    let maxOrderNo = 0, maxOrderId = 0;
    keyRows.forEach(r => {
      const mNo = String(r[0] || '').match(/Ord-(\d+)/);
      const mId = String(r[1] || '').match(/Order-(\d+)/);
      if (mNo) maxOrderNo = Math.max(maxOrderNo, parseInt(mNo[1], 10));
      if (mId) maxOrderId = Math.max(maxOrderId, parseInt(mId[1], 10));
    });
    const orderNo = `Ord-${String(maxOrderNo + 1).padStart(4, '0')}`;

    const nowSerial = sfmsDateToSerial(new Date());
    const dateToSendSerial = dateToSend ? sfmsDateToSerial(new Date(dateToSend + 'T00:00:00')) : '';

    const rows = products.map((p, i) => [
      nowSerial, counterType || '', counterName, area || '', dateToSendSerial, whenToSend || '',
      channel || '', deliverByTransport || 'No', makePerformaInvoice || 'No', orderBy || '',
      paymentTerms || '', remark || '', p.productName, p.rate || '', p.qty,
      p.isSample || 'No', orderNo, `Order-${maxOrderId + 1 + i}`
    ]);

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: O2D_SHEET_ID,
      range: `'${O2D_TAB}'!A${O2D_DATA_START_ROW}:R`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    });

    _o2dCache = null; // new order is now visible immediately — no IMPORTRANGE lag to wait out
    res.json({ success: true, orderNo, orderIds: rows.map(r => r[17]) });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the O2D sheet with the service account.' });
    res.status(500).json({ error: err.message });
  }
});

// "Master." never gets written to directly — every one of its Actual/Status
// cells is an ARRAYFORMULA doing a VLOOKUP into a different source tab (the
// same tab each step's own Google Form response lands in). So "marking a
// step done" means appending a row to THAT tab, in the same shape a real
// form submission would — Master. then picks it up on its own via the
// VLOOKUP the next time it's read. Confirmed empirically by reading real
// historical rows from each of these tabs, not just the formula text.
const O2D_STEP_WRITE_TARGETS = {
  // Step1's real form range is F:I (Ord-#### four-digit numbering matches
  // current orders) — A:D is an older/legacy block Master.'s own formula
  // doesn't even read (it points at F1:I), so nothing is written there.
  1: {
    tab: 'Step1', range: 'F:I',
    build: (o, b, now) => [o.orderNo, now, b.status || 'Yes', b.reason || '']
  },
  2: {
    tab: 'FMS Updation', range: 'G:L',
    build: (o, b, now) => [`${o.orderId}Step-2`, now, o.orderId, 'Step-2', b.status || 'Yes', o.orderNo]
  },
  // Steps 3/7/8 all share the same "FMS Updation" A:F block, distinguished
  // by the Step column — Master.'s VLOOKUP keys on OrderId+StepTag.
  3: {
    tab: 'FMS Updation', range: 'A:F',
    build: (o, b, now) => [`${o.orderId}Step-3`, now, o.orderId, 'Step-3', b.status || 'Yes', o.orderNo]
  },
  4: {
    tab: 'Step4Response', range: 'A:J',
    build: (o, b, now) => [now, o.counterName, o.orderNo, o.orderId, b.billNo || '', b.billAmount || '', b.status || 'Yes', b.photoLink || '', o.qty || '', b.billDate || '']
  },
  5: {
    tab: 'Takeout and loading5', range: 'A:H',
    build: (o, b, now) => [`${o.orderId}Step-5`, now, o.orderId, 'Step-5', b.doerName || '', b.status || 'Yes', b.photo || '', o.orderNo]
  },
  // Steps 6 and 9 key on the plain Order Id directly — no concatenation.
  6: {
    tab: '6', range: 'A:E',
    build: (o, b, now) => [o.orderId, now, b.doerName || '', b.status || 'Yes', o.orderNo]
  },
  7: {
    tab: 'FMS Updation', range: 'A:F',
    build: (o, b, now) => [`${o.orderId}Step-7`, now, o.orderId, 'Step-7', b.status || 'Yes', o.orderNo]
  },
  8: {
    tab: 'FMS Updation', range: 'A:F',
    build: (o, b, now) => [`${o.orderId}Step-8`, now, o.orderId, 'Step-8', b.status || 'Yes', o.orderNo]
  },
  9: {
    tab: 'Loading13', range: 'A:F',
    build: (o, b, now) => [o.orderId, now, b.doerName || '', b.status || 'Yes', b.deliveryBy || '', b.billDate || '']
  }
};

app.put('/api/o2d-fms/:row/step/:stepNum', requireAuth, async (req, res) => {
  try {
    const stepNum = parseInt(req.params.stepNum, 10);
    const target = O2D_STEP_WRITE_TARGETS[stepNum];
    if (!target) return res.status(400).json({ error: 'Invalid step number' });

    // Order context comes from the client (already holds the row from its
    // last /api/o2d-fms load) rather than re-reading Master. here — avoids
    // an extra Sheets read per "Mark Done" click.
    const { orderId, orderNo, counterName, qty } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const now = sfmsDateToSerial(new Date());
    const row = target.build({ orderId, orderNo: orderNo || '', counterName: counterName || '', qty: qty || '' }, req.body, now);

    const sheetsApi = await getCelestileSheetsClient();
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: O2D_SHEET_ID,
      range: `'${target.tab}'!${target.range}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    _o2dCache = null; // next GET re-reads Master. so this shows up once IMPORTRANGE/VLOOKUP catch up
    res.json({ success: true });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
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

    // HOD can only act on transfers involving their own department (GET /api/transfers
    // already scopes visibility the same way — this closes the gap where the write
    // endpoint didn't re-check it, letting an HOD approve/reject any department's transfer).
    if (req.session.role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      const dept = me[0]?.department || '';
      const [involved] = await db.query('SELECT department FROM users WHERE id IN (?,?)', [tr.from_user, tr.to_user]);
      if (!involved.some(u => u.department === dept)) {
        return res.status(403).json({ error: 'Not authorized for this department\'s transfers' });
      }
    }

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
    // Same department-scoping /api/employee-records already applies for HOD —
    // without it an HOD could set/overwrite another department's weekly targets.
    if (req.session.role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      const [target] = await db.query('SELECT department FROM users WHERE id=?', [employeeId]);
      if (!target[0] || target[0].department !== (me[0]?.department || '')) {
        return res.status(403).json({ error: 'Not authorized to set a plan for this employee' });
      }
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
    let hodDeptFilter = '';
    if (req.session.role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      hodDeptFilter = (me[0] && me[0].department) || '';
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
    let rows = rawWP.map(wp => ({
      ...wp,
      employee_name: uMapW[wp.employee_id]?.name || '',
      employee_department: uMapW[wp.employee_id]?.department || '',
      hod_name: uMapW[wp.hod_id]?.name || ''
    }));
    // HOD dept filter applied post-query (users table is separate from week_plans)
    if (hodDeptFilter) {
      rows = rows.filter(r => r.employee_department === hodDeptFilter);
    }
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
// PAGES
// ══════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Auth check is handled client-side via /api/me in init() — removing server-side
// requireAuth here prevents app.html from loading if cookie has any timing/domain issue
// no-cache: browser always fetches latest version (prevents stale JS bugs)
app.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

if (process.env.VERCEL) {
  module.exports = async (req, res) => {
    await _dbReady;
    return app(req, res);
  };
} else {
  _dbReady.finally(() => app.listen(PORT, () => {
    console.log(`\n  ✦ Task Manager: http://localhost:${PORT}`);
    console.log(`  Login: admin@ajantaelectronics.com / Ajanta@2024\n`);
  }));
}