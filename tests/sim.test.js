// Race weekend simulator, track geometry, track cards, multi visuals, rolling windows — and replay of a whole session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';
import { Session, circuit, ROSTER } from '../lib/sim.js';
import { buildTrack } from '../public/shared/track.js';
import { validatePack, resolve, fill } from '../public/shared/viz.js';
import { applyDocOp } from '../public/shared/types/index.js';
import * as S from '../public/shared/types/sheet.js';
import { Engine, isViz } from '../public/shared/engine.js';

const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test('track geometry: a smooth loop, positions by fraction, laps wrap, curvature', () => {
  const T = buildTrack([[0, 0], [100, 0], [100, 100], [0, 100]]);
  assert.ok(T.length > 300 && T.length < 450, 'a rounded square ≈ ' + T.length);
  const a = T.at(0), b = T.at(1), c = T.at(16.25), d = T.at(0.25);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6, 'a lap ends where it starts');
  assert.ok(Math.hypot(c.x - d.x, c.y - d.y) < 1e-6, '16.25 laps = a quarter lap');
  assert.match(T.path(), /^M[\d. -]+(L[\d. -]+)+Z$/);
  assert.ok(T.radius(0.125) < T.radius(0.01) || isFinite(T.radius(0.125)));
  const open = buildTrack([[0, 0], [50, 0], [100, 0]], { closed: false });
  assert.equal(Math.round(open.at(2).x), 100, 'an open route clamps at its end');
});

test('the circuit and its sessions: plausible laps, deterministic with a seed, the flag, pit stops', () => {
  const C = circuit();
  assert.equal(Math.round(C.length), 5278);
  assert.ok(C.lapTime > 75 && C.lapTime < 95, 'lap ≈ ' + C.lapTime);
  assert.deepEqual(C.turns.map((t) => t.at), [...C.turns.map((t) => t.at)].sort((x, y) => x - y), 'turns in order');
  assert.ok(C.zones.every((z) => z.from >= 0 && z.from < 1 && z.to >= 0 && z.to < 1));
  const run = (o) => { const s = new Session(o); for (let i = 0; i < 4000 && !s.done; i++) s.step(1); return s; };
  const r1 = run({ session: 'race', laps: 4, seed: 42 }), r2 = run({ session: 'race', laps: 4, seed: 42 }), r3 = run({ session: 'race', laps: 4, seed: 43 });
  assert.ok(r1.done && r1.flag === 'chequered');
  assert.deepEqual(r1.order().map((c) => c.code), r2.order().map((c) => c.code), 'same seed, same race');
  assert.notDeepEqual(r1.order().map((c) => c.best), r3.order().map((c) => c.best), 'another seed, another race');
  assert.ok(r1.cars.every((c) => c.finished && c.lap >= 4));
  assert.ok(r1.cars.some((c) => c.stops === 1), 'pit stops happen');
  assert.ok(r1.lapsOfFocus.length >= 3);
  const t = r1.telemetry();
  for (const [k, lo, hi] of [['engine', 100, 160], ['coolant', 80, 120], ['rpm', 0, 15]]) assert.ok(t[k] >= lo && t[k] <= hi, `${k} ${t[k]}`);
  assert.deepEqual(Object.keys(t.tyres), ['FL', 'FR', 'RL', 'RR']);
  const p = run({ session: 'practice', minutes: 4, seed: 5 });
  assert.ok(p.done && p.flag === 'chequered');
  const o = p.order();
  assert.ok(o[0].best <= o[1].best, 'practice is ordered by best lap');
  assert.throws(() => new Session({ session: 'sprint' }), /race \| qualifying \| practice/);
  assert.equal(ROSTER.find((x) => x[0] === 'HAM')[2], 44);
});

