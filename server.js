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

// Passwords are stored as bcrypt hashes. Some rows may still hold a plaintext
// value left over from before hashing was added — a successful plaintext
// match is auto-migrated to a hash on login (see /api/login) so every
// account converges to a hash over time without a forced reset.
function checkPassword(plain, stored) {
  if (!stored || plain == null) return { ok: false };
  if (/^\$2[aby]\$/.test(stored)) {
    try { return { ok: bcrypt.compareSync(plain, stored), legacy: false }; }
    catch(_) { return { ok: false }; }
  }
  if (plain === stored) return { ok: true, legacy: true };
  return { ok: false };
}
function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

const app = express();
const PORT = process.env.PORT || 3000;
let JWT_SECRET = process.env.SESSION_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // Refuse to boot rather than silently sign JWTs (including admin logins)
    // with a secret anyone with repo access could read and forge tokens with.
    console.error('  ❌ SESSION_SECRET is not set. Refusing to start in production — set it in your environment.');
    process.exit(1);
  }
  console.warn('  ⚠️  SESSION_SECRET is not set — using an insecure development-only fallback. Set SESSION_SECRET before deploying.');
  JWT_SECRET = 'dev_only_insecure_secret_do_not_use_in_production';
}

const cookieParser = require('cookie-parser');
app.use(cookieParser());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
// LIGHTWEIGHT RATE LIMITING — in-memory per-process sliding window, used on
// login and OTP verification (previously unprotected against brute force).
// On a single always-on instance (the traditional/Hostinger deploy target)
// this is a real limiter; on multi-instance serverless it's best-effort
// only, since each instance keeps its own counters — the same inherent
// limitation already documented for sheets-db.js's in-memory state.
// ══════════════════════════════════════════════════════
const _rateLimitHits = new Map(); // key -> [timestamps]
function rateLimit(keyFn, max, windowMs) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const hits = (_rateLimitHits.get(key) || []).filter(t => now - t < windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Too many attempts — please wait a bit and try again.' });
    }
    hits.push(now);
    _rateLimitHits.set(key, hits);
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, hits] of _rateLimitHits) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length) _rateLimitHits.set(key, fresh); else _rateLimitHits.delete(key);
  }
}, 5 * 60 * 1000).unref();
// Non-middleware variant — for rate-limiting a specific branch inside a
// handler (e.g. only the OTP-check code path of a multi-purpose route)
// rather than the whole route.
function isRateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (_rateLimitHits.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  _rateLimitHits.set(key, hits);
  return hits.length > max;
}

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
    // Migration: add page_access column (per-user page permissions, added after initial deploy)
    if (_usingMysql) {
      try { await db.query('ALTER TABLE users ADD COLUMN page_access TEXT DEFAULT NULL'); }
      catch(e) { if (e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ page_access migration skipped:', e.message); }
      // Migration: add force_logout_at column (admin-triggered remote sign-out)
      try { await db.query('ALTER TABLE users ADD COLUMN force_logout_at DATETIME DEFAULT NULL'); }
      catch(e) { if (e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ force_logout_at migration skipped:', e.message); }
      // Migration: add track_km column — a dedicated per-user flag (set from
      // the Users page) for whether Attendance shows the KM Start/End fields,
      // kept separate from the free-text department column on purpose.
      try { await db.query('ALTER TABLE users ADD COLUMN track_km TINYINT DEFAULT 0'); }
      catch(e) { if (e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ track_km migration skipped:', e.message); }
    }
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
      <p style="color:#777;font-size:12px;margin-top:30px;">This is an automated email from Ajanta Appliances Task Manager.</p>
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
async function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ','');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.session = { userId: decoded.userId, role: decoded.role, name: decoded.name };
    // Admin-triggered remote sign-out: any token issued before the user's
    // force_logout_at gets rejected, even though its own JWT signature is still valid.
    try {
      const [rows] = await db.query('SELECT force_logout_at FROM users WHERE id=?', [decoded.userId]);
      const flAt = rows[0]?.force_logout_at;
      if (flAt && decoded.iat && new Date(flAt).getTime() > decoded.iat * 1000) {
        return res.status(401).json({ error: 'You were signed out remotely. Please sign in again.' });
      }
    } catch(e) {} // column not migrated yet / sheets-db — fail open rather than lock everyone out
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

// Per-user page access — only these pages are ever restrictable; everything
// else (dashboard, all tasks, approvals, profile) stays open to everyone.
const RESTRICTABLE_PAGES = ['mis', 'users', 'records', 'service-fms', 'o2d-fms', 'o2d-new-order', 'price-catalogue', 'stock', 'purchase-fms'];
const DEFAULT_USER_PAGES = ['mis']; // matches the hardcoded nav behavior before this feature existed
function parsePageAccess(raw, role) {
  if (role === 'admin') return RESTRICTABLE_PAGES.slice();
  if (!raw) return DEFAULT_USER_PAGES.slice();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(p => RESTRICTABLE_PAGES.includes(p)) : DEFAULT_USER_PAGES.slice();
  } catch(e) { return DEFAULT_USER_PAGES.slice(); }
}
function getTable(type) {
  return type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
}

// Unexpected-error responder — logs the real error server-side (so it's
// still debuggable) but never forwards internal exception text (SQL
// fragments, column names, driver-specific messages) to the client, unlike
// a raw `sendServerError(res, err)`.
function sendServerError(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Enforce that only an assigned "doer" for this step (or an admin) can act
// on it. A step with no doers configured at all stays open to anyone with
// route access — treated as "not yet restricted", the same way the UI's own
// isMyStep flag treats an empty doer list — so this only closes the gap for
// steps that actually have doers assigned, without breaking sheets nobody's
// configured yet. `table` is always one of the two fixed literals below,
// never user input.
async function assertIsStepDoer(res, table, stepN, userId, role) {
  if (role === 'admin') return true;
  const [rows] = await db.query(`SELECT 1 FROM ${table} WHERE step_n=? AND user_id=?`, [stepN, userId]);
  if (rows.length) return true;
  const [any] = await db.query(`SELECT 1 FROM ${table} WHERE step_n=? LIMIT 1`, [stepN]);
  if (!any.length) return true;
  res.status(403).json({ error: 'You are not assigned to this step' });
  return false;
}

// ── Sequential id generation (service-fms groupNo, O2D orderNo, Purchase
// indentNo) ──────────────────────────────────────────────────────────────
// These ids are computed as "max existing + 1" from a live Sheet read, with
// no locking — two near-simultaneous submissions can compute the same
// candidate number, and since downstream code groups sheet rows purely by
// that id string, two unrelated complaints/orders/indents would be silently
// merged into one record. This claims the candidate atomically via a small
// DB-backed table with a composite primary key: INSERT IGNORE either wins
// outright (row inserted, affectedRows=1) or loses to a concurrent claim of
// the same number (primary-key collision, affectedRows=0), in which case we
// just try the next number.
async function ensureIdSequenceClaimsTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS id_sequence_claims (
    seq_name VARCHAR(50) NOT NULL,
    seq_value INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (seq_name, seq_value)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
async function claimNextSeqValue(seqName, startCandidate, maxAttempts = 50) {
  let candidate = startCandidate;
  for (let i = 0; i < maxAttempts; i++) {
    let result;
    try {
      [result] = await db.query('INSERT IGNORE INTO id_sequence_claims (seq_name, seq_value) VALUES (?, ?)', [seqName, candidate]);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      await ensureIdSequenceClaimsTable();
      [result] = await db.query('INSERT IGNORE INTO id_sequence_claims (seq_name, seq_value) VALUES (?, ?)', [seqName, candidate]);
    }
    if (result.affectedRows) return candidate;
    candidate++;
  }
  throw new Error(`Could not claim a sequential id for ${seqName} after ${maxAttempts} attempts`);
}

// ══════════════════════════════════════════════════════
// GOOGLE SHEETS HELPERS
// ══════════════════════════════════════════════════════
let _sheetsReadClient = null;
let _sheetsWriteClient = null;

// All app sheets (O2D, SFMS, Debtors, generic FMS) are shared with this one
// service account (celestile-fms) — falls back to the older env vars/local
// credentials.json only if that's not set, so local dev without it still works.
function loadGoogleCreds() {
  let creds;
  if (process.env.GOOGLE_CREDENTIALS_CELESTILE_B64) {
    creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_CELESTILE_B64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'));
  } else if (process.env.GOOGLE_CREDENTIALS_B64) {
    creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'));
  } else if (process.env.GOOGLE_CREDENTIALS) {
    creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } else {
    creds = require('./credentials.json');
  }
  if (creds && creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
  }
  return creds;
}

async function getSheetsClient(scopes) {
  const { google } = require('googleapis');
  const creds = loadGoogleCreds();
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
  const creds = loadGoogleCreds();
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive'] });
  _driveClient = google.drive({ version: 'v3', auth: await auth.getClient() });
  return _driveClient;
}

// Uploads any buffer to the Shared Drive. By default the file is left
// private to the service account — NOT shared "anyone with the link" — and
// this returns our own authenticated proxy path for it (see GET
// /api/drive-file/:fileId below), so only logged-in app users can view it.
// This is the right default since uploads include sensitive KYC documents
// (Aadhaar/PAN/GST). Pass `{ public: true }` for the specific cases that
// genuinely need an unauthenticated link — e.g. an invoice photo sent
// straight to a dealer over WhatsApp, who has no app login at all.
async function uploadBufferToDrive(buffer, filename, mimeType, { public: isPublic = false } = {}) {
  const { Readable } = require('stream');
  const drive = await getDriveClient();
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [SFMS_PHOTOS_DRIVE_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    supportsAllDrives: true,
    fields: 'id'
  });
  const fileId = created.data.id;
  if (isPublic) {
    await drive.permissions.create({
      fileId, supportsAllDrives: true, requestBody: { role: 'reader', type: 'anyone' }
    });
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  }
  // Absolute when APP_URL is configured (e.g. so a link pasted into the
  // underlying Sheet, or sent in a notification, still resolves outside
  // the app) — falls back to a same-origin relative path otherwise.
  return `${process.env.APP_URL || ''}/api/drive-file/${fileId}`;
}

// Streams a previously-uploaded file back to an authenticated app user.
// This is the only way to view an uploaded file now that uploadBufferToDrive
// no longer makes files public — the service account itself always retains
// access (it created/owns the file), so it can fetch and re-stream it here.
app.get('/api/drive-file/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = await getDriveClient();
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'name,mimeType', supportsAllDrives: true });
    const resp = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // ?download=1 forces a Save-As instead of the browser's inline
    // preview — replaces the old direct `drive.google.com/uc?export=
    // download` link, which relied on the file being publicly shared.
    if (req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename="${(meta.data.name || 'download').replace(/"/g, '')}"`);
    }
    resp.data.pipe(res);
  } catch (err) {
    if (err.code === 404) return res.status(404).json({ error: 'File not found' });
    res.status(500).json({ error: 'Could not load file' });
  }
});

// Uploads a data-URI (e.g. "data:image/jpeg;base64,...") — same format
// already used by older complaints' Drive-based photo links.
async function uploadPhotoToDrive(dataUri, filename, opts) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!match) throw new Error('Invalid image data');
  const [, mimeType, base64Data] = match;
  return uploadBufferToDrive(Buffer.from(base64Data, 'base64'), filename, mimeType, opts);
}

// Generic upload — any "photo" extra field (O2D's invoice photo, etc.) can
// upload straight away and just carry the resulting link like any other
// text field, instead of needing its own bespoke endpoint per feature.
// Public: this is the endpoint behind O2D's invoice-photo field, whose link
// gets sent straight to a dealer over WhatsApp (see the Make Bill step) —
// someone with no app login at all, so it needs an unauthenticated link.
app.post('/api/upload-photo', requireAuth, async (req, res) => {
  try {
    const { image, filename } = req.body;
    if (!image) return res.status(400).json({ error: 'image is required' });
    const link = await uploadPhotoToDrive(image, filename || `upload-${Date.now()}.jpg`, { public: true });
    res.json({ success: true, url: link });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please add the service account to the photos Shared Drive.' });
    sendServerError(res, err);
  }
});

// ══════════════════════════════════════════════════════
// MASTER DATA WORKBOOK — a manually-maintained .xlsx (Product Master, Dealer
// Master, etc.), uploaded to Drive rather than a native Google Sheet, so the
// Sheets API can't read it directly — downloaded as bytes and parsed with
// the xlsx library instead. Cached since it only changes when someone
// re-uploads it.
// ══════════════════════════════════════════════════════
const MASTER_WORKBOOK_FILE_ID = '1zAcazPtIhM3MsPBLKy0m8f_P3D9JoZeH';
let _masterWorkbookCache = null; // { products, dealerNames, ts }
// Downloading this file is the slow part (~5s, mostly Drive API network
// time, not parsing) — cache long since it's a manually re-uploaded
// reference workbook. Deliberately NOT pre-warmed at startup: on Vercel
// every cold container would pay that ~5s cost even for requests that never
// touch this data at all, which made things worse, not better.
const MASTER_WORKBOOK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Warranty (point 5) — lives in a separate "Data By Ajay" Google Sheet, tab
// "Warranty Sheet" (Product Code / Product Name / Warranty text like "2
// years"), keyed by the same Product Code used in the Product Master
// workbook above (verified: identical codes/names for every row checked).
// Matched by Product Code rather than name — exact and immune to any
// wording drift between the two sources.
const WARRANTY_SHEET_ID = '18osb6xZEXktc1_tG_Y1SzE4Rg6QnlLoQj05if2DYUeo';
const WARRANTY_TAB = 'Warranty Sheet';
let _warrantyMapCache = null; // { code: months }, ts
async function getWarrantyMonthsMap() {
  if (_warrantyMapCache && (Date.now() - _warrantyMapCache.ts) < MASTER_WORKBOOK_CACHE_TTL_MS) return _warrantyMapCache.map;
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  // Row 1 is a title banner, row 2 is the header, data starts row 3.
  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: WARRANTY_SHEET_ID, range: `'${WARRANTY_TAB}'!A3:C`
  });
  const map = {};
  (result.data.values || []).forEach(r => {
    const code = (r[0] || '').trim();
    const m = String(r[2] || '').match(/(\d+(?:\.\d+)?)\s*year/i);
    if (code && m) map[code] = parseFloat(m[1]) * 12;
  });
  _warrantyMapCache = { map, ts: Date.now() };
  return map;
}

async function getMasterWorkbookData() {
  if (_masterWorkbookCache && (Date.now() - _masterWorkbookCache.ts) < MASTER_WORKBOOK_CACHE_TTL_MS) return _masterWorkbookCache;
  const XLSX = require('xlsx'); // lazy — a fairly heavy lib, no reason to pay its load cost on every cold start
  const [drive, warrantyMap] = [await getDriveClient(), await getWarrantyMonthsMap()];
  const resp = await drive.files.get({ fileId: MASTER_WORKBOOK_FILE_ID, alt: 'media' }, { responseType: 'arraybuffer' });
  const wb = XLSX.read(Buffer.from(resp.data), { type: 'buffer', sheets: ['2. Product Master', '5. Dealer Master', '8. Spare Parts Master'] });

  const productSheet = wb.Sheets['2. Product Master'];
  const productRows = productSheet ? XLSX.utils.sheet_to_json(productSheet, { header: 1, raw: false, defval: '' }) : [];
  // Row 0 is a title banner, row 1 is the real header, data starts row 2.
  const products = productRows.slice(2)
    .filter(r => (r[1] || '').trim() && (r[12] || '').trim().toLowerCase() !== 'discontinued')
    .map(r => ({
      code: (r[0] || '').trim(),
      name: (r[1] || '').trim(),
      category: (r[3] || '').trim(),
      warrantyMonths: warrantyMap[(r[0] || '').trim()] || null
    }));

  const dealerSheet = wb.Sheets['5. Dealer Master'];
  const dealerRows = dealerSheet ? XLSX.utils.sheet_to_json(dealerSheet, { header: 1, raw: false, defval: '' }) : [];
  const dealerNames = dealerRows.slice(2)
    .map(r => (r[1] || '').trim())
    .filter(Boolean);

  // Spare Parts Master (point 6) — the real 396-item spare-parts catalog,
  // separate from the small ad-hoc "Items" tab in the Service FMS sheet
  // (which stays for one-off items not in this master list, added via
  // "+ Add New"). Row 0 is a title banner, row 1 is the header, data
  // starts row 2; column L (index 11) is Status, filtered the same way
  // Product Master's discontinued flag is.
  const spareSheet = wb.Sheets['8. Spare Parts Master'];
  const spareRows = spareSheet ? XLSX.utils.sheet_to_json(spareSheet, { header: 1, raw: false, defval: '' }) : [];
  const spareParts = spareRows.slice(2)
    .filter(r => (r[1] || '').trim() && (r[11] || '').trim().toLowerCase() !== 'discontinued')
    .map(r => ({ code: (r[0] || '').trim(), name: (r[1] || '').trim(), category: (r[4] || '').trim() }));

  _masterWorkbookCache = { products, dealerNames, spareParts, ts: Date.now() };
  return _masterWorkbookCache;
}

