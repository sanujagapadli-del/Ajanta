/**
 * Call recordings → Ajanta ERP "Call Reports" page.
 *
 * Runs on the COMPANY Google Workspace account. Recordings arrive in ONE of two layouts:
 *   a) CALLS_FOLDER_ID set: one folder in a Shared Drive with a sub-folder per
 *      salesman ("Ramesh", "Suresh"…). The ERP's "📤 Upload" (Call Reports
 *      page) creates the sub-folder and puts the salesman's files there
 *      (same folder as ⚙️ Setup → Recordings folder). A sync app (FolderSync,
 *      "To remote folder") can write there too: "Limit access" on the
 *      sub-folder, only that salesman added, as Contributor.
 *   b) otherwise: one Shared Drive per salesman named "Calls - <name>".
 * The sub-folder / drive name is the salesman (ERP matches it to the user by
 * name; ⚙️ Setup can map it by hand). Every 10 minutes:
 *   new recording → speech-to-text → Claude Haiku (summary)
 *   → POST to the ERP in small batches → file marked done (appProperties).
 * Speech-to-text: Sarvam (SARVAM_KEY set) or Groq Whisper (GROQ_KEY).
 *   Sarvam's instant API only takes 30 s of audio, so calls go through its
 *   Batch API: one run sends up to 20 files as a job (files marked erp=job),
 *   a later run collects the text when the job is done (job kept in Script
 *   Properties as SJOB_<id>). Groq answers in the same run.
 * Files are never moved, so the phone never uploads them again; the ERP also
 * tells us which names it already has, so nothing is paid for twice.
 *
 * SETUP (once):
 *  1. script.google.com → New project (logged in as the company account).
 *     Paste this file and appsscript.json (Project Settings → "Show
 *     appsscript.json manifest file in editor").
 *  2. Project Settings → Script Properties:
 *       SARVAM_KEY  dashboard.sarvam.ai API key  — OR —
 *       GROQ_KEY    console.groq.com API key (used when SARVAM_KEY is empty)
 *       CLAUDE_KEY  platform.claude.com API key
 *       ERP_KEY     from ERP → Call Reports → ⚙️ Setup → Key banao
 *       ERP_URL     https://ajanta-erp.vercel.app   (optional, this is the default)
 *       CALLS_FOLDER_ID  id of the "Call Recordings" folder (from its URL
 *                   drive.google.com/drive/folders/<id>) — layout (a); leave
 *                   empty for layout (b)
 *     Optional: DRIVE_PREFIX ("Calls - "), KEEP_DAYS (60), LANGUAGE ("hi"),
 *               GROQ_MODEL ("whisper-large-v3-turbo"), CLAUDE_MODEL ("claude-haiku-5-5"),
 *               SARVAM_MODEL ("saaras:v4"), SARVAM_LANGUAGE ("hi-IN"; "unknown" = auto)
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
    if (useSarvam_()) {
      done += sarvamCycle_(timeLeft);
    } else for (const d of listSources_()) {
      if (stop || !timeLeft()) break;
      const files = listNewRecordings_(d);
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
    if (pending.length) { done += flush_(pending); pending = []; }
    // Calls whose summary failed earlier (e.g. before CLAUDE_KEY was added).
    if (!stop && timeLeft() && cfg('CLAUDE_KEY')) {
      const fixed = retrySummaries_(timeLeft);
      if (fixed) console.log(`${fixed} old call(s) got their summary`);
    }
  } finally {
    try { if (pending.length) done += flush_(pending); }
    finally { lock.releaseLock(); }
  }
  if (done) console.log(`${done} call(s) sent to the ERP`);
}

function retrySummaries_(timeLeft) {
  const list = erpPost_('/api/calls/missing-summary', {}).calls || [];
  const fixed = [];
  for (const c of list) {
    if (!timeLeft()) break;
    try {
      c.summary = claudeSummary_(c, { contact: c.contactName || '', phone: c.phone || '' });
      c.error = '';
      fixed.push(c);
    } catch (e) {
      console.warn(`summary retry ${c.fileName}: ${e.message}`);
      if (e.code === 401 || e.code === 429) break;   // wrong key / busy: try next run
    }
  }
  if (fixed.length) erpPost_('/api/calls/ingest', { calls: fixed });
  return fixed.length;
}

// The call row for a file, before any text: salesman, time, number, contact.
function baseCall_(drive, f) {
  // Uploaded from the ERP: properties carry the salesman's user id and the
  // file's time on the phone (≈ when the call was recorded).
  const ap = f.properties || {};
  const meta = parseFileName_(f.name, ap.recordedAt || f.createdTime);
  const call = { drive, userId: Number(ap.erpUser) || null, fileName: f.name, fileId: f.id,
    audioUrl: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, callAt: meta.callAt, phone: meta.phone, contactName: meta.contact };
  return { call, meta };
}
// Text is in call.transcript → add the Claude summary (or the reason there is none).
function addSummary_(call, meta) {
  call.transcript = String(call.transcript || '').trim();
  if (call.transcript.length < 15) {
    call.summary = { type: 'Other', summary: 'Bahut chhoti call — koi baat record nahi hui' };
    return call;
  }
  if (!cfg('CLAUDE_KEY')) { call.error = 'Summary nahi bani: CLAUDE_KEY abhi set nahi hai (key daalte hi apne-aap ban jayegi)'; return call; }
  try { call.summary = claudeSummary_(call, meta); }
  catch (e) { call.error = 'Summary nahi bani: ' + e.message; }
  return call;
}

function processOne_(drive, f) {
  const { call, meta } = baseCall_(drive, f);
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
  call.transcript = tr.text;
  call.durationSec = Math.round(Number(tr.duration) || 0);
  return addSummary_(call, meta);
}

// ── Sarvam (Batch API) ───────────────────────────────────────────────────
const SARVAM_MAX_BYTES = 45 * 1024 * 1024;   // UrlFetch payload limit is 50 MB
const SARVAM_KEYTERMS = ['Ajanta', 'geyser', 'dealer', 'order', 'payment', 'bill', 'rate', 'stock', 'cheque', 'heater', 'fan', 'mixer'];
const useSarvam_ = () => !!cfg('SARVAM_KEY');
function sarvamApi_(method, path, body) {
  const opts = { method, headers: { 'api-subscription-key': cfg('SARVAM_KEY') } };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  return JSON.parse(fetch_('Sarvam', 'https://api.sarvam.ai' + path, opts).getContentText() || '{}');
}
function setErpMark_(fileId, value) {   // value null = not sent anywhere yet
  Drive.Files.update({ appProperties: { erp: value } }, fileId, null, { supportsAllDrives: true });
}
function sarvamCycle_(timeLeft) {
  let done = 0, started = 0;
  // 1) Collect jobs sent in earlier runs.
  CFG.getKeys().filter(k => k.indexOf('SJOB_') === 0).forEach(k => {
    if (timeLeft()) {
      try { done += sarvamCollect_(k); }
      catch (e) { console.warn(`${k}: ${e.message}`); }
    }
  });
  // 2) Send new recordings as jobs of up to 20 (max 3 jobs a run).
  for (const d of listSources_()) {
    if (!timeLeft() || started >= 3) break;
    let files = listNewRecordings_(d);
    if (!files.length) continue;
    const known = erpPost_('/api/calls/known', { drive: d.name, names: files.map(f => f.name) }).known || [];
    const big = [];
    files = files.filter(f => {
      if (known.indexOf(f.name) >= 0) { markDone_(f.id); return false; }
      if (Number(f.size) > SARVAM_MAX_BYTES) { big.push({ id: f.id, call: Object.assign(baseCall_(d.name, f).call, { error: 'Recording 45 MB se badi hai' }) }); return false; }
      return true;
    });
    if (big.length) done += flush_(big);
    for (let i = 0; i < files.length && timeLeft() && started < 3; i += 20) {
      try { sarvamStart_(d.name, files.slice(i, i + 20)); started++; }
      catch (e) { console.warn(`Sarvam job for ${d.name}: ${e.message}`); if (e.code === 429 || e.code === 401 || e.code === 403) return done; }
    }
  }
  return done;
}
function sarvamStart_(drive, files) {
  const params = { model: cfg('SARVAM_MODEL', 'saaras:v4'), language_code: cfg('SARVAM_LANGUAGE', 'hi-IN'), with_timestamps: true };
  let job;
  try { job = sarvamApi_('post', '/speech-to-text/job/v1', { job_parameters: Object.assign({ keyterms: SARVAM_KEYTERMS }, params) }); }
  catch (e) { if (e.code !== 422 && e.code !== 400) throw e; job = sarvamApi_('post', '/speech-to-text/job/v1', { job_parameters: params }); }
  // Plain names on Sarvam's side ("0.m4a"…); the real names stay in our job record.
  const names = files.map((f, i) => `${i}.${(String(f.name).split('.').pop() || 'm4a').toLowerCase()}`);
  const up = sarvamApi_('post', '/speech-to-text/job/v1/upload-files', { job_id: job.job_id, files: names });
  files.forEach((f, i) => {
    const blob = DriveApp.getFileById(f.id).getBlob();
    fetch_('Sarvam upload', up.upload_urls[names[i]].file_url, {
      method: 'put', contentType: blob.getContentType() || 'application/octet-stream', headers: { 'x-ms-blob-type': 'BlockBlob' }, payload: blob.getBytes()
    });
  });
  sarvamApi_('post', `/speech-to-text/job/v1/${job.job_id}/start`);
  CFG.setProperty('SJOB_' + job.job_id, JSON.stringify({ at: Date.now(), drive,
    files: files.map((f, i) => ({ n: names[i], id: f.id, name: f.name, ct: f.createdTime, p: f.properties || {} })) }));
  files.forEach(f => setErpMark_(f.id, 'job'));
  console.log(`Sarvam job ${job.job_id}: ${files.length} recording(s) of ${drive}`);
}
function sarvamCollect_(key) {
  const jobId = key.slice(5), st = JSON.parse(CFG.getProperty(key));
  const ageH = (Date.now() - st.at) / 3600000;
  const s = sarvamApi_('get', `/speech-to-text/job/v1/${jobId}/status`);
  if (['Accepted', 'Pending', 'Running'].indexOf(s.job_state) >= 0) {
    if (ageH < 6) return 0;               // still working — look again next run
    st.files.forEach(f => setErpMark_(f.id, null));   // stuck: send these again
    CFG.deleteProperty(key);
    return 0;
  }
  const outByIn = {}, errByIn = {};
  (s.job_details || []).forEach(dt => {
    const inName = dt.inputs && dt.inputs[0] && dt.inputs[0].file_name;
    if (!inName) return;
    if (dt.state === 'Success' && dt.outputs && dt.outputs[0]) outByIn[inName] = dt.outputs[0].file_name;
    else errByIn[inName] = dt.error_message || dt.state || 'failed';
  });
  const outs = Object.keys(outByIn).map(k => outByIn[k]);
  const urls = outs.length ? (sarvamApi_('post', '/speech-to-text/job/v1/download-files', { job_id: jobId, files: outs }).download_urls || {}) : {};
  let items = [], done = 0;
  st.files.forEach(f => {
    const { call, meta } = baseCall_(st.drive, { id: f.id, name: f.name, createdTime: f.ct, properties: f.p });
    const out = outByIn[f.n];
    if (out && urls[out]) {
      const r = JSON.parse(fetch_('Sarvam download', urls[out].file_url, { method: 'get' }).getContentText());
      call.transcript = r.transcript;
      const ends = (r.timestamps && r.timestamps.end_time_seconds) || [];
      call.durationSec = Math.round(ends.length ? Math.max.apply(null, ends) : 0);
      addSummary_(call, meta);
    } else {
      call.error = 'Text nahi bana (Sarvam): ' + String(errByIn[f.n] || s.job_state).slice(0, 300);
    }
    items.push({ id: f.id, call });
    if (items.length >= BATCH) { done += flush_(items); items = []; }
  });
  if (items.length) done += flush_(items);
  CFG.deleteProperty(key);
  return done;
}

// Send a batch; mark files done only after the ERP saved them.
function flush_(items) {
  const r = erpPost_('/api/calls/ingest', { calls: items.map(x => x.call) });
  if (!r.success) throw new Error('ERP ingest failed: ' + JSON.stringify(r).slice(0, 300));
  items.forEach(x => markDone_(x.id));
  return items.length;
}

// ── Drive ────────────────────────────────────────────────────────────────
// One source per salesman: { name, driveId, folderId } — folderId null = the whole Shared Drive.
function listSources_() {
  const out = [];
  let token;
  const rootId = cfg('CALLS_FOLDER_ID');
  if (rootId) {
    const root = Drive.Files.get(rootId, { supportsAllDrives: true, fields: 'id, name, driveId' });
    do {
      const r = Drive.Files.list(Object.assign(scope_(root.driveId), {
        pageSize: 200, pageToken: token, fields: 'nextPageToken, files(id, name)',
        q: `'${rootId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`
      }));
      (r.files || []).forEach(f => out.push({ name: f.name, driveId: root.driveId, folderId: f.id }));
      token = r.nextPageToken;
    } while (token);
    return out;
  }
  const prefix = cfg('DRIVE_PREFIX', 'Calls - ').toLowerCase();
  do {
    const r = Drive.Drives.list({ pageSize: 100, pageToken: token });
    (r.drives || []).forEach(d => { if (d.name.toLowerCase().indexOf(prefix) === 0) out.push({ name: d.name, driveId: d.id, folderId: null }); });
    token = r.nextPageToken;
  } while (token);
  return out;
}
function scope_(driveId) {
  return driveId ? { corpora: 'drive', driveId, includeItemsFromAllDrives: true, supportsAllDrives: true }
    : { corpora: 'user', includeItemsFromAllDrives: true, supportsAllDrives: true };
}
const inSource_ = src => src.folderId ? ` and '${src.folderId}' in parents` : '';
function listNewRecordings_(src) {
  const out = [];
  let token;
  do {
    const r = Drive.Files.list(Object.assign(scope_(src.driveId), {
      pageSize: 200, pageToken: token,
      q: "trashed=false and mimeType!='application/vnd.google-apps.folder' and not appProperties has { key='erp' and value='done' }" + inSource_(src),
      orderBy: 'createdTime', fields: 'nextPageToken, files(id, name, size, createdTime, webViewLink, properties, appProperties)'
    }));
    // erp=job: already with Sarvam, waiting for its text.
    (r.files || []).forEach(f => { if (AUDIO_RX.test(f.name) && !(f.appProperties && f.appProperties.erp)) out.push(f); });
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
function parseFileName_(name, fallbackTime) {
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
  // No date in the name: the phone's file time ("YYYY-MM-DD HH:mm:ss", IST) or the Drive upload time.
  if (!callAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(fallbackTime || '')) callAt = fallbackTime;
  if (!callAt) callAt = Utilities.formatDate(new Date(fallbackTime || Date.now()), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
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
  const when = call.callAt ? new Date(String(call.callAt).replace(' ', 'T') + '+05:30') : new Date();
  const day = Utilities.formatDate(isNaN(when) ? new Date() : when, 'Asia/Kolkata', 'yyyy-MM-dd EEEE');
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
  for (const d of listSources_()) {
    const names = [];
    let token;
    do {
      const r = Drive.Files.list(Object.assign(scope_(d.driveId), {
        pageSize: 200, pageToken: token, fields: 'nextPageToken, files(id, name)',
        q: `trashed=false and createdTime < '${cutoff}' and appProperties has { key='erp' and value='done' }` + inSource_(d)
      }));
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
  ['SARVAM_KEY', 'GROQ_KEY', 'CLAUDE_KEY', 'ERP_KEY'].forEach(k => console.log(`${k}: ${cfg(k) ? 'set' : 'MISSING'}`));
  console.log(`Speech-to-text: ${useSarvam_() ? 'Sarvam (' + cfg('SARVAM_MODEL', 'saaras:v4') + ', batch — text comes ~1 run later)' : 'Groq (' + cfg('GROQ_MODEL', 'whisper-large-v3-turbo') + ')'}`);
  if (useSarvam_()) {
    try { const j = sarvamApi_('post', '/speech-to-text/job/v1', { job_parameters: { model: cfg('SARVAM_MODEL', 'saaras:v4'), language_code: cfg('SARVAM_LANGUAGE', 'hi-IN') } }); console.log('Sarvam: key OK (test job ' + j.job_id + ' created, never started — costs nothing)'); }
    catch (e) { console.log('Sarvam: ' + e.message); }
  }
  console.log(`Sarvam jobs waiting: ${CFG.getKeys().filter(k => k.indexOf('SJOB_') === 0).length}`);
  const rootId = cfg('CALLS_FOLDER_ID');
  const srcs = listSources_();
  console.log(rootId ? `Salesman folders in CALLS_FOLDER_ID (${srcs.length}): ${srcs.map(d => d.name).join(', ') || 'none — make one sub-folder per salesman'}`
    : `Drives found (${srcs.length}): ${srcs.map(d => d.name).join(', ') || 'none — names must start with "' + cfg('DRIVE_PREFIX', 'Calls - ') + '" (or set CALLS_FOLDER_ID)'}`);
  srcs.forEach(d => console.log(`  ${d.name}: ${listNewRecordings_(d).length} new recording(s)`));
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
