// Dashboard logic. Pure vanilla JS, no build step.

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const state = {
  profile: null,
  system: null,
  status: { state: 'IDLE', busy: false },
  jobs: [],
  screenshotTs: 0,
  pollHandle: null,
  filters: { search: '', stateFilter: 'ALL' },
};

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDuration(sec) {
  if (sec == null) return '—';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtClock(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function jget(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '',
  });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}
async function jdel(url) {
  const r = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
}

// ---------- Profile ----------
async function loadProfile() {
  try {
    state.profile = await jget('/api/profile/status');
  } catch (e) {
    state.profile = { state: 'PROFILE_ERROR', message: e.message, lastChecked: Date.now() };
  }
  renderProfile();
}

function renderProfile() {
  const p = state.profile;
  const root = $('#profile-card');
  if (!root) return;
  const pmap = {
    READY: { dot: 'ok', label: 'Google profile ready' },
    LOGIN_REQUIRED: { dot: 'warn', label: 'Login required' },
    NOT_INITIALIZED: { dot: 'warn', label: 'Profile not initialized' },
    PROFILE_ERROR: { dot: 'err', label: 'Profile error' },
  };
  const v = pmap[p?.state] || { dot: 'err', label: 'Unknown' };
  root.querySelector('.pill').className = `pill ${v.dot}`;
  root.querySelector('.pill .text').textContent = v.label;
  $('#profile-msg').textContent = p?.message ?? 'Probing…';

  const setup = $('#profile-setup');
  if (p?.state === 'LOGIN_REQUIRED' || p?.state === 'NOT_INITIALIZED') {
    setup.style.display = 'block';
  } else {
    setup.style.display = 'none';
  }
}

// ---------- System ----------
async function loadSystem() {
  try { state.system = await jget('/api/system'); } catch {}
  renderSystem();
}

function renderSystem() {
  const s = state.system;
  const root = $('#system-card');
  if (!root || !s) return;
  const pctUsed = s.memory.usedBytes / s.memory.totalBytes * 100;
  const diskUsedPct = s.disk.recordingsTotalBytes > 0
    ? (s.disk.recordingsTotalBytes - s.disk.recordingsFreeBytes) / s.disk.recordingsTotalBytes * 100
    : 0;
  root.innerHTML = `
    <h2>System Health</h2>
    <div class="health-grid">
      <div class="stat">
        <div class="label">CPU Load</div>
        <div class="value">${s.cpu.loadAvg[0].toFixed(2)}</div>
      </div>
      <div class="stat">
        <div class="label">Memory</div>
        <div class="value">${fmtBytes(s.memory.usedBytes)} / ${fmtBytes(s.memory.totalBytes)}</div>
        <div class="bar ${pctUsed > 85 ? 'err' : pctUsed > 65 ? 'warn' : ''}"><div style="width:${pctUsed.toFixed(1)}%"></div></div>
      </div>
      <div class="stat">
        <div class="label">Recordings</div>
        <div class="value">${fmtBytes(s.disk.recordingsBytes)}</div>
        <div class="bar ${diskUsedPct > 90 ? 'err' : diskUsedPct > 75 ? 'warn' : ''}"><div style="width:${diskUsedPct.toFixed(1)}%"></div></div>
      </div>
      <div class="stat">
        <div class="label">Profile Size</div>
        <div class="value">${fmtBytes(s.disk.profileBytes)}</div>
      </div>
      <div class="stat">
        <div class="label">Chrome</div>
        <div class="value">${s.chrome.running ? 'Running' : 'Stopped'}</div>
      </div>
      <div class="stat">
        <div class="label">Uptime</div>
        <div class="value">${fmtDuration(s.uptimeSec)}</div>
      </div>
    </div>`;
}

// ---------- Status pills ----------
function renderStatusPills() {
  const s = state.status;
  const p = state.profile;
  const root = $('#status-pills');
  if (!root) return;
  const pclass = p?.state === 'READY' ? 'ok' : (p?.state === 'LOGIN_REQUIRED' || p?.state === 'NOT_INITIALIZED') ? 'warn' : 'err';
  const sclass = s.state === 'IDLE' ? 'ok' : ['COMPLETED', 'FAILED', 'ABORTED'].includes(s.state) ? '' : 'rec';
  root.innerHTML = `
    <span class="pill ${pclass}"><span class="dot"></span><span class="text">Google ● ${p?.state ?? 'Unknown'}</span></span>
    <span class="pill ${sclass}"><span class="dot"></span><span class="text">Recorder ● ${s.state}</span></span>`;
}