// Product suggestions for New Order = the workbook's seed list PLUS
// whatever product names have actually been typed into real orders since
// (New Order's product field is free-text — this just makes a name typed
// once show up as a suggestion next time). Deliberately separate from the
// Price List & Catalogue table — that's for pricing/photos, not this.
app.get('/api/o2d-fms/product-names', requireAuth, async (req, res) => {
  try {
    const [{ products }, orders] = await Promise.all([
      getMasterWorkbookData(),
      getO2dOrders().catch(() => [])
    ]);
    const seen = new Set(products.map(p => p.name.toLowerCase()));
    const merged = products.slice();
    orders.forEach(o => (o.products || []).forEach(p => {
      const name = (p.productName || '').trim();
      if (!name || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      merged.push({ name, category: '' });
    }));
    res.json({ products: merged });
  } catch (err) { sendServerError(res, err); }
});

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
app.post('/api/login',
  rateLimit(req => `login:${req.ip}`, 20, 5 * 60 * 1000),
  rateLimit(req => `login:${(req.body?.email || '').toLowerCase()}`, 10, 5 * 60 * 1000),
  async (req, res) => {
  try {
    const { email, password, name } = req.body;

    let [rows] = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);

    // No user found in memory — resync from Sheet and retry
    if (!rows.length) {
      try { await db.resync(); } catch(_) {}
      const [rows2] = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
      rows = rows2;
    }

    // Multiple accounts can share one email address (see reminder-email grouping).
    // Narrow to the accounts whose password actually matches before deciding.
    let matches = rows.filter(r => checkPassword(password, r.password).ok);

    if (!matches.length) return res.status(401).json({ error: 'Invalid email or password' });

    if (matches.length > 1) {
      if (name && name.trim()) {
        const byName = matches.filter(r => r.name && r.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (byName.length === 1) {
          matches = byName;
        } else {
          return res.json({ needsName: true, error: 'Could not find that name on this account. Please check the spelling and try again.' });
        }
      } else {
        return res.json({ needsName: true, error: 'This email is shared by multiple accounts. Please enter your full name to continue.' });
      }
    }

    const user = matches[0];
    const check = checkPassword(password, user.password);

    // Legacy plaintext row → migrate to a bcrypt hash now that we know the real password.
    if (check.legacy) {
      try { await db.query('UPDATE users SET password=? WHERE id=?', [hashPassword(password), user.id]); } catch(_) {}
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
  } catch (err) { sendServerError(res, err); }
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
    sendServerError(res, err);
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
    // page_access fetch separately — safe if column not yet added
    let rawAccess = null;
    try {
      const [pa] = await db.query('SELECT page_access FROM users WHERE id=?', [req.session.userId]);
      rawAccess = pa[0]?.page_access;
    } catch(e) {}
    rows[0].page_access = parsePageAccess(rawAccess, rows[0].role);
    res.json(rows[0]);
  } catch (err) { sendServerError(res, err); }
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
      // Fetch HOD's department + department-scoped user ids from DB — do not rely on query param
      let resolvedDept = hodDept;
      if (!resolvedDept) {
        const [meRow] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
        resolvedDept = meRow[0]?.department || '';
      }
      let deptUserIds = [uid];
      if (resolvedDept) {
        const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [resolvedDept, 'admin','hod']);
        deptUserIds = deptUsers.map(u => u.id);
        if (!deptUserIds.includes(uid)) deptUserIds.push(uid); // also include the HOD themselves
      }
      if (filterEmployee && filterEmployee !== 'all') {
        // Only honor an explicit employee filter if that employee is actually in this
        // HOD's own department — otherwise fall back to the full dept view, so an HOD
        // can't view another department's data just by passing a different id.
        const fid = parseInt(filterEmployee, 10);
        if (deptUserIds.includes(fid)) {
          userFilter = 'AND t.assigned_to = ?'; params = [fid];
        } else {
          userFilter = `AND t.assigned_to IN (${deptUserIds.map(()=>'?').join(',')})`; params = deptUserIds;
        }
      } else {
        userFilter = `AND t.assigned_to IN (${deptUserIds.map(()=>'?').join(',')})`; params = deptUserIds;
      }
    } else {
      userFilter = 'AND t.assigned_to = ?'; params = [uid];
    }

    // PC: date range filter applied to both types
    // Regular users: delegation = no date filter (revised-to-future tasks show); checklist = today & past only
    // NOTE: dateFrom/dateTo are user-supplied query params — always bound as ? placeholders below, never string-interpolated into SQL.
    const pcDateClause = isPC && dateFrom && dateTo ? `AND t.due_date BETWEEN ? AND ?` : '';
    const delDateClause = pcDateClause; // delegation: no date cap for non-PC
    const chkDateClause = pcDateClause || `AND t.due_date <= CURDATE()`; // checklist: always cap at today
    const dateClauseParams = pcDateClause ? [dateFrom, dateTo] : []; // shared: delDateClause/chkDateClause are either both pcDateClause (same params) or chkDateClause falls back to CURDATE() (no params)

    const taskType = req.query.taskType || 'both';
    let pending = 0, revised = 0, completed = 0;

    if (taskType === 'delegation' || taskType === 'both') {
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM delegation_tasks t WHERE 1=1 ${userFilter} ${delDateClause}`, [...params, ...dateClauseParams]);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM checklist_tasks t WHERE 1=1 ${userFilter} ${chkDateClause}`, [...params, ...dateClauseParams]);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }

    // Load user names + departments once
    const [allUsers] = await db.query('SELECT id, name, department FROM users');
    const userMap = {};
    allUsers.forEach(u => { userMap[u.id] = { name: u.name||'', dept: u.department||'' }; });

    let delegationPending = [], checklistPending = [];
    if (taskType === 'delegation' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,COALESCE(t.title,'') AS title,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,t.link,COALESCE(t.revision_status,'') AS revision_status,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date FROM delegation_tasks t WHERE t.status IN ('pending','revised') ${delDateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, [...dateClauseParams, ...params]);
      delegationPending = rows.map(t => ({ ...t, type: 'delegation', frequency: '', assignedToName: userMap[t.assigned_to]?.name||'', assignedToDept: userMap[t.assigned_to]?.dept||'', assignedByName: userMap[t.assigned_by]?.name||'' }));
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,COALESCE(t.title,'') AS title,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,COALESCE(t.frequency,'') AS frequency,t.remarks,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date FROM checklist_tasks t WHERE t.status IN ('pending','revised') ${chkDateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, [...dateClauseParams, ...params]);
      checklistPending = rows.map(t => ({ ...t, type: 'checklist', approval: 'no', waiting_approval: 0, assignedToName: userMap[t.assigned_to]?.name||'', assignedToDept: userMap[t.assigned_to]?.dept||'', assignedByName: userMap[t.assigned_by]?.name||'' }));
    }
    res.json({ pending, revised, completed, todayPending: [...delegationPending, ...checklistPending] });
  } catch (err) { sendServerError(res, err); }
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
    // LIMIT is a safety ceiling (matches /api/dashboard's own cap), not a
    // real pagination UX — this endpoint's grouped-by-user response isn't
    // set up for paging without also changing the frontend's "All Tasks" view.
    const [rawTasks] = await db.query(`SELECT t.id,COALESCE(t.title,'') AS title,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,${freqCol},${isDeleg?"COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,":"'no' AS approval,0 AS waiting_approval,t.remarks,"}DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date,DATE_FORMAT(t.created_at,'%Y-%m-%d') AS assigned_on FROM ${table} t ${where} ORDER BY t.due_date ASC LIMIT 5000`, params);
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
  } catch (err) { sendServerError(res, err); }
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
    if (!Number.isFinite(targetUser)) return res.status(400).json({ error: 'Invalid assignee' });
    if (targetUser !== req.session.userId) {
      const [targetRows] = await db.query('SELECT id FROM users WHERE id=?', [targetUser]);
      if (!targetRows.length) return res.status(400).json({ error: 'Assignee not found' });
    }
    if ((type||'checklist') === 'delegation') {
      // Approver: if approverEmail is provided look up that user, otherwise use logged-in user
      let assignedBy = req.session.userId;
      if (approverEmail) {
        const [aprRows] = await db.query('SELECT id FROM users WHERE email=? LIMIT 1', [approverEmail]);
        if (aprRows.length) assignedBy = aprRows[0].id;
      }
      await db.query(`INSERT INTO delegation_tasks (title,description,assigned_to,assigned_by,start_date,due_date,status,priority,approval,remarks,link) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [title||'', desc, targetUser, assignedBy, startDate||'', date, 'pending', priority||'low', approval||'no', remarks||'', link||'']);
      // 📧 Send delegation email (non-blocking — fire and forget). Wrapped in
      // its own try/catch so a failure here (DB hiccup, mail error) can't
      // become an unhandled rejection — task creation itself already succeeded.
      (async () => {
        try {
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
        } catch (e) { console.error('  ⚠️ Delegation email failed:', e.message); }
      })();
    } else {
      await db.query(`INSERT INTO checklist_tasks (title,description,assigned_to,assigned_by,start_date,due_date,status,priority,remarks) VALUES (?,?,?,?,?,?,?,?,?)`, [title||'', desc, targetUser, req.session.userId, startDate||'', date, 'pending', priority||'low', remarks||'']);
    }
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/tasks/bulk-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, desc, assignedTo, priority, remarks, dates, frequency, startDate } = req.body;
    if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
    const assignedToId = parseInt(assignedTo, 10);
    if (!Number.isFinite(assignedToId)) return res.status(400).json({ error: 'Invalid assignee' });
    const [assigneeRows] = await db.query('SELECT id FROM users WHERE id=?', [assignedToId]);
    if (!assigneeRows.length) return res.status(400).json({ error: 'Assignee not found' });
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
    const values = normalizeDates.map((date, i) => [title||'', desc, assignedToId, req.session.userId, i===0 ? (startDate||date) : date, date, 'pending', priority||'low', remarks||'', freq]);
    await db.query(`INSERT INTO checklist_tasks (title,description,assigned_to,assigned_by,start_date,due_date,status,priority,remarks,frequency) VALUES ?`, [values]);
    res.json({ success: true, count: normalizeDates.length });
  } catch (err) { sendServerError(res, err); }
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
      const [insertResult] = await db.query(`INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,status,note) VALUES (?,?,?,?,?,'pending',?)`, [taskId, type, uid, task.assigned_by, status, reason||'']);
      // Close the race: two near-simultaneous requests can both pass the
      // check above before either inserts. Re-check right after inserting —
      // if more than one pending row now exists, only the earliest (lowest
      // id) wins; this request backs out instead of leaving a duplicate.
      const [dupCheck] = await db.query(`SELECT id FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending' ORDER BY id ASC`, [taskId, type]);
      if (dupCheck.length > 1 && dupCheck[0].id !== insertResult.insertId) {
        await db.query(`DELETE FROM task_approvals WHERE id=?`, [insertResult.insertId]);
        return res.status(400).json({ error: 'Approval already pending' });
      }
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
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/tasks/:id/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type||'delegation');
    const [rows] = await db.query(`SELECT t.*,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.start_date,'%Y-%m-%d') AS start_date FROM ${table} t WHERE t.id=?`, [parseInt(req.params.id, 10)]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: rows[0] });
  } catch (err) { sendServerError(res, err); }
});

app.put('/api/tasks/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, title, desc, startDate, date, priority, approval, remarks } = req.body;
    const table = getTable(type||'delegation');
    const taskId = parseInt(req.params.id, 10);
    if (type === 'delegation') await db.query(`UPDATE ${table} SET title=?,description=?,start_date=?,due_date=?,priority=?,approval=?,remarks=? WHERE id=?`, [title||'', desc, startDate||'', date, priority||'low', approval||'no', remarks||'', taskId]);
    else await db.query(`UPDATE ${table} SET title=?,description=?,start_date=?,due_date=?,remarks=? WHERE id=?`, [title||'', desc, startDate||'', date, remarks||'', taskId]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
});

// Bulk delete by user — v16: completed tasks excluded
app.delete('/api/tasks/user/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    await db.query(`DELETE FROM ${table} WHERE assigned_to = ? AND status != 'completed'`, [req.params.userId]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/holidays', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { date, name } = req.body;
    if (!date || !name) { conn.release(); return res.status(400).json({ error: 'Date and name required' }); }

    await conn.beginTransaction();
    // Save holiday
    await conn.query('INSERT INTO holidays (date,name) VALUES (?,?)', [date, name]);

    // Build full holiday set for next-working-day calculation
    const [allH] = await conn.query('SELECT date FROM holidays');
    const holidaySet = new Set(allH.map(h => h.date));

    const target = nextWorkingDay(date, holidaySet);

    // Shift ALL pending/revised tasks (delegation + checklist) on this date —
    // both updates (and the holiday insert above) commit or roll back together,
    // so a failure partway through can't leave only one task table shifted.
    const [dr] = await conn.query(
      "UPDATE delegation_tasks SET due_date=? WHERE due_date=? AND status IN ('pending','revised')",
      [target, date]
    );
    const [cr] = await conn.query(
      "UPDATE checklist_tasks SET due_date=? WHERE due_date=? AND status IN ('pending','revised')",
      [target, date]
    );
    const shifted = (dr.affectedRows || 0) + (cr.affectedRows || 0);
    await conn.commit();

    res.json({ success: true, shifted, shiftedTo: target });
  } catch (err) { await conn.rollback(); sendServerError(res, err); } finally { conn.release(); }
});

app.delete('/api/holidays/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    await db.query('DELETE FROM holidays WHERE id=?', [id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/approvals/count', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    const [rows] = isAdminOrPC
      ? await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE status='pending'`)
      : await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE requested_to=? AND status='pending'`, [req.session.userId]);
    res.json({ count: rows[0].count });
  } catch (err) { sendServerError(res, err); }
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
    // Guard against double-processing (two rapid clicks, or a retried
    // request): only actually transition a row that's still 'pending' —
    // the WHERE clause is re-checked atomically by the UPDATE itself, not
    // against the possibly-stale `appr` read above.
    const [updateResult] = await db.query(`UPDATE task_approvals SET status=?,note=? WHERE id=? AND status='pending'`, [action, note||'', approvalId]);
    if (!updateResult.affectedRows) return res.status(400).json({ error: 'This approval has already been processed' });
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
  } catch (err) { sendServerError(res, err); }
});

