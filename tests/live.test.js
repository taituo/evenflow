// Slides, presence, history, CLI — over HTTP against a fresh store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-live-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const get = (p) => fetch(base + p).then((r) => r.text());
const getJ = (p) => fetch(base + p).then((r) => r.json());
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const ops = async (o, extra = {}) => { const r = await post('/api/ops', { by: 'user', ops: o, ...extra }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const doc = async () => (await getJ('/api/doc?id=main')).doc;
const run = promisify(execFile);
const cm = async (...args) => (await run(process.execPath, ['bin/cm.mjs', ...args], { env: { ...process.env, CANVAS_URL: base, HOME: dir } })).stdout;
test.after(() => srv.close());

// ------------------------------------------------------------------ slides
test('slides: add, update, reorder, remove — all undoable', async () => {
  const r1 = await post('/api/ops', { by: 'agent', wantInverse: true, ops: [{ op: 'slide', id: 'a', title: 'A', cards: [] }] }).then((r) => r.json());
  await ops([{ op: 'slide', id: 'b', title: 'B', sheet: 'Dashboard', mode: 'auto', cards: ['kpiOpen', 'Tasks'], bg: { image: '/assets/x.gif', filter: 'dither' }, duration: 4 }]);
  await ops([{ op: 'slide', id: 'c', title: 'C' }]);
  let d = await doc();
  assert.deepEqual(d.live.slides.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(d.live.slides[1].bg.filter, 'dither');

  // partial update keeps the other fields
  await ops([{ op: 'slide', id: 'b', title: 'B2' }]);
  d = await doc();
  assert.equal(d.live.slides[1].title, 'B2');
  assert.deepEqual(d.live.slides[1].cards, ['kpiOpen', 'Tasks']);

  // reorder with index
  await ops([{ op: 'slide', id: 'c', index: 0 }]);
  assert.deepEqual((await doc()).live.slides.map((s) => s.id), ['c', 'a', 'b']);

  // remove + undo via returned inverse
  const rm = await post('/api/ops', { by: 'user', wantInverse: true, ops: [{ op: 'removeSlide', id: 'a' }] }).then((r) => r.json());
  assert.deepEqual((await doc()).live.slides.map((s) => s.id), ['c', 'b']);
  await ops(rm.inverse);
  assert.deepEqual((await doc()).live.slides.map((s) => s.id), ['c', 'a', 'b']);
  assert.ok(r1.inverse.length);

  // unknown keys are ignored, missing id rejected
  await ops([{ op: 'slide', id: 'a', evil: 1 }]);
  assert.equal((await doc()).live.slides.find((s) => s.id === 'a').evil, undefined);
  const bad = await post('/api/ops', { ops: [{ op: 'slide', title: 'no id' }] });
  assert.equal(bad.status, 400);
});

test('slides show up in the change feed and in cm slides', async () => {
  const feed = await get('/api/changes?since=0');
  assert.match(feed, /PANEL add slide a "A"/);
  assert.match(feed, /update slide b "B2"/);
  const out = await cm('slides');
  assert.match(out, /^1\. c /m);
  assert.match(out, /b {2}"B2" {2}Dashboard auto bg \/assets\/x\.gif dither 4s/);
});

test('present --slide is broadcast to the browser', async () => {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ac.signal });
  const reader = res.body.getReader();
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(new TextDecoder().decode(value)); } } catch {} })();
  await new Promise((r) => setTimeout(r, 100));
  await cm('present', '--slide', '2');
  await new Promise((r) => setTimeout(r, 150));
  ac.abort(); await pump;
  const ev = events.join('').split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === 'present');
  assert.equal(ev.slide, 2);
});

