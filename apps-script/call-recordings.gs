/**
 * Call recordings → Ajanta ERP "Call Reports" page.
 *
 * Runs on the COMPANY Google Workspace account — the Manager of every
 * salesman's Shared Drive "Calls - <name>" (salesmen are Contributors: they
 * can upload, can't delete or see each other's drives). Every 10 minutes:
 *   new recording in a drive → Groq Whisper (text) → Claude Haiku (summary)
 *   → POST to the ERP in small batches → file marked done (appProperties).
 * Files are never moved, so Autosync never uploads them again; the ERP also
 * tells us which names it already has, so nothing is paid for twice.
 *
 * SETUP (once):
 *  1. script.google.com → New project (logged in as the company account).
 *     Paste this file and appsscript.json (Project Settings → "Show
 *     appsscript.json manifest file in editor").
 *  2. Project Settings → Script Properties:
 *       GROQ_KEY    console.groq.com API key
 *       CLAUDE_KEY  platform.claude.com API key
 *       ERP_KEY     from ERP → Call Reports → ⚙️ Setup → Key banao
 *       ERP_URL     https://ajanta-erp.vercel.app   (optional, this is the default)
 *     Optional: DRIVE_PREFIX ("Calls - "), KEEP_DAYS (60), LANGUAGE ("hi"),
 *               GROQ_MODEL ("whisper-large-v3-turbo"), CLAUDE_MODEL ("claude-haiku-5-5")
 *  3. Run checkSetup() once (approve the permissions) and read the log.
 *  4. Run installTriggers() once.
 */

const CFG = PropertiesService.getScriptProperties();
const cfg = (k, d) => CFG.getProperty(k) || d || '';
const RUN_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops a run at 6 min
const BATCH = 10;                         // POST to the ERP every 10 calls
const AUDIO_RX = /\.(m4a|mp3|mp4|wav|ogg|opus|flac|webm|mpeg|mpga|aac|amr|3gp|3gpp|awb)$/i;
const GROQ_OK_RX = /\.(m4a|mp3|mp4|wav|ogg|opus|flac|webm|mpeg|mpga)$/i; // formats Groq accepts
const MAX_BYTES = 24 * 1024 * 1024;
const CALL_TYPES = ['Order', 'Payment', 'Complaint', 'Enquiry', 'Follow-up', 'Other'];

// ── Main job (trigger: every 10 min) ─────────────────────────────────────
function processCalls() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;        // the previous run is still going
  const started = Date.now();
  const timeLeft = () => Date.now() - started < RUN_BUDGET_MS;
  let pending = [], stop = false, done = 0;
  try {
    for (const d of listCallDrives_()) {
      if (stop || !timeLeft()) break;
      const files = listNewRecordings_(d.id);
      if (!files.length) continue;
      const known = erpPost_('/api/calls/known', { drive: d.name, names: files.map(f => f.name) }).known || [];
      for (const f of files) {
        if (!timeLeft()) { stop = true; break; }
        if (known.indexOf(f.name) >= 0) { markDone_(f.id); continue; }
        let call;
        try { call = processOne_(d.name, f); }
        catch (e) {
          // Groq busy / down: leave the file for the next run. 429 = stop now.
          console.warn(`${d.name} / ${f.name}: ${e.message}`);
          if (e.code === 429) { stop = true; break; }
          continue;
        }
        pending.push({ id: f.id, call });
        if (pending.length >= BATCH) { done += flush_(pending); pending = []; }
      }
    }
  } finally {
    try { if (pending.length) done += flush_(pending); }
    finally { lock.releaseLock(); }
  }
  if (done) console.log(`${done} call(s) sent to the ERP`);
}