// ══════════════════════════════════════════════════════
// ATTENDANCE & LEAVE — daily time-in/time-out punch for every employee,
// plus a KM Start/KM End odometer pair for field staff (Sales & Delivery)
// who go out to the market. Both tables are lazily created on first write
// (mirrors the o2d_dealers self-healing pattern).
//
// Who gets the KM fields is its own per-user `users.track_km` flag (set
// from the Users page), kept deliberately separate from the free-text
// `department` column — a mechanic's department text can drift/typo
// without silently turning KM tracking on or off for them.
// ══════════════════════════════════════════════════════
async function ensureAttendanceTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      date DATE NOT NULL,
      time_in DATETIME,
      time_out DATETIME,
      km_start DECIMAL(10,2),
      km_end DECIMAL(10,2),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_date (user_id, date),
      INDEX idx_date (date)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      leave_type VARCHAR(50),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days DECIMAL(4,1),
      reason TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      approved_by INT,
      approved_at DATETIME,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_status (status)
    )
  `);
}
async function withAttendanceTables(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    await ensureAttendanceTables();
    return await fn();
  }
}

app.get('/api/attendance/today', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const [urows] = await db.query('SELECT track_km FROM users WHERE id=?', [uid]);
    const kmTracked = !!(urows[0] && +urows[0].track_km);
    const row = await withAttendanceTables(async () => {
      const [rows] = await db.query('SELECT * FROM attendance WHERE user_id=? AND date=CURDATE()', [uid]);
      return rows[0] || null;
    });
    res.json({ attendance: row, kmTracked });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/attendance/punch-in', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const kmStart = req.body?.kmStart != null && req.body.kmStart !== '' ? parseFloat(req.body.kmStart) : null;
    await withAttendanceTables(async () => {
      const [existing] = await db.query('SELECT id,time_in FROM attendance WHERE user_id=? AND date=CURDATE()', [uid]);
      if (existing[0] && existing[0].time_in) {
        const err = new Error('Already punched in today'); err.code = 'ALREADY_IN'; throw err;
      }
      if (existing[0]) {
        await db.query('UPDATE attendance SET time_in=NOW(), km_start=? WHERE id=?', [kmStart, existing[0].id]);
      } else {
        await db.query('INSERT INTO attendance (user_id,date,time_in,km_start) VALUES (?,CURDATE(),NOW(),?)', [uid, kmStart]);
      }
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ALREADY_IN') return res.status(400).json({ error: err.message });
    sendServerError(res, err);
  }
});

app.post('/api/attendance/punch-out', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const kmEnd = req.body?.kmEnd != null && req.body.kmEnd !== '' ? parseFloat(req.body.kmEnd) : null;
    await withAttendanceTables(async () => {
      const [existing] = await db.query('SELECT id,time_in,time_out FROM attendance WHERE user_id=? AND date=CURDATE()', [uid]);
      if (!existing[0] || !existing[0].time_in) {
        const err = new Error("You haven't punched in yet today"); err.code = 'NOT_IN'; throw err;
      }
      if (existing[0].time_out) {
        const err = new Error('Already punched out today'); err.code = 'ALREADY_OUT'; throw err;
      }
      await db.query('UPDATE attendance SET time_out=NOW(), km_end=? WHERE id=?', [kmEnd, existing[0].id]);
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'NOT_IN' || err.code === 'ALREADY_OUT') return res.status(400).json({ error: err.message });
    sendServerError(res, err);
  }
});

// History — self sees own rows; admin/HOD/PC can pass ?employee=<userId> or
// omit it to see everyone's rows in range (team report).
app.get('/api/attendance/history', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrHod = role === 'admin' || role === 'hod' || role === 'pc';
    const { from, to, employee } = req.query;
    const where = ['a.date BETWEEN ? AND ?'];
    const params = [from || '1970-01-01', to || '2999-12-31'];
    if (!isAdminOrHod) {
      where.push('a.user_id=?'); params.push(req.session.userId);
    } else if (employee && employee !== 'all') {
      where.push('a.user_id=?'); params.push(parseInt(employee, 10));
    }
    const rows = await withAttendanceTables(async () => {
      const [r] = await db.query(
        `SELECT a.*, u.name, u.department FROM attendance a JOIN users u ON a.user_id=u.id WHERE ${where.join(' AND ')} ORDER BY a.date DESC, u.name ASC`,
        params
      );
      return r;
    });
    res.json(rows);
  } catch (err) { sendServerError(res, err); }
});

// ── Leave requests ──
app.get('/api/leave', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrHod = role === 'admin' || role === 'hod' || role === 'pc';
    const { status, employee } = req.query;
    const where = [];
    const params = [];
    if (!isAdminOrHod) {
      where.push('l.user_id=?'); params.push(req.session.userId);
    } else if (employee && employee !== 'all') {
      where.push('l.user_id=?'); params.push(parseInt(employee, 10));
    }
    if (status && status !== 'all') { where.push('l.status=?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await withAttendanceTables(async () => {
      const [r] = await db.query(
        `SELECT l.*, u.name, u.department, ab.name AS approvedByName FROM leave_requests l JOIN users u ON l.user_id=u.id LEFT JOIN users ab ON l.approved_by=ab.id ${whereSql} ORDER BY l.created_at DESC`,
        params
      );
      return r;
    });
    res.json(rows);
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/leave', requireAuth, async (req, res) => {
  try {
    const { leaveType, startDate, endDate, reason } = req.body;
    if (!leaveType || !startDate || !endDate) return res.status(400).json({ error: 'Leave type, start date and end date are required' });
    if (new Date(endDate) < new Date(startDate)) return res.status(400).json({ error: 'End date cannot be before start date' });
    const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    await withAttendanceTables(async () => {
      await db.query(
        'INSERT INTO leave_requests (user_id,leave_type,start_date,end_date,days,reason,status) VALUES (?,?,?,?,?,?,\'pending\')',
        [req.session.userId, leaveType, startDate, endDate, days, reason || '']
      );
    });
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.put('/api/leave/:id', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { action, remarks } = req.body;
    if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const [result] = await db.query(
      `UPDATE leave_requests SET status=?,approved_by=?,approved_at=NOW(),remarks=? WHERE id=? AND status='pending'`,
      [action, req.session.userId, remarks || '', id]
    );
    if (!result.affectedRows) return res.status(400).json({ error: 'This request has already been processed' });
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.delete('/api/leave/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const [rows] = await db.query('SELECT user_id,status FROM leave_requests WHERE id=?', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (!isAdmin && rows[0].user_id !== req.session.userId) return res.status(403).json({ error: 'Not allowed' });
    if (!isAdmin && rows[0].status !== 'pending') return res.status(400).json({ error: 'Only a pending request can be cancelled' });
    await db.query('DELETE FROM leave_requests WHERE id=?', [id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [dept, 'admin', 'hod']);
      const deptUserIds = deptUsers.map(u => u.id);
      if (filterEmployee && filterEmployee !== 'all') {
        // Only honor the filter if that employee is actually in this HOD's own
        // department — otherwise an HOD could view another department's FMS data.
        const fid = parseInt(filterEmployee);
        targetUserIds = deptUserIds.includes(fid) ? [fid] : deptUserIds;
      } else {
        targetUserIds = deptUserIds;
      }
      if (!targetUserIds.length) return res.json({ rows: [], pendingCount: 0 });
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
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/mis/detail', requireAuth, async (req, res) => {
  try {
    const { userId, type, start, end } = req.query;
    if (!userId || !start || !end) return res.status(400).json({ error: 'Missing params' });
    // Regular users can only view their own detail
    if (req.session.role === 'user' && parseInt(userId) !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // HODs are department-scoped everywhere else in MIS — enforce the same here
    // rather than letting them pull any employee's detail company-wide.
    if (req.session.role === 'hod' && parseInt(userId) !== req.session.userId) {
      const [[me], [target]] = await Promise.all([
        db.query('SELECT department FROM users WHERE id=?', [req.session.userId]),
        db.query('SELECT department FROM users WHERE id=?', [userId])
      ]);
      const myDept = me[0]?.department || '';
      const targetDept = target[0]?.department || '';
      if (!myDept || myDept !== targetDept) return res.status(403).json({ error: 'Access denied' });
    }
    const table = type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
    const [allUC] = await db.query('SELECT id,name FROM users');
    const uMapC = {};
    allUC.forEach(u => { uMapC[u.id] = u.name; });
    const [rawCal] = await db.query(`SELECT t.id,t.description,t.status,t.assigned_by,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM ${table} t WHERE t.assigned_to=? AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date ASC`, [userId, start, end]);
    const tasks = rawCal.map(t => ({ ...t, assigned_by_name: uMapC[t.assigned_by]||'' }));
    res.json({ tasks });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
});

// ── PC: Users with pending tasks (for smart dropdown) ──
app.get('/api/users/with-pending-tasks', requireAuth, requireAdminOrPC, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    // dateFrom/dateTo are user-supplied query params — always bound as ? placeholders, never string-interpolated into SQL.
    let dateFilter = 'AND t.due_date <= CURDATE()';
    let dateParams = [];
    if (dateFrom && dateTo) { dateFilter = `AND t.due_date BETWEEN ? AND ?`; dateParams = [dateFrom, dateTo]; }
    const [rows] = await db.query(`
      SELECT DISTINCT u.id, u.name FROM users u
      WHERE u.id IN (
        SELECT DISTINCT assigned_to FROM delegation_tasks t WHERE status='pending' ${dateFilter}
        UNION
        SELECT DISTINCT assigned_to FROM checklist_tasks t WHERE status='pending' ${dateFilter}
      ) AND u.role NOT IN ('admin','pc')
      ORDER BY u.name ASC`, [...dateParams, ...dateParams]);
    res.json(rows);
  } catch(err) { sendServerError(res, err); }
});

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
// Whole-page permission for the Users admin page (list/edit/deactivate/
// delete + the Access-grant tab) — same pattern as canAccessPriceCatalogue.
// Admins always have it; everyone else needs 'users' explicitly granted.
async function canAccessUsersPage(req) {
  if (req.session.role === 'admin') return true;
  const [rows] = await db.query('SELECT page_access FROM users WHERE id=?', [req.session.userId]);
  const pages = parsePageAccess(rows[0] ? rows[0].page_access : null, req.session.role);
  return pages.includes('users');
}

// Every employee needs SOME list of colleagues for ordinary things — a
// "Delegate to" dropdown, a checklist assignee, week-off lookups for date
// generation, department-scoped pickers — none of which need email/phone/
// notification settings/page access. That sensitive detail is reserved for
// the actual Users admin page (GET /api/users below), gated by
// canAccessUsersPage; this one is open to any logged-in user.
app.get('/api/users/roster', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,name,email,department,role,week_off,extra_off,is_active FROM users ORDER BY role DESC,name ASC');
    res.json(rows.map(r => ({
      ...r,
      is_active: (r.is_active === '' || r.is_active === null || r.is_active === undefined) ? 1 : +r.is_active
    })));
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessUsersPage(req))) return res.status(403).json({ error: 'You do not have access to the Users page' });
    const [rows] = await db.query('SELECT id,name,email,notification_email,role,phone,department,week_off,extra_off,is_active,track_km FROM users ORDER BY role DESC,name ASC');
    // page_access fetch separately — safe if column not yet added
    let accessById = {};
    try {
      const [pa] = await db.query('SELECT id, page_access FROM users');
      accessById = Object.fromEntries(pa.map(r => [r.id, r.page_access]));
    } catch(e) {}
    // Treat null/empty string as active (1) — existing users before is_active column had '' in sheet
    res.json(rows.map(r => ({
      ...r,
      is_active: (r.is_active === '' || r.is_active === null || r.is_active === undefined) ? 1 : +r.is_active,
      page_access: parsePageAccess(accessById[r.id], r.role)
    })));
  } catch (err) { sendServerError(res, err); }
});

// Update a user's per-page access (admin only; admins always keep full access)
app.put('/api/users/:id/access', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { pages } = req.body;
    if (!Array.isArray(pages)) return res.status(400).json({ error: 'pages must be an array' });
    const [rows] = await db.query('SELECT role FROM users WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    if (rows[0].role === 'admin') return res.status(400).json({ error: 'Admins always have full access' });
    const cleaned = pages.filter(p => RESTRICTABLE_PAGES.includes(p));
    await db.query('UPDATE users SET page_access=? WHERE id=?', [JSON.stringify(cleaned), req.params.id]);
    res.json({ success: true, page_access: cleaned });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, password, role, phone, department, week_off, extra_off, track_km } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const [ex] = await db.query('SELECT id FROM users WHERE email=?', [email]);
    if (ex[0]) return res.status(400).json({ error: 'Email already exists' });
    await db.query('INSERT INTO users (name,email,notification_email,password,role,phone,department,week_off,extra_off,track_km) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [name, email, notification_email||'', hashPassword(password), role||'user', phone||null, department||'', week_off||'', extra_off||'', track_km ? 1 : 0]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, role, password, phone, department, week_off, extra_off, track_km } = req.body;
    if (password) await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,password=?,phone=?,department=?,week_off=?,extra_off=?,track_km=? WHERE id=?',
      [name,email,notification_email||'',role,hashPassword(password),phone||null,department||'',week_off||'',extra_off||'',track_km?1:0,req.params.id]);
    else await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,phone=?,department=?,week_off=?,extra_off=?,track_km=? WHERE id=?',
      [name,email,notification_email||'',role,phone||null,department||'',week_off||'',extra_off||'',track_km?1:0,req.params.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    await db.query('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// Check pending checklist tasks before deactivating
app.get('/api/users/:id/pending-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [tasks] = await db.query(
      `SELECT id, COALESCE(title,'') AS title, description, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM checklist_tasks WHERE assigned_to=? AND status IN ('pending','revised')`,
      [req.params.id]
    );
    res.json(tasks);
  } catch (err) { sendServerError(res, err); }
});

// Deactivate user (with per-task checklist reassignment)
app.put('/api/users/:id/deactivate', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const uid = req.params.id;
    if (parseInt(uid) === req.session.userId) { conn.release(); return res.status(400).json({ error: 'Cannot deactivate yourself' }); }
    const { taskAssignments } = req.body;
    await conn.beginTransaction();
    // Reassignment + deactivation commit together — a failure partway
    // through shouldn't leave some tasks reassigned but the user still active
    // (or vice versa).
    if (Array.isArray(taskAssignments) && taskAssignments.length) {
      for (const { taskIds, assignTo } of taskAssignments) {
        if (Array.isArray(taskIds) && taskIds.length && assignTo) {
          await conn.query(`UPDATE checklist_tasks SET assigned_to=? WHERE id IN (${taskIds.map(()=>'?').join(',')})`, [assignTo, ...taskIds]);
        }
      }
    }
    await conn.query('UPDATE users SET is_active=0 WHERE id=?', [uid]);
    await conn.commit();
    res.json({ success: true });
  } catch (err) { await conn.rollback(); sendServerError(res, err); } finally { conn.release(); }
});

// Reactivate user
app.put('/api/users/:id/activate', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('UPDATE users SET is_active=1 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// Force sign-out — invalidates this one user's current session(s) immediately,
// without deactivating the account. They just get bounced to login on their next request.
app.put('/api/users/:id/signout', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('UPDATE users SET force_logout_at=NOW() WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// Force sign-out every user at once (including the admin issuing this)
app.post('/api/users/signout-all', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [result] = await db.query('UPDATE users SET force_logout_at=NOW()');
    res.json({ success: true, count: result.affectedRows });
  } catch (err) { sendServerError(res, err); }
});

// One-time migration: set is_active=1 for all users where it is null/empty
app.post('/api/users/fix-active', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [result] = await db.query(`UPDATE users SET is_active=1 WHERE is_active='' OR is_active IS NULL`);
    res.json({ success: true, fixed: result.affectedRows });
  } catch (err) { sendServerError(res, err); }
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
        [u.name, u.email, hashPassword(u.password), u.role||'user', u.phone||null, u.department||'', u.week_off||'', u.extra_off||'']);
      added++;
    }
    res.json({ success: true, added, skipped, errors });
  } catch (err) { sendServerError(res, err); }
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
      if (newPassword) await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=?,password=? WHERE id=?', [name,email,notification_email||'',phone||null,hashPassword(newPassword),uid]);
      else await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    } else {
      await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    }
    if (profileImage !== undefined) await db.query('UPDATE users SET profile_image=? WHERE id=?', [profileImage||null, uid]);
    req.session.name = name;
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/profile/image', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE users SET profile_image=? WHERE id=?', [req.body.image||null, req.session.userId]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// ══════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════
// A user may read/post comments on a task only if they're the assignee, the
// assigner, an admin/PC (already broadly-visible roles elsewhere in the
// app), or an HOD over the assignee's own department — not just any
// logged-in employee guessing/incrementing a task id.
async function canAccessTaskComments(req, taskId, taskType) {
  if (req.session.role === 'admin' || req.session.role === 'pc') return true;
  const table = getTable(taskType);
  const [rows] = await db.query(`SELECT assigned_to, assigned_by FROM ${table} WHERE id=?`, [taskId]);
  const task = rows[0];
  if (!task) return false;
  if (task.assigned_to === req.session.userId || task.assigned_by === req.session.userId) return true;
  if (req.session.role === 'hod') {
    const [[me], [assignee]] = await Promise.all([
      db.query('SELECT department FROM users WHERE id=?', [req.session.userId]),
      db.query('SELECT department FROM users WHERE id=?', [task.assigned_to])
    ]);
    const myDept = me[0]?.department || '';
    if (myDept && myDept === (assignee[0]?.department || '')) return true;
  }
  return false;
}

app.get('/api/comments/:type/:taskId', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessTaskComments(req, req.params.taskId, req.params.type))) {
      return res.status(403).json({ error: 'You do not have access to this task' });
    }
    const [rows] = await db.query(`SELECT tc.id,tc.comment,tc.created_at,u.name AS userName FROM task_comments tc JOIN users u ON tc.user_id=u.id WHERE tc.task_id=? AND tc.task_type=? ORDER BY tc.created_at ASC`, [req.params.taskId, req.params.type]);
    res.json(rows);
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/comments', requireAuth, async (req, res) => {
  try {
    const { taskId, taskType, comment } = req.body;
    if (!comment || !taskId || !taskType) return res.status(400).json({ error: 'All fields required' });
    if (!(await canAccessTaskComments(req, taskId, taskType))) {
      return res.status(403).json({ error: 'You do not have access to this task' });
    }
    await db.query('INSERT INTO task_comments (task_id,task_type,user_id,comment) VALUES (?,?,?,?)', [taskId, taskType, req.session.userId, comment]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM task_comments WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].user_id !== req.session.userId && req.session.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
    await db.query('DELETE FROM task_comments WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// ══════════════════════════════════════════════════════
// FMS ADMIN APIs
// ══════════════════════════════════════════════════════

app.get('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query(`SELECT f.*,u.name AS createdByName FROM fms_sheets f JOIN users u ON f.created_by=u.id ORDER BY f.created_at DESC`);
    res.json(sheets);
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { await conn.rollback(); sendServerError(res, err); } finally { conn.release(); }
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
  } catch (err) { await conn.rollback(); sendServerError(res, err); } finally { conn.release(); }
});

app.delete('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM fms_sheets WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
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
    sendServerError(res, err);
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
    sendServerError(res, err);
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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

    // Same doer restriction as marking a step done — don't expose another
    // step's pending rows (which can contain customer/dealer data) to
    // employees who aren't assigned to it.
    if (req.session.role !== 'admin') {
      const [doerRows] = await db.query('SELECT 1 FROM fms_step_doers WHERE step_id=? AND user_id=?', [step.id, req.session.userId]);
      if (!doerRows.length) {
        const [anyDoer] = await db.query('SELECT 1 FROM fms_step_doers WHERE step_id=? LIMIT 1', [step.id]);
        if (anyDoer.length) return res.status(403).json({ error: 'You are not assigned to this step' });
      }
    }

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
        // Only show columns the admin explicitly picked for this step — no
        // longer falls back to dumping every sheet column when unconfigured.
        let colsToShow = showCols.length ? showCols : [];
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
    sendServerError(res, err);
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

    // Only an assigned doer for this step (or an admin) can mark it done —
    // steps with nobody assigned yet stay open, same rule as assertIsStepDoer.
    if (req.session.role !== 'admin') {
      const [doerRows] = await db.query('SELECT 1 FROM fms_step_doers WHERE step_id=? AND user_id=?', [step.id, req.session.userId]);
      if (!doerRows.length) {
        const [anyDoer] = await db.query('SELECT 1 FROM fms_step_doers WHERE step_id=? LIMIT 1', [step.id]);
        if (anyDoer.length) return res.status(403).json({ error: 'You are not assigned to this step' });
      }
    }

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
    sendServerError(res, err);
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
const SFMS_AREA_TAB = 'Area';
const SFMS_ZONE_TAB = 'Zone';
// Reusing confirmed-unused columns (verified directly against the live
// sheet's row-6 header: BC/BD/BF/BG/BH all read literally "(Unused)")
// instead of appending new ones, so the sheet's existing column layout/
// formulas aren't disturbed.
const SFMS_ZONE_COL = 'BC';
const SFMS_OWNERSHIP_COL = 'BD';
const SFMS_WARRANTY_CHARGES_AGREED_COL = 'BF';
// Multi-spare Takeout/In-Out (points 1/3) — a complaint can need more than
// one different spare item, and In/Out now tracks new (unused, back to
// stock) vs old (faulty, removed from the product) returned counts per
// item. Stored as a JSON array string in these last two confirmed-unused
// columns; itemName/spareTaken/qtyReturned stay populated too (first
// item's values) so every existing report/list column keeps working
// unchanged for the common single-item case.
const SFMS_SPARE_OUT_COL = 'BG';
const SFMS_SPARE_IN_COL = 'BH';
// Point 2/3/8 of the complaint form corrections — whether the product is the
// dealer's own stock or something a customer already purchased. Drives
// whether Bill Upload is shown/required on the create form, and is shown
// plainly on the Spare Check (step 2) tab per point 8.
const SFMS_OWNERSHIP_VALUES = ['Dealer Stock Piece', 'Customer Purchased Piece'];

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
  // Reordered (was step 4) — mechanic gets assigned zone-wise before the
  // spare is taken out, per the field-batching workflow.
  { n: 3, label: 'Assign Complaint to Mechanic After Batching', planned: 'AC', actual: 'AD', status: 'AE',
    extra: [
      { key: 'zone', col: SFMS_ZONE_COL, label: 'Zone' },
      { key: 'mechanic', col: 'AF', label: 'Mechanic Name' }
    ], timeDelay: 'AG' },
  // Reordered (was step 3) — now comes after Assign.
  { n: 4, label: 'Takeout Spare', planned: 'W', actual: 'X', status: 'Y',
    extra: [
      { key: 'itemName', col: 'BE', label: 'Item Name' },
      { key: 'spareTaken', col: 'Z', label: 'Qty' },
      { key: 'spareOutJson', col: SFMS_SPARE_OUT_COL, label: 'Spares Taken (all items)' },
      { key: 'spareReturned', col: 'AA', label: 'Spares Returned' }
    ],
    timeDelay: 'AB' },
  // Reordered (was step 6) — spare in/out is now logged before the OTP
  // solve step, not after. Point 6: dropped "Out" from the label — Takeout
  // (step 4) is the "out" side, this step only asks what came back in.
  { n: 5, label: 'Spare In Entry (in the field)', planned: 'AP', actual: 'AQ', status: 'AT',
    extra: [
      { key: 'qtyReturned', col: 'AR', label: 'Item Qty (Returned)' },
      { key: 'reasonIfShort', col: 'AS', label: 'Reason (if Short)' },
      { key: 'spareInJson', col: SFMS_SPARE_IN_COL, label: 'Spares In (all items, new/old)' }
    ],
    timeDelay: 'AU' },
  // Reordered (was step 5) — mechanic reaching the customer's location,
  // OTP-gated, plus a repair-status answer. Now comes after In/Out.
  { n: 6, label: "Mechanic's Complaint Solve", planned: 'AH', actual: 'AI', status: 'AJ',
    extra: [{ key: 'repairStatus', col: 'AK', label: 'Repair Status' }],
    timeDelay: 'AM', otpRequired: true },
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
//
// The sheet has no timezone tag on its numbers — a serial's fractional part
// is just whatever wall-clock hour the business reads it as, which for this
// app is IST. date.getTime() is a UTC instant, so without shifting it first
// every serial we wrote came out 5:30 fast of real IST time (a 4:06pm punch
// recorded as if it were 10:36am) — visibly wrong to anyone reading the
// sheet, and silently wrong for the sheet's own business-hours formulas
// (WORKDAY.INTL/HOUR() checks), which were judging "before 10am"/"after
// 6pm" against the UTC hour instead of the real IST one.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function sfmsDateToSerial(date) {
  return (date.getTime() + IST_OFFSET_MS - Date.UTC(1899, 11, 30)) / 86400000;
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

async function sfmsFetchComplaints() {
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
        // A multi-product complaint shares one "C-N" group across sibling rows
        // ("C-N-1", "C-N-2", ...) — groupNo is that shared prefix, used by the
        // frontend to fold sibling product-lines into one card. Single-product
        // complaints (no "-line" suffix) are their own group of one.
        groupNo: (String(get('B') || '').match(/^(C-\d+)/) || [null, get('B') || ''])[1],
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
        area: get('N') || '',
        zone: get(SFMS_ZONE_COL) || '',
        productOwnership: get(SFMS_OWNERSHIP_COL) || '',
        warrantyChargesAgreed: get(SFMS_WARRANTY_CHARGES_AGREED_COL) || ''
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
    return complaints;
}

app.get('/api/service-fms', requireAuth, async (req, res) => {
  try {
    res.json(await sfmsFetchComplaints());
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    sendServerError(res, err);
  }
});

// NOTE (point 7): a "Spare In/Out Table" + "Item-Wise" report already exist
// in the frontend Reports tab (public/app.html, buildReportSpareTable /
// buildReportItemWise), built the same way — reshaping Step 3/Step 6 data
// already returned by GET /api/service-fms — so no separate endpoint is
// needed here.

app.post('/api/service-fms', requireAuth, async (req, res) => {
  try {
    const {
      filledByName, mobile, customerType, dealerName,
      productLocation, address, area, productOwnership, billPhoto, products
    } = req.body;
    if (!filledByName || !mobile) {
      return res.status(400).json({ error: 'Name and mobile are required' });
    }
    if (!SFMS_OWNERSHIP_VALUES.includes(productOwnership)) {
      return res.status(400).json({ error: 'Select whether this is a Dealer Stock Piece or a Customer Purchased Piece' });
    }
    // Bill upload is only relevant (and required) for a customer's own
    // purchased piece — a dealer's stock piece was never billed to a
    // customer, so there's no bill to attach.
    if (productOwnership === 'Customer Purchased Piece' && !billPhoto) {
      return res.status(400).json({ error: 'Bill photo is required for a Customer Purchased Piece' });
    }
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'At least one product is required' });
    }
    for (const p of products) {
      if (!p || !p.productName || !p.problemDescription) {
        return res.status(400).json({ error: 'Every product needs a product name and problem description' });
      }
      if (p.productPhoto && p.productPhoto.length > SFMS_PHOTO_MAX_CHARS) return res.status(400).json({ error: 'A product photo is too large — try a smaller/compressed image' });
    }
    if (billPhoto && billPhoto.length > SFMS_PHOTO_MAX_CHARS) return res.status(400).json({ error: 'Bill photo is too large — try a smaller/compressed image' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);

    const colB = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SFMS_SHEET_ID, range: `'${SFMS_TAB}'!B${SFMS_DATA_START_ROW}:B`, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const bRows = colB.data.values || [];
    let maxNum = 0;
    bRows.forEach(r => { const m = String(r[0] || '').match(/C-(\d+)/); if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10)); });
    const groupNo = `C-${await claimNextSeqValue('service_fms_group', maxNum + 1)}`;
    const timestamp = sfmsDateToSerial(new Date());

    // Photos are uploaded to Drive (never stored as raw base64 in the sheet) —
    // the sheet cell only ever holds the resulting share link. The bill photo
    // is shared across every product line in this complaint (one customer,
    // one bill); each product line can have its own product photo.
    let billPhotoLink = '';
    if (billPhoto) billPhotoLink = await uploadPhotoToDrive(billPhoto, `${groupNo}-bill.jpg`);

    // Each product becomes its own sheet row — "C-N-1", "C-N-2", ... — sharing
    // groupNo so every product is tracked through the full 8-step pipeline
    // independently (own warranty/spare/mechanic/solve status), per point 2.
    const complainNos = products.map((p, i) => products.length > 1 ? `${groupNo}-${i + 1}` : groupNo);
    const rows = [];
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const purchaseDateSerial = p.purchaseDate ? sfmsDateToSerial(new Date(p.purchaseDate + 'T00:00:00Z')) : '';
      const productPhotoLink = p.productPhoto ? await uploadPhotoToDrive(p.productPhoto, `${complainNos[i]}-product.jpg`) : '';
      rows.push([
        timestamp, complainNos[i], filledByName, mobile, customerType || '', dealerName || '',
        p.productName, purchaseDateSerial, p.problemDescription, billPhotoLink, productPhotoLink,
        productLocation || '', address || '', area || ''
      ]);
    }

    // append (not a computed-row update) so a stale/short bRows read can never
    // overwrite an existing row — Sheets itself finds the true last row.
    const appendRes = await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SFMS_SHEET_ID,
      range: `'${SFMS_TAB}'!A${SFMS_DATA_START_ROW}:N`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    });
    const writtenRange = appendRes.data.updates.updatedRange; // e.g. "'Complain FMS'!A195:N196"
    const firstRow = parseInt(writtenRange.match(/![A-Z]+(\d+)/)[1], 10);

    // The sheet's own row-creation flow only ever copied down the "Planned" date
    // formulas for the first 3 steps (O/S/W) — every complaint made through this
    // app was silently missing them for steps 4/5/6/8 (AC/AH/AP/AV). Write the
    // exact same per-row formula pattern every older row already has, so newly
    // created complaints behave identically — once per product row.
    // Point 4 — warranty was already computed on the create form itself
    // (Purchase Date + Product Master's Warranty Months), so asking staff
    // to manually re-confirm "Check Product in Warranty" as Step 1 is pure
    // duplication. Auto-mark it done here with the same computed answer,
    // wherever it's determinable — otherwise Step 1 is left as a normal
    // manual step (e.g. a product name not found in Product Master).
    const { products: masterProducts } = await getMasterWorkbookData();
    const warrantyMonthsByName = Object.fromEntries(
      masterProducts.filter(mp => mp.warrantyMonths).map(mp => [mp.name.trim().toLowerCase(), mp.warrantyMonths])
    );

    const formulaData = [];
    for (let i = 0; i < products.length; i++) {
      const r = firstRow + i;
      const p = products[i];
      const warrantyMonths = warrantyMonthsByName[(p.productName || '').trim().toLowerCase()];
      if (warrantyMonths && p.purchaseDate) {
        const expiry = new Date(p.purchaseDate + 'T00:00:00Z');
        expiry.setMonth(expiry.getMonth() + warrantyMonths);
        formulaData.push(
          { range: `'${SFMS_TAB}'!P${r}`, values: [[timestamp]] },
          { range: `'${SFMS_TAB}'!Q${r}`, values: [[new Date() <= expiry ? 'Yes' : 'No']] }
        );
      }
      formulaData.push(
        { range: `'${SFMS_TAB}'!O${r}`, values: [[`=IF(A${r}<>"",IFS(HOUR(A${r}+O$5)>$D$1,workday.intl(A${r},1,"0000001")+$C$1/24+O$5,HOUR(A${r}+O$5)<$C$1,Datevalue(A${r})+$C$1/24+O$5,and(hour(A${r}+O$5)>=$C$1,hour(A${r}+O$5)<=$D$1),A${r}+O$5),"")`]] },
        { range: `'${SFMS_TAB}'!S${r}`, values: [[`=IF(P${r}<>"",IFS(HOUR(P${r}+S$5)>$D$1,workday.intl(P${r},1,"0000001")+$C$1/24+S$5,HOUR(P${r}+S$5)<$C$1,Datevalue(P${r})+$C$1/24+S$5,and(hour(P${r}+S$5)>=$C$1,hour(P${r}+S$5)<=$D$1),P${r}+S$5),"")`]] },
        { range: `'${SFMS_TAB}'!W${r}`, values: [[`=if(T${r},workday.intl(int(T${r}),0,"0000001",Holidays!A:A)+"17:00","")`]] },
        { range: `'${SFMS_TAB}'!AC${r}`, values: [[`=if(X${r},workday.intl(int(X${r}),0,"0000001",Holidays!A:A)+"18:00","")`]] },
        { range: `'${SFMS_TAB}'!AH${r}`, values: [[`=if(AD${r},workday.intl(int(AD${r}),0,"0000001",Holidays!A:A)+"18:00","")`]] },
        { range: `'${SFMS_TAB}'!AP${r}`, values: [[`=if(AI${r},WORKDAY.INTL(AI${r},AN$5,"0000001",Holidays!A:A)+hour(AI${r})/24+MINUTE(AI${r})/1440,"")`]] },
        { range: `'${SFMS_TAB}'!AV${r}`, values: [[`=if(AO${r},workday.intl(int(AO${r}),0,"0000001",Holidays!A:A)+"19:30","")`]] },
        { range: `'${SFMS_TAB}'!${SFMS_OWNERSHIP_COL}${r}`, values: [[productOwnership]] }
      );
      // Out-of-warranty-but-customer-agreed-to-pay flag (point 5) — written only
      // when the frontend determined the product was out of warranty and the
      // customer explicitly agreed to be charged.
      if (p.warrantyChargesAgreed) {
        formulaData.push({ range: `'${SFMS_TAB}'!${SFMS_WARRANTY_CHARGES_AGREED_COL}${r}`, values: [['Yes']] });
      }
    }
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: SFMS_SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: formulaData }
    });

    // Point 6 — confirmation to the customer once the complaint is actually
    // registered. Never let a WhatsApp failure fail the complaint creation
    // itself — the complaint is already saved at this point.
    const productList = products.map(p => p.productName).join(', ');
    sendWhatsApp(mobile, `Ajanta Appliances Service: Your complaint ${groupNo} for ${productList} has been registered. Our team will get back to you soon.`)
      .catch(e => console.log('  ⚠️ Complaint confirmation WhatsApp failed:', e.message));

    res.json({ success: true, groupNo, complainNos, firstRow });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    sendServerError(res, err);
  }
});

// Edit Complaint (point 7) — updates one product-line row's own intake
// fields after the complaint has already been saved. A multi-product
// complaint's sibling rows are edited the same way, one row at a time.
app.put('/api/service-fms/:row', requireAuth, async (req, res) => {
  try {
    const row = parseInt(req.params.row, 10);
    if (!row) return res.status(400).json({ error: 'Invalid row' });
    const {
      filledByName, mobile, customerType, dealerName, productOwnership,
      productName, purchaseDate, problemDescription,
      productLocation, address, area, billPhoto, productPhoto
    } = req.body;
    if (!filledByName || !mobile) return res.status(400).json({ error: 'Name and mobile are required' });
    if (!productName || !problemDescription) return res.status(400).json({ error: 'Product name and problem description are required' });
    if (!SFMS_OWNERSHIP_VALUES.includes(productOwnership)) {
      return res.status(400).json({ error: 'Select whether this is a Dealer Stock Piece or a Customer Purchased Piece' });
    }
    if (billPhoto && billPhoto.length > SFMS_PHOTO_MAX_CHARS) return res.status(400).json({ error: 'Bill photo is too large — try a smaller/compressed image' });
    if (productPhoto && productPhoto.length > SFMS_PHOTO_MAX_CHARS) return res.status(400).json({ error: 'Product photo is too large — try a smaller/compressed image' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);

    // Bill photo is only required (client + here) for a Customer Purchased
    // Piece, and only if there isn't already one on file — an edit doesn't
    // force a re-upload of an existing bill.
    if (productOwnership === 'Customer Purchased Piece' && !billPhoto) {
      const existing = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: SFMS_SHEET_ID, range: `'${SFMS_TAB}'!J${row}:J${row}`
      });
      const hasExistingBill = !!(existing.data.values && existing.data.values[0] && existing.data.values[0][0]);
      if (!hasExistingBill) return res.status(400).json({ error: 'Bill photo is required for a Customer Purchased Piece' });
    }

    const purchaseDateSerial = purchaseDate ? sfmsDateToSerial(new Date(purchaseDate + 'T00:00:00Z')) : '';
    const data = [
      { range: `'${SFMS_TAB}'!C${row}`, values: [[filledByName]] },
      { range: `'${SFMS_TAB}'!D${row}`, values: [[mobile]] },
      { range: `'${SFMS_TAB}'!E${row}`, values: [[customerType || '']] },
      { range: `'${SFMS_TAB}'!F${row}`, values: [[dealerName || '']] },
      { range: `'${SFMS_TAB}'!G${row}`, values: [[productName]] },
      { range: `'${SFMS_TAB}'!H${row}`, values: [[purchaseDateSerial]] },
      { range: `'${SFMS_TAB}'!I${row}`, values: [[problemDescription]] },
      { range: `'${SFMS_TAB}'!L${row}`, values: [[productLocation || '']] },
      { range: `'${SFMS_TAB}'!M${row}`, values: [[address || '']] },
      { range: `'${SFMS_TAB}'!N${row}`, values: [[area || '']] },
      { range: `'${SFMS_TAB}'!${SFMS_OWNERSHIP_COL}${row}`, values: [[productOwnership]] }
    ];
    if (billPhoto) {
      const link = await uploadPhotoToDrive(billPhoto, `edit-${row}-bill.jpg`);
      data.push({ range: `'${SFMS_TAB}'!J${row}`, values: [[link]] });
    }
    if (productPhoto) {
      const link = await uploadPhotoToDrive(productPhoto, `edit-${row}-product.jpg`);
      data.push({ range: `'${SFMS_TAB}'!K${row}`, values: [[link]] });
    }
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: SFMS_SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data }
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    sendServerError(res, err);
  }
});

// Sends a 6-digit OTP to the customer's WhatsApp; the mechanic must read it
// from the customer and enter it to mark Step 6 (Complaint Solve) done.
app.post('/api/service-fms/:row/step/:stepNum/send-otp',
  requireAuth,
  rateLimit(req => `sfms-send-otp:${req.params.row}`, 3, 15 * 60 * 1000),
  async (req, res) => {
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

    await sendWhatsApp(mobile, `Ajanta Appliances Service: Your OTP to confirm the technician's visit is ${otp}. Please share this with the technician. Valid for 30 minutes.`);

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
    sendServerError(res, err);
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