// ------------------------------------------------------------------ history
test('cell history follows a cell through edits, a move and a row insert', async () => {
  await ops([{ op: 'set', sheet: 'Budget', cells: { B3: '2' } }], { who: 'Alice', color: '#e8710a' });
  await ops([{ op: 'set', sheet: 'Budget', cells: { B3: '3' } }], { who: 'Bob' });
  await ops([{ op: 'move', sheet: 'Budget', from: 'A2:E5', to: 'A12' }]);     // B3 -> B13
  await ops([{ op: 'insertRows', sheet: 'Budget', at: 1, count: 2 }]);         // B13 -> B15
  await ops([{ op: 'set', sheet: 'Budget', cells: { B15: '9' } }], { by: 'agent' });

  const h = await getJ('/api/history?cell=Budget!B15&format=json');
  assert.deepEqual(h.map((x) => x.moved ? 'move' : `${x.old}→${x.new}`), ['3→9', 'move', '2→3', '1→2']);
  assert.equal(h.find((x) => x.new === '3').who, 'Bob');
  assert.equal(h.find((x) => x.new === '2').who, 'Alice');

  const txt = await cm('history', 'Budget!B15');
  assert.match(txt, /history of Budget!B15/);
  assert.match(txt, /user \(Alice\): Budget!B3 1 → 2/);
  assert.match(txt, /moved Budget!A2:E5 → Budget!A12:E15/);

  // a cell that was created by the insert has no older history
  assert.match(await get('/api/history?cell=Budget!B2'), /no recorded changes/);
});

test('table history lists record edits and structure changes', async () => {
  await ops([{ op: 'updateRows', table: 'Tasks', key: 'Wire the servos', set: { Status: 'done' } }], { who: 'Carol' });
  await ops([{ op: 'addColumn', table: 'Tasks', name: 'Priority' }]);
  const h = await getJ('/api/history?table=Tasks&format=json');
  assert.ok(h.some((x) => x.t === 'Tasks[Wire the servos].Status' && x.new === 'done' && x.who === 'Carol'), JSON.stringify(h));
  assert.ok(h.some((x) => x.table && /column|resize|range/i.test(x.table)) || h.some((x) => x.t === 'Tasks header'), JSON.stringify(h.slice(0, 5)));
  assert.match(await cm('history', '@tasks'), /Tasks\[Wire the servos\]\.Status/);
});

test('change feed shows who', async () => {
  assert.match(await get('/api/changes?since=0'), /by \(Alice\)|user \(Alice\)/);
});

// ------------------------------------------------------------------ presence
test('presence: join, move, leave, expire', async () => {
  await post('/api/presence', { id: 'u1', name: 'Alice', color: '#e8710a', doc: 'main', sheet: 'Project', ranges: ['B6:E10'], active: 'C8' });
  await post('/api/presence', { id: 'u2', name: 'Bob', color: '#1a73e8', doc: 'main', sheet: 'Dashboard', live: { mode: 'auto', sheet: 'Dashboard', slide: 2 } });
  let ppl = await getJ('/api/presence?format=json');
  assert.deepEqual(ppl.map((p) => p.name).sort(), ['Alice', 'Bob']);
  const txt = await cm('people');
  assert.match(txt, /Alice {2}\[main\] Project!C8 sel B6:E10/);
  assert.match(txt, /Bob .*LIVE combined/);

  // update merges
  await post('/api/presence', { id: 'u1', active: 'D9' });
  ppl = await getJ('/api/presence?format=json');
  assert.equal(ppl.find((p) => p.id === 'u1').active, 'D9');
  assert.equal(ppl.find((p) => p.id === 'u1').name, 'Alice');

  await post('/api/presence', { id: 'u2', leave: true });
  assert.deepEqual((await getJ('/api/presence?format=json')).map((p) => p.id), ['u1']);

  // stale entries expire
  store.presence.get('u1').ts -= 60000;
  assert.deepEqual(await getJ('/api/presence?format=json'), []);
  assert.match(await cm('people'), /nobody else is here/);

  // overview mentions people
  await post('/api/presence', { id: 'u3', name: 'Dana', doc: 'main', sheet: 'Budget' });
  assert.match(await get('/api/overview'), /Dana/);
});

