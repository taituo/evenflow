// SVG visual packs: spec validation, value → frame, template filling, =VIZ(), API, persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePack, resolve, fill, renderString } from '../public/shared/viz.js';
import * as S from '../public/shared/types/sheet.js';
import { Engine, fmtValue, isViz } from '../public/shared/engine.js';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';

const svg = (inner = '<circle cx="5" cy="5" r="4"/>') => `<svg viewBox="0 0 10 10">${inner}</svg>`;
const pack = (o) => ({ spec: 'spread-viz/1', id: 'p', kind: 'states', states: [{ id: 'a', when: '=', value: 'a', svg: svg() }, { id: 'b', when: 'any', svg: svg() }], ...o });

test('built-in packs are valid, and the spec example is too', () => {
  for (const f of fs.readdirSync('public/viz')) {
    const r = validatePack(JSON.parse(fs.readFileSync(path.join('public/viz', f), 'utf8')));
    assert.ok(r.ok, `${f}: ${r.errors.join('; ')}`);
    assert.deepEqual(r.warnings, [], f);
  }
  const spec = fs.readFileSync('VIZ_SPEC.md', 'utf8');
  const ex = /## A complete example\n\n```json\n([\s\S]*?)```/.exec(spec)[1];
  assert.ok(validatePack(JSON.parse(ex)).ok);
});