// Real spare-parts catalog (396 items, "8. Spare Parts Master" in the same
// workbook as Product Master) — read-only, merged with the small ad-hoc
// "Items" list below on the frontend so "+ Add New" still works for
// anything not in this master catalog.
app.get('/api/service-fms/spare-parts', requireAuth, async (req, res) => {
  try {
    const { spareParts } = await getMasterWorkbookData();
    res.json(spareParts);
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/service-fms/items', requireAuth, async (req, res) => {
  try { res.json(await sfmsGetList(SFMS_ITEMS_TAB)); }
  catch (err) { sendServerError(res, err); }
});
app.post('/api/service-fms/items', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Item name is required' });
    await sfmsAddToList(SFMS_ITEMS_TAB, name);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// Area — free-text "Where is the product / Location" field turned into a
// self-serve dropdown (point 4). Same single-column tab pattern as Items.
app.get('/api/service-fms/areas', requireAuth, async (req, res) => {
  try { res.json(await sfmsGetList(SFMS_AREA_TAB)); }
  catch (err) { sendServerError(res, err); }
});
app.post('/api/service-fms/areas', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Area name is required' });
    await sfmsAddToList(SFMS_AREA_TAB, name);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// Area -> Zone map (column B of the Area tab, seeded from the "Area
// Details" zone grid) — lets the Assign step's list be filtered by Zone
// even though a complaint only ever records its Area, not a zone, at
// creation time. Areas added later via "+ Add New" simply have no zone
// here until someone fills column B in the sheet directly.
app.get('/api/service-fms/area-zone-map', requireAuth, async (req, res) => {
  try {
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const result = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SFMS_SHEET_ID, range: `'${SFMS_AREA_TAB}'!A2:B`
    });
    const map = {};
    (result.data.values || []).forEach(r => { if (r[0] && r[1]) map[r[0]] = r[1]; });
    res.json(map);
  } catch (err) { sendServerError(res, err); }
});

// Zone — groups mechanics for zone-wise assignment (point 8). Same pattern.
app.get('/api/service-fms/zones', requireAuth, async (req, res) => {
  try { res.json(await sfmsGetList(SFMS_ZONE_TAB)); }
  catch (err) { sendServerError(res, err); }
});
app.post('/api/service-fms/zones', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Zone name is required' });
    await sfmsAddToList(SFMS_ZONE_TAB, name);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// Mechanics tab has a second column (B = Mobile) so the Mechanic-Wise report
// can WhatsApp a mechanic directly via the WhatsApp API instead of opening wa.me,
// and a third column (C = Zone) for zone-wise assignment filtering (point 8).
async function sfmsGetMechanics() {
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SFMS_SHEET_ID,
    range: `'${SFMS_MECHANICS_TAB}'!A2:C`
  });
  return (result.data.values || [])
    .filter(r => r[0])
    .map(r => ({ name: r[0], mobile: r[1] || '', zone: r[2] || '' }));
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
  catch (err) { sendServerError(res, err); }
});
app.post('/api/service-fms/mechanics', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    const zone = String(req.body.zone || '').trim();
    if (!name) return res.status(400).json({ error: 'Mechanic name is required' });
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SFMS_SHEET_ID,
      range: `'${SFMS_MECHANICS_TAB}'!A:C`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[name, mobile, zone]] }
    });
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});
app.post('/api/service-fms/mechanics/mobile', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    if (!name || !mobile) return res.status(400).json({ error: 'Mechanic name and mobile are required' });
    await sfmsSetMechanicMobile(name, mobile);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
      // A 6-digit code is guessable given enough attempts — cap attempts per
      // row rather than relying on the TTL alone.
      if (isRateLimited(`sfms-otp-verify:${row}`, 8, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many incorrect attempts — please wait a bit and try again.' });
      }
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
    sendServerError(res, err);
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
// other spreadsheet involved).
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
  { n: 4, label: 'Make Bill', doer: 'Accountant', tat: '10 min', planned: 'AF', actual: 'AG', status: 'AH', timeDelay: 'AI',
    // Bill detail columns live far from this step's own Planned/Actual/Status
    // block, at the very end of the sheet (BJ:BM) — everything else here
    // reads BJ/BK for display already; this is what actually WRITES them.
    extra: [
      { key: 'billNo', col: 'BJ', label: 'Bill No' },
      { key: 'billAmount', col: 'BK', label: 'Bill Amount' },
      { key: 'photoLink', col: 'BL', label: 'Invoice Photo' },
      { key: 'billDate', col: 'BM', label: 'Bill Date', isDate: true }
    ] },
  { n: 5, label: 'Goods Takeout and Photo', doer: 'Rajesh (Warehouse Manager)', tat: '30 min', planned: 'AJ', actual: 'AK', status: 'AL', timeDelay: 'AO',
    extra: [
      { key: 'doerName', col: 'AM', label: 'Doer Name' },
      { key: 'photo', col: 'AN', label: 'Photo (link)' }
    ] },
  { n: 6, label: 'Check physical stock with bill', doer: 'Aziz', tat: '10 min', planned: 'AP', actual: 'AQ', status: 'AR', timeDelay: 'AT',
    extra: [ { key: 'doerName', col: 'AS', label: 'Doer Name' } ] },
  { n: 7, label: 'Arrange Loader', doer: 'Kavita', tat: '10 min', planned: 'AU', actual: 'AV', status: 'AW', timeDelay: 'AX', extra: [] },
  { n: 8, label: 'In/ Out Entry', doer: 'Priyanka (SCCRR)', tat: '10 min', planned: 'AY', actual: 'AZ', status: 'BA', timeDelay: 'BB', extra: [] },
  { n: 9, label: 'Load Goods', doer: 'Rajesh (Warehouse Manager)', tat: '30 min', planned: 'BC', actual: 'BD', status: 'BE', timeDelay: 'BG',
    extra: [
      { key: 'loaderName', col: 'BF', label: 'Doer Name' },
      { key: 'deliveryBy', col: 'BI', label: 'Delivery By' }
    ] }
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
  } catch (err) { sendServerError(res, err); }
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
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// No caching here — Vercel runs this across multiple serverless instances,
// each with its own memory, so a TTL cache led to "Mark Done" writes not
// showing up until some later request happened to land on an instance whose
// cache had already expired. The sheet's small now (a handful of rows, not
// the 2300+ it briefly held), so a fresh read on every request is fast
// enough that the cache wasn't worth that inconsistency.
async function getO2dOrders() {
  {
    const stepDoersMap = await getO2dStepDoersMap();
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
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
        if (!isRateLimit || attempt >= 2) throw e;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    const sheetRows = result.data.values || [];
    const lines = sheetRows.map((r, i) => {
      const rowNum = O2D_DATA_START_ROW + i;
      const get = col => r[colToIdx(col)];
      if (!get('R')) return null; // skip blank rows (Order Id is the unique key column)
      const line = {
        row: rowNum,
        timestamp: sfmsSerialToDate(get('A')),
        counterType: get('B') || '',
        counterName: get('C') || '',
        area: get('D') || '',
        dateToSend: get('E') ? sfmsSerialToDate(get('E')).split(' ')[0] : '',
        whenToSend: get('F') || '',
        channel: get('G') || '',
        deliverByTransport: get('H') || '',
        makePerformaInvoice: get('I') || '',
        orderBy: get('J') || '',
        paymentTerms: get('K') || '',
        remark: get('L') || '',
        productName: get('M') || '',
        rate: get('N') || '',
        qty: get('O') || '',
        isSample: get('P') || '',
        orderNo: get('Q') || '',
        orderId: get('R') || '',
        billNo: get('BJ') || '',
        amount: get('BK') || ''
      };
      line.steps = O2D_STEPS.map(sd => {
        const step = {
          planned: sd.planned ? sfmsSerialToDate(get(sd.planned)) : '',
          actual: sd.actual ? sfmsSerialToDate(get(sd.actual)) : '',
          status: get(sd.status) || ''
        };
        sd.extra.forEach(e => {
          const val = get(e.col);
          step[e.key] = e.isDate && typeof val === 'number' ? sfmsSerialToDate(val).split(' ')[0] : (val || '');
        });
        return step;
      });
      let lineCurrentStep = 0;
      for (const s of line.steps) { if (s.status) lineCurrentStep++; else break; }
      line.currentStep = lineCurrentStep;
      return line;
    }).filter(Boolean);

    // One order = one Order No., not one product row. A step is only
    // "done" for the order once every one of its product lines has it, and
    // the order's currentStep is bottlenecked by whichever line is furthest
    // behind — so a freshly added item (Add Order, step 3) correctly drags
    // the whole order back to "pending" on the steps it hasn't cleared,
    // while lines that already finished those steps keep their own data.
    const orderNos = [];
    const byOrderNo = {};
    lines.forEach(line => {
      if (!byOrderNo[line.orderNo]) { byOrderNo[line.orderNo] = []; orderNos.push(line.orderNo); }
      byOrderNo[line.orderNo].push(line);
    });

    const orders = orderNos.map(orderNo => {
      const group = byOrderNo[orderNo];
      const first = group[0];
      const o = {
        orderNo,
        rows: group.map(l => l.row),
        timestamp: group.map(l => l.timestamp).sort()[0],
        counterType: first.counterType,
        counterName: first.counterName,
        area: first.area,
        dateToSend: first.dateToSend,
        whenToSend: first.whenToSend,
        channel: first.channel,
        deliverByTransport: first.deliverByTransport,
        makePerformaInvoice: first.makePerformaInvoice,
        orderBy: first.orderBy,
        paymentTerms: first.paymentTerms,
        remark: first.remark,
        billNo: first.billNo,
        // Bill Amount is an order-level value the Accountant enters once (see
        // writeO2dStepForOrder) but gets written identically onto every
        // product-line row sharing this Order No — summing it across the
        // group was multiplying a 2-product order's real amount by 2x, a
        // 3-product order by 3x, etc. Every row in the group has the same
        // value, so just take one.
        amount: Number(first.amount) || 0,
        productName: group.length > 1 ? `${first.productName} +${group.length - 1} more` : first.productName,
        qty: group.reduce((sum, l) => sum + (Number(l.qty) || 0), 0),
        // availability = the raw Good Check (step 2) status for this line —
        // 'Yes'/'No'/'' — kept per product so other steps can show what was
        // picked instead of asking the per-item question again.
        products: group.map(l => ({ row: l.row, orderId: l.orderId, productName: l.productName, rate: l.rate, qty: l.qty, isSample: l.isSample, currentStep: l.currentStep, availability: (l.steps[1] && l.steps[1].status) || '' }))
      };
      o.steps = O2D_STEPS.map((sd, idx) => {
        const lineSteps = group.map(l => l.steps[idx]);
        const allDone = lineSteps.every(s => s.status);
        const actuals = lineSteps.map(s => s.actual).filter(Boolean).sort();
        const step = {
          n: sd.n, label: sd.label, doer: sd.doer, tat: sd.tat, doers: stepDoersMap[sd.n] || [],
          planned: lineSteps[0].planned,
          actual: allDone ? (actuals[actuals.length - 1] || '') : '',
          // Order-level steps (e.g. Accounts Yes/No) write the SAME status to
          // every line, so this preserves the real answer. Per-item steps
          // (Good Check) can legitimately have lines that disagree — those
          // fall back to a generic "Yes" meaning just "done"; the real
          // per-product answer lives in each product's own `availability`.
          status: allDone ? (lineSteps.every(s => s.status === lineSteps[0].status) ? lineSteps[0].status : 'Yes') : ''
        };
        sd.extra.forEach(e => {
          const withVal = lineSteps.find(s => s[e.key]);
          step[e.key] = withVal ? withVal[e.key] : '';
        });
        return step;
      });
      let currentStep = 0;
      for (let i = 0; i < O2D_STEPS.length; i++) {
        if (o.steps[i].status) currentStep = i + 1;
        else break;
      }
      o.currentStep = currentStep;
      o.closed = currentStep === O2D_STEPS.length;
      return o;
    });

    orders.reverse(); // newest first
    return orders;
  }
}

app.get('/api/o2d-fms', requireAuth, async (req, res) => {
  try {
    res.json(await getO2dOrders());
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    sendServerError(res, err);
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
  } catch (err) { sendServerError(res, err); }
});

app.get('/api/o2d-fms/customer-names', requireAuth, async (req, res) => {
  try {
    const map = await getDebtorsMap();
    const names = Object.values(map).map(v => v.name).sort((a, b) => a.localeCompare(b));
    res.json({ names });
  } catch (err) { sendServerError(res, err); }
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

// Tally dates come back as "DD-Mon-YY" / "DD-Mon-YYYY" (e.g. "29-Mar-16") —
// convert to a real Date so it can be compared/subtracted properly.
const TALLY_MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseTallyDate(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const month = TALLY_MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  const d = new Date(year, month, parseInt(m[1], 10));
  return isNaN(d.getTime()) ? null : d;
}
function toIsoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// A handful of older synced rows can still carry a plain "YYYY-MM-DD" date
// instead of Tally's own "DD-Mon-YY" — leftover from before the sync
// switched its sheet writes from USER_ENTERED to RAW (USER_ENTERED let
// Sheets auto-convert some date-shaped strings but not others, inconsistently).
function parseAnyDate(str) {
  const tally = parseTallyDate(str);
  if (tally) return tally;
  const m = String(str || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d.getTime()) ? null : d;
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

// Dealer directory lives under the same page as O2D FMS in the UI — admins
// always have it, everyone else needs 'o2d-fms' explicitly granted, same
// gate the Dealers tab itself lives behind. Previously these routes only
// checked the caller was logged in at all, exposing every dealer's credit
// limit, payment ledger and KYC document links to any employee.
async function canAccessDealers(req) {
  if (req.session.role === 'admin') return true;
  const [rows] = await db.query('SELECT page_access FROM users WHERE id=?', [req.session.userId]);
  const pages = parsePageAccess(rows[0] ? rows[0].page_access : null, req.session.role);
  return pages.includes('o2d-fms');
}
// Credit limit and payment history directly feed the automated credit-tier
// rating (computeCreditTier/computeDealerRating) — restrict those to admin
// only, distinct from the more permissive view/KYC/location actions above.
function canEditDealers(req) {
  return req.session.role === 'admin';
}

app.get('/api/o2d-fms/dealers', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessDealers(req))) return res.status(403).json({ error: 'You do not have access to Dealers' });
    const [debtorsMap, dealerRows, paymentRows, orders, billsAgingByParty, tallyPaymentsByParty, tallyRatingByParty, ledgerBalancesByParty, vouchers] = await Promise.all([
      getDebtorsMap().catch(() => ({})), // dealer directory shouldn't 500 just because the debtors sheet hiccups — Outstanding just shows blank
      withDealerTables(() => db.query('SELECT * FROM o2d_dealers')).then(([r]) => r),
      withDealerTables(() => db.query('SELECT * FROM o2d_dealer_payments ORDER BY due_date')).then(([r]) => r),
      getO2dOrders().catch(() => []), // dealer directory shouldn't 500 just because the orders sheet hiccups
      getBillsReceivableAgingByDealer().catch(() => ({})), // same — Tally sync sheet hiccup shouldn't break the whole page
      getTallyPaymentsByDealer().catch(() => ({})),
      getTallyPaymentPerformanceByDealer().catch(() => ({})),
      getLedgerBalancesByDealer().catch(() => ({})),
      getLedgerVouchers().catch(() => ({ byKey: {}, legIndex: {} }))
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

    // getO2dOrders() already groups by Order No. — just take each dealer's most recent
    orders.forEach(o => {
      if (!o.counterName) return;
      const d = ensure(o.counterName);
      if (!d) return;
      if (!d.lastOrder || o.timestamp > d.lastOrder.timestamp) {
        d.lastOrder = { timestamp: o.timestamp, orderNo: o.orderNo, qty: o.qty, amount: o.amount, area: o.area };
      }
    });

    // Only attaches aging to dealers we already know about (via debtors/
    // dealer profile/orders) — doesn't create new dealer rows just because
    // Tally has a party by that name; most Tally parties aren't O2D dealers.
    // Outstanding provisionally takes this (bill-wise, synced daily) over
    // the older Group Summary debtors sheet — but only provisionally: a
    // dealer whose invoices aren't tracked bill-by-bill in Tally has real
    // dues that never appear here at all, so the real Ledger Closing
    // Balance below (when available) overrides this with the true total.
    // The bucket breakdown itself stays as-is either way — it can only ever
    // reflect whatever portion was bill-tracked.
    Object.values(billsAgingByParty).forEach(agg => {
      const key = agg.name.trim().toLowerCase();
      const d = byKey[key];
      if (d) { d.aging = { buckets: agg.buckets, total: agg.total, billCount: agg.count }; d.outstanding = agg.total; }
    });

    // Real ledger balance — the source of truth for Outstanding whenever
    // Tally has it, since it reflects the party's actual running account
    // regardless of bill-wise tracking. Wins over both the bill-wise total
    // above and the legacy debtors-sheet fallback.
    Object.values(ledgerBalancesByParty).forEach(lb => {
      const key = lb.name.trim().toLowerCase();
      const d = byKey[key];
      if (d) d.outstanding = lb.closingBalance;
    });

    // Tally's own "Bills Receivable" bill-wise matching turned out
    // unreliable both ways — some dealers carry years-old invoices that
    // were actually settled but never left the report (some 8+ years
    // overdue on a real sync), while others have genuinely-unpaid older
    // invoices that quietly drop OUT of the report even though the real
    // Ledger Closing Balance is well above the bill-wise total (confirmed
    // case: bill-wise showed one ₹17,500 invoice, real balance was
    // ₹29,221 — ₹11,721 of real debt Bills Receivable just didn't list).
    // Wherever this FY's actual vouchers are available for a dealer, our
    // own FIFO aging (computeFifoAging) replaces the bill-wise buckets
    // entirely instead of trying to patch or merely distrust them.
    Object.values(byKey).forEach(d => {
      const key = d.name.trim().toLowerCase();
      const ledger = ledgerBalancesByParty[key];
      const fifo = vouchers.legIndex[key] ? computeFifoAging(key, vouchers, ledger || null) : null;
      if (fifo && fifo.billCount) {
        d.aging = fifo;
      } else if (fifo) {
        d.aging = null; // vouchers exist this FY but nothing's actually open — trust that over stale bill-wise data
      }
      // else: no FY voucher data for this dealer at all — leave whatever bill-wise aging was set above as a fallback
    });

    // Same matching rule — only for dealers we already know, most recent 5.
    Object.entries(tallyPaymentsByParty).forEach(([key, list]) => {
      const d = byKey[key];
      if (d) d.tallyPayments = list.slice(-5).reverse();
    });

    const dealers = Object.values(byKey).map(d => {
      // Real Tally-derived on-time/late (bill-by-bill payments joined
      // against BillRegistry due dates) wins when there's enough of it to
      // mean something; otherwise falls back to manually logged payments.
      const tallyKey = d.name.trim().toLowerCase();
      const tallyRating = tallyRatingByParty[tallyKey];
      const manualRating = computeDealerRating(d.payments);
      const rating = (tallyRating && tallyRating.total > 0) ? { ...tallyRating, source: 'tally' } : { ...manualRating, source: 'manual' };
      const creditTier = computeCreditTier(d.aging ? d.aging.buckets : {}, d.aging ? d.aging.total : 0, rating.source === 'tally' ? rating : null);
      const kycCount = Object.values(d.kyc).filter(Boolean).length;
      delete d.payments;
      return { ...d, kycCount, rating, creditTier };
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ dealers });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/o2d-fms/dealers', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessDealers(req))) return res.status(403).json({ error: 'You do not have access to Dealers' });
    const { name, city, phone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Dealer name is required' });
    await withDealerTables(() => db.query(
      'INSERT INTO o2d_dealers (counter_name, city, phone) VALUES (?,?,?) ON DUPLICATE KEY UPDATE city=VALUES(city), phone=VALUES(phone)',
      [name.trim(), city || null, phone || null]
    ));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.put('/api/o2d-fms/dealers/:name', requireAuth, async (req, res) => {
  try {
    if (!canEditDealers(req)) return res.status(403).json({ error: 'Only admins can set a dealer\'s credit limit' });
    const name = req.params.name.trim();
    const { city, phone, creditLimit } = req.body;
    if (creditLimit !== '' && creditLimit !== undefined && creditLimit !== null && !(Number(creditLimit) >= 0)) {
      return res.status(400).json({ error: 'Credit limit must be a non-negative number' });
    }
    await withDealerTables(() => db.query(
      `INSERT INTO o2d_dealers (counter_name, city, phone, credit_limit) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE
         city = COALESCE(VALUES(city), city),
         phone = COALESCE(VALUES(phone), phone),
         credit_limit = VALUES(credit_limit)`,
      [name, city || null, phone || null, (creditLimit === '' || creditLimit === undefined || creditLimit === null) ? null : Number(creditLimit)]
    ));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/o2d-fms/dealers/:name/kyc', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessDealers(req))) return res.status(403).json({ error: 'You do not have access to Dealers' });
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
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/o2d-fms/dealers/:name/location', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessDealers(req))) return res.status(403).json({ error: 'You do not have access to Dealers' });
    const name = req.params.name.trim();
    const { lat, lng, address } = req.body;
    await withDealerTables(() => db.query(
      `INSERT INTO o2d_dealers (counter_name, location_lat, location_lng, location_address) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE location_lat=VALUES(location_lat), location_lng=VALUES(location_lng), location_address=VALUES(location_address)`,
      [name, lat ?? null, lng ?? null, address || null]
    ));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/o2d-fms/dealers/:name/payments', requireAuth, async (req, res) => {
  try {
    if (!canEditDealers(req)) return res.status(403).json({ error: 'Only admins can log a dealer payment' });
    const name = req.params.name.trim();
    const { amount, dueDate, paidDate } = req.body;
    if (!dueDate || !paidDate) return res.status(400).json({ error: 'Due date and paid date are required' });
    if (amount !== undefined && amount !== null && amount !== '' && !(Number(amount) >= 0)) {
      return res.status(400).json({ error: 'Amount must be a non-negative number' });
    }
    await withDealerTables(() => db.query(
      'INSERT INTO o2d_dealer_payments (counter_name, amount, due_date, paid_date) VALUES (?,?,?,?)',
      [name, amount || null, dueDate, paidDate]
    ));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// ══════════════════════════════════════════════════════
// PRICE LIST & CATALOGUE — its own page (not nested in O2D FMS), gated by
// the 'price-catalogue' permission on the Access page. Has two parts: an
// editable product price list (seeded once from the read-only Product
// Master workbook — name/category/UOM/HSN/GST, no real prices in that
// workbook) and a history of uploaded catalogue PDFs. Editing/uploading is
// restricted to Ajay and admins; viewing needs the page permission (admins
// always have it, others only once granted it).
// ══════════════════════════════════════════════════════
async function ensurePriceListTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS o2d_price_list (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_name VARCHAR(255) NOT NULL UNIQUE,
      category VARCHAR(255),
      uom VARCHAR(50),
      hsn_code VARCHAR(50),
      gst_percent VARCHAR(20),
      price DECIMAL(12,2),
      image_url VARCHAR(1000),
      remarks VARCHAR(500),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}
async function withPriceListTable(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; await ensurePriceListTable(); return await fn(); }
}

async function ensureCataloguePdfsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS o2d_catalogue_pdfs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      doc_type VARCHAR(20) NOT NULL DEFAULT 'catalogue',
      filename VARCHAR(500) NOT NULL,
      url VARCHAR(1000) NOT NULL,
      drive_file_id VARCHAR(255),
      uploaded_by_id INT,
      uploaded_by_name VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
async function withCataloguePdfsTable(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') { await ensureCataloguePdfsTable(); return await fn(); }
    // Table already existed from before doc_type was added — add it now.
    if (e.code === 'ER_BAD_FIELD_ERROR') { await db.query(`ALTER TABLE o2d_catalogue_pdfs ADD COLUMN doc_type VARCHAR(20) NOT NULL DEFAULT 'catalogue'`); return await fn(); }
    throw e;
  }
}

// Vercel serverless functions hard-cap the request body at ~4.5MB regardless
// of Express's own json() limit, so large catalogue PDFs (base64-encoded,
// ~33% bigger than the raw file) get rejected with a 413 before our code
// even runs. The client splits the file into sub-4.5MB chunks and POSTs them
// one at a time; we stash each chunk here (a serverless instance can't hold
// state in memory between separate requests) and reassemble on the last one.
async function ensureCataloguePdfChunksTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS o2d_catalogue_pdf_chunks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      upload_id VARCHAR(64) NOT NULL,
      chunk_index INT NOT NULL,
      chunk_data LONGTEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_upload_chunk (upload_id, chunk_index)
    )
  `);
}
async function withCataloguePdfChunksTable(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; await ensureCataloguePdfChunksTable(); return await fn(); }
}

// Chunks now upload in parallel (see the /chunk route) instead of strictly
// in order, so "was this the last chunk index" no longer tells us when to
// reassemble — several requests can see "all chunks are in" at once. This
// lock table makes sure only one of them actually does the reassembly +
// Drive upload; INSERT IGNORE on a PRIMARY KEY is an atomic "first one wins".
async function ensureCataloguePdfUploadLocksTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS o2d_catalogue_pdf_upload_locks (
      upload_id VARCHAR(64) PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
async function withCataloguePdfUploadLocksTable(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; await ensureCataloguePdfUploadLocksTable(); return await fn(); }
}

// Ajay (ajaykumarparwani@gmail.com, user id 9) + admins, per their request —
// not the generic page_access permission below since it's just these two.
function canEditPriceList(req) {
  return req.session.role === 'admin' || req.session.userId === 9;
}

// Whole-page viewing permission — admins and Ajay always have it (they can
// edit, so they can obviously view); everyone else needs 'price-catalogue'
// explicitly granted on the Access page.
async function canAccessPriceCatalogue(req) {
  if (canEditPriceList(req)) return true;
  const [rows] = await db.query('SELECT page_access FROM users WHERE id=?', [req.session.userId]);
  const pages = parsePageAccess(rows[0] ? rows[0].page_access : null, req.session.role);
  return pages.includes('price-catalogue');
}

app.get('/api/o2d-fms/price-list', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessPriceCatalogue(req))) return res.status(403).json({ error: 'You do not have access to the price list' });
    let [rows] = await withPriceListTable(() => db.query('SELECT * FROM o2d_price_list ORDER BY category, product_name'));
    if (!rows.length) {
      // First-ever load — seed names/category/UOM/HSN/GST from the Product
      // Master workbook so there's something to start pricing, instead of
      // an empty table nobody knows how to populate.
      const { products: masterProducts } = await getMasterWorkbookData();
      if (masterProducts.length) {
        const values = masterProducts.map(p => [p.name, p.category]);
        const placeholders = values.map(() => '(?,?)').join(',');
        await db.query(
          `INSERT IGNORE INTO o2d_price_list (product_name, category) VALUES ${placeholders}`,
          values.flat()
        );
        [rows] = await db.query('SELECT * FROM o2d_price_list ORDER BY category, product_name');
      }
    }
    res.json({ items: rows, canEdit: canEditPriceList(req) });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/o2d-fms/price-list', requireAuth, async (req, res) => {
  try {
    if (!canEditPriceList(req)) return res.status(403).json({ error: 'Only Ajay and admins can edit the price list' });
    const { productName, category, uom, hsnCode, gstPercent, price, remarks } = req.body;
    if (!productName || !productName.trim()) return res.status(400).json({ error: 'Product name is required' });
    await withPriceListTable(() => db.query(
      `INSERT INTO o2d_price_list (product_name, category, uom, hsn_code, gst_percent, price, remarks) VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE category=VALUES(category), uom=VALUES(uom), hsn_code=VALUES(hsn_code), gst_percent=VALUES(gst_percent), price=VALUES(price), remarks=VALUES(remarks)`,
      [productName.trim(), category || null, uom || null, hsnCode || null, gstPercent || null,
       (price === '' || price === undefined || price === null) ? null : Number(price), remarks || null]
    ));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.put('/api/o2d-fms/price-list/:id', requireAuth, async (req, res) => {
  try {
    if (!canEditPriceList(req)) return res.status(403).json({ error: 'Only Ajay and admins can edit the price list' });
    const id = parseInt(req.params.id, 10);
    const { category, uom, hsnCode, gstPercent, price, imageUrl, remarks } = req.body;
    await withPriceListTable(() => db.query(
      `UPDATE o2d_price_list SET
         category = COALESCE(?, category), uom = COALESCE(?, uom), hsn_code = COALESCE(?, hsn_code),
         gst_percent = COALESCE(?, gst_percent), price = ?, image_url = COALESCE(?, image_url), remarks = COALESCE(?, remarks)
       WHERE id = ?`,
      [category ?? null, uom ?? null, hsnCode ?? null, gstPercent ?? null,
       (price === '' || price === undefined || price === null) ? null : Number(price),
       imageUrl ?? null, remarks ?? null, id]
    ));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.delete('/api/o2d-fms/price-list/:id', requireAuth, async (req, res) => {
  try {
    if (!canEditPriceList(req)) return res.status(403).json({ error: 'Only Ajay and admins can edit the price list' });
    await withPriceListTable(() => db.query('DELETE FROM o2d_price_list WHERE id = ?', [parseInt(req.params.id, 10)]));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// ── Stock (Ajanta appliance stock — fans, blenders etc.) ─────────────────
// ajanta_stock_items already exists in production (seeded from the "Ajanta
// Stock" Google Sheet); ensureStockTable/withStockTable only exist so a
// fresh/dev database self-heals the same way price-list does above.
function canEditStock(req) {
  return req.session.role === 'admin';
}
async function canAccessStock(req) {
  if (canEditStock(req)) return true;
  const [rows] = await db.query('SELECT page_access FROM users WHERE id=?', [req.session.userId]);
  const pages = parsePageAccess(rows[0] ? rows[0].page_access : null, req.session.role);
  return pages.includes('stock');
}
async function ensureStockTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ajanta_stock_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      item_code VARCHAR(32) NOT NULL UNIQUE,
      description VARCHAR(255) NOT NULL,
      std_pack DECIMAL(10,2) DEFAULT NULL,
      uom VARCHAR(16) NOT NULL DEFAULT 'PCS',
      current_stock DECIMAL(12,2) NOT NULL DEFAULT 0,
      as_of_date DATE NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}
async function withStockTable(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; await ensureStockTable(); return await fn(); }
}

app.get('/api/stock', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessStock(req))) return res.status(403).json({ error: 'You do not have access to Stock' });
    const q = (req.query.q || '').trim();
    let sql = 'SELECT * FROM ajanta_stock_items';
    const params = [];
    if (q) { sql += ' WHERE item_code LIKE ? OR description LIKE ?'; params.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY description';
    const [rows] = await withStockTable(() => db.query(sql, params));
    res.json({ items: rows, canEdit: canEditStock(req) });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/stock', requireAuth, async (req, res) => {
  try {
    if (!canEditStock(req)) return res.status(403).json({ error: 'Only admins can add stock items' });
    const { itemCode, description, stdPack, uom, currentStock, asOfDate } = req.body;
    if (!itemCode || !itemCode.trim()) return res.status(400).json({ error: 'Item code is required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'Description is required' });
    await withStockTable(() => db.query(
      `INSERT INTO ajanta_stock_items (item_code, description, std_pack, uom, current_stock, as_of_date) VALUES (?,?,?,?,?,?)`,
      [itemCode.trim(), description.trim(),
       (stdPack === '' || stdPack === undefined || stdPack === null) ? null : Number(stdPack),
       (uom && uom.trim()) || 'PCS',
       (currentStock === '' || currentStock === undefined || currentStock === null) ? 0 : Number(currentStock),
       asOfDate || new Date().toISOString().slice(0, 10)]
    ));
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'This item code already exists' });
    sendServerError(res, err);
  }
});

app.put('/api/stock/:id', requireAuth, async (req, res) => {
  try {
    if (!canEditStock(req)) return res.status(403).json({ error: 'Only admins can edit stock items' });
    const id = parseInt(req.params.id, 10);
    const { description, stdPack, uom, currentStock, asOfDate } = req.body;
    await withStockTable(() => db.query(
      `UPDATE ajanta_stock_items SET
         description = COALESCE(?, description), std_pack = ?, uom = COALESCE(?, uom),
         current_stock = COALESCE(?, current_stock), as_of_date = COALESCE(?, as_of_date)
       WHERE id = ?`,
      [description ?? null,
       (stdPack === '' || stdPack === undefined) ? null : Number(stdPack),
       uom ?? null,
       (currentStock === '' || currentStock === undefined) ? null : Number(currentStock),
       asOfDate ?? null, id]
    ));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

app.delete('/api/stock/:id', requireAuth, async (req, res) => {
  try {
    if (!canEditStock(req)) return res.status(403).json({ error: 'Only admins can delete stock items' });
    await withStockTable(() => db.query('DELETE FROM ajanta_stock_items WHERE id = ?', [parseInt(req.params.id, 10)]));
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// ── Stock Inward/Outward ledger ───────────────────────────────────────────
// Logging a movement is open to anyone with 'stock' access (that's the whole
// point of the page for day-to-day store staff); only admins can cancel one,
// same split as canAccessStock/canEditStock above.
async function ensureStockTxnTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ajanta_stock_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      txn_date DATE NOT NULL,
      direction VARCHAR(3) NOT NULL,
      item_code VARCHAR(32) NOT NULL,
      item_name VARCHAR(255) DEFAULT '',
      quantity DECIMAL(12,2) NOT NULL,
      uom VARCHAR(16) DEFAULT '',
      remarks VARCHAR(500) DEFAULT '',
      status VARCHAR(16) NOT NULL DEFAULT 'Active',
      created_by VARCHAR(120) DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}
async function withStockTxnTable(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; await ensureStockTxnTable(); return await fn(); }
}

app.get('/api/stock/transactions', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessStock(req))) return res.status(403).json({ error: 'You do not have access to Stock' });
    const direction = req.query.direction === 'OUT' ? 'OUT' : 'IN';
    const [rows] = await withStockTxnTable(() => db.query(
      'SELECT * FROM ajanta_stock_transactions WHERE direction = ? ORDER BY txn_date DESC, id DESC LIMIT 500',
      [direction]
    ));
    res.json({ items: rows, canEdit: canEditStock(req) });
  } catch (err) { sendServerError(res, err); }
});

async function _logStockMovement(req, res, direction) {
  if (!(await canAccessStock(req))) return res.status(403).json({ error: 'You do not have access to Stock' });
  const { itemCode, quantity, txnDate, remarks } = req.body;
  const qty = Number(quantity);
  if (!itemCode || !itemCode.trim()) return res.status(400).json({ error: 'Item code is required' });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Quantity must be a positive number' });
  const [items] = await withStockTable(() => db.query('SELECT * FROM ajanta_stock_items WHERE item_code = ?', [itemCode.trim()]));
  const item = items[0];
  if (!item) return res.status(400).json({ error: 'Item code not found in Stock catalog' });
  const date = txnDate || new Date().toISOString().slice(0, 10);
  if (direction === 'OUT') {
    // Atomic guard: the WHERE clause is re-checked by the UPDATE itself
    // against the live value, so this can't be driven negative by a stale
    // read, and it doubles as the "enough stock?" validation.
    const [claim] = await db.query(
      'UPDATE ajanta_stock_items SET current_stock = current_stock - ?, as_of_date = ? WHERE item_code = ? AND current_stock >= ?',
      [qty, date, item.item_code, qty]
    );
    if (!claim.affectedRows) return res.status(400).json({ error: `Not enough stock — only ${item.current_stock} ${item.uom} available` });
  } else {
    await db.query(
      'UPDATE ajanta_stock_items SET current_stock = current_stock + ?, as_of_date = ? WHERE item_code = ?',
      [qty, date, item.item_code]
    );
  }
  await withStockTxnTable(() => db.query(
    `INSERT INTO ajanta_stock_transactions (txn_date, direction, item_code, item_name, quantity, uom, remarks, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [date, direction, item.item_code, item.description, qty, item.uom, (remarks || '').trim(), req.session.name || '']
  ));
  res.json({ success: true });
}
app.post('/api/stock/inward', requireAuth, async (req, res) => {
  try { await _logStockMovement(req, res, 'IN'); }
  catch (err) { sendServerError(res, err); }
});
app.post('/api/stock/outward', requireAuth, async (req, res) => {
  try { await _logStockMovement(req, res, 'OUT'); }
  catch (err) { sendServerError(res, err); }
});

app.put('/api/stock/transactions/:id/cancel', requireAuth, async (req, res) => {
  try {
    if (!canEditStock(req)) return res.status(403).json({ error: 'Only admins can cancel a stock entry' });
    const id = parseInt(req.params.id, 10);
    const [rows] = await withStockTxnTable(() => db.query('SELECT * FROM ajanta_stock_transactions WHERE id = ?', [id]));
    const txn = rows[0];
    if (!txn) return res.status(404).json({ error: 'Entry not found' });
    if (txn.status === 'Cancelled') return res.status(400).json({ error: 'Already cancelled' });
    // Claim the cancel atomically first — WHERE status<>'Cancelled' is
    // re-checked by the UPDATE itself, so two near-simultaneous cancel
    // requests can't both pass and double-reverse the stock delta.
    const [claim] = await db.query(`UPDATE ajanta_stock_transactions SET status = 'Cancelled' WHERE id = ? AND status <> 'Cancelled'`, [id]);
    if (!claim.affectedRows) return res.status(400).json({ error: 'Already cancelled' });
    // Reverse this entry's effect on current_stock — an IN being cancelled
    // subtracts back out, an OUT being cancelled adds back in.
    const reverseDelta = txn.direction === 'IN' ? -Number(txn.quantity) : Number(txn.quantity);
    await db.query('UPDATE ajanta_stock_items SET current_stock = current_stock + ? WHERE item_code = ?', [reverseDelta, txn.item_code]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// Catalogue PDFs — full upload history kept (not just the latest), same
// viewing permission as the price list above.
app.get('/api/o2d-fms/catalogue-pdfs', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessPriceCatalogue(req))) return res.status(403).json({ error: 'You do not have access to the catalogue' });
    const [rows] = await withCataloguePdfsTable(() => db.query('SELECT * FROM o2d_catalogue_pdfs ORDER BY created_at DESC'));
    res.json({ items: rows, canEdit: canEditPriceList(req) });
  } catch (err) { sendServerError(res, err); }
});

app.post('/api/o2d-fms/catalogue-pdfs', requireAuth, async (req, res) => {
  try {
    if (!canEditPriceList(req)) return res.status(403).json({ error: 'Only Ajay and admins can upload catalogue PDFs' });
    const { filename, pdfData, docType } = req.body;
    if (!filename || !pdfData) return res.status(400).json({ error: 'filename and pdfData are required' });
    const type = docType === 'price_list' ? 'price_list' : 'catalogue';
    const link = await uploadPhotoToDrive(pdfData, filename);
    const driveFileId = (link.match(/\/api\/drive-file\/([^/?]+)/) || [])[1] || null;
    await withCataloguePdfsTable(() => db.query(
      'INSERT INTO o2d_catalogue_pdfs (doc_type, filename, url, drive_file_id, uploaded_by_id, uploaded_by_name) VALUES (?,?,?,?,?,?)',
      [type, filename, link, driveFileId, req.session.userId, req.session.name || '']
    ));
    res.json({ success: true, url: link });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please add the service account to the photos Shared Drive.' });
    sendServerError(res, err);
  }
});

// Chunked upload — same end result as the POST above (a row in
// o2d_catalogue_pdfs + a Drive file), but works around Vercel's ~4.5MB
// request body cap for larger catalogue PDFs. The client sends the file as
// a sequence of small base64 chunks; we store each one, and on the final
// chunk reassemble, upload to Drive, and clean up the temp rows.
app.post('/api/o2d-fms/catalogue-pdfs/chunk', requireAuth, async (req, res) => {
  try {
    if (!canEditPriceList(req)) return res.status(403).json({ error: 'Only Ajay and admins can upload catalogue PDFs' });
    const { chunkIndex, totalChunks, chunkData, filename, docType, mimeType } = req.body;
    if (!req.body.uploadId || chunkIndex === undefined || chunkIndex === null || !totalChunks || !chunkData || !filename) {
      return res.status(400).json({ error: 'uploadId, chunkIndex, totalChunks, chunkData and filename are required' });
    }
    // Scope the client-supplied uploadId to this session so one user's
    // in-progress upload can't collide with or be interfered with by another.
    const uploadId = `${req.session.userId}:${req.body.uploadId}`;
    // Sanity caps — this is a chunked-upload workaround for Vercel's request
    // size limit, not an unbounded storage endpoint.
    const MAX_CHUNKS = 200, MAX_CHUNK_CHARS = 2_000_000; // ~200 x 1.5MB decoded ≈ 300MB reconstructed, ceiling
    if (Number(totalChunks) > MAX_CHUNKS) return res.status(400).json({ error: 'File is too large to upload' });
    if (String(chunkData).length > MAX_CHUNK_CHARS) return res.status(400).json({ error: 'Chunk too large' });
    // Best-effort prune of abandoned uploads (browser closed mid-upload etc).
    db.query('DELETE FROM o2d_catalogue_pdf_chunks WHERE created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR)').catch(() => {});
    db.query('DELETE FROM o2d_catalogue_pdf_upload_locks WHERE created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR)').catch(() => {});

    await withCataloguePdfChunksTable(() => db.query(
      'INSERT INTO o2d_catalogue_pdf_chunks (upload_id, chunk_index, chunk_data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE chunk_data=VALUES(chunk_data)',
      [uploadId, chunkIndex, chunkData]
    ));

    // The client fires several chunks at once for speed, so they can land in
    // any order — completion means "all chunks are stored", not "this was
    // the highest index".
    const [countRows] = await db.query('SELECT COUNT(*) as c FROM o2d_catalogue_pdf_chunks WHERE upload_id=?', [uploadId]);
    if (Number(countRows[0].c) < Number(totalChunks)) {
      return res.json({ success: true, done: false });
    }

    // All chunks are in — but several concurrent requests can reach this
    // point at once, so only the one that wins this lock actually reassembles.
    const [lockResult] = await withCataloguePdfUploadLocksTable(() => db.query(
      'INSERT IGNORE INTO o2d_catalogue_pdf_upload_locks (upload_id) VALUES (?)',
      [uploadId]
    ));
    if (!lockResult.affectedRows) {
      return res.json({ success: true, done: false });
    }

    const [rows] = await db.query(
      'SELECT chunk_data FROM o2d_catalogue_pdf_chunks WHERE upload_id=? ORDER BY chunk_index ASC',
      [uploadId]
    );
    if (rows.length !== Number(totalChunks)) {
      return res.status(400).json({ error: `Upload incomplete — got ${rows.length} of ${totalChunks} chunks. Please retry.` });
    }
    const fullBase64 = rows.map(r => r.chunk_data).join('');
    const dataUri = `data:${mimeType || 'application/pdf'};base64,${fullBase64}`;
    const type = docType === 'price_list' ? 'price_list' : 'catalogue';
    const link = await uploadPhotoToDrive(dataUri, filename);
    const driveFileId = (link.match(/\/api\/drive-file\/([^/?]+)/) || [])[1] || null;
    await withCataloguePdfsTable(() => db.query(
      'INSERT INTO o2d_catalogue_pdfs (doc_type, filename, url, drive_file_id, uploaded_by_id, uploaded_by_name) VALUES (?,?,?,?,?,?)',
      [type, filename, link, driveFileId, req.session.userId, req.session.name || '']
    ));
    await db.query('DELETE FROM o2d_catalogue_pdf_chunks WHERE upload_id=?', [uploadId]);
    await db.query('DELETE FROM o2d_catalogue_pdf_upload_locks WHERE upload_id=?', [uploadId]);

    res.json({ success: true, done: true, url: link });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please add the service account to the photos Shared Drive.' });
    sendServerError(res, err);
  }
});

app.delete('/api/o2d-fms/catalogue-pdfs/:id', requireAuth, async (req, res) => {
  try {
    if (!canEditPriceList(req)) return res.status(403).json({ error: 'Only Ajay and admins can remove catalogue PDFs' });
    const id = parseInt(req.params.id, 10);
    const [rows] = await withCataloguePdfsTable(() => db.query('SELECT drive_file_id FROM o2d_catalogue_pdfs WHERE id=?', [id]));
    if (rows[0] && rows[0].drive_file_id) {
      try {
        const drive = await getDriveClient();
        await drive.files.delete({ fileId: rows[0].drive_file_id, supportsAllDrives: true });
      } catch (e) { /* Drive file may already be gone — don't block removing the DB record */ }
    }
    await db.query('DELETE FROM o2d_catalogue_pdfs WHERE id=?', [id]);
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// ══════════════════════════════════════════════════════
// BILLS RECEIVABLE — read-only view of whatever the local Tally-sync
// script (tally-sync/) last wrote into its Google Sheet. This app can't
// reach Tally directly (it's on a different, local-only network), so
// this just displays the latest synced snapshot — same viewing
// permission as Price List & Catalogue.
// ══════════════════════════════════════════════════════
const BILLS_RECEIVABLE_SHEET_ID = '1uXHUmSzX7nAM2fYS3lf5NzIgfVDEbccgHXQuTODHS1Y'; // "O2D Bills Receivable (Tally Sync)" — switched here 24-Sep-2026
let _billsReceivableCache = null; // { bills, lastSynced, ts }
const BILLS_RECEIVABLE_CACHE_TTL_MS = 5 * 60 * 1000; // the local sync only writes at most a few times a day

async function getBillsReceivable() {
  if (_billsReceivableCache && (Date.now() - _billsReceivableCache.ts) < BILLS_RECEIVABLE_CACHE_TTL_MS) return _billsReceivableCache;
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const r = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: BILLS_RECEIVABLE_SHEET_ID, range: `'Sheet1'!A2:H10000`
  });
  const rows = (r.data.values || []).filter(row => row[0]);
  const bills = rows.map(row => ({
    party: row[0] || '', billRef: row[1] || '', billDate: row[2] || '', dueDate: row[3] || '',
    amount: row[4] || '', daysOverdue: row[5] || '', bucket: row[6] || '', syncedAt: row[7] || ''
  }));
  const lastSynced = bills.reduce((max, b) => b.syncedAt > max ? b.syncedAt : max, '');
  _billsReceivableCache = { bills, lastSynced, ts: Date.now() };
  return _billsReceivableCache;
}

// Party names in Tally rarely match our counter names 100% — same
// case-insensitive-then-fuzzy approach used everywhere else dealer names
// get matched (debtors sheet, order history).
const BILLS_BUCKET_KEYS = ['<30', '30-45', '45-60', '60-90', '90+', 'Unknown'];

// Credit tier — prefers real bill-by-bill payment performance (on-time
// ratio, once there's enough of it) since that's a better trust signal
// than just "how old is what they currently owe"; falls back to the
// aging split (buckets/total) when there isn't enough payment history yet.
function computeCreditTier(buckets, total, tallyRating) {
  if (tallyRating && tallyRating.total >= 2) {
    const onTimeRatio = (tallyRating.total - tallyRating.late) / tallyRating.total;
    if (onTimeRatio === 1) return { tier: 'Diamond', icon: '💎', color: '#2563eb' };
    if (onTimeRatio >= 0.8) return { tier: 'Gold', icon: '🥇', color: '#d97706' };
    if (onTimeRatio >= 0.5) return { tier: 'Silver', icon: '🥈', color: '#6b7280' };
    return { tier: 'At Risk', icon: '⚠️', color: '#dc2626' };
  }
  if (!total) return null;
  const badShare = ((buckets['90+'] || 0) + (buckets['60-90'] || 0)) / total;
  if (badShare === 0) return { tier: 'Diamond', icon: '💎', color: '#2563eb' };
  if (badShare < 0.2) return { tier: 'Gold', icon: '🥇', color: '#d97706' };
  if (badShare < 0.5) return { tier: 'Silver', icon: '🥈', color: '#6b7280' };
  return { tier: 'At Risk', icon: '⚠️', color: '#dc2626' };
}

async function getBillsReceivableAgingByDealer() {
  const { bills } = await getBillsReceivable();
  const byParty = {}; // lowercased party name -> { buckets, total, count }
  bills.forEach(b => {
    const key = b.party.trim().toLowerCase();
    if (!key) return;
    if (!byParty[key]) byParty[key] = { name: b.party.trim(), buckets: {}, total: 0, count: 0 };
    const bucket = BILLS_BUCKET_KEYS.includes(b.bucket) ? b.bucket : 'Unknown';
    const amt = Number(b.amount) || 0;
    byParty[key].buckets[bucket] = (byParty[key].buckets[bucket] || 0) + amt;
    byParty[key].total += amt;
    byParty[key].count += 1;
  });
  return byParty;
}

// Ledger Closing Balance — the party's real running account balance,
// straight from Tally, independent of whether entries were ever tracked
// bill-by-bill. Bills Receivable only lists bills that WERE entered
// bill-wise; a dealer with older "on account" invoices has real dues that
// never show up there, which used to leave Outstanding silently stuck on
// a stale manual number for exactly those dealers. This is the source of
// truth for the total; Bills Receivable is still used for the aging-bucket
// breakdown (best-effort, only covers whatever portion was bill-tracked).
let _ledgerBalancesCache = null; // { byParty, ts }
const LEDGER_BALANCES_CACHE_TTL_MS = 5 * 60 * 1000;
async function getLedgerBalancesByDealer() {
  if (_ledgerBalancesCache && (Date.now() - _ledgerBalancesCache.ts) < LEDGER_BALANCES_CACHE_TTL_MS) return _ledgerBalancesCache.byParty;
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const r = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: BILLS_RECEIVABLE_SHEET_ID, range: `'LedgerBalances'!A2:D10000`
  }).catch(() => ({ data: { values: [] } })); // tab may not exist yet on an older sync
  const byParty = {}; // lowercased party name -> { name, closingBalance, syncedAt, drCr }
  (r.data.values || []).forEach(row => {
    const name = (row[0] || '').trim();
    if (!name) return;
    // drCr is '' on syncs older than the column — treated as Dr (the normal case for a debtor)
    byParty[name.toLowerCase()] = { name, closingBalance: Number(row[1]) || 0, syncedAt: row[2] || '', drCr: (row[3] || '').trim() };
  });
  _ledgerBalancesCache = { byParty, ts: Date.now() };
  return byParty;
}

// Item-wise breakup of each Sales invoice — synced alongside Payments (same
// Day Book response, just the Sales vouchers instead of Receipts). Keyed by
// party+billRef so the Statement modal can show what's actually in a bill
// when it's clicked. Bill Ref here is the Sales voucher's own number, which
// is what Bills Receivable's Bill Ref defaults to unless a bill was given a
// separate manual reference — most won't be, but a bill with no matching
// items just means that one wasn't found under this assumption.
let _salesItemsCache = null; // { byKey, ts }
const SALES_ITEMS_CACHE_TTL_MS = 5 * 60 * 1000;
async function getSalesItemsByBillKey() {
  if (_salesItemsCache && (Date.now() - _salesItemsCache.ts) < SALES_ITEMS_CACHE_TTL_MS) return _salesItemsCache.byKey;
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const r = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: BILLS_RECEIVABLE_SHEET_ID, range: `'SalesItems'!A2:H100000`
  }).catch(() => ({ data: { values: [] } })); // tab may not exist yet on an older sync
  const byKey = {}; // "party|||billref" (lowercased party) -> [{itemName, qty, rate, amount}]
  (r.data.values || []).forEach(row => {
    const party = (row[0] || '').trim(), billRef = (row[1] || '').trim();
    if (!party || !billRef) return;
    const key = `${party.toLowerCase()}|||${billRef}`;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push({ itemName: row[3] || '', qty: row[4] || '', rate: row[5] || '', amount: Number(row[6]) || 0 });
  });
  _salesItemsCache = { byKey, ts: Date.now() };
  return byKey;
}

// Every ledger leg of every voucher in the current financial year (the
// sync's "LedgerVouchers" tab, from a date-bound Voucher Collection).
// Grouped by voucher, plus an index from party name → the vouchers that
// party appears in, so one dealer's ledger can be rebuilt Tally-style.
let _ledgerVouchersCache = null; // { byKey, legIndex, ts }
const LEDGER_VOUCHERS_CACHE_TTL_MS = 5 * 60 * 1000;
async function getLedgerVouchers() {
  if (_ledgerVouchersCache && (Date.now() - _ledgerVouchersCache.ts) < LEDGER_VOUCHERS_CACHE_TTL_MS) return _ledgerVouchersCache;
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const r = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: BILLS_RECEIVABLE_SHEET_ID, range: `'LedgerVouchers'!A2:G200000`
  }).catch(() => ({ data: { values: [] } })); // tab may not exist yet on an older sync
  const byKey = {};    // voucher key -> { date, vchType, vchNo, legs: [{ ledgerName, ledgerKey, amount }] }
  const legIndex = {}; // lowercased ledger name -> Set of voucher keys
  (r.data.values || []).forEach(row => {
    const key = (row[0] || '').trim(), ledgerName = (row[4] || '').trim();
    const amount = Number(row[5]);
    if (!key || !ledgerName || !amount) return;
    if (!byKey[key]) byKey[key] = { date: row[1] || '', vchType: row[2] || '', vchNo: row[3] || '', legs: [] };
    const ledgerKey = ledgerName.toLowerCase();
    byKey[key].legs.push({ ledgerName, ledgerKey, amount });
    if (!legIndex[ledgerKey]) legIndex[ledgerKey] = new Set();
    legIndex[ledgerKey].add(key);
  });
  _ledgerVouchersCache = { byKey, legIndex, ts: Date.now() };
  return _ledgerVouchersCache;
}

