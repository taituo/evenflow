// Shell: doc tabs, live sync (SSE), history drawer, milestones. Canvas views live in /canvases/<type>/view.js
import { applyDocOp, replaceInPlace } from './shared/types/index.js';
import { setPacks } from './canvases/sheet/viz-dom.js';

const $ = (s) => document.querySelector(s);
const clientId = Math.random().toString(36).slice(2, 10);
const S = { version: 0, docs: [], commits: [], docId: null, doc: null, view: null, pending: 0, dirty: false, lastAgent: null };

// ------------------------------------------------------------------ http
async function http(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || data || r.statusText);
  return data;
}
const get = (u) => http('GET', u);
const post = (u, b) => http('POST', u, b);

// ------------------------------------------------------------------ ui helpers
export function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 5000 : 2500);
}

let openLayer = null;
function closeLayer() { openLayer?.remove(); openLayer = null; }
addEventListener('mousedown', (e) => { if (openLayer && !openLayer.contains(e.target)) closeLayer(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && openLayer) { closeLayer(); e.stopPropagation(); } }, true);

function place(el, x, y) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

/** items: [{label, kbd, action, disabled} | '-'] */
export function menu(x, y, items) {
  closeLayer();
  const m = document.createElement('div');
  m.className = 'menu';
  for (const it of items) {
    if (it === '-') { m.append(document.createElement('hr')); continue; }
    const d = document.createElement('div');
    d.className = 'it' + (it.disabled ? ' dis' : '');
    d.textContent = it.label;
    if (it.kbd) { const k = document.createElement('kbd'); k.textContent = it.kbd; d.append(k); }
    d.onmousedown = (e) => e.preventDefault();
    d.onclick = () => { closeLayer(); it.action(); };
    m.append(d);
  }
  openLayer = m;
  place(m, x, y);
}

export function popover(anchor, build) {
  closeLayer();
  const p = document.createElement('div');
  p.className = 'pop';
  build(p, closeLayer);
  openLayer = p;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  place(p, r.left, r.bottom + 4);
  return p;
}

