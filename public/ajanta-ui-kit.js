/* Ajanta ERP — UI kit (2026-10-31). Loaded with `defer` after app.html's inline
   script. Pure progressive enhancement: native inputs/selects/tables stay in the
   DOM with the same ids, values and onchange handlers, so no business code
   changes. Three parts:
   1. Date range picker — every From/To filter pair in DATE_PRESET_PAIRS (+ OWS,
      MD Summary) becomes one "📅 1 Oct – 31 Oct 2026" button with presets and a
      calendar. Replaces the two DD-MM-YYYY boxes and the Aaj/Kal chip row.
   2. Searchable dropdown — a <select> with 8+ options opens a type-to-search
      list on mouse/trackpad devices (phones keep the native picker).
   3. Sortable tables — click a column header to sort (▲/▼). Skips tables with
      grouped/merged rows, header onclicks, #dashTable and `.no-sort`.
   Plus: mouse wheel over a focused number field no longer changes the amount.
   Opt out of 2/3 per element with class `no-kit` / `no-sort`. */
(function () {
  'use strict';
  if (window.__ajKit) return;
  window.__ajKit = true;

  const css = `
.kit-hidden{display:none!important}
.kit-range{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 12px;border:1.5px solid var(--gray-200,#e2e8f0);border-radius:10px;background:var(--surface,#fff);color:var(--gray-800,#1e293b);font:600 13.5px/1 var(--font-sans,Inter,sans-serif);cursor:pointer;white-space:nowrap;max-width:100%;transition:border-color .15s,box-shadow .15s}
.kit-range:hover{border-color:var(--n-300,#cbd5e1)}
.kit-range:focus-visible,.kit-range[aria-expanded="true"]{outline:none;border-color:var(--brand-600,#010371);box-shadow:0 0 0 3px var(--brand-100,rgba(1,3,113,.12))}
.kit-range svg{flex-shrink:0;color:var(--gray-500,#64748b)}
.kit-range .kit-range-txt{overflow:hidden;text-overflow:ellipsis}
.kit-range .kit-range-tag{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:var(--brand-50,rgba(1,3,113,.06));color:var(--brand-600,#010371)}
.kit-pop{position:fixed;z-index:1300;background:var(--surface,#fff);border:1px solid var(--gray-200,#e2e8f0);border-radius:14px;box-shadow:var(--sh-4,0 24px 60px -12px rgba(15,23,42,.3));animation:kit-pop .16s cubic-bezier(.2,.8,.2,1) both;font-family:var(--font-sans,Inter,sans-serif)}
@keyframes kit-pop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
.kit-backdrop{position:fixed;inset:0;z-index:1299;background:rgba(15,23,42,.35);animation:kit-fade .16s both}
@keyframes kit-fade{from{opacity:0}to{opacity:1}}
.kit-rp{display:flex;max-width:calc(100vw - 16px)}
.kit-rp-presets{display:flex;flex-direction:column;gap:2px;padding:10px;border-right:1px solid var(--gray-100,#f1f5f9);min-width:150px}
.kit-rp-presets button{all:unset;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:13px;font-weight:600;color:var(--gray-700,#334155);cursor:pointer;white-space:nowrap}
.kit-rp-presets button:hover,.kit-rp-presets button:focus-visible{background:var(--gray-100,#f1f5f9)}
.kit-rp-presets button.on{background:var(--brand-50,rgba(1,3,113,.06));color:var(--brand-600,#010371)}
.kit-rp-main{display:flex;flex-direction:column;padding:10px 12px 12px;min-width:0}
.kit-rp-cal .flatpickr-calendar{box-shadow:none!important;border:0!important;width:auto!important;font-family:inherit}
.kit-rp-cal .flatpickr-calendar.inline{margin:0 auto}
.kit-rp-cal .flatpickr-day.selected,.kit-rp-cal .flatpickr-day.startRange,.kit-rp-cal .flatpickr-day.endRange{background:var(--brand-600,#010371)!important;border-color:var(--brand-600,#010371)!important;color:#fff!important}
.kit-rp-cal .flatpickr-day.inRange{background:var(--brand-50,rgba(1,3,113,.06))!important;border-color:transparent!important;box-shadow:-5px 0 0 var(--brand-50,rgba(1,3,113,.06)),5px 0 0 var(--brand-50,rgba(1,3,113,.06))!important}
.kit-rp-cal .flatpickr-day.today{border-color:var(--accent-600,#D80700)}
.kit-rp-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--gray-100,#f1f5f9);margin-top:6px}
.kit-rp-foot input{width:118px;height:36px;padding:0 10px;border:1.5px solid var(--gray-200,#e2e8f0);border-radius:8px;font:500 13px var(--font-sans,Inter,sans-serif);background:var(--surface,#fff);color:var(--gray-800,#1e293b)}
.kit-rp-foot input:focus{outline:none;border-color:var(--brand-600,#010371)}
.kit-rp-foot input.bad{border-color:var(--danger-600,#dc2626)}
.kit-rp-foot .kit-sp{flex:1}
.kit-sel{display:flex;flex-direction:column;min-width:220px;max-width:min(440px,calc(100vw - 16px));max-height:360px;overflow:hidden}
.kit-sel input{margin:8px;height:36px;padding:0 10px 0 32px;border:1.5px solid var(--gray-200,#e2e8f0);border-radius:8px;font:500 13.5px var(--font-sans,Inter,sans-serif);background:var(--surface,#fff) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E") 10px 50%/14px no-repeat;color:var(--gray-800,#1e293b)}
.kit-sel input:focus{outline:none;border-color:var(--brand-600,#010371)}
.kit-sel ul{list-style:none;margin:0;padding:0 6px 6px;overflow:auto;overscroll-behavior:contain}
.kit-sel li{padding:8px 10px;border-radius:7px;font-size:13.5px;color:var(--gray-800,#1e293b);cursor:pointer;display:flex;align-items:center;gap:8px}
.kit-sel li.grp{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--gray-400,#94a3b8);cursor:default;padding:10px 10px 4px}
.kit-sel li.dis{opacity:.45;cursor:not-allowed}
.kit-sel li.act{background:var(--gray-100,#f1f5f9)}
.kit-sel li.sel{font-weight:700;color:var(--brand-600,#010371)}
.kit-sel li.sel::after{content:'';margin-left:auto;width:14px;height:14px;flex-shrink:0;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/contain no-repeat}
.kit-sel mark{background:rgba(250,204,21,.35);color:inherit;border-radius:2px}
.kit-sel .kit-empty{padding:14px;text-align:center;font-size:13px;color:var(--gray-500,#64748b)}
.kit-more{display:inline-flex!important;align-items:center;justify-content:center;min-width:32px;padding-left:6px!important;padding-right:6px!important}
@media (min-width:769px){td[data-kit-menu]{white-space:nowrap}td[data-kit-menu]>div{flex-wrap:nowrap!important}}
.kit-menu{display:flex;flex-direction:column;padding:6px;min-width:150px}
.kit-menu button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13.5px;font-weight:600;color:var(--gray-800,#1e293b);cursor:pointer;white-space:nowrap}
.kit-menu button:hover,.kit-menu button:focus-visible{background:var(--gray-100,#f1f5f9)}
.kit-menu button.danger{color:var(--danger-600,#dc2626)}
.kit-menu button.danger:hover,.kit-menu button.danger:focus-visible{background:var(--danger-50,#fef2f2)}
th.kit-sortable{cursor:pointer;user-select:none}
th.kit-sortable:hover{color:var(--brand-600,#010371)}
th[aria-sort="ascending"]::after,th[aria-sort="descending"]::after{content:'';display:inline-block;vertical-align:middle;margin-left:4px;border:4px solid transparent}
th[aria-sort="ascending"]::after{border-bottom:5px solid currentColor;border-top:0}
th[aria-sort="descending"]::after{border-top:5px solid currentColor;border-bottom:0}
@media (max-width:640px){
  .kit-range{width:100%;height:44px;font-size:14px}
  .kit-pop.kit-sheet{left:0!important;right:0;top:auto!important;bottom:0;border-radius:18px 18px 0 0;max-height:88dvh;overflow:auto;padding-bottom:env(safe-area-inset-bottom);animation-name:kit-sheet}
  @keyframes kit-sheet{from{transform:translateY(100%)}to{transform:none}}
  .kit-rp{flex-direction:column;max-width:none}
  .kit-rp-presets{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--gray-100,#f1f5f9);min-width:0}
  .kit-rp-presets button{padding:8px 12px;border:1px solid var(--gray-200,#e2e8f0);border-radius:999px;font-size:13px}
  .kit-rp-foot input{flex:1 1 calc(50% - 24px);width:auto;min-width:0;font-size:16px;height:42px}
  .kit-rp-foot .kit-sp{display:none}
  .kit-rp-foot .btn{flex:1 1 40%;min-height:42px}
}
@media (prefers-reduced-motion:reduce){.kit-pop,.kit-backdrop{animation:none}}`;
  const style = document.createElement('style');
  style.id = 'ui-kit-css';
  style.textContent = css;
  document.head.appendChild(style);

  const isPhone = () => window.matchMedia('(max-width:640px)').matches;
  const finePointer = window.matchMedia('(pointer:fine)');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── shared popover ─────────────────────────────────────────────
  let openPop = null; // { el, backdrop, anchor, onClose }
  function closePop() {
    if (!openPop) return;
    const p = openPop; openPop = null;
    p.el.remove(); if (p.backdrop) p.backdrop.remove();
    if (p.anchor) p.anchor.setAttribute('aria-expanded', 'false');
    if (p.onClose) p.onClose();
  }
  function showPop(el, anchor, { sheet = false, onClose } = {}) {
    closePop();
    el.classList.add('kit-pop');
    let backdrop = null;
    if (sheet && isPhone()) {
      el.classList.add('kit-sheet');
      backdrop = document.createElement('div');
      backdrop.className = 'kit-backdrop';
      backdrop.addEventListener('click', closePop);
      document.body.appendChild(backdrop);
    }
    document.body.appendChild(el);
    openPop = { el, backdrop, anchor, onClose };
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    placePop();
  }
  function placePop() {
    if (!openPop || openPop.el.classList.contains('kit-sheet')) return;
    const { el, anchor } = openPop;
    const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    el.style.minWidth = Math.max(r.width, 0) + 'px';
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(r.left, vw - w - 8); left = Math.max(8, left);
    let top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6; // flip up when it would overflow
    else if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  document.addEventListener('pointerdown', e => {
    if (!openPop) return;
    if (openPop.el.contains(e.target) || (openPop.anchor && openPop.anchor.contains(e.target))) return;
    closePop();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openPop) { e.stopPropagation(); const a = openPop.anchor; closePop(); if (a) a.focus(); } }, true);
  window.addEventListener('resize', placePop);
  window.addEventListener('scroll', e => { if (openPop && !openPop.el.contains(e.target)) placePop(); }, true);
  window.addEventListener('hashchange', closePop);

  // ── 1. date range picker ───────────────────────────────────────
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dmy = s => { const d = parseYmd(s); return d ? `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}` : ''; };
  function rangeText(a, b) {
    const da = parseYmd(a), db = parseYmd(b);
    if (!da && !db) return 'Sab dates';
    if (!da) return `… – ${db.getDate()} ${MON[db.getMonth()]} ${db.getFullYear()}`;
    if (!db) return `${da.getDate()} ${MON[da.getMonth()]} ${da.getFullYear()} – …`;
    if (a === b) return `${da.getDate()} ${MON[da.getMonth()]} ${da.getFullYear()}`;
    const sameYear = da.getFullYear() === db.getFullYear();
    return `${da.getDate()} ${MON[da.getMonth()]}${sameYear ? '' : ' ' + da.getFullYear()} – ${db.getDate()} ${MON[db.getMonth()]} ${db.getFullYear()}`;
  }
  // Same Monday-start week and labels as the old Aaj/Kal chips (datePresetRange).
  const PRESETS = [
    ['today', 'Aaj', () => { const d = new Date(); return [d, d]; }],
    ['yday', 'Kal', () => { const d = new Date(); d.setDate(d.getDate() - 1); return [d, d]; }],
    ['thisweek', 'Is hafte', () => { const d = new Date(), m = new Date(); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return [m, d]; }],
    ['lastweek', 'Pichhla hafta', () => { const m = new Date(); m.setDate(m.getDate() - ((m.getDay() + 6) % 7) - 7); const s = new Date(m); s.setDate(m.getDate() + 6); return [m, s]; }],
    ['7d', 'Last 7 din', () => { const d = new Date(), s = new Date(); s.setDate(s.getDate() - 6); return [s, d]; }],
    ['month', 'Is mahine', () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth(), 1), d]; }],
    ['lastmonth', 'Pichhla mahina', () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0)]; }],
    ['30d', 'Last 30 din', () => { const d = new Date(), s = new Date(); s.setDate(s.getDate() - 29); return [s, d]; }],
    ['fy', 'Is FY (Apr–Mar)', () => { const d = new Date(), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return [new Date(y, 3, 1), d]; }],
    ['lastfy', 'Pichhla FY', () => { const d = new Date(), y = (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1) - 1; return [new Date(y, 3, 1), new Date(y + 1, 2, 31)]; }]
  ].map(([k, label, fn]) => ({ k, label, range: () => fn().map(ymd) }));
  const presetFor = (a, b) => PRESETS.find(p => { const r = p.range(); return r[0] === a && r[1] === b; });

  const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const getV = el => NATIVE_VALUE.get.call(el);
  const setV = (el, v) => NATIVE_VALUE.set.call(el, v);
  const CAL_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';
  const CARET_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  function rangePairs() {
    // [fromId, toId, reload fn name] — the page's own list, plus pairs that have no chips.
    let base = [];
    try { base = DATE_PRESET_PAIRS.slice(); } catch (e) { /* app script not loaded */ }
    return base.concat([['owsFrom', 'owsTo', 'loadOws'], ['mdFrom', 'mdTo', 'loadMdSummary']]);
  }
  // The input's own "label + input" box (so "FROM"/"TO" captions go with it), else the input.
  function fieldBox(input, other) {
    const p = input.parentElement;
    if (p && p !== other.parentElement && p.children.length === 2 && !p.querySelector('input:not([type="date"]),select,button')) return p;
    return input;
  }
  function upgradeRange([fromId, toId, fnName]) {
    const f = document.getElementById(fromId), t = document.getElementById(toId);
    if (!f || !t || f.dataset.kitRange || f.dataset.dmyDone || t.dataset.dmyDone) return;
    f.dataset.kitRange = t.dataset.kitRange = '1';
    // The old DD-MM-YYYY upgrader and the Aaj/Kal chip row skip these from now on.
    f.dataset.dmyDone = t.dataset.dmyDone = '1';
    const fb = fieldBox(f, t), tb = fieldBox(t, f);
    const chips = document.querySelector(`[data-dp="${fromId}"]`);
    if (chips) chips.style.display = 'none';
    else { const ph = document.createElement('div'); ph.dataset.dp = fromId; ph.hidden = true; tb.insertAdjacentElement('afterend', ph); }
    // "Sab dates" (clear) only where the page itself had a Clear / All button.
    const allowEmpty = ['tasksDateFrom', 'pcDateFrom', 'pettyFrom'].includes(fromId);

    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'kit-range';
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    if (fb !== f) {
      const cap = [...fb.children].find(c => c !== f);
      if (cap) cap.textContent = '📅 Dates';
      fb.appendChild(btn);
    } else {
      f.insertAdjacentElement('beforebegin', btn);
      const prev = btn.previousElementSibling;
      if (prev && /^(📅\s*)?from:?$/i.test(prev.textContent.trim())) prev.textContent = 'Dates:';
      // "to" / "→" between two bare inputs
      for (let n = f.nextSibling; n && n !== t && n !== tb; n = n.nextSibling) {
        if (n.nodeType === 3) n.nodeValue = n.nodeValue.replace(/\b(to|se)\b|→/gi, '');
        else if (n.nodeType === 1 && !n.querySelector('input,select,button') && n.textContent.trim().length <= 3) n.classList.add('kit-hidden');
      }
    }
    f.classList.add('kit-hidden'); (tb === t ? t : tb).classList.add('kit-hidden');
    f.tabIndex = t.tabIndex = -1;

    const paint = () => {
      const a = getV(f), b = getV(t), p = presetFor(a, b);
      btn.innerHTML = `${CAL_SVG}${p ? `<span class="kit-range-tag">${esc(p.label)}</span>` : ''}<span class="kit-range-txt">${esc(rangeText(a, b))}</span>${CARET_SVG}`;
      btn.title = a || b ? `${dmy(a) || '…'} → ${dmy(b) || '…'}` : 'Date range chunein';
    };
    // Code that sets .value (presets, "This Month" buttons, page defaults) keeps the button in sync.
    [f, t].forEach(el => Object.defineProperty(el, 'value', { configurable: true, get() { return getV(this); }, set(v) { setV(this, v); paint(); } }));
    f.addEventListener('change', paint); t.addEventListener('change', paint);
    paint();

    const commit = (a, b) => {
      if (a && b && a > b) [a, b] = [b, a];
      const changed = a !== getV(f) || b !== getV(t);
      setV(f, a); setV(t, b); paint(); closePop();
      if (!changed) return;
      if (typeof window[fnName] === 'function') window[fnName]();
      else t.dispatchEvent(new Event('change', { bubbles: true }));
    };
    btn.addEventListener('click', () => {
      if (openPop && openPop.anchor === btn) { closePop(); return; }
      openRangePop(btn, getV(f), getV(t), allowEmpty, commit);
    });
  }

  function openRangePop(anchor, a0, b0, allowEmpty, commit) {
    const el = document.createElement('div');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Date range');
    const cur = presetFor(a0, b0);
    el.innerHTML = `<div class="kit-rp">
      <div class="kit-rp-presets">${PRESETS.map(p => `<button type="button" data-k="${p.k}" class="${cur && cur.k === p.k ? 'on' : ''}">${esc(p.label)}</button>`).join('')}${allowEmpty ? '<button type="button" data-k="clear">Sab dates</button>' : ''}</div>
      <div class="kit-rp-main">
        <div class="kit-rp-cal"><input type="text" hidden></div>
        <div class="kit-rp-foot">
          <input class="kit-a" inputmode="numeric" placeholder="DD-MM-YYYY" maxlength="10" aria-label="From">
          <span style="color:var(--gray-400)">→</span>
          <input class="kit-b" inputmode="numeric" placeholder="DD-MM-YYYY" maxlength="10" aria-label="To">
          <span class="kit-sp"></span>
          <button type="button" class="btn btn-outline btn-sm kit-cancel">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm kit-apply">Apply</button>
        </div>
      </div></div>`;
    const ia = el.querySelector('.kit-a'), ib = el.querySelector('.kit-b');
    let a = a0, b = b0, fp = null;
    ia.value = dmy(a); ib.value = dmy(b);
    el.querySelector('.kit-rp-presets').addEventListener('click', e => {
      const k = e.target.closest('button') && e.target.closest('button').dataset.k;
      if (!k) return;
      if (k === 'clear') return commit('', '');
      const r = PRESETS.find(p => p.k === k).range();
      commit(r[0], r[1]); // one click and done
    });
    const typed = inp => {
      const d = inp.value.replace(/\D/g, '').slice(0, 8);
      const v = d.length > 4 ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d;
      if (inp.value !== v) inp.value = v;
      const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v);
      let iso = '';
      if (m) { const dt = new Date(+m[3], +m[2] - 1, +m[1]); if (dt.getDate() === +m[1] && dt.getMonth() === +m[2] - 1) iso = ymd(dt); }
      inp.classList.toggle('bad', v.length === 10 && !iso);
      return v ? iso || null : '';
    };
    const fromTyped = () => {
      const va = typed(ia), vb = typed(ib);
      if (va !== null) a = va;
      if (vb !== null) b = vb;
      if (fp && a && b && va !== null && vb !== null) fp.setDate([a, b].sort(), false);
    };
    ia.addEventListener('input', fromTyped); ib.addEventListener('input', fromTyped);
    const apply = () => { fromTyped(); if (ia.classList.contains('bad') || ib.classList.contains('bad')) return; commit(a, b); };
    [ia, ib].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }));
    el.querySelector('.kit-apply').addEventListener('click', apply);
    el.querySelector('.kit-cancel').addEventListener('click', () => { closePop(); anchor.focus(); });
    showPop(el, anchor, { sheet: true, onClose: () => { if (fp) fp.destroy(); } });
    if (window.flatpickr) {
      fp = window.flatpickr(el.querySelector('.kit-rp-cal input'), {
        inline: true, mode: 'range', disableMobile: true, dateFormat: 'Y-m-d',
        showMonths: window.innerWidth >= 900 ? 2 : 1,
        defaultDate: [a, b].filter(Boolean), locale: { firstDayOfWeek: 1 },
        onChange: sel => {
          if (!sel.length) return;
          a = ymd(sel[0]); b = ymd(sel[sel.length - 1]);
          ia.value = dmy(a); ib.value = sel.length > 1 ? dmy(b) : '';
          ia.classList.remove('bad'); ib.classList.remove('bad');
        }
      });
      const d = parseYmd(b || a);
      if (d && fp.config.showMonths > 1) fp.jumpToDate(new Date(d.getFullYear(), d.getMonth() - 1, 1));
      placePop();
    }
    const on = el.querySelector('.kit-rp-presets .on') || el.querySelector('.kit-rp-presets button');
    if (on && finePointer.matches) on.focus({ preventScroll: true });
  }

  function upgradeAllRanges() { rangePairs().forEach(upgradeRange); }

  // ── 2. searchable <select> ─────────────────────────────────────
  const SEL_MIN = 8;
  const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  function openSelect(s) {
    const el = document.createElement('div');
    el.className = 'kit-sel';
    el.setAttribute('role', 'dialog');
    el.innerHTML = '<input type="text" autocomplete="off" spellcheck="false" placeholder="Search…" aria-label="Search options"><ul role="listbox"></ul>';
    const q = el.querySelector('input'), ul = el.querySelector('ul');
    const items = [];
    [...s.children].forEach(c => {
      if (c.tagName === 'OPTGROUP') {
        items.push({ grp: c.label });
        [...c.children].forEach(o => items.push({ o, dis: o.disabled || c.disabled }));
      } else if (c.tagName === 'OPTION') items.push({ o: c, dis: c.disabled });
    });
    let shown = [], act = -1;
    const render = () => {
      const t = norm(q.value), words = t.split(' ').filter(Boolean);
      shown = [];
      let html = '', pendingGrp = null;
      items.forEach(it => {
        if (it.grp !== undefined) { pendingGrp = it.grp; return; }
        if (it.o.hidden || it.o.style.display === 'none') return;
        const txt = it.o.textContent;
        if (words.length && !words.every(w => norm(txt).includes(w))) return;
        if (pendingGrp !== null) { html += `<li class="grp" role="presentation">${esc(pendingGrp)}</li>`; pendingGrp = null; }
        const i = shown.push(it) - 1;
        let label = esc(txt.trim() || ' ');
        if (words.length) words.forEach(w => { label = label.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'); });
        html += `<li role="option" data-i="${i}" class="${it.o.selected ? 'sel' : ''}${it.dis ? ' dis' : ''}" aria-selected="${it.o.selected}">${label}</li>`;
      });
      ul.innerHTML = html || '<li class="kit-empty">Kuch nahi mila</li>';
      const sel = shown.findIndex(it => it.o.selected && !it.dis);
      setAct(words.length ? shown.findIndex(it => !it.dis) : sel);
    };
    const setAct = i => {
      act = i;
      ul.querySelectorAll('li.act').forEach(li => li.classList.remove('act'));
      const li = ul.querySelector(`li[data-i="${i}"]`);
      if (li) { li.classList.add('act'); li.scrollIntoView({ block: 'nearest' }); }
    };
    const move = d => {
      if (!shown.length) return;
      let i = act;
      for (let n = 0; n < shown.length; n++) { i = (i + d + shown.length) % shown.length; if (!shown[i].dis) break; }
      setAct(i);
    };
    const pick = i => {
      const it = shown[i];
      if (!it || it.dis) return;
      closePop(); s.focus({ preventScroll: true });
      if (it.o.selected) return;
      it.o.selected = true;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    };
    q.addEventListener('input', render);
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(act); }
      else if (e.key === 'Tab') closePop();
    });
    ul.addEventListener('mousemove', e => { const li = e.target.closest('li[data-i]'); if (li && +li.dataset.i !== act) setAct(+li.dataset.i); });
    ul.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) pick(+li.dataset.i); });
    showPop(el, s);
    el.style.width = Math.min(Math.max(s.getBoundingClientRect().width, 220), 440) + 'px';
    render(); placePop();
    q.focus({ preventScroll: true });
  }
  document.addEventListener('mousedown', e => {
    if (e.button !== 0 || !finePointer.matches) return;
    const s = e.target.closest && e.target.closest('select');
    if (!s || s.multiple || s.size > 1 || s.disabled || s.closest('.no-kit') || s.options.length < SEL_MIN) return;
    e.preventDefault();
    if (openPop && openPop.anchor === s) { closePop(); return; }
    s.focus({ preventScroll: true });
    openSelect(s);
  }, true);

  // ── 3. sortable tables ─────────────────────────────────────────
  function sortInfo(th) {
    if (th.tagName !== 'TH' || th.hasAttribute('onclick') || th.colSpan !== 1 || !th.textContent.trim()) return null;
    const table = th.closest('table');
    if (!table || table.id === 'dashTable' || table.closest('.no-sort') || !table.tHead || table.tHead.rows.length !== 1) return null;
    if (th.parentElement !== table.tHead.rows[0] || table.tBodies.length !== 1) return null;
    const head = table.tHead.rows[0];
    if ([...head.cells].some(c => c.colSpan !== 1)) return null;
    const tb = table.tBodies[0], rows = [...tb.rows];
    if (rows.length < 2 || rows.length > 3000) return null;
    const cols = head.cells.length;
    // every body row must be a plain one-cell-per-column row (no group headers, detail rows, merges)
    for (const r of rows) {
      if (r.cells.length !== cols) return null;
      for (const c of r.cells) if (c.colSpan !== 1 || c.rowSpan !== 1) return null;
    }
    return { table, tb, rows, col: th.cellIndex };
  }
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function cellKey(td) {
    const raw = (td.dataset.sort !== undefined ? td.dataset.sort : td.textContent).replace(/\s+/g, ' ').trim();
    if (!raw || /^[—–\-]$/.test(raw)) return { empty: true };
    let m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b/.exec(raw);
    if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return { date: y * 10000 + +m[2] * 100 + +m[1], raw }; }
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (m) return { date: +m[1] * 10000 + +m[2] * 100 + +m[3], raw };
    m = /^(\d{1,2})[ \-]([A-Za-z]{3})[a-z]*[ \-,]*(\d{4})?/.exec(raw);
    if (m && MONTHS[m[2].toLowerCase()] !== undefined) return { date: (m[3] ? +m[3] : 0) * 10000 + (MONTHS[m[2].toLowerCase()] + 1) * 100 + +m[1], raw };
    m = /^([-+]?)\s*(?:₹|Rs\.?)?\s*([\d,]*\.?\d+)\s*(%|L|Cr|K)?\b/i.exec(raw);
    if (m) { let n = parseFloat(m[1] + m[2].replace(/,/g, '')); const u = (m[3] || '').toUpperCase(); if (u === 'L') n *= 1e5; else if (u === 'CR') n *= 1e7; else if (u === 'K') n *= 1e3; return { num: n, raw }; }
    return { raw };
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortBy(th) {
    const info = sortInfo(th);
    if (!info) return;
    const { table, tb, rows, col } = info;
    const dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
    const keyed = rows.map((r, i) => ({ r, i, k: cellKey(r.cells[col]) }));
    const filled = keyed.filter(x => !x.k.empty);
    const type = filled.length && filled.every(x => x.k.date !== undefined) ? 'date' : filled.length && filled.every(x => x.k.num !== undefined) ? 'num' : 'text';
    keyed.sort((x, y) => {
      if (x.k.empty !== y.k.empty) return x.k.empty ? 1 : -1; // blanks always last
      let c = 0;
      if (!x.k.empty) c = type === 'date' ? x.k.date - y.k.date : type === 'num' ? x.k.num - y.k.num : coll.compare(x.k.raw, y.k.raw);
      return c * dir || x.i - y.i;
    });
    [...th.parentElement.cells].forEach(c => c.removeAttribute('aria-sort'));
    th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
    const frag = document.createDocumentFragment();
    keyed.forEach(x => frag.appendChild(x.r));
    tb.appendChild(frag);
    table.dispatchEvent(new CustomEvent('kit:sorted', { bubbles: true }));
  }
  document.addEventListener('click', e => {
    const th = e.target.closest && e.target.closest('th');
    if (!th || e.target.closest('input,button,a,select,label,textarea')) return;
    sortBy(th);
  });
  document.addEventListener('pointerover', e => {
    const th = e.target.closest && e.target.closest('th');
    if (!th || th.dataset.kitChecked) return;
    th.dataset.kitChecked = '1';
    if (sortInfo(th)) { th.classList.add('kit-sortable'); th.title = th.title || 'Click to sort'; }
    // re-check when the table is re-rendered with different rows
    setTimeout(() => { delete th.dataset.kitChecked; }, 4000);
  }, { passive: true });

  // ── 4. ⋯ row menus ─────────────────────────────────────────────
  // In a table cell, Edit / Delete style buttons move into one ⋯ menu; the
  // main actions (Approve, Reject, Call ho gaya…) stay visible. The original
  // buttons stay in the cell (hidden) and the menu just clicks them, so every
  // page's own confirm / permission logic runs unchanged.
  const SEC_WORD = /^(edit|delete|remove|hatao)\b/i, SEC_ICON = /^(✏|🖊|📝|🗑)/u;
  const isSecondary = b => {
    const t = b.textContent.replace(/\s+/g, ' ').trim(), tip = (b.title || b.getAttribute('aria-label') || '').trim();
    const words = t.replace(/[\u{1F000}-\u{1FFFF}☀-➿️]/gu, '').trim(); // text without emoji
    if (SEC_ICON.test(t)) return !words || SEC_WORD.test(words); // "✏️", "🗑 Delete"
    if (!words) return SEC_WORD.test(tip) || !!b.querySelector('svg.lucide-trash-2,svg.lucide-pencil'); // icon-only with an Edit/Delete title
    return SEC_WORD.test(words) && !words.includes(' '); // plain "Edit" / "Delete"
  };
  const isDanger = b => /🗑|❌|delete|remove|hatao/i.test(b.textContent + ' ' + (b.title || ''));
  const itemLabel = b => {
    const t = b.textContent.replace(/\s+/g, ' ').trim(), tip = (b.title || b.getAttribute('aria-label') || '').trim();
    const word = /[a-z]{3}/i.test(t) ? t.replace(/^[^\w]+/u, '') : tip || (isDanger(b) ? 'Delete' : 'Edit');
    return `<span aria-hidden="true">${isDanger(b) ? '🗑' : '✏️'}</span>${esc(word.charAt(0).toUpperCase() + word.slice(1))}`;
  };
  const visible = b => b.style.display !== 'none' && !b.hidden && !b.classList.contains('kit-hidden');
  function collapseRowActions(td) {
    if (td.dataset.kitMenu || td.closest('#dashTable,.no-kit')) return;
    const btns = [...td.querySelectorAll('button')].filter(visible);
    if (btns.length < 2) return;
    const sec = btns.filter(isSecondary);
    if (!(sec.length >= 2 || (sec.length >= 1 && btns.length >= 3))) return;
    td.dataset.kitMenu = '1';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = (sec[0].className || 'btn btn-outline btn-sm') + ' kit-more';
    more.setAttribute('aria-label', 'More actions'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    more.title = sec.map(b => itemLabel(b).replace(/<[^>]+>[^<]*<\/span>/, '')).join(' / ');
    more.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
    sec[0].insertAdjacentElement('beforebegin', more);
    sec.forEach(b => b.classList.add('kit-hidden'));
    more.addEventListener('click', e => {
      e.stopPropagation(); // rows with their own onclick (open detail) must not fire
      if (openPop && openPop.anchor === more) { closePop(); return; }
      const m = document.createElement('div');
      m.className = 'kit-menu'; m.setAttribute('role', 'menu');
      m.innerHTML = sec.map((b, i) => `<button type="button" role="menuitem" data-i="${i}" class="${isDanger(b) ? 'danger' : ''}">${itemLabel(b)}</button>`).join('');
      m.addEventListener('click', ev => {
        const it = ev.target.closest('[data-i]');
        if (!it) return;
        closePop();
        sec[+it.dataset.i].click();
      });
      m.addEventListener('keydown', ev => {
        const items = [...m.querySelectorAll('[role=menuitem]')], i = items.indexOf(document.activeElement);
        if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      });
      showPop(m, more);
      const r = more.getBoundingClientRect(); // right-align under the ⋯ button
      m.style.minWidth = '150px';
      m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + 'px';
      if (!finePointer.matches) return;
      m.querySelector('button').focus({ preventScroll: true });
    });
  }
  let rowQueue = new Set(), rowQueued = false;
  function queueRowActions(nodes) {
    nodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'TD') rowQueue.add(n);
      else if (n.closest && n.closest('td')) rowQueue.add(n.closest('td'));
      else if (n.querySelectorAll) n.querySelectorAll('td').forEach(td => { if (td.querySelector('button')) rowQueue.add(td); });
    });
    if (rowQueued || !rowQueue.size) return;
    rowQueued = true;
    requestAnimationFrame(() => {
      rowQueued = false;
      const tds = rowQueue; rowQueue = new Set();
      tds.forEach(td => { if (td.isConnected) collapseRowActions(td); });
    });
  }

  // ── number fields: wheel scroll must not change an amount ──────
  document.addEventListener('wheel', e => {
    const el = e.target;
    if (el && el.tagName === 'INPUT' && el.type === 'number' && el === document.activeElement) el.blur();
  }, { passive: true });

  // ── boot ───────────────────────────────────────────────────────
  // Runs before DOMContentLoaded (defer), i.e. before app.html's DD-MM-YYYY
  // upgrader, so pairs never get the two-box treatment first. The observer
  // callback is a microtask and beats that upgrader's requestAnimationFrame
  // for pairs rendered later.
  upgradeAllRanges();
  queueRowActions([document.body]);
  let pending = false;
  new MutationObserver(recs => {
    for (const r of recs) if (r.addedNodes.length) queueRowActions(r.addedNodes);
    if (pending) return; pending = true;
    queueMicrotask(() => { pending = false; upgradeAllRanges(); });
  }).observe(document.body, { childList: true, subtree: true });
})();