test('presence without id is ignored, leave via beacon body works', async () => {
  const before = (await getJ('/api/presence?format=json')).length;
  await post('/api/presence', { name: 'ghost' });
  assert.equal((await getJ('/api/presence?format=json')).length, before);
  // sendBeacon posts a Blob with type application/json — same as a normal POST
  await fetch(base + '/api/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Blob([JSON.stringify({ id: 'u3', leave: true })]) });
  assert.ok(!(await getJ('/api/presence?format=json')).some((p) => p.id === 'u3'));
});

// ------------------------------------------------------------------ atomic batches
test('a multi-op batch is one version and one undo', async () => {
  const v0 = (await getJ('/api/doc?id=main')).version;
  const r = await post('/api/ops', { by: 'agent', wantInverse: true, ops: [
    { op: 'set', sheet: 'Settings', cells: { D1: 'a', D2: 'b' } },
    { op: 'slide', id: 'z', title: 'Z' },
    { op: 'format', sheet: 'Settings', range: 'D1:D2', style: { b: true } },
  ] }).then((x) => x.json());
  assert.equal(r.version, v0 + 1);
  await ops(r.inverse);
  const d = await doc();
  const st = d.sheets.find((s) => s.name === 'Settings');
  assert.equal(st.cells.D1, undefined);
  assert.ok(!d.live.slides.some((s) => s.id === 'z'));
});

test('cell history: cut-away source, cross-sheet move, deleted rows above', async () => {
  // Budget!B5 now holds what used to be B3 before the 2-row insert; B3's data was cut away to row 12 earlier
  const h5 = await getJ('/api/history?cell=Budget!B5&format=json');
  assert.equal(h5.length, 1);
  assert.ok(h5[0].away, JSON.stringify(h5));
  assert.match(await cm('history', 'Budget!B5'), /contents cut away: Budget!A2:E5/);

  // cross-sheet move: Settings!F1 -> Project!K20, then edit there
  await ops([{ op: 'set', sheet: 'Settings', cells: { F1: 'x1' } }]);
  await ops([{ op: 'move', sheet: 'Settings', from: 'F1', to: 'Project!K20' }]);
  await ops([{ op: 'set', sheet: 'Project', cells: { K20: 'x2' } }]);
  const hk = await getJ('/api/history?cell=Project!K20&format=json');
  assert.deepEqual(hk.map((x) => x.moved ? (x.away ? 'away' : 'move') : x.new), ['x2', 'move', 'x1']);
  // the source cell on Settings ends at the cut
  const hf = await getJ('/api/history?cell=Settings!F1&format=json');
  assert.ok(hf[0].away && hf.length === 1, JSON.stringify(hf));

  // deleting rows above shifts the address back
  await ops([{ op: 'deleteRows', sheet: 'Project', at: 1, count: 3 }]);   // K20 -> K17
  const h17 = await getJ('/api/history?cell=Project!K17&format=json');
  assert.deepEqual(h17.filter((x) => !x.moved).map((x) => x.new), ['x2', 'x1']);
});

test('presence and attribution are sanitized', async () => {
  await post('/api/presence', { id: 'x1', name: '<img src=x onerror=alert(1)>"Eve', color: 'red" onmouseover="alert(1)', doc: 'main', live: { mode: 'auto', evil: '<b>' } });
  const p = (await getJ('/api/presence?format=json')).find((x) => x.id === 'x1');
  assert.equal(p.name, 'img src=x onerror=alert(1)Eve');
  assert.equal(p.color, '#888888');
  assert.equal(p.live.evil, undefined);
  await post('/api/presence', { id: { obj: 1 }, name: 'bad id' });
  assert.ok(!(await getJ('/api/presence?format=json')).some((x) => x.name === 'bad id'));
  await ops([{ op: 'set', sheet: 'Settings', cells: { H1: 'z' } }], { who: 'Mallory<script>', color: 'javascript:1' });
  const last = store.log.at(-1);
  assert.equal(last.who, 'Malloryscript');
  assert.equal(last.color, '#888888');
  await post('/api/presence', { id: 'x1', leave: true });
});

// ------------------------------------------------------------------ screens + remote control
const sse = async (fn, ms = 200) => {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ac.signal });
  const reader = res.body.getReader();
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(new TextDecoder().decode(value)); } } catch {} })();
  await new Promise((r) => setTimeout(r, 80));
  await fn();
  await new Promise((r) => setTimeout(r, ms));
  ac.abort(); await pump;
  return events.join('').split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
};

