// Spread remote: drive any open Live screen (a TV, a laptop) from a phone — slides or a card carousel —
// and edit the values behind it. Everything goes through the same API the agent uses.
import { tables as allTables, readTable } from './shared/types/sheet.js';
import { applyDocOp } from './shared/types/index.js';

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const DOC = q.get('doc') || 'main';
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let me = null;
try { me = JSON.parse(localStorage.getItem('spread.user') || 'null'); } catch {}
const who = (me?.name || 'Remote') + ' (remote)';

const S = { screens: [], screen: q.get('screen') || null, doc: null, tab: null };
try { S.screen ||= localStorage.getItem('spread.remote.screen'); } catch {}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(j?.error || t);
  return j;
}
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'on' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 2200);
}
const cur = () => S.screens.find((x) => x.screen === S.screen) || null;
const present = (o) => api('POST', '/api/present', { doc: DOC, by: 'remote', screen: S.screen || undefined, ...o }).catch((e) => toast(e.message, true));

// ------------------------------------------------------------------ screens
function renderScreens() {
  const el = $('#screens');
  if (!S.screens.length) {
    el.innerHTML = `<div class="empty">No screen is showing Live.<br>Open <code>${esc(location.origin)}/?screen=tv</code> on the TV — it becomes a screen named “tv”.</div>`;
    $('#now').innerHTML = '';
    return;
  }
  if (!cur()) S.screen = S.screens[0].screen;
  el.innerHTML = S.screens.map((x) => `<button class="pill ${x.screen === S.screen ? 'on' : ''}" data-screen="${esc(x.screen)}">${esc(x.name)}</button>`).join('');
  const c = cur();
  $('#now').innerHTML = `<div class="nowname">${esc(c.name)}</div><div class="nowwhat">${c.slide ? `Slide ${c.slide}` : c.focus ? 'Focus · ' + esc(c.focus.split('::')[1] || c.focus) : c.mode === 'auto' ? 'Combined' : 'Sheet ' + esc(c.sheet)}${c.playing ? ' · <b>playing</b>' : ''}</div>`;
  $('[data-act=toggle]').textContent = c.playing ? '❚❚' : '▶';
  $('[data-act=toggle]').classList.toggle('on', !!c.playing);
  renderModes(); renderCards(); renderSlides();
}
$('#screens').addEventListener('click', (e) => {
  const b = e.target.closest('[data-screen]');
  if (!b) return;
  S.screen = b.dataset.screen;
  try { localStorage.setItem('spread.remote.screen', S.screen); } catch {}
  renderScreens();
});

// ------------------------------------------------------------------ transport
document.querySelector('.transport').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !cur()) return;
  navigator.vibrate?.(8);
  present({ action: b.dataset.act });
});
// swipe left/right anywhere on the transport area = next/prev
let sx = null;
document.querySelector('.transport').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
document.querySelector('.transport').addEventListener('touchend', (e) => {
  if (sx == null) return;
  const dx = e.changedTouches[0].clientX - sx; sx = null;
  if (Math.abs(dx) > 50 && cur()) present({ action: dx < 0 ? 'next' : 'prev' });
});

function renderModes() {
  const c = cur(), d = S.doc;
  if (!c || !d) return;
  $('#modes').innerHTML = `<div class="row"><button class="pill ${c.mode === 'auto' ? 'on' : ''}" data-mode="auto">✦ Combined</button>${d.sheets.map((s) => `<button class="pill ${c.mode !== 'auto' && c.sheet === s.name ? 'on' : ''}" data-sheet="${esc(s.name)}">${esc(s.name)}</button>`).join('')}</div>`;
}
$('#modes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mode) present({ mode: 'auto' });
  else present({ mode: 'sheet', sheet: b.dataset.sheet });
});

function renderCards() {
  const c = cur();
  const cards = (c?.cards || []).filter((x) => x.kind !== 'text' && x.kind !== 'slot');
  $('#cardsBox').hidden = !cards.length;
  $('#cards').innerHTML = cards.map((x) => `<button class="card ${c.focus === x.key ? 'on' : ''}" data-focus="${esc(x.key)}"><span class="k">${esc(x.kind)}</span><b>${esc(x.title || x.key.split(':').pop())}</b><small>${esc(x.summary || '')}</small></button>`).join('');
}
$('#cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-focus]');
  if (!b) return;
  const c = cur();
  if (c?.focus === b.dataset.focus) present({ action: 'unfocus' });
  else present({ mode: c?.mode, sheet: c?.sheet, focus: b.dataset.focus.split('::')[1] });
});

function renderSlides() {
  const sl = S.doc?.live?.slides || [];
  $('#slidesBox').hidden = !sl.length;
  const c = cur();
  $('#slides').innerHTML = sl.map((x, i) => `<button class="slide ${c?.slide === i + 1 ? 'on' : ''}" data-slide="${i + 1}"><span>${i + 1}</span>${esc(x.title || x.id)}</button>`).join('');
}
$('#slides').addEventListener('click', (e) => { const b = e.target.closest('[data-slide]'); if (b) present({ slide: +b.dataset.slide }); });