function financialYearStartLabel(today) {
  const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return `1-Apr-${String(y).slice(2)}`;
}
function financialYearStartDate(today) {
  const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return new Date(y, 3, 1);
}

// One row per ledger leg of every voucher the party appears in this FY,
// date-sorted — the shared basis for both the Statement's running ledger
// and the FIFO aging below. Debit/Credit from the party's own leg (Tally
// export sign: negative = Dr, positive = Cr); Particulars = the biggest
// opposite leg of the same voucher (Sales A/c, Cash, a bank…).
function buildDealerFyRows(dealerKey, vouchers) {
  const keys = vouchers.legIndex[dealerKey] ? [...vouchers.legIndex[dealerKey]] : [];
  const rows = [];
  keys.forEach(k => {
    const v = vouchers.byKey[k];
    const partyLegs = v.legs.filter(l => l.ledgerKey === dealerKey);
    const others = v.legs.filter(l => l.ledgerKey !== dealerKey).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    partyLegs.forEach(pl => {
      rows.push({
        date: v.date, vchType: v.vchType, vchNo: v.vchNo,
        particulars: others[0] ? others[0].ledgerName : v.vchType,
        debit: pl.amount < 0 ? -pl.amount : 0,
        credit: pl.amount > 0 ? pl.amount : 0
      });
    });
  });
  rows.sort((a, b) => {
    const da = parseAnyDate(a.date), db = parseAnyDate(b.date);
    if (da && db && da - db !== 0) return da - db;
    return (parseInt(a.vchNo, 10) || 0) - (parseInt(b.vchNo, 10) || 0);
  });
  return rows;
}

