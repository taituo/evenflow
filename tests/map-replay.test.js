// Map cards (points from tables, camera fields) and time replay (the past rebuilt from recorded inverses).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as S from '../public/shared/types/sheet.js';
import { applyDocOp } from '../public/shared/types/index.js';
import { Store } from '../lib/store.js';
import { createServer, parseWhen } from '../server.js';

const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function fleet() {
  const st = S.create('t');
  S.apply(st, { op: 'set', cells: { A1: 'Robot', B1: 'Leveys', C1: 'Pituus', D1: 'Status', E1: 'Battery', A2: 'R1', B2: '60,17', C2: '24.94', D2: 'late', E2: '=VIZ("battery",80)', A3: 'R2', B3: '60.2', C3: '24.8', D3: '#ff00aa', A4: 'R3', B4: 'x', A6: '' } });
  S.apply(st, { op: 'table', range: 'A1:E4', name: 'Robots' });
  S.apply(st, { op: 'cond', range: 'D2:D9', rules: [{ when: '=', value: 'late', light: 'red' }] });
  S.apply(st, { op: 'set', cells: { G1: 'Stop', H1: 'Coords', G2: 'Base', H2: '60.1686, 24.9318', G3: 'Library', H3: '60.1739;24.9381', G4: 'Bad', H4: '200, 10' } });
  S.apply(st, { op: 'table', range: 'G1:H4', name: 'Stops' });
  return st;
}

test('map points: lat/lon found by name (also Finnish), coords column, colors from lights / hex / values, =VIZ markers', () => {
  const st = fleet();
  const r = S.apply(st, { op: 'addChart', id: 'm', type: 'map', layers: [{ table: 'Robots', color: 'Status', value: 'Battery' }, { table: 'Stops', route: true }], at: 'J2' });
  const m = S.chartData(st, 'Sheet1', st.sheets[0].charts[0]).map;
  const [rob, stops] = m.layers;
  assert.deepEqual(rob.points.map((p) => [p.key, p.lat, p.lon]), [['R1', 60.17, 24.94], ['R2', 60.2, 24.8]]);
  assert.equal(rob.skipped, 1, 'a row without coordinates is counted, not drawn');
  assert.equal(rob.points[0].color, '#ea4335', 'traffic light → red');
  assert.equal(rob.points[0].light, true);
  assert.equal(rob.points[1].color, '#ff00aa', 'a hex value is used as is');
  assert.deepEqual(rob.points[0].viz, { pack: 'battery', value: 80, label: null });
  assert.equal(rob.points[0].cell, 'Sheet1!A2');
  assert.deepEqual(stops.points.map((p) => [p.label, p.lat, p.lon]), [['Base', 60.1686, 24.9318], ['Library', 60.1739, 24.9381]]);
  assert.equal(stops.route, true);
  assert.equal(m.basemap, 'dark');
  assert.deepEqual(S.parseLatLon('60,17 24,94'), [60.17, 24.94]);
  // renames follow; undo removes the card
  S.apply(st, { op: 'renameTable', name: 'Stops', newName: 'Stations' });
  assert.equal(st.sheets[0].charts[0].layers[1].table, 'Stations');
  S.apply(st, { op: 'renameTable', name: 'Stations', newName: 'Stops' });
  for (const inv of r.inverse) S.apply(st, inv);
  assert.equal(st.sheets[0].charts, undefined);
});