test('validation explains every problem (so a model can fix its pack)', () => {
  const evil = [
    ['<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>', /no <script>/],
    ['<svg viewBox="0 0 1 1" onload="x()"></svg>', /event attributes/],
    ['<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>', /foreignObject/],
    ['<svg viewBox="0 0 1 1"><image href="http://evil/x.png"/></svg>', /<image>/],
    ['<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"><rect/></a></svg>', /javascript:/],
    ['<svg viewBox="0 0 1 1"><use href="http://evil/s.svg#x"/></svg>', /href may only point inside/],
    ['<svg viewBox="0 0 1 1"><rect style="fill:url(http://evil/t)"/></svg>', /url\(\.\.\.\) may only point inside/],
    ['<svg viewBox="0 0 1 1"><style>@import "http://evil/x.css";</style></svg>', /@import/],
    ['<svg><rect/></svg>', /needs a viewBox/],
    ['<div>not svg</div>', /exactly one <svg/],
    ['<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"></svg>', /DOCTYPE/],
  ];
  for (const [s, re] of evil) {
    const r = validatePack(pack({ kind: 'toggle', svg: s, states: undefined }));
    assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${s} → ${r.errors.join(' | ')}`);
  }
  const many = validatePack(pack({ id: 'Bad Id', spec: 'x', kind: 'states', states: [
    { id: 'a', when: '<', value: ['1', '2'], svg: svg() }, { id: 'a', when: 'between', value: 1, svg: svg() }, { id: 'c', when: '=', value: '=A1', svg: svg() },
  ] }));
  for (const re of [/spec must be/, /id must be/, /list of values only works/, /used twice/, /needs "value2"/, /formulas aren't allowed/]) assert.ok(many.errors.some((e) => re.test(e)), re + ' in ' + many.errors.join(' | '));
  assert.ok(validatePack(pack({ states: Array.from({ length: 13 }, (_, i) => ({ id: 's' + i, svg: svg() })) })).errors.some((e) => /at most 12/.test(e)));
  assert.ok(validatePack(pack({ kind: 'range', svg: svg(), states: undefined })).warnings.some((w) => /never uses --v/.test(w)));
  assert.ok(validatePack(pack({ kind: 'toggle', svg: svg(), states: undefined })).warnings.some((w) => /data-state/.test(w)));
  assert.ok(validatePack(pack({ kind: 'range', svg: svg(), min: 5, max: 5, states: undefined })).errors.some((e) => /max > min/.test(e)));
});

test('values pick frames: range clamps, toggle words, states in order with lists and a fallback', () => {
  const range = validatePack(pack({ kind: 'range', min: 10, max: 20, svg: svg('<rect style="transform:scaleX(var(--v))"/>'), states: undefined })).pack;
  assert.deepEqual([5, 10, 15, 25, 'x'].map((v) => [resolve(range, v).v, resolve(range, v).level]), [[0, 0], [0, 0], [0.5, 5], [1, 10], [0, 0]]);
  const tog = validatePack(pack({ kind: 'toggle', svg: svg('<style>[data-state="on"] circle{fill:red}</style>'), states: undefined })).pack;
  assert.deepEqual([1, 0, true, 'ON', 'valmis', 'nope', '', null].map((v) => resolve(tog, v).state), ['on', 'off', 'on', 'on', 'on', 'off', 'off', 'off']);
  const tog2 = validatePack(pack({ kind: 'toggle', on: { when: '>', value: 50 }, svg: svg('<style>[data-state="on"] circle{fill:red}</style>'), states: undefined })).pack;
  assert.deepEqual([10, 51].map((v) => resolve(tog2, v).state), ['off', 'on']);
  const st = validatePack(pack({ states: [
    { id: 'low', when: '<', value: 10, svg: svg() }, { id: 'ok', when: '=', value: ['ok', 'Done'], svg: svg() }, { id: 'other', when: 'any', svg: svg() },
  ] })).pack;
  assert.deepEqual([3, 'OK', 'done', 'late', 12].map((v) => resolve(st, v).state), ['low', 'ok', 'ok', 'other', 'other']);
});

test('filling the template: escaped placeholders, state on the root, no attribute injection', () => {
  const p = validatePack(pack({ kind: 'range', svg: '<svg viewBox="0 0 10 10" style="color:red" data-state="x"><text>{{value}} {{pct}}% {{label}}</text></svg>', states: undefined })).pack;
  const out = fill(p.svg, resolve(p, '"><script>alert(1)</script>', '<b>'));
  assert.ok(!/<script>|<b>/.test(out), out);
  assert.match(out, /&quot;&gt;&lt;script&gt;/);
  assert.match(out, /^<svg viewBox="0 0 10 10" style="--v:0;--pct:0;--level:0;color:red" data-state="v" data-level="0">/);
  assert.equal((out.match(/data-state=/g) || []).length, 1, 'the pack cannot pre-set the state');
  const r = renderString(p, 50, null, 64, 32);
  assert.match(r, /width="64" height="32" xmlns="http:\/\/www.w3.org\/2000\/svg"/);
});

test('=VIZ() keeps the value for everything else; viz cards read through it; refs follow structure', () => {
  const st = S.create('t');
  S.apply(st, { op: 'addSheet', name: 'Data' });
  S.apply(st, { op: 'set', cells: { A1: '42', B1: '=VIZ("battery",A1,"pack 1")', C1: '=B1+1', D1: '=VIZ("no such!",A1)', E1: '=VIZ("x")', 'Data!A2': 'ok' } });
  const en = new Engine(st), sh = st.sheets[0];
  const b1 = en.value(sh, 1, 0);
  assert.ok(isViz(b1));
  assert.deepEqual([b1.pack, b1.value, b1.label], ['battery', 42, 'pack 1']);
  assert.equal(fmtValue(b1), '42');
  assert.equal(fmtValue(en.value(sh, 2, 0)), '43', 'formulas see the value behind the picture');
  assert.equal(fmtValue(en.value(sh, 3, 0)), '#VALUE!');
  assert.equal(fmtValue(en.value(sh, 4, 0)), '#N/A');
  assert.throws(() => S.apply(st, { op: 'addChart', type: 'viz', value: 'A1', at: 'H1' }), /needs pack/);
  S.apply(st, { op: 'addChart', id: 'v1', type: 'viz', pack: 'status', value: 'Data!A2', at: 'H1' });
  S.apply(st, { op: 'addChart', id: 'v2', type: 'viz', pack: 'battery', value: 'B1', at: 'H9' });
  assert.equal(S.chartData(st, 'Sheet1', sh.charts[0]).viz.value, 'ok');
  assert.equal(S.chartData(st, 'Sheet1', sh.charts[1]).viz.value, 42, 'a =VIZ cell gives its value');
  S.apply(st, { op: 'insertRows', sheet: 'Data', at: 1, count: 1 });
  assert.equal(sh.charts[0].value, 'Data!A3');
});

// ------------------------------------------------------------------ API + persistence
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-viz-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const req = (m, p, b) => fetch(base + p, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
test.after(() => srv.close());

test('API: list, spec, dry-run, install, update, delete; built-ins are protected; restarts keep packs', async () => {
  const list = await (await req('GET', '/api/viz')).json();
  assert.ok(list.length >= 8 && list.every((p) => p.builtin));
  assert.match(await (await req('GET', '/api/viz/spec')).text(), /spread-viz\/1/);
  assert.match(await (await req('GET', '/api/viz?format=text')).text(), /weather +states +Weather \[sunny partly rain storm cloudy\]/);

  const bad = await req('POST', '/api/viz?dry=1', pack({ states: [{ id: 'a', svg: '<svg onload="x"></svg>' }] }));
  assert.equal(bad.status, 400);
  const bj = await bad.json();
  assert.ok(bj.errors.length >= 3, JSON.stringify(bj));
  assert.equal((await req('POST', '/api/viz?dry=1', pack({ id: 'mine' }))).status, 200);
  assert.equal((await (await req('GET', '/api/viz')).json()).some((p) => p.id === 'mine'), false, 'dry run installs nothing');

  const events = [];
  store.subscribe((e) => e.type === 'viz' && events.push(e));
  let r = await (await req('POST', '/api/viz', { pack: pack({ id: 'mine' }), by: 'claude' })).json();
  assert.deepEqual([r.ok, r.id, r.rev, r.replaced], [true, 'mine', 1, false]);
  r = await (await req('POST', '/api/viz', pack({ id: 'mine', name: 'Mine v2' }))).json();
  assert.deepEqual([r.rev, r.replaced], [2, true]);
  assert.deepEqual(events.map((e) => [e.action, e.id, e.by]), [['add', 'mine', 'claude'], ['update', 'mine', 'agent']]);
  assert.equal((await req('POST', '/api/viz', pack({ id: 'battery' }))).status, 409);
  assert.equal((await req('DELETE', '/api/viz?id=battery')).status, 409);
  assert.equal((await req('DELETE', '/api/viz?id=nope')).status, 404);

  const again = new Store(dir).init().loadViz('public/viz');
  assert.equal(again.viz.get('mine').name, 'Mine v2');
  assert.equal(again.viz.get('mine').rev, 2);
  assert.equal((await req('DELETE', '/api/viz?id=mine')).status, 200);
  assert.equal(new Store(dir).init().loadViz('public/viz').viz.has('mine'), false);
});