// A party's FY ledger the way Tally's "Ledger Vouchers" screen shows it:
// running balance from an opening balance derived as closing − FY net.
function buildDealerFyLedger(dealerKey, vouchers, ledgerBalance) {
  const rows = buildDealerFyRows(dealerKey, vouchers);
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  // Our convention here: positive balance = Dr (dealer owes us), negative = Cr (advance).
  const closing = ledgerBalance
    ? (ledgerBalance.drCr === 'Cr' ? -ledgerBalance.closingBalance : ledgerBalance.closingBalance)
    : null;
  const openingKnown = closing !== null;
  const opening = openingKnown ? closing - (totalDebit - totalCredit) : 0;
  let bal = opening;
  rows.forEach(r => { bal += r.debit - r.credit; r.balance = bal; });
  return { fyLabel: `${financialYearStartLabel(new Date())} se aaj tak`, opening, openingKnown, closing, totalDebit, totalCredit, rows };
}

function bucketForDays(days) {
  if (days < 30) return '<30';
  if (days < 45) return '30-45';
  if (days < 60) return '45-60';
  if (days < 90) return '60-90';
  return '90+';
}

// FIFO-based aging — replaces trusting Tally's own "Bills Receivable"
// bill-wise matching, which turned out unreliable in a very concrete way:
// a dealer's older Sales invoices can drop out of that report through
// Tally's own internal allocation without actually being paid off, while
// newer ones that ARE settled still show. Real example that surfaced this:
// a dealer's Bills Receivable showed only their latest ₹17,500 invoice as
// outstanding, but their real Ledger Closing Balance was ₹29,221 — ₹11,721
// of genuinely unpaid older invoices were simply missing from that report.
// This instead walks every Sales (debit) and Receipt (credit) for the
// party this FY in date order and applies each payment against the
// OLDEST still-open invoice first — the exact manual method used to
// hand-verify that mismatch. The FY's derived opening balance (if
// positive) is treated as the very first, oldest "bill" so it's the
// first thing paid down, same as it would be in reality.
function computeFifoAging(dealerKey, vouchers, ledgerBalance) {
  const rows = buildDealerFyRows(dealerKey, vouchers);
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  const closing = ledgerBalance
    ? (ledgerBalance.drCr === 'Cr' ? -ledgerBalance.closingBalance : ledgerBalance.closingBalance)
    : null;
  const opening = closing !== null ? closing - (totalDebit - totalCredit) : 0;

  const openBills = [];
  if (opening > 0.5) openBills.push({ date: financialYearStartDate(new Date()), remaining: opening });
  rows.forEach(r => {
    if (r.debit > 0.5) {
      openBills.push({ date: parseAnyDate(r.date) || financialYearStartDate(new Date()), remaining: r.debit });
    } else if (r.credit > 0.5) {
      let toApply = r.credit;
      for (const bill of openBills) {
        if (toApply <= 0.5) break;
        if (bill.remaining <= 0.5) continue;
        const applied = Math.min(bill.remaining, toApply);
        bill.remaining -= applied;
        toApply -= applied;
      }
      // leftover toApply beyond any open bill = an advance/overpayment — not represented here
    }
  });

  const today = new Date();
  const buckets = {};
  let total = 0, billCount = 0;
  openBills.forEach(b => {
    if (b.remaining <= 0.5) return;
    const days = Math.max(0, Math.floor((today - b.date) / 86400000));
    const bucket = bucketForDays(days);
    buckets[bucket] = (buckets[bucket] || 0) + b.remaining;
    total += b.remaining;
    billCount++;
  });
  return { buckets, total, billCount };
}

