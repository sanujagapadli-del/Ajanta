/* Ajanta Task Manager — card numbers count up from 0 on every page (client 2026-10-27:
   "jha jha cards and numbers hai vo 0 se badhte hue hi aana chahiye").
   Presentation only. Watches what pages render and, for a big stand-alone
   number on a card (₹50,18,451 · 638 · 70.7%), counts it up from 0 the first
   time it appears and from the old value when a refresh changes it.
   Tables, badges, buttons and inputs are left alone. The Dashboard KPI cards
   are counted by ajanta-dashboard-fx.js. Nothing runs with reduced motion. */
(function () {
  'use strict';
  if (window.__ajCountUp) return;
  window.__ajCountUp = true;
  if (!window.matchMedia || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // ₹ / Rs prefix, digits with Indian or plain commas, optional decimals, optional % / L / Cr / K suffix.
  var NUM_RE = /^(\s*(?:₹|Rs\.?)\s?)?(-?)(\d{1,3}(?:,\d{2,3})*|\d+)(\.\d+)?(\s?(?:%|L|Cr|K|k))?\s*$/;
  var SKIP = 'td,th,button,input,select,option,textarea,kbd,code,.status-badge,.priority-badge,.btn,.tab,.nav-item,.bn-item,label,#page-dashboard .ov-card,.ajfx-rate,.tb-search,.ui-toast,.cmdk';
  var DUR = 700;
  var ease = function (t) { return 1 - Math.pow(1 - t, 3); };

  function parse(text) {
    var m = NUM_RE.exec(text);
    if (!m) return null;
    var dec = m[4] ? m[4].length - 1 : 0;
    var val = Number((m[2] || '') + m[3].replace(/,/g, '') + (m[4] || ''));
    if (!isFinite(val)) return null;
    var indian = /\d,\d{2},/.test(m[3]) || (m[3].indexOf(',') >= 0 && Math.abs(val) >= 100000);
    return { val: val, dec: dec, pre: m[1] || '', suf: m[5] || '', comma: m[3].indexOf(',') >= 0, indian: indian };
  }
  function fmt(p, v) {
    var s = p.comma
      ? Math.abs(v).toLocaleString(p.indian ? 'en-IN' : 'en-US', { minimumFractionDigits: p.dec, maximumFractionDigits: p.dec })
      : Math.abs(v).toFixed(p.dec);
    return p.pre + (v < 0 ? '-' : '') + s + p.suf;
  }
  function candidate(el) {
    if (!el || el.nodeType !== 1 || el.children.length) return false;
    if (!el.closest('.page.active, .modal-overlay.open')) return false;
    if (el.closest(SKIP)) return false;
    var t = el.textContent;
    if (!t || t.length > 24 || !/\d/.test(t)) return false;
    var cs = getComputedStyle(el);
    return parseFloat(cs.fontSize) >= 16 && (parseInt(cs.fontWeight, 10) || 400) >= 600;
  }
  // Pages re-draw their cards on every tab click / search keystroke. A card counts
  // from 0 the first time it shows after its page was opened (however long the data
  // took); later re-draws count from its previous value (same card = same page +
  // same label next to the number). Opening a page changes the tab title.
  var gen = 0, lastVal = new Map(), seenGen = new Map();
  var titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(function () { gen++; }).observe(titleEl, { childList: true, characterData: true, subtree: true });
  function keyOf(el) {
    var page = el.closest('.page, .modal-overlay');
    var box = el.parentElement, label = box ? box.textContent.replace(el.textContent, '').trim().slice(0, 40) : '';
    return (page ? page.id : '') + '|' + label;
  }
  function run(el) {
    var text = el.textContent;
    if (text === el.__cuLast) return; // our own frame
    var p = parse(text), key = keyOf(el);
    if (!p || p.val === 0) { el.__cuLast = text; el.__cuVal = p ? 0 : null; if (p) lastVal.set(key, 0); return; }
    var fresh = seenGen.get(key) !== gen;
    seenGen.set(key, gen);
    var from = typeof el.__cuVal === 'number' ? el.__cuVal : (fresh || !lastVal.has(key) ? 0 : lastVal.get(key));
    lastVal.set(key, p.val);
    if (from === p.val) { el.__cuLast = text; el.__cuVal = p.val; return; }
    cancelAnimationFrame(el.__cuRaf || 0);
    var t0 = performance.now();
    var step = function (now) {
      var k = Math.min(1, (now - t0) / DUR);
      var v = from + (p.val - from) * ease(k);
      var out = k < 1 ? fmt(p, p.dec ? v : Math.round(v)) : text; // last frame = the page's own text exactly
      el.__cuLast = out;
      el.textContent = out;
      if (k < 1) el.__cuRaf = requestAnimationFrame(step);
      else el.__cuRaf = 0;
    };
    el.__cuVal = p.val;
    el.__cuLast = fmt(p, from);
    el.textContent = el.__cuLast; // before paint, so the final number never flashes
    el.__cuRaf = requestAnimationFrame(step);
  }

  var queue = new Set(), scheduled = false;
  function flush() {
    scheduled = false;
    queue.forEach(function (el) { if (el.isConnected && candidate(el)) run(el); });
    queue.clear();
  }
  function add(node) {
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return;
    if (!node.children.length) queue.add(node);
    else if (node.querySelectorAll) {
      var all = node.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) if (!all[i].children.length && /\d/.test(all[i].textContent)) queue.add(all[i]);
    }
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  }
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'characterData') add(r.target);
      else for (var j = 0; j < r.addedNodes.length; j++) add(r.addedNodes[j]);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