// ---------- Active card ----------
function renderActive() {
  const s = state.status;
  const root = $('#active-card');
  if (!root) return;
  if (!s.jobId || ['IDLE', 'COMPLETED', 'FAILED', 'ABORTED'].includes(s.state)) {
    root.style.display = 'none';
    return;
  }
  root.style.display = 'block';
  root.querySelector('.meet-code').textContent = s.meetCode || '—';
  root.querySelector('.bot-name').textContent = s.botName || '—';
  root.querySelector('.elapsed').textContent = fmtDuration(s.elapsedSec);
  root.querySelector('.start-time').textContent = fmtClock(s.startedAt);
  const recStat = root.querySelector('.bytes-stat');
  if (recStat) recStat.textContent = fmtBytes(s.bytes || 0);
  root.querySelector('.state-text').textContent = s.state;

  const img = root.querySelector('img.screenshot-img');
  if (img && s.jobId) {
    img.src = `/api/jobs/${encodeURIComponent(s.jobId)}/screenshot?_=${state.screenshotTs}`;
    img.onerror = () => { img.style.display = 'none'; };
  }

  const failEl = root.querySelector('.failure');
  if (failEl) {
    if (s.failureReason) {
      failEl.style.display = 'block';
      failEl.textContent = `${s.failureReason}${s.failureDetail ? ': ' + s.failureDetail : ''}`;
    } else {
      failEl.style.display = 'none';
    }
  }
}

// ---------- Job history ----------
async function loadJobs() {
  try {
    const data = await jget('/api/jobs');
    state.jobs = data.jobs || [];
  } catch { state.jobs = []; }
  renderHistory();
}