app.get('/api/o2d-fms/bills-receivable', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessPriceCatalogue(req))) return res.status(403).json({ error: 'You do not have access to this page' });
    const { bills, lastSynced } = await getBillsReceivable();
    res.json({ bills, lastSynced });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the Bills Receivable sheet with the service account.' });
    sendServerError(res, err);
  }
});

// Payment history — from the same Tally sync's "Payments" tab (Receipt
// vouchers, bill-wise allocated).
let _tallyPaymentsCache = null; // { byParty, ts }
const TALLY_PAYMENTS_CACHE_TTL_MS = 5 * 60 * 1000;
async function getTallyPaymentsByDealer() {
  if (_tallyPaymentsCache && (Date.now() - _tallyPaymentsCache.ts) < TALLY_PAYMENTS_CACHE_TTL_MS) return _tallyPaymentsCache.byParty;
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const r = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: BILLS_RECEIVABLE_SHEET_ID, range: `'Payments'!A2:E20000`
  }).catch(() => ({ data: { values: [] } })); // tab may not exist yet on an older sync
  const rows = (r.data.values || []).filter(row => row[0]);
  const byParty = {};
  rows.forEach(row => {
    const key = (row[0] || '').trim().toLowerCase();
    if (!key) return;
    if (!byParty[key]) byParty[key] = [];
    byParty[key].push({ paidDate: row[1] || '', billRef: row[2] || '', amount: Number(row[3]) || 0 });
  });
  _tallyPaymentsCache = { byParty, ts: Date.now() };
  return byParty;
}

// Dealer statement — every currently-outstanding bill plus every synced
// payment for one party, merged and date-sorted (most recent first), with
// the real Ledger Closing Balance as the header total. Not a byte-for-byte
// replica of Tally's own ledger screen (a bill that's already fully paid
// off drops out of Bills Receivable and we don't keep its amount anywhere
// once that happens) — it's everything the sync actually has on hand.
app.get('/api/o2d-fms/dealer-ledger', requireAuth, async (req, res) => {
  try {
    if (!(await canAccessDealers(req))) return res.status(403).json({ error: 'You do not have access to Dealers' });
    const name = (req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const key = name.toLowerCase();
    const [{ bills }, paymentsByParty, ledgerByParty, itemsByKey, vouchers] = await Promise.all([
      getBillsReceivable(),
      getTallyPaymentsByDealer(),
      getLedgerBalancesByDealer(),
      getSalesItemsByBillKey(),
      getLedgerVouchers().catch(() => ({ byKey: {}, legIndex: {} }))
    ]);
    // Bills Receivable is a running list of everything Tally still calls
    // "outstanding" — including invoices from before bill-by-bill tracking
    // started, which were settled without ever being matched back to a
    // specific bill in Tally and so never actually left the report (some
    // sit there 8+ years overdue, confirmed on a real sync). Those also
    // predate the current-FY Voucher Collection, so they never have item
    // data either. Scoping "open bills" to the current financial year
    // keeps this list to invoices the sync can actually back up, and lines
    // it up with the Ledger section above (same FY window).
    const fyStart = financialYearStartDate(new Date());
    const dealerBills = bills.filter(b => {
      if (b.party.trim().toLowerCase() !== key) return false;
      const d = parseAnyDate(b.billDate);
      return d && d >= fyStart;
    });
    const payments = paymentsByParty[key] || [];
    const ledger = ledgerByParty[key] || null;
    const fyLedger = buildDealerFyLedger(key, vouchers, ledger);

    const entries = [
      ...dealerBills.map(b => ({ type: 'bill', date: b.billDate, ref: b.billRef, amount: Number(b.amount) || 0, dueDate: b.dueDate, daysOverdue: b.daysOverdue, bucket: b.bucket, items: itemsByKey[`${key}|||${b.billRef}`] || null })),
      ...payments.map(p => ({ type: 'payment', date: p.paidDate, ref: p.billRef, amount: p.amount }))
    ];
    entries.sort((a, b) => {
      const da = parseAnyDate(a.date), db = parseAnyDate(b.date);
      if (da && db) return db - da;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });

    res.json({
      name,
      outstanding: ledger ? ledger.closingBalance : null,
      syncedAt: ledger ? ledger.syncedAt : (dealerBills[0] ? dealerBills[0].syncedAt : null),
      billCount: dealerBills.length,
      paymentCount: payments.length,
      entries,
      ledger: fyLedger
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Real on-time/late rating from Tally — joins each payment (Payments tab,
// bill-by-bill now that billing is done that way) against the bill's due
// date (BillRegistry tab, which keeps remembering it even after the bill
// is paid off and drops out of Bills Receivable). Reuses
// computeDealerRating() with the same {due_date, paid_date} shape the
// manual Log Payment feature already produces.
let _tallyRatingCache = null; // { byParty, ts }
async function getTallyPaymentPerformanceByDealer() {
  if (_tallyRatingCache && (Date.now() - _tallyRatingCache.ts) < TALLY_PAYMENTS_CACHE_TTL_MS) return _tallyRatingCache.byParty;
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const [registryResp, paymentsResp] = await Promise.all([
    sheetsApi.spreadsheets.values.get({ spreadsheetId: BILLS_RECEIVABLE_SHEET_ID, range: `'BillRegistry'!A2:D100000` }).catch(() => ({ data: { values: [] } })),
    sheetsApi.spreadsheets.values.get({ spreadsheetId: BILLS_RECEIVABLE_SHEET_ID, range: `'Payments'!A2:E100000` }).catch(() => ({ data: { values: [] } }))
  ]);
  const dueDateByBill = new Map(); // "party|||billref" -> due date string
  (registryResp.data.values || []).forEach(row => {
    if (!row[0] || !row[1]) return;
    dueDateByBill.set(`${row[0].trim().toLowerCase()}|||${row[1].trim()}`, row[3] || '');
  });

  const paymentsByParty = {};
  (paymentsResp.data.values || []).forEach(row => {
    const party = (row[0] || '').trim();
    const billRef = (row[2] || '').trim();
    if (!party || !billRef) return;
    const dueDateStr = dueDateByBill.get(`${party.toLowerCase()}|||${billRef}`);
    if (!dueDateStr) return; // this bill was never seen in Bills Receivable — can't tell if it was late
    const due = parseTallyDate(dueDateStr);
    const paid = parseTallyDate(row[1]);
    if (!due || !paid) return;
    const key = party.toLowerCase();
    if (!paymentsByParty[key]) paymentsByParty[key] = [];
    paymentsByParty[key].push({ due_date: toIsoDate(due), paid_date: toIsoDate(paid) });
  });

  const byParty = {};
  Object.entries(paymentsByParty).forEach(([key, payments]) => { byParty[key] = computeDealerRating(payments); });
  _tallyRatingCache = { byParty, ts: Date.now() };
  return byParty;
}

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
      if (!(Number(p.qty) > 0)) return res.status(400).json({ error: 'Quantity must be a positive number' });
      if (p.rate !== undefined && p.rate !== null && p.rate !== '' && !(Number(p.rate) >= 0)) return res.status(400).json({ error: 'Rate must be a non-negative number' });
    }

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);

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
    const orderNo = `Ord-${String(await claimNextSeqValue('o2d_order_no', maxOrderNo + 1)).padStart(4, '0')}`;
    // Each product line needs its own unique "Order-N" id — claim one
    // sequential value per line rather than assuming maxOrderId+1+i is free.
    const orderIds = [];
    let nextOrderIdCandidate = maxOrderId + 1;
    for (let i = 0; i < products.length; i++) {
      const claimed = await claimNextSeqValue('o2d_order_id', nextOrderIdCandidate);
      orderIds.push(claimed);
      nextOrderIdCandidate = claimed + 1;
    }

    const nowSerial = sfmsDateToSerial(new Date());
    const dateToSendSerial = dateToSend ? sfmsDateToSerial(new Date(dateToSend + 'T00:00:00')) : '';

    const rows = products.map((p, i) => [
      nowSerial, counterType || '', counterName, area || '', dateToSendSerial, whenToSend || '',
      channel || '', deliverByTransport || 'No', makePerformaInvoice || 'No', orderBy || '',
      paymentTerms || '', remark || '', p.productName, p.rate || '', p.qty,
      p.isSample || 'No', orderNo, `Order-${orderIds[i]}`
    ]);

    // OVERWRITE, not INSERT_ROWS — inserting rows shifts the sheet's row
    // dimensions, which corrupts the Planned column's ARRAYFORMULA (it spills
    // down live from row 6). Overwrite just fills the next blank row instead.
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: O2D_SHEET_ID,
      range: `'${O2D_TAB}'!A${O2D_DATA_START_ROW}:R`,
      valueInputOption: 'RAW',
      insertDataOption: 'OVERWRITE',
      requestBody: { values: rows }
    });

    res.json({ success: true, orderNo, orderIds: rows.map(r => r[17]) });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the O2D sheet with the service account.' });
    sendServerError(res, err);
  }
});

