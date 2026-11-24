-- ════════════════════════════════════════════════════════════════════
-- Ajanta ERP — performance indexes (audit 2026-11-24)
--
-- Kaise chalana hai:
--   phpMyAdmin → ERP wala database chuno → "SQL" tab → yeh poora text paste → "Go".
--   Raat ya lunch time pe chalao (kam log online hon). Har line 1-2 second leti hai.
--
-- Safe hai:
--   • Sirf naye INDEX bante hain. Koi table, column ya data nahi badalta.
--   • "IF NOT EXISTS" hai, isliye do baar chal gaya toh bhi koi error/nuksaan nahi.
--   • WordPress ki pk_* tables ko chhua nahi gaya hai.
--
-- Wapas lena ho (rollback) toh neeche sabse aakhri section dekho.
-- ════════════════════════════════════════════════════════════════════

-- 1) checklist_tasks (31,000+ rows, sabse badi table)
--    Dashboard count, aaj ke tasks, MIS / weekly report, All Tasks, cron —
--    sab due_date se filter karte hain, aur due_date pe koi index nahi tha.
--    Abhi "aaj ke pending tasks" wali query poori table (31,225 rows) padhti hai.
CREATE INDEX IF NOT EXISTS idx_ct_due_status ON checklist_tasks (due_date, status);
CREATE INDEX IF NOT EXISTS idx_ct_user_due   ON checklist_tasks (assigned_to, due_date);

-- 2) delegation_tasks — wahi queries, wahi columns
CREATE INDEX IF NOT EXISTS idx_dt_due_status ON delegation_tasks (due_date, status);
CREATE INDEX IF NOT EXISTS idx_dt_user_due   ON delegation_tasks (assigned_to, due_date);

-- 3) ajanta_stock_transactions (IMS Daily Register — har din badhti hai)
--    Register (date range + ORDER BY txn_date, id), item ki history (item_code),
--    "link karna baaki" list (applied = 0).
CREATE INDEX IF NOT EXISTS idx_stx_date      ON ajanta_stock_transactions (txn_date, id);
CREATE INDEX IF NOT EXISTS idx_stx_item_date ON ajanta_stock_transactions (item_code, txn_date);
CREATE INDEX IF NOT EXISTS idx_stx_applied   ON ajanta_stock_transactions (applied, status);

-- 4) task_transfers — Approvals list (status = 'pending' ORDER BY created_at)
--    aur "My transfer requests" (requested_by ORDER BY created_at)
CREATE INDEX IF NOT EXISTS idx_tt_status_created ON task_transfers (status, created_at);
CREATE INDEX IF NOT EXISTS idx_tt_requester      ON task_transfers (requested_by, created_at);

-- Check: yeh 4 lines chala ke dekho — har ek mein naye idx_ wale naam dikhne chahiye.
SHOW INDEX FROM checklist_tasks;
SHOW INDEX FROM delegation_tasks;
SHOW INDEX FROM ajanta_stock_transactions;
SHOW INDEX FROM task_transfers;

-- ── Rollback (sirf zaroorat ho tab; upar wala hissa chalane ke baad) ──
-- DROP INDEX idx_ct_due_status ON checklist_tasks;
-- DROP INDEX idx_ct_user_due ON checklist_tasks;
-- DROP INDEX idx_dt_due_status ON delegation_tasks;
-- DROP INDEX idx_dt_user_due ON delegation_tasks;
-- DROP INDEX idx_stx_date ON ajanta_stock_transactions;
-- DROP INDEX idx_stx_item_date ON ajanta_stock_transactions;
-- DROP INDEX idx_stx_applied ON ajanta_stock_transactions;
-- DROP INDEX idx_tt_status_created ON task_transfers;
-- DROP INDEX idx_tt_requester ON task_transfers;