function renderHistory() {
  const root = $('#history-card');
  if (!root) return;
  const filtered = state.jobs.filter((j) => {
    if (state.filters.stateFilter !== 'ALL' && j.state !== state.filters.stateFilter) return false;
    if (state.filters.search) {
      const q = state.filters.search.toLowerCase();
      const hay = `${j.jobId} ${j.meetUrl} ${j.meetCode} ${j.botName ?? ''} ${j.failureReason ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    root.innerHTML = `
      <h2>Recording History</h2>
      <div class="history-controls">
        <input type="text" placeholder="Search meetings, codes, IDs…" />
        <select>
          <option value="ALL">All states</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed</option>
          <option value="ABORTED">Aborted</option>
          <option value="RECORDING">Recording</option>
        </select>
      </div>
      <div class="muted">No recordings yet.</div>`;
    bindHistoryControls();
    return;
  }

  root.innerHTML = `
    <h2>Recording History (${filtered.length})</h2>
    <div class="history-controls">
      <input type="text" placeholder="Search meetings, codes, IDs…" value="${escapeHtml(state.filters.search)}" />
      <select>
        <option value="ALL">All states</option>
        <option value="COMPLETED">Completed</option>
        <option value="FAILED">Failed</option>
        <option value="ABORTED">Aborted</option>
        <option value="RECORDING">Recording</option>
        <option value="JOINING">Joining</option>
      </select>
    </div>
    <table class="history">
      <thead><tr>
        <th>Started</th><th>Meeting</th><th>Bot</th><th>Duration</th><th>Size</th><th>State</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${filtered.map(jobRow).join('')}
      </tbody>
    </table>`;
  bindHistoryControls();
}

function jobRow(j) {
  const started = fmtClock(j.startedAt);
  const duration = fmtDuration(j.durationSec);
  const size = fmtBytes(j.totalBytes);
  const reason = j.failureReason
    ? `<div class="reason">${escapeHtml(j.failureReason)}</div>`
    : '';
  return `
    <tr>
      <td>${started}</td>
      <td><strong>${escapeHtml(j.meetCode || '—')}</strong><div class="muted" style="font-size:11px">${escapeHtml(j.jobId)}</div></td>
      <td>${escapeHtml(j.botName || '')}</td>
      <td>${duration}</td>
      <td>${size}${reason}</td>
      <td><span class="badge ${j.state.toLowerCase()}">${j.state}</span></td>
      <td class="actions">
        <div class="row-actions">
          <button data-act="play" data-id="${escapeHtml(j.jobId)}" ${j.state === 'COMPLETED' || j.state === 'FAILED' || j.state === 'ABORTED' ? '' : 'disabled'}>Play</button>
          <button data-act="download" data-id="${escapeHtml(j.jobId)}" ${j.totalBytes > 0 ? '' : 'disabled'}>Download</button>
          <button data-act="meta" data-id="${escapeHtml(j.jobId)}">Meta</button>
          <button data-act="del" data-id="${escapeHtml(j.jobId)}" class="ghost">Delete</button>
        </div>
      </td>
    </tr>`;
}

function bindHistoryControls() {
  const root = $('#history-card');
  const input = root.querySelector('input[type="text"]');
  const sel = root.querySelector('select');
  if (input) input.addEventListener('input', (e) => { state.filters.search = e.target.value; renderHistory(); });
  if (sel) {
    sel.value = state.filters.stateFilter;
    sel.addEventListener('change', (e) => { state.filters.stateFilter = e.target.value; renderHistory(); });
  }
  root.addEventListener('click', onHistoryClick);
}

async function onHistoryClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const job = state.jobs.find((j) => j.jobId === id);
  if (!job) return;
  if (act === 'play') {
    openPlayer(job);
  } else if (act === 'download') {
    downloadJob(job);
  } else if (act === 'meta') {
    openMeta(job);
  } else if (act === 'del') {
    if (state.status.jobId === id) return alert('cannot delete running job');
    if (!confirm(`Delete ${job.meetCode}? This removes all segments.`)) return;
    const r = await jdel(`/api/jobs/${encodeURIComponent(id)}`);
    if (r.ok) loadJobs();
    else alert('delete failed: ' + (r.data?.error ?? r.status));
  }
}

function openPlayer(job) {
  const url = `/api/recordings/${encodeURIComponent(job.jobId)}/part-000.mp4`;
  const modal = $('#modal');
  modal.innerHTML = `
    <div class="modal">
      <h3>${escapeHtml(job.meetCode)} — ${escapeHtml(job.botName ?? '')}</h3>
      <video controls autoplay src="${url}"></video>
      <div class="modal-actions">
        <a href="${url}" download="${escapeHtml(job.jobId)}-part-000.mp4"><button>Download</button></a>
        <button class="ghost" data-close>Close</button>
      </div>
    </div>`;
  modal.style.display = 'flex';
  modal.querySelector('[data-close]').addEventListener('click', () => { modal.style.display = 'none'; modal.innerHTML = ''; });
}

function downloadJob(job) {
  const url = `/api/recordings/${encodeURIComponent(job.jobId)}/part-000.mp4`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${job.meetCode || job.jobId}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openMeta(job) {
  const modal = $('#modal');
  modal.innerHTML = `
    <div class="modal">
      <h3>Metadata — ${escapeHtml(job.meetCode)}</h3>
      <pre>${escapeHtml(JSON.stringify(job, null, 2))}</pre>
      <div class="modal-actions">
        <button class="ghost" data-close>Close</button>
      </div>
    </div>`;
  modal.style.display = 'flex';
  modal.querySelector('[data-close]').addEventListener('click', () => { modal.style.display = 'none'; modal.innerHTML = ''; });
}

// ---------- Status poller ----------
async function pollStatus() {
  try {
    const data = await jget('/status');
    state.status = data;
  } catch {}
  renderStatusPills();
  renderActive();
}

async function pollEverything() {
  await Promise.all([pollStatus(), loadSystem()]);
  if (!state.profile) await loadProfile();
  if (state.status.busy) await loadJobs();
}

// ---------- Job lifecycle ----------
async function startJob() {
  const meetUrl = $('#meet-url').value.trim();
  const botName = $('#bot-name').value.trim() || 'Recording Bot';
  const maxDuration = parseInt($('#max-duration').value || '0', 10) || 0;
  const skip = $('#skip-recording').checked;
  const errBox = $('#start-error');
  errBox.style.display = 'none';

  if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(meetUrl)) {
    errBox.textContent = 'Meet URL must look like https://meet.google.com/abc-defg-hij';
    errBox.style.display = 'block';
    return;
  }

  const r = await jpost('/api/jobs', {
    meetUrl, botName, maxDurationSec: maxDuration, skipRecording: skip,
  });
  if (!r.ok) {
    errBox.textContent = r.data?.error ?? `failed (${r.status})`;
    errBox.style.display = 'block';
    return;
  }
  await loadJobs();
  await pollStatus();
}

async function abortJob() {
  const id = state.status.jobId;
  if (!id) return;
  if (!confirm('Stop the current recording?')) return;
  await jpost(`/api/jobs/${encodeURIComponent(id)}/abort`, {});
  await pollStatus();
  await loadJobs();
}

async function checkProfile() {
  $('#profile-msg').textContent = 'Checking…';
  await jpost('/api/profile/check', {});
  await loadProfile();
}

async function openChromeForSetup() {
  const btn = $('#open-chrome-btn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Opening…';
  const r = await jpost('/api/browser/open', {});
  btn.disabled = false;
  btn.textContent = orig;
  if (!r.ok) {
    alert('Failed to open Chrome: ' + (r.data?.error ?? r.status));
  }
}

async function closeChromeForSetup() {
  const btn = $('#close-chrome-btn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Closing…';
  const r = await jpost('/api/browser/close', {});
  btn.disabled = false;
  btn.textContent = orig;
  if (!r.ok) {
    alert('Failed to close Chrome: ' + (r.data?.error ?? r.status));
  }
}

// ---------- Boot ----------
function bindUi() {
  $('#start-btn').addEventListener('click', startJob);
  $('#abort-btn').addEventListener('click', abortJob);
  $('#check-profile-btn').addEventListener('click', checkProfile);
  $('#open-chrome-btn')?.addEventListener('click', openChromeForSetup);
  $('#close-chrome-btn')?.addEventListener('click', closeChromeForSetup);
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') { $('#modal').style.display = 'none'; $('#modal').innerHTML = ''; }
  });
}

(async function main() {
  bindUi();
  await pollEverything();
  await loadJobs();
  state.pollHandle = setInterval(pollEverything, 5000);
  // screenshot refresh every 10s if active
  setInterval(() => {
    state.screenshotTs = Date.now();
    if (state.status.busy) renderActive();
  }, 10000);
})();