function processOne_(drive, f) {
  const meta = parseFileName_(f.name, f.createdTime);
  const call = { drive, fileName: f.name, fileId: f.id, audioUrl: f.webViewLink || '', callAt: meta.callAt, phone: meta.phone, contactName: meta.contact };
  if (!GROQ_OK_RX.test(f.name)) { call.error = 'Ye recording format (' + f.name.split('.').pop() + ') text me nahi badalta — phone recorder ko m4a / mp3 pe set karo'; return call; }
  if (Number(f.size) > MAX_BYTES) { call.error = 'Recording 24 MB se badi hai'; return call; }
  const blob = DriveApp.getFileById(f.id).getBlob().setName(f.name);
  let tr;
  try { tr = groqTranscribe_(blob); }      // busy / network → throws, retried next run
  catch (e) {
    if (!e.permanent) throw e;             // corrupt / empty audio: save the error, don't retry
    call.error = e.message.slice(0, 500);
    return call;
  }
  call.transcript = String(tr.text || '').trim();
  call.durationSec = Math.round(Number(tr.duration) || 0);
  if (call.transcript.length < 15) {
    call.summary = { type: 'Other', summary: 'Bahut chhoti call — koi baat record nahi hui' };
    return call;
  }
  try { call.summary = claudeSummary_(call, meta); }
  catch (e) { call.error = 'Summary nahi bani: ' + e.message; }
  return call;
}

// Send a batch; mark files done only after the ERP saved them.
function flush_(items) {
  const r = erpPost_('/api/calls/ingest', { calls: items.map(x => x.call) });
  if (!r.success) throw new Error('ERP ingest failed: ' + JSON.stringify(r).slice(0, 300));
  items.forEach(x => markDone_(x.id));
  return items.length;
}

// ── Drive ────────────────────────────────────────────────────────────────
function listCallDrives_() {
  const prefix = cfg('DRIVE_PREFIX', 'Calls - ').toLowerCase();
  const out = [];
  let token;
  do {
    const r = Drive.Drives.list({ pageSize: 100, pageToken: token });
    (r.drives || []).forEach(d => { if (d.name.toLowerCase().indexOf(prefix) === 0) out.push({ id: d.id, name: d.name }); });
    token = r.nextPageToken;
  } while (token);
  return out;
}
function listNewRecordings_(driveId) {
  const out = [];
  let token;
  do {
    const r = Drive.Files.list({
      corpora: 'drive', driveId, includeItemsFromAllDrives: true, supportsAllDrives: true, pageSize: 200, pageToken: token,
      q: "trashed=false and mimeType!='application/vnd.google-apps.folder' and not appProperties has { key='erp' and value='done' }",
      orderBy: 'createdTime', fields: 'nextPageToken, files(id, name, size, createdTime, webViewLink)'
    });
    (r.files || []).forEach(f => { if (AUDIO_RX.test(f.name)) out.push(f); });
    token = r.nextPageToken;
  } while (token && out.length < 300);
  return out;
}
function markDone_(fileId) {
  Drive.Files.update({ appProperties: { erp: 'done' } }, fileId, null, { supportsAllDrives: true });
}