// ------------------------------------------------------------------ who am I (multi-user)
const PALETTE = ['#e8710a', '#1e8e3e', '#d93025', '#1a73e8', '#c5221f', '#129eaf', '#b06000', '#a142f4', '#e52592', '#188038'];
const ME = (() => {
  let u = null;
  try { u = JSON.parse(localStorage.getItem('spread.user') || 'null'); } catch {}
  if (!u?.id) {
    const id = 'u' + Math.random().toString(36).slice(2, 8);
    u = { id, name: 'Guest ' + id.slice(1, 4).toUpperCase(), color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
    try { localStorage.setItem('spread.user', JSON.stringify(u)); } catch {}
  }
  return u;
})();
// this browser tab as a Live screen: ?screen=tv names it; otherwise a per-tab id
const SCREEN = (() => {
  const q = new URLSearchParams(location.search).get('screen');
  if (q) return { id: q.replace(/[^\w-]/g, '').slice(0, 40) || 'tv', name: q.slice(0, 40), named: true };
  let id = null;
  try { id = sessionStorage.getItem('spread.screen'); } catch {}
  if (!id) { id = 'scr-' + Math.random().toString(36).slice(2, 6); try { sessionStorage.setItem('spread.screen', id); } catch {} }
  return { id, name: `${ME.name} · ${/Mobi|Android/i.test(navigator.userAgent) ? 'phone' : 'screen'}` };
})();
let myPresence = {};
function sendPresence(extra) {
  Object.assign(myPresence, extra || {});
  post('/api/presence', { ...ME, doc: S.docId, ...myPresence }).catch(() => {});
}
setInterval(() => { if (!document.hidden) sendPresence(); }, 15000);
addEventListener('pagehide', () => {
  navigator.sendBeacon?.('/api/presence', new Blob([JSON.stringify({ id: ME.id, leave: true })], { type: 'application/json' }));
  if (document.querySelector('.lv')) navigator.sendBeacon?.('/api/live-state', new Blob([JSON.stringify({ open: false, screen: SCREEN.id })], { type: 'application/json' }));   // this screen goes away
});
S.people = [];
function renderPeople() {
  const el = $('#people');
  const others = S.people.filter((p) => p.id !== ME.id);
  el.innerHTML = others.slice(0, 6).map((p) => `<b class="av" style="background:${esc(p.color || '#888')}" title="${esc(p.name)} — ${esc(p.doc === S.docId ? (p.sheet || '') + (p.active ? '!' + p.active : '') : 'in ' + p.doc)}${p.live ? ' · in Live' : ''}">${esc((p.name || '?')[0].toUpperCase())}</b>`).join('')
    + `<b class="av me" style="background:${esc(ME.color)}" title="You: ${esc(ME.name)} — click to rename">${esc(ME.name[0].toUpperCase())}</b>`;
  el.querySelector('.me').onclick = (e) => popover(e.target, (pp, close) => {
    const i = document.createElement('input');
    i.value = ME.name; i.style.width = '160px';
    const sw = document.createElement('div'); sw.className = 'swatches';
    sw.innerHTML = PALETTE.map((c) => `<i data-c="${c}" style="background:${c}" class="${c === ME.color ? 'on' : ''}"></i>`).join('');
    sw.onclick = (ev) => { const c = ev.target.dataset.c; if (!c) return; ME.color = c; sw.querySelectorAll('i').forEach((x) => x.classList.toggle('on', x.dataset.c === c)); };
    const go = () => { ME.name = i.value.trim() || ME.name; try { localStorage.setItem('spread.user', JSON.stringify(ME)); } catch {} close(); renderPeople(); sendPresence(); };
    i.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } };
    const ok = document.createElement('button'); ok.className = 'btn'; ok.textContent = 'OK'; ok.onclick = go;
    pp.append(i, sw, ok);
    setTimeout(() => i.select());
  });
}
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ ctx given to views
let selTimer = null;
const ctx = {
  clientId, toast, menu, popover, get, post, me: ME, screen: SCREEN,
  /** Live mode tells others what this user is looking at. */
  livePresence(l) { sendPresence({ live: l || null }); },
  get doc() { return S.doc; },
  get docId() { return S.docId; },
  toolbar: $('#toolslot'),
  /** Apply ops locally (optimistic), send to server. Returns inverse ops or null on error. */
  submit(ops, label) {
    const inverse = [];
    try {
      for (const op of ops) { const r = applyDocOp(S.doc, op); inverse.unshift(...r.inverse); }
    } catch (e) {
      toast(e.message, true);
      reloadDoc();
      return null;
    }
    S.pending++;
    post('/api/ops', { doc: S.docId, by: 'user', who: ME.name, color: ME.color, clientId, ops, label })
      .then((r) => { S.version = Math.max(S.version, r.version); renderVer(); })
      .catch((e) => { toast(e.message, true); S.dirty = true; })
      .finally(() => { S.pending--; if (!S.pending && S.dirty) reloadDoc(); });
    return inverse;
  },
  reportSelection(sel) {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      post('/api/selection', { doc: S.docId, ...sel }).catch(() => {});
      sendPresence({ sheet: sel.sheet, ranges: sel.ranges, active: sel.active });
    }, 250);
  },
  milestone: () => milestonePopover(),
};

// ------------------------------------------------------------------ docs
function renderDocs() {
  const nav = $('#docs');
  nav.innerHTML = '';
  for (const d of S.docs) {
    const b = document.createElement('button');
    b.className = 'doctab' + (d.id === S.docId ? ' on' : '');
    b.innerHTML = `<span class="ico">${d.type === 'sheet' ? '▦' : '¶'}</span>`;
    b.append(d.title);
    b.title = `${d.title}  [${d.id}]`;
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => openDoc(d.id);
    b.ondblclick = () => renameDoc(d);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      menu(e.clientX, e.clientY, [
        { label: 'Rename', action: () => renameDoc(d) },
        { label: 'Delete canvas', disabled: S.docs.length < 2, action: () => http('DELETE', `/api/docs?id=${d.id}&by=user`).catch((er) => toast(er.message, true)) },
      ]);
    };
    nav.append(b);
  }
  const add = document.createElement('button');
  add.className = 'tb';
  add.textContent = '+';
  add.title = 'New canvas';
  add.onclick = (e) => menu(e.clientX, e.clientY + 12, [
    { label: '▦  Spreadsheet', action: () => newDoc('sheet', 'Workbook') },
    { label: '¶  Text / notes', action: () => newDoc('text', 'Notes') },
  ]);
  nav.append(add);
}
async function newDoc(type, title) {
  const r = await post('/api/docs', { type, title, by: 'user' });
  await refreshWorkspace();
  openDoc(r.id);
}
function renameDoc(d) {
  popover($('#docs'), (p, close) => {
    const i = document.createElement('input');
    i.value = d.title;
    const ok = document.createElement('button');
    ok.className = 'btn'; ok.textContent = 'Rename';
    const go = () => { http('PATCH', `/api/docs?id=${d.id}`, { title: i.value, by: 'user' }).catch((e) => toast(e.message, true)); close(); };
    ok.onclick = go;
    i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    p.append(i, ok);
    setTimeout(() => { i.focus(); i.select(); });
  });
}