// ------------------------------------------------------------------ edit data
function editableTabs() {
  const d = S.doc;
  const tabs = allTables(d).map((x) => ({ id: 't:' + x.t.name, label: x.t.name }));
  // KPI source cells that hold plain values (not formulas) — the "dials" of a dashboard
  const vals = [];
  for (const s of d.sheets) for (const ch of s.charts || []) for (const ref of [ch.value, ch.value2]) {
    if (!ref) continue;
    const [sn, a] = ref.includes('!') ? [ref.slice(0, ref.lastIndexOf('!')).replace(/^'|'$/g, ''), ref.slice(ref.lastIndexOf('!') + 1)] : [s.name, ref];
    const sh2 = d.sheets.find((x) => x.name.toLowerCase() === sn.toLowerCase());
    const raw = sh2?.cells[a.toUpperCase()]?.v;
    if (sh2 && !(typeof raw === 'string' && raw[0] === '=')) vals.push({ sheet: sh2.name, a: a.toUpperCase(), label: ch.title || a, raw: raw ?? '' });
  }
  return { tabs: vals.length ? [{ id: 'values', label: 'Values' }, ...tabs] : tabs, vals };
}
function renderEdit(force) {
  const d = S.doc;
  if (!d) return;
  const { tabs, vals } = editableTabs();
  if (!S.tab || !tabs.some((t) => t.id === S.tab)) S.tab = tabs[0]?.id;
  $('#editTabs').innerHTML = tabs.map((t) => `<button class="pill ${t.id === S.tab ? 'on' : ''}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('');
  const box = $('#edit');
  if (!force && box.contains(document.activeElement)) { refreshValues(); return; }   // don't yank the field you're typing in
  if (S.tab === 'values') {
    box.innerHTML = vals.map((v) => `<label class="field"><span>${esc(v.label)} <small>${esc(v.sheet)}!${v.a}</small></span><input data-cell="${esc(v.sheet)}!${v.a}" value="${esc(v.raw)}" inputmode="decimal"></label>`).join('') || '<div class="empty">No editable values.</div>';
    return;
  }
  const name = S.tab?.slice(2);
  if (!name) { box.innerHTML = '<div class="empty">No tables in this workbook.</div>'; return; }
  const t = readTable(d, name, { limit: 60 });
  const c1 = allTables(d).find((x) => x.t.name === name).R.c1;
  const col = (i) => { let n = c1 + i, s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
  // each column offers the values it already has (status words, owners…) — quick picking on a phone
  const lists = t.columns.map((_, i) => [...new Set(t.rows.map((r) => r.values[i].raw).filter((x) => x !== '' && !(typeof x === 'string' && x[0] === '=')))].slice(0, 30));
  box.innerHTML = lists.map((l, i) => `<datalist id="dl${i}">${l.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`).join('') + t.rows.map((row) => `<div class="rec">${row.values.map((v, i) => {
    const A = `${t.sheet}!${col(i)}${row.r}`;
    const f = typeof v.raw === 'string' && v.raw[0] === '=';
    return `<label class="field ${i === 0 ? 'key' : ''}"><span>${esc(t.columns[i])}</span>${f ? `<output data-cell="${esc(A)}" title="${esc(v.raw)}">${esc(v.value)}</output>` : `<input data-cell="${esc(A)}" value="${esc(v.raw)}" ${i > 0 && lists[i].length > 1 && lists[i].length <= 12 ? `list="dl${i}"` : ''} ${lists[i].length && lists[i].every((x) => !isNaN(+x)) ? 'inputmode="decimal"' : ''}>`}</label>`;
  }).join('')}</div>`).join('') + `<button class="addrow" data-add="${esc(name)}">＋ Add row</button>`;
}
function refreshValues() {
  // live values into fields you're not editing
  const d = S.doc;
  for (const el of document.querySelectorAll('#edit [data-cell]')) {
    if (el === document.activeElement) continue;
    const ref = el.dataset.cell, i = ref.lastIndexOf('!');
    const sh2 = d.sheets.find((x) => x.name === ref.slice(0, i));
    const raw = sh2?.cells[ref.slice(i + 1)]?.v ?? '';
    if (el.tagName === 'INPUT' && el.value !== raw) { el.value = raw; flash(el); }
  }
}
const flash = (el) => { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); };
$('#editTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; renderEdit(true); } });
$('#edit').addEventListener('change', async (e) => {
  const el = e.target.closest('input[data-cell]');
  if (!el) return;
  try {
    await api('POST', '/api/ops', { doc: DOC, by: 'user', who, color: me?.color, ops: [{ op: 'set', cells: { [el.dataset.cell]: el.value } }] });
    flash(el); navigator.vibrate?.(6);
  } catch (er) { toast(er.message, true); }
});
$('#edit').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.target.blur(); });
$('#edit').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  try { await api('POST', '/api/ops', { doc: DOC, by: 'user', who, ops: [{ op: 'appendRows', table: b.dataset.add, rows: [[]] }] }); setTimeout(() => renderEdit(true), 300); } catch (er) { toast(er.message, true); }
});

// ------------------------------------------------------------------ live sync
async function loadDoc() { S.doc = (await api('GET', `/api/doc?id=${encodeURIComponent(DOC)}`)).doc; renderEdit(); renderModes(); renderSlides(); }
let docTimer = null;
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#conn').classList.add('ok');
  es.onerror = () => $('#conn').classList.remove('ok');
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'screens') { S.screens = e.screens; renderScreens(); return; }
    if (e.type === 'batch' && e.doc === DOC && S.doc) {
      try { for (const op of e.ops) applyDocOp(S.doc, op); renderEdit(); renderSlides(); } catch { clearTimeout(docTimer); docTimer = setTimeout(loadDoc, 200); }
    }
    if (e.type === 'docs' || e.type === 'hello') { clearTimeout(docTimer); docTimer = setTimeout(loadDoc, 200); }
  };
}
(async () => {
  await loadDoc();
  S.screens = await api('GET', '/api/screens?format=json').then((l) => l.map((x) => ({ ...x }))).catch(() => []);
  renderScreens();
  connect();
})();