// ── File name → call time, number, saved contact name ────────────────────
// Phones name recordings differently ("Call recording Sharma Electricals_241018_103022.m4a",
// "9876543210_20241018103022.mp3", "Rec_+919876543210 2024-10-18 10-30-22.m4a" …). Anything not found falls back to
// the upload time. Adjust here once the real file names are known.
function parseFileName_(name, createdTime) {
  let base = String(name).replace(/\.[^.]+$/, '');
  let callAt = '';
  const pats = [
    { rx: /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})/, y4: true },
    { rx: /(?:^|\D)(\d{2})(\d{2})(\d{2})[_ -](\d{2})(\d{2})(\d{2})(?!\d)/, y4: false }
  ];
  for (const p of pats) {
    const m = p.rx.exec(base);
    if (!m) continue;
    const y = p.y4 ? m[1] : '20' + m[1], mo = +m[2], dd = +m[3], hh = +m[4], mi = +m[5], ss = +m[6];
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) continue;
    callAt = `${y}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
    base = base.replace(m[0], ' ');
    break;
  }
  if (!callAt) callAt = Utilities.formatDate(new Date(createdTime || Date.now()), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
  let phone = '';
  const pm = /\+?\d[\d\s-]{8,15}\d/.exec(base);
  if (pm && pm[0].replace(/\D/g, '').length >= 10) { phone = pm[0].replace(/[^\d+]/g, ''); base = base.replace(pm[0], ' '); }
  const contact = base.replace(/call[\s_-]*recording|recording|record|call|rec|voice|audio/gi, ' ')
    .replace(/[_@#()[\]]+/g, ' ').replace(/\s*[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
  return { callAt, phone, contact: /[a-zऀ-ॿ]/i.test(contact) ? contact : '' };
}

// ── Groq Whisper: audio → text ───────────────────────────────────────────
function groqTranscribe_(blob) {
  const res = fetch_('Groq', 'https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + cfg('GROQ_KEY') },
    payload: { file: blob, model: cfg('GROQ_MODEL', 'whisper-large-v3-turbo'), language: cfg('LANGUAGE', 'hi'), response_format: 'verbose_json', temperature: '0' }
  });
  return JSON.parse(res.getContentText());   // { text, duration, … }
}

// ── Claude Haiku: text → short report ────────────────────────────────────
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    dealer: { type: 'string' }, type: { type: 'string', enum: CALL_TYPES }, summary: { type: 'string' },
    items: { type: 'string' }, payment: { type: 'string' }, followupDate: { type: 'string' }, followupNote: { type: 'string' }
  },
  required: ['dealer', 'type', 'summary', 'items', 'payment', 'followupDate', 'followupNote'],
  additionalProperties: false
};
const SUMMARY_SYSTEM = `Tum Ajanta Appliances (geyser aur home appliances ke distributor) ke ek salesman ki dealer / customer ke saath phone call ka transcript padh rahe ho. Transcript speech-to-text se bana hai, isme galat shabd ho sakte hain.
Owner ke liye chhoti report banao, Roman Hinglish me (jaise "Dealer ne 20 geyser ka order diya, Monday tak payment"). Jo baat call me nahi hui, us field ko khali string "" rakho — apne se kuch mat banao.
- dealer: call me bola gaya dukaan / firm ka naam, warna "".
- type: Order (order diya / maal manga), Payment (paisa, cheque, bakaya, vaada), Complaint (kharab maal, service, replacement), Enquiry (rate, stock, naya product poocha), Follow-up (pichli baat aage badhayi, visit fix), Other.
- summary: 1-2 line me kya baat hui.
- items: product aur quantity, jaise "20 × 15L Geyser, 5 × Room Heater".
- payment: amount / cheque / payment ki date ka vaada.
- followupDate: agli call / visit / payment ki date YYYY-MM-DD me ("kal", "Monday ko" ko call ki date se nikaalo), warna "".
- followupNote: follow-up me kya karna hai, warna "".`;

function claudeSummary_(call, meta) {
  const day = Utilities.formatDate(new Date(call.callAt.replace(' ', 'T') + '+05:30'), 'Asia/Kolkata', 'yyyy-MM-dd EEEE');
  const res = fetch_('Claude', 'https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': cfg('CLAUDE_KEY'), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: cfg('CLAUDE_MODEL', 'claude-haiku-5-5'),
      max_tokens: 2000,
      system: SUMMARY_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
      messages: [{ role: 'user', content: `Call ki date: ${day}\nSalesman: ${call.drive}\nPhone me saved naam / number: ${meta.contact || '-'} ${meta.phone || ''}\n\nTranscript:\n${call.transcript.slice(0, 60000)}` }]
    })
  });
  const data = JSON.parse(res.getContentText());
  if (data.stop_reason === 'refusal') throw new Error('Claude ne mana kiya');
  const block = (data.content || []).filter(b => b.type === 'text')[0];   // thinking blocks may come first
  if (!block) throw new Error('Claude ne khali jawab diya (' + data.stop_reason + ')');
  return JSON.parse(block.text);
}

// ── ERP + HTTP ───────────────────────────────────────────────────────────
function erpPost_(path, body) {
  const res = fetch_('ERP', cfg('ERP_URL', 'https://ajanta-erp.vercel.app').replace(/\/+$/, '') + path, {
    method: 'post', contentType: 'application/json', headers: { 'x-calls-key': cfg('ERP_KEY') }, payload: JSON.stringify(body)
  });
  return JSON.parse(res.getContentText());
}
function fetch_(who, url, opts) {
  opts.muteHttpExceptions = true;
  let res;
  try { res = UrlFetchApp.fetch(url, opts); }
  catch (e) { const err = new Error(`${who}: ${e.message}`); err.code = 0; throw err; }
  const code = res.getResponseCode();
  if (code >= 200 && code < 300) return res;
  const err = new Error(`${who} ${code}: ${res.getContentText().slice(0, 300)}`);
  err.code = code;
  // Bad audio / bad request: report it on the call instead of retrying forever.
  if (who === 'Groq' && code >= 400 && code < 500 && code !== 401 && code !== 429) err.permanent = true;
  throw err;
}

// ── Cleanup (trigger: daily ~2 am): delete audio older than KEEP_DAYS ────
// Only files already in the ERP; the text stays there forever.
function cleanupOldAudio() {
  const keep = Number(cfg('KEEP_DAYS', '60')) || 60;
  const cutoff = new Date(Date.now() - keep * 86400000).toISOString();
  const started = Date.now();
  for (const d of listCallDrives_()) {
    const names = [];
    let token;
    do {
      const r = Drive.Files.list({
        corpora: 'drive', driveId: d.id, includeItemsFromAllDrives: true, supportsAllDrives: true, pageSize: 200, pageToken: token,
        q: `trashed=false and createdTime < '${cutoff}' and appProperties has { key='erp' and value='done' }`, fields: 'nextPageToken, files(id, name)'
      });
      (r.files || []).forEach(f => { Drive.Files.remove(f.id, { supportsAllDrives: true }); names.push(f.name); });
      token = r.nextPageToken;
    } while (token && Date.now() - started < RUN_BUDGET_MS);
    for (let i = 0; i < names.length; i += 500) erpPost_('/api/calls/audio-removed', { drive: d.name, names: names.slice(i, i + 500) });
    if (names.length) console.log(`${d.name}: ${names.length} old recording(s) deleted`);
    if (Date.now() - started > RUN_BUDGET_MS) break;
  }
}

// ── One-time helpers ─────────────────────────────────────────────────────
function checkSetup() {
  ['GROQ_KEY', 'CLAUDE_KEY', 'ERP_KEY'].forEach(k => console.log(`${k}: ${cfg(k) ? 'set' : 'MISSING'}`));
  const drives = listCallDrives_();
  console.log(`Drives found (${drives.length}): ${drives.map(d => d.name).join(', ') || 'none — names must start with "' + cfg('DRIVE_PREFIX', 'Calls - ') + '"'}`);
  drives.forEach(d => console.log(`  ${d.name}: ${listNewRecordings_(d.id).length} new recording(s)`));
  try { erpPost_('/api/calls/known', { drive: 'test', names: ['test'] }); console.log('ERP: key OK'); }
  catch (e) { console.log('ERP: ' + e.message); }
  const sample = ['Call recording Sharma Electricals_241018_103022.m4a', '919876543210_20241018103022.mp3'];
  sample.forEach(n => console.log(`parse "${n}" → ${JSON.stringify(parseFileName_(n))}`));
}
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['processCalls', 'cleanupOldAudio'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processCalls').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('cleanupOldAudio').timeBased().everyDays(1).atHour(2).create();
  console.log('Triggers installed: processCalls every 10 min, cleanupOldAudio daily ~2 am');
}