async function refreshWorkspace() {
  const ws = await get('/api/workspace');
  S.docs = ws.docs; S.commits = ws.commits; S.version = ws.version;
  renderDocs(); renderVer();
}

async function openDoc(id) {
  const r = await get('/api/doc?id=' + encodeURIComponent(id));
  S.view?.unmount?.();
  $('#toolslot').innerHTML = '';
  $('#view').innerHTML = '';
  S.docId = id;
  S.doc = r.doc;
  S.version = Math.max(S.version, r.version);
  const mod = await import(`./canvases/${r.doc.type}/view.js`);
  S.view = mod.mount($('#view'), ctx);
  history.replaceState(null, '', '#' + id);
  renderDocs(); renderVer();
  S.view?.presence?.(S.people.filter((p) => p.id !== ME.id && p.doc === id));
  sendPresence({ sheet: null, ranges: null, active: null });
}

async function reloadDoc() {
  S.dirty = false;
  if (!S.docId) return;
  try {
    const r = await get('/api/doc?id=' + encodeURIComponent(S.docId));
    replaceInPlace(S.doc, r.doc);
    S.version = r.version;
    S.view?.reload?.();
    renderVer();
  } catch { /* doc deleted */ }
}

function renderVer() { $('#ver').textContent = 'v' + S.version; }

// ------------------------------------------------------------------ live
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('#conn').classList.add('ok'); sendPresence(); };
  es.onerror = () => $('#conn').classList.remove('ok');
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'hello') { if (S.version && e.version !== S.version) { refreshWorkspace(); reloadDoc(); } return; }
    if (e.type === 'docs') {
      S.version = e.v; S.docs = e.docs; renderDocs(); renderVer();
      if (!S.docs.find((d) => d.id === S.docId)) openDoc(S.docs[0].id);
      return;
    }
    if (e.type === 'commit') { S.commits.push(e.commit); if (!$('#drawer').hidden && drawerMode === 'history') renderDrawer(); toast(`Milestone ${e.commit.id}: ${e.commit.message}`); return; }
    if (e.type === 'viz') { loadPacks(); if (e.by !== 'user') toast(`Visual pack “${e.id}” ${e.action === 'delete' ? 'removed' : e.action === 'add' ? 'installed' : 'updated'} by ${e.by}`); return; }
    if (e.type === 'presence') {
      S.people = e.people || [];
      renderPeople();
      const others = S.people.filter((p) => p.id !== ME.id);
      S.view?.presence?.(others.filter((p) => p.doc === S.docId));
      return;
    }
    if (e.type === 'focus') { if (e.doc === S.docId) S.view?.focus?.(e); return; }
    if (e.type === 'present' && e.screen && e.screen !== SCREEN.id) return;   // aimed at another screen
    if (e.type === 'present') {
      const go = () => S.view?.present?.(e);
      if (e.doc && e.doc !== S.docId) openDoc(e.doc).then(go); else go();
      return;
    }
    if (e.type !== 'batch') return;
    S.version = Math.max(S.version, e.v);
    renderVer();
    if (e.by !== 'user') {
      S.lastAgent = { by: e.by, ts: Date.now(), where: e.touched.slice(0, 3).map((t) => `${t.sheet ?? ''}${t.sheet ? '!' : ''}${t.range}`).join(', ') || e.doc };
      renderActivity();
    }
    if (!$('#drawer').hidden && drawerMode === 'history') renderDrawerSoon();
    if (e.doc !== S.docId || e.clientId === clientId) return;
    if (S.pending) { S.dirty = true; return; }
    try { for (const op of e.ops) applyDocOp(S.doc, op); } catch { reloadDoc(); return; }
    S.view?.remote?.(e);
  };
}