// Marks a step done for every product row under an Order No. whose next
// pending step genuinely IS this one — every earlier step already done,
// this one not yet. This is how "mark done" applies to a whole order in one
// action, and how a step re-opens for just a newly added item without
// touching lines that were already through it. Rows that are further
// behind (e.g. a brand new line still on step 1) are correctly skipped
// rather than having a later step's Actual/Status written out of order.
// Returns how many rows got written (0 = nothing to do — either the order
// doesn't exist or no line has this as its next step right now).
async function writeO2dStepForOrder(sheetsApi, orderNo, stepNum, body) {
  const stepDef = O2D_STEPS.find(s => s.n === stepNum);
  if (!stepDef) return { rowsUpdated: -1 };
  const priorStatusCols = O2D_STEPS.filter(s => s.n < stepNum).map(s => s.status);

  // Reads from C (Counter Name) instead of Q so the counter name is
  // available for post-write side effects (e.g. WhatsApp-ing the dealer
  // when the bill is uploaded) without a second round trip.
  const keyCols = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: O2D_SHEET_ID, range: `'${O2D_TAB}'!C${O2D_DATA_START_ROW}:${stepDef.status}`, valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const keyRows = keyCols.data.values || [];
  const cOffset = colToIdx('C');
  const qOffset = colToIdx('Q') - cOffset;
  const targetRows = [];
  let counterName = '';
  keyRows.forEach((r, i) => {
    if ((r[qOffset] || '') !== orderNo) return;
    if (r[colToIdx(stepDef.status) - cOffset]) return; // already has this step
    const priorDone = priorStatusCols.every(col => r[colToIdx(col) - cOffset]);
    if (priorDone) { targetRows.push(O2D_DATA_START_ROW + i); if (!counterName) counterName = r[0] || ''; }
  });
  if (!targetRows.length) return { rowsUpdated: 0 };

  const now = sfmsDateToSerial(new Date());
  const defaultStatus = body.status || 'Yes';
  const perRowStatus = body.perRowStatus || {}; // { rowNum: 'Yes'|'No' } — per-item Available/Not Available
  const batchData = [];
  targetRows.forEach(rowNum => {
    const status = perRowStatus[rowNum] || defaultStatus;
    batchData.push({ range: `'${O2D_TAB}'!${stepDef.actual}${rowNum}`, values: [[now]] });
    batchData.push({ range: `'${O2D_TAB}'!${stepDef.status}${rowNum}`, values: [[status]] });
    stepDef.extra.forEach(f => {
      const val = body[f.key];
      if (val !== undefined && val !== '') batchData.push({ range: `'${O2D_TAB}'!${f.col}${rowNum}`, values: [[val]] });
    });
  });

  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId: O2D_SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: batchData }
  });
  return { rowsUpdated: targetRows.length, counterName };
}

// Step 3 ("Call Made By CRM When Add More Order") — CRM calls the dealer to
// ask if they want to add anything before the order proceeds. Adds more
// product lines under the SAME Order No, reusing the dealer/order metadata
// from an existing row instead of asking for it again. Optionally resolves
// a step (normally step 3 itself) in the same request, so "add items" and
// "mark this step done" are one submit instead of two.
app.post('/api/o2d-fms/add-order-items', requireAuth, async (req, res) => {
  try {
    const { orderNo, products, alsoCompleteStep } = req.body;
    if (!orderNo) return res.status(400).json({ error: 'orderNo is required' });
    const hasProducts = Array.isArray(products) && products.length;
    if (!hasProducts && !alsoCompleteStep) {
      return res.status(400).json({ error: 'At least one product is required' });
    }
    if (hasProducts) {
      for (const p of products) {
        if (!p.productName || !p.qty) return res.status(400).json({ error: 'Each product needs a name and quantity' });
      if (!(Number(p.qty) > 0)) return res.status(400).json({ error: 'Quantity must be a positive number' });
      if (p.rate !== undefined && p.rate !== null && p.rate !== '' && !(Number(p.rate) >= 0)) return res.status(400).json({ error: 'Rate must be a non-negative number' });
      }
    }

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    let orderIds = [];

    if (hasProducts) {
      const existing = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: O2D_SHEET_ID, range: `'${O2D_TAB}'!A${O2D_DATA_START_ROW}:R`, valueRenderOption: 'UNFORMATTED_VALUE'
      });
      const existingRows = existing.data.values || [];
      const template = existingRows.find(r => (r[16] || '') === orderNo); // Q = Order No.
      if (!template) return res.status(404).json({ error: `Order ${orderNo} not found` });

      let maxOrderId = 0;
      existingRows.forEach(r => {
        const m = String(r[17] || '').match(/Order-(\d+)/);
        if (m) maxOrderId = Math.max(maxOrderId, parseInt(m[1], 10));
      });
      // Claim one sequential value per new line — same collision risk/fix as
      // the new-order route above.
      const newOrderIds = [];
      let nextOrderIdCandidate = maxOrderId + 1;
      for (let i = 0; i < products.length; i++) {
        const claimed = await claimNextSeqValue('o2d_order_id', nextOrderIdCandidate);
        newOrderIds.push(claimed);
        nextOrderIdCandidate = claimed + 1;
      }

      const nowSerial = sfmsDateToSerial(new Date());
      const rows = products.map((p, i) => [
        nowSerial, template[1] || '', template[2] || '', template[3] || '', template[4] || '', template[5] || '',
        template[6] || '', template[7] || 'No', template[8] || 'No', template[9] || '',
        template[10] || '', template[11] || '', p.productName, p.rate || '', p.qty,
        p.isSample || 'No', orderNo, `Order-${newOrderIds[i]}`
      ]);

      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: O2D_SHEET_ID,
        range: `'${O2D_TAB}'!A${O2D_DATA_START_ROW}:R`,
        valueInputOption: 'RAW',
        insertDataOption: 'OVERWRITE',
        requestBody: { values: rows }
      });
      orderIds = rows.map(r => r[17]);
    }

    let rowsUpdated = 0;
    if (alsoCompleteStep && alsoCompleteStep.stepNum) {
      ({ rowsUpdated } = await writeO2dStepForOrder(sheetsApi, orderNo, alsoCompleteStep.stepNum, alsoCompleteStep));
    }

    res.json({ success: true, orderIds, rowsUpdated });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the O2D sheet with the service account.' });
    sendServerError(res, err);
  }
});

app.put('/api/o2d-fms/order/:orderNo/step/:stepNum', requireAuth, async (req, res) => {
  try {
    const orderNo = req.params.orderNo;
    const stepNum = parseInt(req.params.stepNum, 10);
    if (!(await assertIsStepDoer(res, 'o2d_step_doers', stepNum, req.session.userId, req.session.role))) return;
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const { rowsUpdated, counterName } = await writeO2dStepForOrder(sheetsApi, orderNo, stepNum, req.body);
    if (rowsUpdated === -1) return res.status(400).json({ error: 'Invalid step number' });
    if (rowsUpdated === 0) return res.status(404).json({ error: `No pending rows for this step under order ${orderNo}` });

    // Make Bill (step 4) — WhatsApp the dealer as soon as the invoice is
    // uploaded. Only fires when there's actually a phone number on file
    // (Dealers tab) and an invoice was attached; a missing phone shouldn't
    // block the bill itself from being recorded.
    let whatsappSent = false, whatsappSkippedReason = null;
    if (stepNum === 4 && req.body.photoLink && counterName) {
      try {
        const [dealerRows] = await withDealerTables(() => db.query('SELECT phone FROM o2d_dealers WHERE counter_name = ?', [counterName]));
        const phone = dealerRows[0] && dealerRows[0].phone;
        if (phone) {
          const billNo = req.body.billNo ? ` (Bill No: ${req.body.billNo})` : '';
          const amount = req.body.billAmount ? `, Amount: ₹${req.body.billAmount}` : '';
          await sendWhatsApp(phone, `Ajanta Appliances: Your bill for order ${orderNo}${billNo}${amount} is ready.\nInvoice: ${req.body.photoLink}`);
          whatsappSent = true;
        } else {
          whatsappSkippedReason = 'Dealer phone number not set — add it from the Dealers tab to enable WhatsApp bill alerts.';
        }
      } catch (e) { whatsappSkippedReason = e.message; }
    }

    res.json({ success: true, rowsUpdated, whatsappSent, whatsappSkippedReason });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the sheet with the service account.' });
    sendServerError(res, err);
  }
});

// ══════════════════════════════════════════════════════
// PURCHASE FMS — live-connected to the "Purchase Fms" Google Sheet. Tracks
// an already-placed PO through two follow-up stages: Follow (chasing the
// vendor) and Material Received (closing it out once goods arrive). One row
// per product line under a PO Number, grouped into POs the same
// "bottlenecked by the furthest-behind line" way O2D groups order lines
// under an Order No.
//
// IMPORTANT — re-verified live on 2026-09-24: this sheet's own column
// layout had been restructured since this module was first built (it used
// to run Indent → Check Stock → Provide from Store → Finalise Rate →
// Approval → Generate PO — a 6-step, AQ-wide sheet). The sheet's owner has
// since moved all of that upstream of this tab: by the time a row appears
// here it already carries a real PO Number, Indent No, Vendor and Final
// Rate as INPUT data, and the sheet is only A:V wide now. The old 6-step
// config was reading columns that no longer mean what they used to (e.g.
// its "Indent No" column B is now "PO Number"), which is what produced
// garbage in the UI — wrong row labels, ~1900 dates from small unrelated
// numbers being fed through the serial-date formatter. New-Indent creation
// and PO-PDF generation were removed for the same reason: writing a new row
// with the old 9-column shape would have clobbered the live PO Number
// column. If raising new indents/POs from inside this app is still wanted,
// it needs to target wherever they actually originate upstream of this tab
// (unconfirmed — the workbook has several other tabs: "Indent FMS",
// "Step 1/3/5 Updation", etc. — needs the user to point at the right one).
// ══════════════════════════════════════════════════════
const PURCHASE_SHEET_ID = '1ME8gPAN92EyxmX9YUYkq4Ag2E2lUlM9MCZYED7FPLho';
const PURCHASE_TAB = 'Purchase Fms';
const PURCHASE_HEADER_ROW = 6;
const PURCHASE_DATA_START_ROW = 7;
const PURCHASE_LAST_COL = 'V';

const PURCHASE_STEPS = [
  { n: 1, label: 'Follow', doer: 'Priyanka (SCCRR)', tat: 'Every alternate day', planned: 'L', actual: 'M', status: 'N',
    extra: [
      { key: 'remark', col: 'O', label: 'Remark' },
      { key: 'nextFollowup', col: 'P', label: 'Next Followup', isDate: true }
    ] },
  { n: 2, label: 'Material Received', doer: 'Priyanka (SCCRR)', tat: '—', planned: 'Q', actual: 'R', status: 'U',
    extra: [
      { key: 'receivedQty', col: 'S', label: 'Received Qty' },
      { key: 'pendingQty', col: 'T', label: 'Pending Qty', readOnly: true },
      { key: 'forceFullClosed', col: 'V', label: 'Force Full Closed PO' }
    ] }
];

function purchaseStepIsDone(stepDef, get) {
  return !!(stepDef.status && get(stepDef.status));
}

// ── Purchase step doers — same shape/pattern as o2d_step_doers above. ──
async function ensurePurchaseStepDoersTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_step_doers (
      step_n INT NOT NULL,
      user_id INT NOT NULL,
      PRIMARY KEY (step_n, user_id)
    )
  `);
}
async function withPurchaseStepDoersTable(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; await ensurePurchaseStepDoersTable(); return await fn(); }
}

let _purchaseStepDoersCache = null; // { map, ts } — step_n -> [{id,name}]
const PURCHASE_STEP_DOERS_CACHE_TTL_MS = 60 * 1000;
async function getPurchaseStepDoersMap() {
  if (_purchaseStepDoersCache && (Date.now() - _purchaseStepDoersCache.ts) < PURCHASE_STEP_DOERS_CACHE_TTL_MS) return _purchaseStepDoersCache.map;
  const [rows] = await withPurchaseStepDoersTable(() => db.query(
    `SELECT psd.step_n, u.id, u.name FROM purchase_step_doers psd JOIN users u ON psd.user_id=u.id ORDER BY u.name`
  ));
  const map = {};
  rows.forEach(r => { (map[r.step_n] = map[r.step_n] || []).push({ id: r.id, name: r.name }); });
  _purchaseStepDoersCache = { map, ts: Date.now() };
  return map;
}

app.get('/api/purchase-fms/step-doers', requireAuth, async (req, res) => {
  try {
    const map = await getPurchaseStepDoersMap();
    const assignments = {};
    PURCHASE_STEPS.forEach(s => { assignments[s.n] = map[s.n] || []; });
    res.json({ assignments });
  } catch (err) { sendServerError(res, err); }
});

app.put('/api/purchase-fms/step-doers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { assignments } = req.body; // { "1": [userId,...], ... }
    await ensurePurchaseStepDoersTable();
    await db.query('DELETE FROM purchase_step_doers');
    const rows = [];
    Object.entries(assignments || {}).forEach(([stepN, userIds]) => {
      (userIds || []).forEach(uid => rows.push([Number(stepN), Number(uid)]));
    });
    if (rows.length) await db.query('INSERT INTO purchase_step_doers (step_n, user_id) VALUES ?', [rows]);
    _purchaseStepDoersCache = null;
    res.json({ success: true });
  } catch (err) { sendServerError(res, err); }
});

// No caching on the sheet read itself — same reasoning as getO2dOrders
// above (multi-instance serverless deploys make a TTL cache show stale
// "Mark Done" results).
async function getPurchasePOs() {
  const stepDoersMap = await getPurchaseStepDoersMap();
  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: PURCHASE_SHEET_ID,
        range: `'${PURCHASE_TAB}'!A${PURCHASE_DATA_START_ROW}:${PURCHASE_LAST_COL}`,
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
      break;
    } catch (e) {
      const isRateLimit = e.code === 429 || (e.message || '').includes('Quota exceeded');
      if (!isRateLimit || attempt >= 2) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  const sheetRows = result.data.values || [];
  const lines = sheetRows.map((r, i) => {
    const rowNum = PURCHASE_DATA_START_ROW + i;
    const get = col => r[colToIdx(col)];
    if (!get('B')) return null; // skip blank rows (PO Number is the unique key column)
    const line = {
      row: rowNum,
      timestamp: sfmsSerialToDate(get('A')),
      poNumber: get('B') || '',
      indentNo: get('C') || '',
      itemId: get('D') || '',
      productName: get('E') || '',
      uom: get('F') || '',
      qty: Number(get('G')) || 0,
      finalRate: get('H') || '',
      vendorName: get('I') || '',
      raisedBy: get('J') || '',
      leadTime: get('K') || ''
    };
    line.steps = PURCHASE_STEPS.map(sd => {
      const step = {
        planned: sd.planned ? sfmsSerialToDate(get(sd.planned)) : '',
        actual: sd.actual ? sfmsSerialToDate(get(sd.actual)) : '',
        status: sd.status ? (get(sd.status) || '') : '',
        done: !!(sd.status && get(sd.status))
      };
      sd.extra.forEach(e => {
        const val = get(e.col);
        step[e.key] = e.isDate && typeof val === 'number' ? sfmsSerialToDate(val).split(' ')[0] : (val || '');
      });
      return step;
    });
    let lineCurrentStep = 0;
    for (const s of line.steps) { if (s.done) lineCurrentStep++; else break; }
    line.currentStep = lineCurrentStep;
    return line;
  }).filter(Boolean);

  const poNos = [];
  const byPoNo = {};
  lines.forEach(line => {
    if (!byPoNo[line.poNumber]) { byPoNo[line.poNumber] = []; poNos.push(line.poNumber); }
    byPoNo[line.poNumber].push(line);
  });

  const pos = poNos.map(poNumber => {
    const group = byPoNo[poNumber];
    const first = group[0];
    const o = {
      poNumber,
      rows: group.map(l => l.row),
      timestamp: group.map(l => l.timestamp).sort()[0],
      indentNo: first.indentNo,
      vendorName: first.vendorName,
      raisedBy: first.raisedBy,
      leadTime: first.leadTime,
      qty: group.reduce((sum, l) => sum + l.qty, 0),
      amount: group.reduce((sum, l) => sum + l.qty * (Number(l.finalRate) || 0), 0),
      products: group.map(l => ({
        row: l.row, itemId: l.itemId, productName: l.productName, uom: l.uom, qty: l.qty, finalRate: l.finalRate
      }))
    };
    o.steps = PURCHASE_STEPS.map((sd, idx) => {
      const lineSteps = group.map(l => l.steps[idx]);
      const allDone = lineSteps.every(s => s.done);
      const actuals = lineSteps.map(s => s.actual).filter(Boolean).sort();
      const step = {
        n: sd.n, label: sd.label, doer: sd.doer, tat: sd.tat, doers: stepDoersMap[sd.n] || [],
        planned: lineSteps[0].planned,
        actual: allDone ? (actuals[actuals.length - 1] || '') : '',
        done: allDone,
        status: allDone ? (lineSteps.every(s => s.status === lineSteps[0].status) ? lineSteps[0].status : 'Yes') : ''
      };
      sd.extra.forEach(e => {
        const withVal = lineSteps.find(s => s[e.key]);
        step[e.key] = withVal ? withVal[e.key] : '';
      });
      return step;
    });
    let currentStep = 0;
    for (let i = 0; i < PURCHASE_STEPS.length; i++) {
      if (o.steps[i].done) currentStep = i + 1;
      else break;
    }
    o.currentStep = currentStep;
    o.closed = currentStep === PURCHASE_STEPS.length;
    return o;
  });

  pos.reverse(); // newest first
  return pos;
}

app.get('/api/purchase-fms', requireAuth, async (req, res) => {
  try {
    res.json(await getPurchasePOs());
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the Purchase Fms sheet with the service account.' });
    sendServerError(res, err);
  }
});

// Marks a step done for every product row under a PO Number whose next
// pending step genuinely IS this one — same "furthest-behind line" logic as
// writeO2dStepForOrder above.
async function writePurchaseStepForPO(sheetsApi, poNumber, stepNum, body) {
  const stepDef = PURCHASE_STEPS.find(s => s.n === stepNum);
  if (!stepDef) return { rowsUpdated: -1 };
  const priorSteps = PURCHASE_STEPS.filter(s => s.n < stepNum);
  const lastCol = stepDef.status || stepDef.actual;

  const keyCols = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID, range: `'${PURCHASE_TAB}'!B${PURCHASE_DATA_START_ROW}:${lastCol}`, valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const keyRows = keyCols.data.values || [];
  const bOffset = colToIdx('B');
  const targetRows = [];
  keyRows.forEach((r, i) => {
    const get = col => r[colToIdx(col) - bOffset];
    if ((get('B') || '') !== poNumber) return;
    if (stepDef.status && get(stepDef.status)) return; // already has this step
    const priorDone = priorSteps.every(s => purchaseStepIsDone(s, get));
    if (priorDone) targetRows.push(PURCHASE_DATA_START_ROW + i);
  });
  if (!targetRows.length) return { rowsUpdated: 0 };

  const now = sfmsDateToSerial(new Date());
  const defaultStatus = body.status || 'Yes';
  const batchData = [];
  targetRows.forEach(rowNum => {
    if (stepDef.actual) batchData.push({ range: `'${PURCHASE_TAB}'!${stepDef.actual}${rowNum}`, values: [[now]] });
    if (stepDef.status && stepDef.status !== stepDef.actual) batchData.push({ range: `'${PURCHASE_TAB}'!${stepDef.status}${rowNum}`, values: [[defaultStatus]] });
    stepDef.extra.forEach(f => {
      if (f.readOnly) return; // e.g. Pending Qty — display-only, may be formula-driven
      const val = body[f.key];
      if (val === undefined || val === '') return;
      const writeVal = f.isDate ? sfmsDateToSerial(new Date(val + 'T00:00:00')) : val;
      batchData.push({ range: `'${PURCHASE_TAB}'!${f.col}${rowNum}`, values: [[writeVal]] });
    });
  });

  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId: PURCHASE_SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: batchData }
  });
  return { rowsUpdated: targetRows.length };
}

app.put('/api/purchase-fms/po/:poNumber/step/:stepNum', requireAuth, async (req, res) => {
  try {
    const poNumber = req.params.poNumber;
    const stepNum = parseInt(req.params.stepNum, 10);
    if (!(await assertIsStepDoer(res, 'purchase_step_doers', stepNum, req.session.userId, req.session.role))) return;
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const { rowsUpdated } = await writePurchaseStepForPO(sheetsApi, poNumber, stepNum, req.body);
    if (rowsUpdated === -1) return res.status(400).json({ error: 'Invalid step number' });
    if (rowsUpdated === 0) return res.status(404).json({ error: `No pending rows for this step under PO ${poNumber}` });
    res.json({ success: true, rowsUpdated });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the Purchase Fms sheet with the service account.' });
    sendServerError(res, err);
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
  } catch (err) { sendServerError(res, err); }
});

// GET — Task IDs that already have a pending transfer (for current user's tasks)
app.get('/api/transfers/pending-tasks', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT task_id, task_type FROM task_transfers WHERE status='pending' AND requested_by=?`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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
  } catch (err) { sendServerError(res, err); }
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