test('map validation explains itself; camera fields are undoable', () => {
  const st = fleet();
  const bad = (o, re) => assert.throws(() => S.apply(st, { op: 'addChart', type: 'map', at: 'J2', ...o }), re);
  bad({}, /needs layers/);
  bad({ layers: [{ table: 'Nope' }] }, /No table "Nope"/);
  bad({ layers: [{ table: 'Robots', colour: 'x' }] }, /unknown key "colour"/);
  bad({ layers: ['Robots', 'Robots'] }, /same name/);
  bad({ layers: ['Robots'], basemap: 'satellite' }, /dark \| light \| bright \| none/);
  bad({ layers: ['Robots'], view: { lat: 60 } }, /both lat and lon/);
  bad({ layers: ['Robots'], view: { lat: 95, lon: 1 } }, /view.lat/);
  S.apply(st, { op: 'addChart', id: 'm', type: 'map', layers: ['Robots'], at: 'J2' });
  assert.deepEqual(st.sheets[0].charts[0].layers, [{ table: 'Robots' }], 'a bare table name is a layer');
  const r = S.apply(st, { op: 'updateChart', id: 'm', view: { to: 'R2', zoom: 14, pitch: 40 }, follow: 'R1', focus: 'R2', basemap: 'none' });
  const ch = st.sheets[0].charts[0];
  assert.deepEqual([ch.view, ch.follow, ch.focus, ch.basemap], [{ to: 'R2', zoom: 14, pitch: 40 }, 'R1', 'R2', 'none']);
  for (const inv of r.inverse) S.apply(st, inv);
  assert.deepEqual([ch.view, ch.follow, ch.focus, ch.basemap], [undefined, undefined, undefined, undefined]);
  const { project } = S.fitMercator([{ lat: 60, lon: 24 }, { lat: 61, lon: 25 }], 200, 100, 10);
  const [a, b] = [project(60, 24), project(61, 25)];
  assert.ok(a[0] < b[0] && a[1] > b[1], 'east is right, north is up');
  assert.ok([a, b].every(([x, y]) => x >= 9 && x <= 191 && y >= 9 && y <= 91), 'points fit inside the padding');
});