function renderActivity() {
  const a = S.lastAgent;
  if (!a) return;
  const s = Math.round((Date.now() - a.ts) / 1000);
  $('#activity').textContent = `● ${a.by}: ${a.where} · ${s < 60 ? s + 's' : Math.round(s / 60) + 'min'} ago`;
}
setInterval(renderActivity, 5000);

// ------------------------------------------------------------------ milestones + history
function milestonePopover() {
  popover($('#btnMilestone'), (p, close) => {
    const i = document.createElement('input');
    i.placeholder = 'Milestone message…';
    i.style.width = '240px';
    const ok = document.createElement('button');
    ok.className = 'btn'; ok.textContent = 'Save';
    const go = async () => {
      close();
      try { const c = await post('/api/commit', { message: i.value || 'milestone', by: 'user' }); toast(`Saved ${c.id} at v${c.version}`); } catch (e) { toast(e.message, true); }
    };
    ok.onclick = go;
    i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    p.append(i, ok);
    setTimeout(() => i.focus());
  });
}
$('#btnMilestone').onclick = milestonePopover;
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); milestonePopover(); }
});

let drawerMode = 'history';
function toggleDrawer(mode) {
  const d = $('#drawer');
  const open = d.hidden || drawerMode !== mode;
  drawerMode = mode;
  d.hidden = !open;
  $('#btnHistory').classList.toggle('on', open && mode === 'history');
  $('#btnSql').classList.toggle('on', open && mode === 'sql');
  if (open) (mode === 'sql' ? renderSql() : renderDrawer());
  S.view?.resized?.();
}
$('#btnHistory').onclick = () => toggleDrawer('history');
$('#btnSql').onclick = () => toggleDrawer('sql');

let lastSql = 'SELECT * FROM Tasks';
let lastResult = null;
function renderSql() {
  const d = $('#drawer');
  d.innerHTML = '';
  const head = document.createElement('header');
  head.innerHTML = '<span style="flex:1">SQL <small style="font-weight:400;color:var(--muted)">— named tables are SQL tables</small></span>';
  const x = document.createElement('button'); x.className = 'tb'; x.textContent = '✕'; x.onclick = () => toggleDrawer('sql');
  head.append(x);
  const sec = document.createElement('section');
  const ta = document.createElement('textarea');
  ta.value = lastSql; ta.rows = 6; ta.spellcheck = false;
  ta.style.cssText = 'width:100%;font:12px/1.4 ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:4px;padding:6px;resize:vertical';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap';
  const run = document.createElement('button'); run.className = 'mini'; run.textContent = 'Run ⌘↵';
  const into = document.createElement('button'); into.className = 'mini'; into.textContent = 'Save result as table at active cell';
  const pre = document.createElement('pre');
  const exec = async (body) => {
    lastSql = ta.value;
    try { pre.textContent = await post('/api/sql', { doc: S.docId, sql: ta.value, by: 'user', ...body }); }
    catch (e) { pre.textContent = '✗ ' + e.message; }
  };
  run.onclick = () => exec({ write: !/^\s*(select|with)\b/i.test(ta.value) });
  into.onclick = () => {
    const at = S.view?.activeRef?.();
    if (!at) return;
    popover(into, (p, close) => {
      const i = document.createElement('input'); i.placeholder = 'Table name'; i.value = 'Result';
      const ok = document.createElement('button'); ok.className = 'btn'; ok.textContent = 'Save';
      const go = () => { close(); exec({ into: { name: i.value, at } }); };
      ok.onclick = go; i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
      p.append(i, ok); setTimeout(() => i.focus());
    });
  };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run.click(); } e.stopPropagation(); };
  const hint = document.createElement('div');
  hint.style.cssText = 'color:var(--muted);font-size:11px;margin-top:6px';
  hint.textContent = 'SELECT reads. UPDATE / INSERT / DELETE write back into the tables (undoable, versioned). Other workbooks: "doc.Table".';
  row.append(run, into);
  sec.append(ta, row, hint);
  d.append(head, sec, pre);
  setTimeout(() => ta.focus());
}

let drawerTimer = null;
function renderDrawerSoon() { clearTimeout(drawerTimer); drawerTimer = setTimeout(renderDrawer, 300); }