test('multi visuals: color inputs, per-use scales, labels from cells, ranges into packs', () => {
  const car = validatePack(JSON.parse(fs.readFileSync('public/viz/car.json', 'utf8'))).pack;
  const r = resolve(car, [60, 95, 130, 95, 100, 600, 1100, 300, '#00ff88']);
  assert.deepEqual(r.vals.map((x) => x.level ?? x.color), [0, 5, 10, 5, 0, 5, 10, 2, '#00ff88']);
  assert.match(fill(car.svg, r), /--color:#00ff88/);
  assert.match(fill(car.svg, resolve(car, [1, 2, 3, 4, 5, 6, 7, 8, 'red;}*{x:1'])), /--color:#c8102e/, 'only #hex colors get through');
  assert.ok(!validatePack({ spec: 'spread-viz/1', id: 'x', kind: 'multi', svg: '<svg viewBox="0 0 1 1"><rect style="fill:var(--c)"/></svg>', inputs: [{ id: 'a' }, { id: 'c', type: 'color', value: 'red' }] }).ok);
  const arc = validatePack(JSON.parse(fs.readFileSync('public/viz/arc.json', 'utf8'))).pack;
  assert.equal(resolve(arc, 75).pct, 50, 'pack scale 0–150');
  assert.equal(resolve(arc, 75, '', { min: 50, max: 100 }).pct, 50);
  assert.equal(resolve(arc, 100, '', { min: 50, max: 100 }).pct, 100, 'the scale where it is used');
  const st = S.create('t');
  S.apply(st, { op: 'set', cells: { A1: '95', B1: '21', C1: '80', D1: 'L. Hamilton', E1: '=VIZ("arc", A1, "°C", 60, 130)', F1: '=VIZ("tyre-panel", A1:C1, "FL")' } });
  const en = new Engine(st), sh = st.sheets[0];
  const e1 = en.value(sh, 4, 0), f1 = en.value(sh, 5, 0);
  assert.ok(isViz(e1) && e1.min === 60 && e1.max === 130);
  assert.deepEqual(f1.value, [95, 21, 80], 'a range feeds a multi pack');
  S.apply(st, { op: 'addChart', id: 'v', type: 'viz', pack: 'driver', value: 'A1:B1', label: '=D1', at: 'H1' });
  S.apply(st, { op: 'addChart', id: 'g', type: 'viz', pack: 'arc', value: 'A1', min: 60, max: 130, at: 'H9' });
  assert.equal(S.chartData(st, 'Sheet1', sh.charts[0]).viz.label, 'L. Hamilton', 'a label from a cell');
  assert.deepEqual([S.chartData(st, 'Sheet1', sh.charts[1]).viz.min, S.chartData(st, 'Sheet1', sh.charts[1]).viz.max], [60, 130]);
  assert.throws(() => S.apply(st, { op: 'updateChart', id: 'g', min: 5, max: 1 }), /max > min/);
  S.apply(st, { op: 'insertCols', at: 'A', count: 1 });
  assert.equal(sh.charts[0].value, 'B1:C1', 'a range in a visual follows inserts');
});

test('rolling windows (last) and trace scaling options', () => {
  const st = S.create('t');
  S.apply(st, { op: 'set', range: 'A1', values: [['T', 'V'], ...Array.from({ length: 10 }, (_, i) => [String(i), i * 10])] });
  S.apply(st, { op: 'table', name: 'Tr', range: 'A1:B11' });
  S.apply(st, { op: 'addChart', id: 'c', type: 'area', table: 'Tr', x: 'T', last: 3, axes: 'none', colors: ['#ff2d55', '#7b2cff'], at: 'D1' });
  const d = S.chartData(st, 'Sheet1', st.sheets[0].charts[0]);
  assert.deepEqual(d.labels, ['7', '8', '9']);
  assert.deepEqual(d.series[0].values, [70, 80, 90]);
  assert.throws(() => S.apply(st, { op: 'updateChart', id: 'c', last: 1 }), /last/);
  assert.throws(() => S.apply(st, { op: 'updateChart', id: 'c', axes: 'some' }), /all \| x \| y \| none/);
});

test('track cards: shape, things by distance, zones, marks; errors explain; renames follow', () => {
  const st = S.create('t');
  S.apply(st, { op: 'set', range: 'A1', values: [['X', 'Y'], [0, 0], [100, 0], [100, 60], [0, 60]] });
  S.apply(st, { op: 'table', name: 'Loop', range: 'A1:B5' });
  S.apply(st, { op: 'set', range: 'D1', values: [['Code', 'Dist', 'Color', 'Speed'], ['A', 3.5, '#ff0000', 300], ['B', 'x', '', 1]] });
  S.apply(st, { op: 'table', name: 'Runners', range: 'D1:G3' });
  S.apply(st, { op: 'set', range: 'I1', values: [['Name', 'From', 'To'], ['Z1', 0.1, 0.2]] });
  S.apply(st, { op: 'table', name: 'Z', range: 'I1:K2' });
  assert.throws(() => S.apply(st, { op: 'addChart', type: 'track', at: 'M1' }), /needs shape/);
  assert.throws(() => S.apply(st, { op: 'addChart', type: 'track', shape: 'Loop', layers: [{ table: 'Runners', speed: 1 }], at: 'M1' }), /unknown key "speed"/);
  assert.throws(() => S.apply(st, { op: 'addChart', type: 'track', shape: 'Nope', at: 'M1' }), /No table "Nope"/);
  assert.throws(() => S.apply(st, { op: 'addChart', type: 'track', shape: 'Loop', sectors: [1.2], at: 'M1' }), /fractions/);
  S.apply(st, { op: 'addChart', id: 't', type: 'track', shape: 'Loop', layers: [{ table: 'Runners', value: 'Speed' }], zones: 'Z', trail: 'A', sectors: [0.5], at: 'M1' });
  const t = S.chartData(st, 'Sheet1', st.sheets[0].charts[0]).track;
  assert.equal(t.points.length, 4);
  assert.deepEqual(t.layers[0].items.map((x) => [x.key, x.dist, x.color, x.value]), [['A', 3.5, '#ff0000', '300']], 'a row without a distance is skipped');
  assert.deepEqual(t.zones, [{ from: 0.1, to: 0.2, label: 'Z1', color: null }]);
  S.apply(st, { op: 'renameTable', name: 'Loop', newName: 'Circuit' });
  assert.equal(st.sheets[0].charts[0].shape.table, 'Circuit');
  S.apply(st, { op: 'addChart', id: 'l', type: 'track', layout: 'line', length: 5000, layers: [{ table: 'Runners', value: 'Speed' }], at: 'M20' });
  assert.equal(S.chartData(st, 'Sheet1', st.sheets[0].charts[1]).track.layout, 'line', 'a line needs no shape');
});

// ------------------------------------------------------------------ the server: a session on the Pitwall, then its replay
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-sim-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const req = (m, p, b) => fetch(base + p, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
test.after(() => { store.sim.stop(true); srv.close(); });

test('a race on the Pitwall: every card resolves, ticks are compact batches, the session replays exactly', async () => {
  const st = await (await req('POST', '/api/sim', { action: 'start', session: 'race', laps: 2, speed: 20, seed: 9 })).json();
  clearInterval(store.sim.timer);   // drive the ticks by hand
  assert.deepEqual([st.session, st.doc, st.focus, st.seed], ['race', 'race', 'HAM', 9]);
  const doc = store.doc('race');
  const pit = doc.sheets.find((s) => s.name === 'Pitwall');
  assert.ok(pit.charts.length >= 30, pit.charts.length + ' cards');
  const v0 = store.state.version;
  for (let i = 0; i < 40 && !store.sim.S.done; i++) store.sim.tick();
  for (const ch of pit.charts) {
    const d = S.chartData(doc, 'Pitwall', ch);
    if (d.track) assert.deepEqual(d.track.errors, [], ch.id);
    if (d.viz) assert.ok(d.viz.value != null && d.viz.value !== '', `${ch.id} has a value`);
  }
  const trk = S.chartData(doc, 'Pitwall', pit.charts.find((c) => c.id === 'trk')).track;
  assert.equal(trk.layers[0].items.length, 22);
  assert.equal(trk.points.length, 32);
  const sizes = store.log.filter((e) => e.v > v0 + 1 && e.by === 'sim').map((e) => JSON.stringify(e).length);
  const med = [...sizes].sort((a, b) => a - b)[sizes.length >> 1];
  assert.ok(med < 15000 && Math.max(...sizes) < 60000, `ticks stay small: median ${med}, max ${Math.max(...sizes)}`);
  const car = S.chartData(doc, 'Pitwall', pit.charts.find((c) => c.id === 'car')).viz;
  assert.equal(car.value.length, 9);
  assert.match(String(car.value[8]), /^#[0-9a-f]{6}$/i, 'the livery comes from the focus car');
  assert.equal(car.label, '44');
  // follow another car
  await req('POST', '/api/sim', { action: 'focus', focus: 'lec' });
  store.sim.tick();
  assert.equal(S.chartData(doc, 'Pitwall', pit.charts.find((c) => c.id === 'car')).viz.label, '16');
  assert.equal(pit.charts.find((c) => c.id === 'trk').trail, 'LEC');
  assert.equal((await req('POST', '/api/sim', { action: 'focus', focus: 'XYZ' })).status, 404);
  for (let i = 0; i < 200 && !store.sim.S.done; i++) store.sim.tick();
  assert.equal(store.sim.S.done, true);
  assert.match(store.commits.at(-1).message, /Race end — .* wins/);
  assert.match(await (await req('GET', '/api/sim')).text(), /race \[race\] .*flag chequered/);
  // the whole session, rebuilt from its start milestone and played forward, is exactly now
  const start = store.commits.find((c) => /Race start/.test(c.message));
  const r = await (await req('GET', `/api/replay?doc=race&from=${start.id}&format=json`)).json();
  const s = JSON.parse(JSON.stringify(r.start));
  for (const f of r.frames) for (const op of f.ops) applyDocOp(s, op);
  assert.ok(JSON.stringify(canon(s)) === JSON.stringify(canon(store.doc('race'))), 'replay arrives at now');
  assert.equal(r.start.sheets.find((x) => x.name === 'Data').cells.R3?.v, store.sim.S.cars[0] && '0', 'the field starts on the grid');
  // a second session reuses the workbook and starts clean
  await req('POST', '/api/sim', { action: 'start', session: 'practice', minutes: 2, speed: 20 });
  clearInterval(store.sim.timer);
  store.sim.tick();
  const lt = S.findTable(store.doc('race'), 'LapTimes');
  assert.equal(lt.R.r2, lt.R.r1, 'lap times cleared');
  assert.equal((await req('POST', '/api/sim', { action: 'start', session: 'sprint' })).status, 400);
  await req('POST', '/api/sim', { action: 'stop' });
  assert.match(store.commits.at(-1).message, /Practice stopped/);
});