test('screens: register, list, target, close; actions validated', async () => {
  await post('/api/live-state', { open: true, screen: 'tv', name: 'Living room <b>', mode: 'auto', sheet: 'Dashboard', vw: 1920, vh: 1080, cards: [{ key: 'Dashboard::chart:kpiOpen', kind: 'kpi', title: 'Open tasks', visible: true }] });
  await post('/api/live-state', { open: true, screen: 'lap/../top', name: 'Laptop', mode: 'sheet', sheet: 'Project', vw: 1440, vh: 900, cards: [] });
  const list = await getJ('/api/screens?format=json');
  assert.deepEqual(list.map((x) => x.screen).sort(), ['laptop', 'tv']);
  assert.equal(list.find((x) => x.screen === 'tv').name, 'Living room b');
  assert.match(await cm('screens'), /tv {2}"Living room b" {2}combined · 1 cards/);
  assert.match(await get('/api/live?screen=tv'), /Live open on "Living room b" \[tv\]/);
  assert.match(await get('/api/live'), /2 screens/);

  // commands carry the target screen; unknown screens and actions are rejected
  const ev = await sse(async () => {
    await cm('present', 'next', '--screen', 'tv');
    await cm('present', '--slide', '2', '--screen', 'tv');
    await post('/api/present', { action: 'pause', screen: 'laptop' });
  });
  const pres = ev.filter((e) => e.type === 'present');
  assert.deepEqual(pres.map((e) => [e.action, e.slide ?? null, e.screen]), [['next', null, 'tv'], [null, 2, 'tv'], ['pause', null, 'laptop']]);
  assert.equal((await post('/api/present', { action: 'explode' })).status, 400);
  assert.equal((await post('/api/present', { action: 'next', screen: 'nope' })).status, 404);

  // a screen that closes, or goes quiet, disappears
  const ev2 = await sse(() => post('/api/live-state', { open: false, screen: 'laptop' }), 300);
  assert.ok(ev2.some((e) => e.type === 'screens' && e.screens.length === 1 && e.screens[0].screen === 'tv'));
  store.screens.get('tv').ts -= 120000;
  assert.deepEqual(await getJ('/api/screens?format=json'), []);
  assert.match(await get('/api/live'), /not open on any screen/);
});

test('traffic lights via CLI and overview; KPI second value follows structure', async () => {
  assert.match(await cm('traffic', 'Budget!D2:D5', '<20:green', 'between 20 60:amber', '>60:red'), /traffic lights c1 on D2:D5/);
  assert.match(await get('/api/overview'), /traffic lights c1 D2:D5: < 20 → green, between 20 and 60 → amber, > 60 → red/);
  await assert.rejects(cm('traffic', 'Budget!D2', 'whatever:green'), /Can't read rule/);
  assert.match(await cm('traffic', 'Budget!D2:D5', 'off'), /removed/);

  await ops([{ op: 'addChart', sheet: 'Dashboard', type: 'kpi', id: 'duo', value: 'Project!C12', value2: 'Project!C13', label2: 'cost', at: 'K2' }]);
  let d = await doc();
  const duo = d.sheets.find((s) => s.name === 'Dashboard').charts.find((c) => c.value2);
  const data = (await getJ(`/api/chart?id=${duo.id}&format=json`)).data;
  assert.ok(data.kpi && data.kpi2 && data.kpi2.label === 'cost', JSON.stringify(data));
  await ops([{ op: 'insertRows', sheet: 'Project', at: 1, count: 1 }]);
  d = await doc();
  const after = d.sheets.find((s) => s.name === 'Dashboard').charts.find((c) => c.id === duo.id);
  assert.equal(after.value2, 'Project!C14');
  assert.equal(after.value, 'Project!C13', 'a KPI on another sheet follows its source cell');
});

test('live effect setting is part of the layout (undoable)', async () => {
  const r = await post('/api/ops', { by: 'user', wantInverse: true, ops: [{ op: 'liveLayout', fx: 'vapor' }] }).then((x) => x.json());
  assert.equal((await doc()).live.fx, 'vapor');
  await ops(r.inverse);
  assert.equal((await doc()).live.fx, undefined);
});
