/* Ajanta Task Manager — Dashboard effects (2026-10-27).
   Presentation only: watches what the app renders on #page-dashboard and
   animates it. No API calls, no data changes, no app functions rewritten.
   Loaded once from app.html with <script src="/ajanta-dashboard-fx.js" defer>. */
(function () {
  'use strict';
  if (window.__ajDashFx) return; // idempotent: a second copy does nothing
  window.__ajDashFx = true;
  if (!window.matchMedia || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var page = document.getElementById('page-dashboard');
  if (!page) return;
  var finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

  // ── Styles ─────────────────────────────────────────────────────────────
  var CSS = [
    '@keyframes ajfxRise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}',
    '@keyframes ajfxRowIn{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}',
    '@keyframes ajfxBreathe{0%,100%{box-shadow:0 2px 14px rgba(216,7,0,.08)}50%{box-shadow:0 0 0 3px rgba(216,7,0,.10),0 10px 32px -6px rgba(216,7,0,.38)}}',
    '@keyframes ajfxPop{0%{transform:scale(1)}40%{transform:scale(1.12)}100%{transform:scale(1)}}',
    '@keyframes ajfxRing{0%{box-shadow:0 0 0 0 rgba(1,3,113,.45)}70%{box-shadow:0 0 0 12px rgba(1,3,113,0)}100%{box-shadow:0 0 0 0 rgba(1,3,113,0)}}',
    '@keyframes ajfxFlow{from{background-position:0 0}to{background-position:-200% 0}}',
    // 2 · entrance (fill "backwards" so the tilt's inline transform still applies afterwards)
    '#page-dashboard.ajfx-enter .dash-topbar,#page-dashboard.ajfx-enter .ov-card,#page-dashboard.ajfx-enter .dash-bottom>*,#page-dashboard.ajfx-enter #dashO2dHold{animation:ajfxRise .62s cubic-bezier(.22,1,.36,1) backwards}',
    '#page-dashboard.ajfx-enter .ov-card:nth-child(1){animation-delay:.1s}',
    '#page-dashboard.ajfx-enter .ov-card:nth-child(2){animation-delay:.2s}',
    '#page-dashboard.ajfx-enter .ov-card:nth-child(3){animation-delay:.3s}',
    '#page-dashboard.ajfx-enter .dash-bottom>*:nth-child(1){animation-delay:.34s}',
    '#page-dashboard.ajfx-enter .dash-bottom>*:nth-child(2){animation-delay:.44s}',
    '#page-dashboard.ajfx-enter #dashO2dHold{animation-delay:.52s}',
    // 4 · pending breathing (combined with the entrance when both apply)
    '#page-dashboard .ov-card.pending.ajfx-breathe{animation:ajfxBreathe 2.8s ease-in-out infinite}',
    '#page-dashboard.ajfx-enter .ov-card.pending.ajfx-breathe{animation:ajfxRise .62s cubic-bezier(.22,1,.36,1) .1s backwards,ajfxBreathe 2.8s ease-in-out .8s infinite}',
    // 3 · tilt + cursor glow (glow is a child: .ov-card::after is the coloured top bar)
    '#page-dashboard .ov-card.ajfx-tilt{transition:transform .14s ease-out,box-shadow .25s ease;will-change:transform}',
    '#page-dashboard .ov-card.ajfx-tilt:hover{box-shadow:0 20px 40px -14px rgba(15,23,42,.30)}',
    '#page-dashboard .ov-card>:not(.ajfx-glow){position:relative}',
    '.ajfx-glow{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .25s;border-radius:inherit;background:radial-gradient(220px circle at var(--mx,50%) var(--my,50%),var(--ajfx-tint),transparent 65%)}',
    '#page-dashboard .ov-card:hover .ajfx-glow{opacity:1}',
    '.ov-card.pending{--ajfx-tint:rgba(216,7,0,.14)}.ov-card.revised{--ajfx-tint:rgba(245,158,11,.18)}.ov-card.completed{--ajfx-tint:rgba(16,185,129,.18)}',
    // 1 · pop at the end of a count
    '#page-dashboard .ov-card .number.ajfx-pop{animation:ajfxPop .38s cubic-bezier(.34,1.56,.64,1);transform-origin:left center}',
    // 5 · table rows (beats the app-wide row fade for this table)
    '#page-dashboard #dashTable tbody tr{animation:none}',
    '#page-dashboard #dashTable tbody tr.ajfx-row{animation:ajfxRowIn .42s cubic-bezier(.22,1,.36,1) backwards;animation-delay:calc(var(--ajfx-i,0) * 32ms)}',
    '#page-dashboard #dashTable tbody tr:hover td{background:rgba(1,3,113,.035)}',
    '#page-dashboard #dashTable tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 #D80700}',
    // 7 · completion rate
    '.ajfx-rate{margin-top:14px;padding-top:12px;border-top:1px solid var(--gray-100,#f1f5f9)}',
    '.ajfx-rate-top{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--gray-500,#64748b)}',
    '.ajfx-rate-pct{font-size:18px;font-weight:800;letter-spacing:0;color:#059669;font-variant-numeric:tabular-nums}',
    '.ajfx-rate-bar{height:8px;border-radius:99px;background:var(--gray-100,#eef2f7);overflow:hidden;margin-top:6px}',
    '.ajfx-rate-fill{height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,#10b981,#34d399,#6ee7b7,#34d399,#10b981);background-size:200% 100%;animation:ajfxFlow 2.4s linear infinite;transition:width 1.2s cubic-bezier(.22,1,.36,1)}',
    // 8 · Punch In ring
    '#dashAttnPunchBtn.ajfx-ring{animation:ajfxRing 2s cubic-bezier(.4,0,.6,1) infinite}',
    // 10 · topbar buttons
    '#page-dashboard .dash-topbar .btn{transition:transform .15s ease,filter .15s ease,box-shadow .2s ease}',
    '#page-dashboard .dash-topbar .btn:hover{transform:translateY(-2px);filter:brightness(1.05)}',
    '#page-dashboard .dash-topbar .btn:active{transform:scale(.96)}',
    // 9 · confetti layer
    '.ajfx-confetti{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999}'
  ].join('\n');
  if (!document.getElementById('ajfx-css')) {
    var st = document.createElement('style');
    st.id = 'ajfx-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ── 2 · entrance (first paint + every return to the dashboard) ──────────
  function replayEnter() {
    page.classList.remove('ajfx-enter');
    void page.offsetWidth; // restart the animations
    page.classList.add('ajfx-enter');
  }
  if (page.classList.contains('active')) replayEnter();

  // ── 1 · KPI count-up ─────────────────────────────────────────────────────
  var easeOutExpo = function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); };
  var parseNum = function (t) { var s = String(t).replace(/,/g, '').trim(); return /^-?\d+$/.test(s) ? Number(s) : null; };
  var kpi = {}; // id -> { el, shown, target, raf, last }
  ['dPending', 'dRevised', 'dCompleted'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) kpi[id] = { el: el, shown: null, target: parseNum(el.textContent), raf: 0, last: el.textContent };
  });

  function write(o, v) { o.last = String(v); o.el.textContent = o.last; } // o.last = our own write → observer skips it
  function pop(el) {
    el.classList.remove('ajfx-pop');
    void el.offsetWidth;
    el.classList.add('ajfx-pop');
  }
  function countTo(o, from, to) {
    cancelAnimationFrame(o.raf);
    o.target = to;
    if (from === to) { o.shown = to; write(o, to); return; }
    var dur = Math.min(1600, 600 + Math.log10(Math.abs(to - from) + 1) * 350);
    var t0 = performance.now();
    var step = function (now) {
      var p = Math.min(1, (now - t0) / dur);
      o.shown = Math.round(from + (to - from) * easeOutExpo(p));
      write(o, o.shown);
      if (p < 1) o.raf = requestAnimationFrame(step);
      else { o.raf = 0; pop(o.el); }
    };
    o.raf = requestAnimationFrame(step);
  }
  function replayCounts() {
    Object.keys(kpi).forEach(function (id) {
      var o = kpi[id];
      if (o.target != null && o.el.offsetParent) { o.shown = 0; write(o, 0); countTo(o, 0, o.target); }
    });
  }

  // 9 · confetti only after a Done click on the dashboard (a reload first writes
  // Delegation+Checklist and only then adds the FMS count, so "the number went
  // up" alone would fire on every load).
  var armed = null; // { until, base }
  page.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#dashTable .action-btn.done');
    if (b && kpi.dCompleted) armed = { until: Date.now() + 120000, base: kpi.dCompleted.target || 0 };
  }, true);

  Object.keys(kpi).forEach(function (id) {
    var o = kpi[id];
    new MutationObserver(function () {
      var t = o.el.textContent;
      if (t === o.last) return; // our own frame
      var n = parseNum(t);
      o.last = t;
      if (n === null) { cancelAnimationFrame(o.raf); o.raf = 0; o.shown = null; o.target = null; return; }
      var from = o.shown == null ? 0 : o.shown;
      write(o, from); // runs before paint, so the app's final number never flashes
      countTo(o, from, n);
      if (id === 'dPending' && kpi.dPending) {
        var card = o.el.closest('.ov-card');
        if (card) card.classList.toggle('ajfx-breathe', n > 0);
      }
      if (id === 'dCompleted' && armed && Date.now() < armed.until && n > armed.base) { armed = null; confetti(o.el); }
      scheduleRate();
    }).observe(o.el, { childList: true, characterData: true, subtree: true });
  });

  // ── 3 · tilt + glow on the KPI cards (mouse only) ───────────────────────
  if (finePointer) {
    Array.prototype.forEach.call(page.querySelectorAll('.ov-card'), function (card) {
      card.classList.add('ajfx-tilt');
      if (!card.querySelector(':scope > .ajfx-glow')) {
        var g = document.createElement('span');
        g.className = 'ajfx-glow';
        g.setAttribute('aria-hidden', 'true');
        card.insertBefore(g, card.firstChild);
      }
      var raf = 0, last = null;
      card.addEventListener('pointermove', function (e) {
        if (e.pointerType !== 'mouse') return;
        last = e;
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          var r = card.getBoundingClientRect();
          var x = (last.clientX - r.left) / r.width, y = (last.clientY - r.top) / r.height;
          card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
          card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
          card.style.transform = 'perspective(700px) rotateX(' + ((0.5 - y) * 14).toFixed(2) + 'deg) rotateY(' + ((x - 0.5) * 14).toFixed(2) + 'deg) translateY(-4px)';
        });
      });
      card.addEventListener('pointerleave', function () {
        cancelAnimationFrame(raf); raf = 0;
        card.style.transform = '';
      });
    });
  }

  // ── 5 · table rows slide in on every re-render ───────────────────────────
  var tbody = document.getElementById('dashTbody') || (document.getElementById('dashTable') || {}).tBodies && document.getElementById('dashTable').tBodies[0];
  function markRows() {
    var rows = tbody.rows;
    for (var i = 0; i < rows.length && i < 14; i++) {
      if (rows[i].classList.contains('ajfx-row')) continue;
      rows[i].style.setProperty('--ajfx-i', i);
      rows[i].classList.add('ajfx-row');
    }
  }
  if (tbody) {
    markRows();
    new MutationObserver(markRows).observe(tbody, { childList: true }); // only rows; our class edits don't re-trigger it
  }

  // ── 6 · pie: rotate + scale, replayed when it comes back into view ───────
  try {
    if (window.Chart && Chart.register && !(Chart.registry && Chart.registry.plugins.get('ajfxPie'))) {
      Chart.register({
        id: 'ajfxPie',
        beforeInit: function (chart) {
          if (!chart.canvas || chart.canvas.id !== 'dashChart') return;
          var cfg = chart.config, opts = cfg.options || (cfg.options = {});
          opts.animation = Object.assign({}, opts.animation, { animateRotate: true, animateScale: true, duration: 1500, easing: 'easeOutQuart' });
          ((cfg.data && cfg.data.datasets) || []).forEach(function (d) { d.hoverOffset = 14; d.borderWidth = 3; d.borderColor = '#fff'; });
          chart.$ajfxBorn = Date.now();
        }
      });
    }
  } catch (e) { /* Chart.js missing or changed — the pie just stays as it is */ }
  function replayPie() {
    try {
      var c = window.Chart && Chart.getChart && Chart.getChart('dashChart');
      if (!c || Date.now() - (c.$ajfxBorn || 0) < 1600) return; // a fresh chart is already animating
      c.reset();
      c.update();
    } catch (e) { /* skip */ }
  }

  // ── 7 · completion rate under the pie ────────────────────────────────────
  var chartCard = page.querySelector('.chart-card');
  var rateBox = document.getElementById('ajfxRate');
  if (chartCard && !rateBox) {
    rateBox = document.createElement('div');
    rateBox.className = 'ajfx-rate';
    rateBox.id = 'ajfxRate';
    rateBox.innerHTML = '<div class="ajfx-rate-top"><span>Completion rate</span><span class="ajfx-rate-pct">—</span></div>' +
      '<div class="ajfx-rate-bar" role="progressbar" aria-label="Completion rate" aria-valuemin="0" aria-valuemax="100"><div class="ajfx-rate-fill"></div></div>';
    chartCard.appendChild(rateBox);
  }
  var rateT = 0;
  function scheduleRate() { clearTimeout(rateT); rateT = setTimeout(updateRate, 250); }
  function updateRate() {
    if (!rateBox) return;
    var v = function (id) { var o = kpi[id]; return o && o.target != null ? o.target : 0; };
    var done = v('dCompleted'), total = v('dPending') + v('dRevised') + done;
    var pct = total ? Math.round(done / total * 1000) / 10 : 0;
    rateBox.querySelector('.ajfx-rate-pct').textContent = total ? pct + '%' : '—';
    rateBox.querySelector('.ajfx-rate-fill').style.width = pct + '%';
    rateBox.querySelector('.ajfx-rate-bar').setAttribute('aria-valuenow', String(pct));
  }
  updateRate();

  // ── 8 · Punch In ring ─────────────────────────────────────────────────────
  var punch = document.getElementById('dashAttnPunchBtn');
  if (punch) {
    var syncRing = function () { punch.classList.toggle('ajfx-ring', punch.textContent.trim() === 'Punch In'); };
    syncRing();
    new MutationObserver(syncRing).observe(punch, { childList: true, characterData: true, subtree: true });
  }

  // ── 9 · confetti ──────────────────────────────────────────────────────────
  var confettiOn = false;
  function confetti(fromEl) {
    if (confettiOn) return;
    confettiOn = true;
    var r = fromEl.getBoundingClientRect();
    var cx = r.left + Math.min(r.width, 120) / 2, cy = r.top + r.height / 2;
    var cv = document.createElement('canvas');
    cv.className = 'ajfx-confetti';
    cv.setAttribute('aria-hidden', 'true');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    var colors = ['#010371', '#D80700', '#10b981', '#f59e0b', '#3b82f6'];
    var parts = [];
    for (var i = 0; i < 70; i++) {
      parts.push({ x: cx, y: cy, vx: (Math.random() - 0.5) * 10, vy: -(Math.random() * 8 + 3), s: 4 + Math.random() * 4,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: colors[i % colors.length] });
    }
    var t0 = performance.now(), DUR = 1600;
    var frame = function (now) {
      var el = now - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - el / DUR);
      parts.forEach(function (p) {
        p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (el < DUR) requestAnimationFrame(frame);
      else { cv.remove(); confettiOn = false; }
    };
    requestAnimationFrame(frame);
  }

  // ── Replays: back on the dashboard (page was display:none) / pie scrolled back into view ──
  if ('IntersectionObserver' in window) {
    var hiddenByPage = false;
    var cards = page.querySelector('.overview-cards');
    if (cards) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) { if (!en.boundingClientRect.width) hiddenByPage = true; return; }
          if (hiddenByPage) { hiddenByPage = false; replayEnter(); replayCounts(); }
        });
      }).observe(cards);
    }
    if (chartCard) {
      var pieSeen = false;
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { if (pieSeen) replayPie(); pieSeen = true; }
        });
      }, { threshold: 0.35 }).observe(chartCard);
    }
  }
})();