async function renderDrawer() {
  const d = $('#drawer');
  d.innerHTML = '';
  const head = document.createElement('header');
  head.innerHTML = '<span style="flex:1">History</span>';
  const x = document.createElement('button'); x.className = 'tb'; x.textContent = '✕'; x.onclick = () => $('#btnHistory').click();
  head.append(x);
  const ms = document.createElement('section');
  ms.innerHTML = '<h4>Milestones</h4>';
  if (!S.commits.length) ms.insertAdjacentHTML('beforeend', '<div style="color:var(--muted)">None yet — Ctrl+S</div>');
  for (const c of [...S.commits].reverse().slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'ms';
    const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = c.message; msg.title = `${c.by} · ${new Date(c.ts).toLocaleString()}`;
    const meta = document.createElement('small'); meta.textContent = `${c.id} v${c.version}`;
    const diff = document.createElement('button'); diff.className = 'mini'; diff.textContent = 'Diff';
    diff.onclick = () => showDiff(c);
    const rs = document.createElement('button'); rs.className = 'mini'; rs.textContent = 'Restore';
    rs.onclick = async () => {
      if (!rs.classList.contains('warn')) { rs.classList.add('warn'); rs.textContent = 'Confirm?'; return; }
      try { await post('/api/restore', { commit: c.id, doc: S.docId, by: 'user' }); toast(`Restored ${c.id}`); } catch (e) { toast(e.message, true); }
    };
    row.append(meta, msg, diff, rs);
    ms.append(row);
  }
  const pre = document.createElement('pre');
  d.append(head, ms, pre);
  try {
    const txt = await get(`/api/changes?since=${Math.max(0, S.version - 60)}&doc=${S.docId}`);
    linkify(pre, txt.split('\n').reverse().filter((l) => !l.startsWith('cursor:')).join('\n'));
  } catch (e) { pre.textContent = e.message; }
}

/** Turn Sheet!A1 tokens into jump links. */
function linkify(pre, text) {
  pre.innerHTML = '';
  for (const line of text.split('\n')) {
    const re = /([\p{L}\p{N}_.-]+)!([A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?)/gu;
    let last = 0, m;
    const div = document.createElement('div');
    if (/^v\d+ /.test(line)) div.className = 'v' + (/ user /.test(line) ? '' : ' agent');
    while ((m = re.exec(line))) {
      div.append(line.slice(last, m.index));
      const a = document.createElement('span');
      a.className = 'lnk'; a.textContent = m[0];
      const [sheet, range] = [m[1], m[2]];
      a.onclick = () => S.view?.goto?.(sheet, range);
      div.append(a);
      last = m.index + m[0].length;
    }
    div.append(line.slice(last));
    pre.append(div);
  }
}

async function showDiff(c) {
  try {
    const d = await get(`/api/diff?from=${c.id}&doc=${S.docId}&format=json`);
    S.view?.showDiff?.(d, c);
    const txt = await get(`/api/diff?from=${c.id}&doc=${S.docId}`);
    linkify($('#drawer pre'), txt);
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ SVG visual packs
async function loadPacks() { try { setPacks(await get('/api/viz')); } catch { /* visuals show "no pack" */ } }

// ------------------------------------------------------------------ boot
(async () => {
  await loadPacks();
  await refreshWorkspace();
  const want = location.hash.slice(1);
  await openDoc(S.docs.find((d) => d.id === want) ? want : S.docs[0].id);
  connect();
  renderPeople();
  // deep link straight into Live / Focus: ?live=Dashboard&mode=auto&focus=chart:status&kiosk=1
  const q = new URLSearchParams(location.search);
  // ?screen=tv on its own makes this tab a wall screen: Live, combined, no chrome — driven from /remote
  if (q.has('screen') && !q.has('live') && !q.has('slides')) S.view?.present?.({ mode: 'auto', kiosk: true });
  else if (q.has('live') || q.has('slides')) S.view?.present?.({ sheet: q.get('live') || undefined, mode: q.get('mode') || undefined, focus: q.get('focus') || undefined, kiosk: q.has('kiosk'), slide: q.has('slides') ? +q.get('slides') || 1 : undefined });
  addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && id !== S.docId && S.docs.find((d) => d.id === id)) openDoc(id); });
})();