// ------------------------------------------------------------------ replay over the API
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-replay-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const req = (m, p, b) => fetch(base + p, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
test.after(() => srv.close());
const tick = () => new Promise((r) => setTimeout(r, 4));

test('replay rebuilds the past exactly and plays forward to now (moves, inserts, tables, maps, restores)', async () => {
  const before = JSON.parse(JSON.stringify(store.doc('main')));
  await tick();
  const t0 = Date.now();
  await tick();
  const batches = [
    [{ op: 'set', cells: { 'Budget!H1': 'Lat', 'Budget!I1': 'Lon', 'Budget!H2': '60.17', 'Budget!I2': '24.94' } }, { op: 'table', range: 'Budget!H1:I2', name: 'Spot' }],
    [{ op: 'addChart', sheet: 'Budget', id: 'mm', type: 'map', layers: ['Spot'], at: 'K2' }],
    [{ op: 'move', from: 'Budget!A2:E5', to: 'Budget!A30' }],
    [{ op: 'insertRows', sheet: 'Budget', at: 1, count: 2 }],
    [{ op: 'updateChart', id: 'mm', follow: '1', view: null }],
    [{ op: 'liveLayout', cards: 'clear' }],
  ];
  for (const ops of batches) { assert.equal((await req('POST', '/api/ops', { by: 'agent', ops })).status, 200); await tick(); }
  const t1 = Date.now();
  await tick();
  store.commit({ message: 'mid' });
  await req('POST', '/api/ops', { by: 'user', who: 'Ann', color: '#e8710a', ops: [{ op: 'set', cells: { 'Budget!H3': 'later' } }] });

  const r = await (await req('GET', `/api/replay?from=${t0}&format=json`)).json();
  assert.ok(same(r.start, before), 'the start state is the doc as it was at "from"');
  assert.equal(r.frames.length, batches.length + 1);
  assert.equal(r.frames.at(-1).who, 'Ann');
  const s = JSON.parse(JSON.stringify(r.start));
  for (const f of r.frames) for (const op of f.ops) applyDocOp(s, op);
  assert.ok(same(s, store.doc('main')), 'playing every frame arrives at now');

  const w = await (await req('GET', `/api/replay?from=${t0}&to=${t1}&format=json`)).json();
  assert.equal(w.frames.length, batches.length, 'a window stops at "to"');
  assert.match(await (await req('GET', `/api/replay?from=${t0}`)).text(), /replay \[main\] .* 7 changes by agent 6, Ann 1/);
  assert.ok(!store.changes({}).entries.some((e) => 'inv' in e), 'the change feed does not carry inverses');

  // a doc created inside the window starts at its creation
  await req('POST', '/api/docs', { type: 'sheet', id: 'fresh', title: 'Fresh', by: 'agent' });
  await req('POST', '/api/ops', { doc: 'fresh', by: 'agent', ops: [{ op: 'set', cells: { A1: 'x' } }] });
  const f = await (await req('GET', `/api/replay?doc=fresh&from=${t0}&format=json`)).json();
  assert.match(f.note, /created/);
  assert.equal(f.frames.length, 1);
  assert.equal(f.start.sheets[0].cells.A1, undefined);

  // a restore is undone like any batch
  const tR = Date.now(); await tick();
  await req('POST', '/api/restore', { commit: 'm1', doc: 'main', by: 'user' });
  const rr = await (await req('GET', `/api/replay?from=${tR}&format=json`)).json();
  assert.equal(rr.frames.length, 1);
  assert.equal(rr.start.sheets.find((x) => x.name === 'Budget').cells.H3?.v, 'later');
});

test('replay times and the present command', async () => {
  const now = Date.now();
  assert.ok(Math.abs(parseWhen('-2h', store) - (now - 7200e3)) < 1000);
  assert.ok(Math.abs(parseWhen('-90m', store) - (now - 5400e3)) < 1000);
  assert.equal(parseWhen('1700000000000', store), 1700000000000);
  assert.equal(parseWhen('2026-01-02T03:04:05Z', store), Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(new Date(parseWhen('14:30', store)).getHours(), 14);
  assert.equal(parseWhen('m1', store), store.commits[0].ts);
  assert.ok(parseWhen('v1', store) < now);
  assert.throws(() => parseWhen('yesterday-ish', store), /Not a time/);

  const events = [];
  const off = store.subscribe((e) => e.type === 'present' && events.push(e));
  assert.equal((await req('POST', '/api/present', { replay: { from: '-10m', speed: 120 } })).status, 200);
  assert.equal((await req('POST', '/api/present', { replay: 'stop' })).status, 200);
  assert.equal((await req('POST', '/api/present', { replay: { from: '-10m', speed: 0 } })).status, 400);
  assert.equal((await req('POST', '/api/present', { replay: { from: '-1m', to: '-2m' } })).status, 400);
  off();
  assert.equal(events[0].replay.speed, 120);
  assert.equal(events[0].replay.gaps, true);
  assert.ok(Math.abs(events[0].replay.from - (now - 600e3)) < 2000);
  assert.deepEqual(events[1].replay, { stop: true });
  assert.equal((await req('GET', '/api/replay?from=-1m&to=-2m')).status, 400);
});

test('the CLI drives maps and lists replays', async () => {
  await req('POST', '/api/ops', { by: 'agent', ops: [{ op: 'set', cells: { 'Budget!H5': 'x' } }] });
  const cm = (...a) => new Promise((ok, bad) => { import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['bin/cm.mjs', ...a], { env: { ...process.env, CANVAS_URL: base } }, (e, so, se) => (e ? bad(new Error(se || e.message)) : ok(so)))); });
  assert.match(await cm('map'), /mm map "" basemap dark .*follow 1/);
  assert.match(await cm('map', 'fly', '60.2', '24.9', '--zoom', '12'), /CHART update mm \(map\) \[view,follow\]/);
  const d = store.doc('main');
  const ch = d.sheets.flatMap((x) => x.charts || []).find((c) => c.id === 'mm');
  assert.deepEqual(ch.view, { lat: 60.2, lon: 24.9, zoom: 12 });
  await cm('map', 'focus', 'Kamppi');
  assert.equal(ch.focus, 'Kamppi');
  await cm('map', 'layer', 'Spot', 'off');
  assert.equal(ch.layers[0].hidden, true);
  await cm('map', 'fly', 'fit');
  assert.equal(ch.view, undefined);
  assert.match(await cm('replay', 'ls', '--from', '-5m'), /replay \[main\]/);
  assert.match(await cm('overview'), /chart mm map ← @Spot/);
});
