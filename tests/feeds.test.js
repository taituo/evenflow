// Open data feeds (with recorded-format fixtures, no network) and the NLS map tile proxy (against a fake upstream).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';
import { Feeds, KINDS, parseFmiSimple, syncOps, clearFeedCache } from '../lib/feeds.js';
import * as S from '../public/shared/types/sheet.js';

// ---- fixtures in the shape the services document
let trains = [
  { trainNumber: 27, departureDate: '2026-11-04', timestamp: '2026-11-04T10:00:00.000Z', location: { type: 'Point', coordinates: [24.9414, 60.1719] }, speed: 0, accuracy: 10 },
  { trainNumber: 8, departureDate: '2026-11-04', timestamp: '2026-11-04T10:00:01.000Z', location: { type: 'Point', coordinates: [23.7609, 61.4981] }, speed: 112 },
  { trainNumber: 9999, timestamp: '2026-11-04T10:00:01.000Z', location: null },
];
const ais = { type: 'FeatureCollection', features: [
  { mmsi: 230145250, type: 'Feature', geometry: { type: 'Point', coordinates: [24.95, 60.15] }, properties: { mmsi: 230145250, sog: 12.3, cog: 180.5, timestampExternal: 1762250400000 } },
  { mmsi: 1, type: 'Feature', geometry: { type: 'Point', coordinates: [21.0, 59.0] }, properties: { mmsi: 1, sog: 1, cog: 1, timestampExternal: 1762250400000 } },
] };
const vessels = [{ mmsi: 230145250, name: 'MEGASTAR ' }];
const wstations = { type: 'FeatureCollection', features: [
  { id: 1001, type: 'Feature', geometry: { type: 'Point', coordinates: [24.9, 60.2, 10] }, properties: { id: 1001, name: 'vt1_Espoo' } },
  { id: 1002, type: 'Feature', geometry: { type: 'Point', coordinates: [25.5, 65.0, 10] }, properties: { id: 1002, name: 'vt4_Oulu' } },
] };
const wdata = { stations: [
  { id: 1001, sensorValues: [{ name: 'ILMA', value: 3.2, unit: '°C' }, { name: 'TIE_1', value: 1.1 }, { name: 'KESKITUULI', value: 4.5 }] },
  { id: 1002, sensorValues: [{ name: 'ILMA', value: -6.0 }] },
  { id: 4040, sensorValues: [{ name: 'ILMA', value: 9 }] },
] };
const fmi = (lat, lon, t) => `<?xml version="1.0"?><wfs:FeatureCollection>
${[['t2m', t - 1, '2026-11-04T09:50:00Z'], ['t2m', t, '2026-11-04T10:00:00Z'], ['ws_10min', 4.2, '2026-11-04T10:00:00Z'], ['rh', 'NaN', '2026-11-04T10:00:00Z']].map(([p, v, time]) => `<wfs:member><BsWfs:BsWfsElement gml:id="x"><BsWfs:Location><gml:Point><gml:pos>${lat} ${lon} </gml:pos></gml:Point></BsWfs:Location><BsWfs:Time>${time}</BsWfs:Time><BsWfs:ParameterName>${p}</BsWfs:ParameterName><BsWfs:ParameterValue>${v}</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>`).join('\n')}</wfs:FeatureCollection>`;
const calls = [];
const get = async (url) => {
  calls.push(url);
  if (url.includes('train-locations')) return JSON.parse(JSON.stringify(trains));
  if (url.endsWith('/api/ais/v1/locations')) return ais;
  if (url.endsWith('/api/ais/v1/vessels')) return vessels;
  if (url.endsWith('/api/weather/v1/stations')) return wstations;
  if (url.endsWith('/api/weather/v1/stations/data')) return wdata;
  if (url.includes('opendata.fmi.fi')) return url.includes('place=Oulu') ? fmi(65.01, 25.47, -2.5) : url.includes('place=Nowhere') ? '<x/>' : fmi(60.17, 24.94, 4.5);
  throw new Error('unexpected ' + url);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-feeds-'));
const store = new Store(dir).init();
store.feeds = new Feeds(store, { get });
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const req = (m, p, b) => fetch(base + p, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
test.after(() => { store.feeds.stop(); srv.close(); });

test('providers parse what the services send', async () => {
  const t = await KINDS.trains.rows(get, {});
  assert.deepEqual(t.map((r) => [r.Train, r.Lat, r.Lon, r.Speed]), [['27', 60.1719, 24.9414, 0], ['8', 61.4981, 23.7609, 112]], 'a train without a location is skipped');
  assert.match(t[0].Updated, /^\d\d:\d\d:\d\d$/);
  assert.deepEqual((await KINDS.trains.rows(get, { bbox: [24, 60, 26, 61] })).map((r) => r.Train), ['27']);
  const sh = await KINDS.ships.rows(get, {});
  assert.deepEqual(sh.map((r) => [r.Ship, r.MMSI, r.Speed, r.Course]), [['MEGASTAR', '230145250', 12.3, 180.5]], 'name from vessel metadata; outside the box dropped');
  const rw = await KINDS.roadweather.rows(get, {});
  assert.deepEqual(rw.map((r) => [r.Station, r.Air, r.Road, r.Wind]), [['vt1_Espoo', 3.2, 1.1, 4.5], ['vt4_Oulu', -6, null, null]], 'unknown station ids skipped');
  const p = parseFmiSimple(fmi(60.17, 24.94, 4.5));
  assert.deepEqual([p.lat, p.lon, p.values.t2m.v, p.values.ws_10min.v, p.values.rh], [60.17, 24.94, 4.5, 4.2, undefined], 'latest value wins; NaN skipped');
  const w = await KINDS.weather.rows(get, { places: ['Helsinki', 'Oulu', 'Nowhere'] });
  assert.deepEqual(w.map((r) => [r.Place, r.Temp, r.Wind]), [['Helsinki', 4.5, 4.2], ['Oulu', -2.5, 4.2]], 'a place with no data is skipped');
});

test('a feed creates its table (and a map), then updates, appends and removes by key — one batch per poll', async () => {
  const r = await (await req('POST', '/api/feeds', { kind: 'trains', map: true, every: 1 })).json();
  assert.equal(r.every, 15, 'polling is clamped to the service minimum');
  assert.deepEqual([r.status.ok, r.status.rows, r.status.created], [true, 2, true]);
  const d = store.doc('main');
  const x = S.findTable(d, 'Trains');
  assert.equal(x.sh.name, 'Trains');
  assert.deepEqual(S.tableColumns(x.sh, x.R), ['Train', 'Lat', 'Lon', 'Speed', 'Updated']);
  const map = x.sh.charts.find((c) => c.type === 'map');
  assert.deepEqual(map.layers, [{ table: 'Trains', label: 'Train' }]);
  assert.equal(S.chartData(d, 'Trains', map).map.layers[0].points.length, 2);
  const v1 = store.state.version;
  // nothing changed → no batch
  assert.equal((await (await req('POST', '/api/feeds/run', { id: 'trains' })).json()).status.version, undefined);
  assert.equal(store.state.version, v1);
  // train 27 moves, 8 is gone, 41 appears
  trains = [{ ...trains[0], location: { type: 'Point', coordinates: [24.9, 60.2] }, speed: 60 }, { trainNumber: 41, timestamp: '2026-11-04T10:01:00Z', location: { type: 'Point', coordinates: [25.0, 60.3] }, speed: 90 }];
  const s2 = (await (await req('POST', '/api/feeds/run', { id: 'trains' })).json()).status;
  assert.deepEqual([s2.added, s2.updated, s2.removed], [1, 1, 1]);
  assert.equal(store.state.version, v1 + 1, 'one batch');
  const e = store.changes({ since: v1 }).entries[0];
  assert.deepEqual([e.by, e.who, e.label], ['feed', 'Trains (Digitraffic)', 'feed trains']);
  const t2 = S.findTable(store.doc('main'), 'Trains');
  const keys = []; for (let rr = t2.R.r1 + 1; rr <= t2.R.r2; rr++) keys.push(String(t2.sh.cells['A' + (rr + 1)]?.v));
  assert.deepEqual(keys, ['27', '41']);
  assert.equal(String(t2.sh.cells.B2.v), '60.2');
  // replay sees the train move
  const rp = await (await req('GET', `/api/replay?from=${e.ts - 1}&format=json`)).json();
  assert.equal(rp.frames.length, 1);
  assert.match(await (await req('GET', '/api/feeds')).text(), /trains {2}trains → main:Trains every 15s .*2 rows \(\+1 ~1 -1\)/);
  assert.match(await (await req('GET', '/api/changes?since=' + v1)).text(), /feed/);
});

test('feeds: kinds, pause/resume, keep, errors, removal; settings survive a restart', async () => {
  assert.match(await (await req('GET', '/api/feeds?kinds')).text(), /trains .*ships .*roadweather .*weather/s);
  assert.equal((await req('POST', '/api/feeds', { kind: 'planes' })).status, 400);
  assert.equal((await req('POST', '/api/feeds', { kind: 'ships', bbox: [1, 2, 0, 3] })).status, 400);
  assert.equal((await req('POST', '/api/feeds', { kind: 'weather', places: [] })).status, 400);
  const w = await (await req('POST', '/api/feeds', { kind: 'weather', places: ['Helsinki', 'Oulu'], keep: true, sheet: 'Trains', at: 'H20' })).json();
  assert.deepEqual([w.status.rows, w.table], [2, 'Weather']);
  const wt = S.findTable(store.doc('main'), 'Weather');
  assert.deepEqual([wt.sh.name, wt.t.range], ['Trains', 'H20:N22']);
  await req('POST', '/api/feeds', { kind: 'weather', places: ['Helsinki'], keep: true });
  assert.equal(S.findTable(store.doc('main'), 'Weather').R.r2 - S.findTable(store.doc('main'), 'Weather').R.r1, 2, 'keep: rows that disappear stay');
  assert.equal((await (await req('POST', '/api/feeds/set', { id: 'weather', on: false })).json()).on, false);
  assert.equal(store.feeds.timers.has('weather'), false);
  await req('POST', '/api/feeds/set', { id: 'weather', on: true });
  assert.equal(store.feeds.timers.has('weather'), true);
  // a failing source reports, writes nothing
  const bad = new Feeds(store, { get: async () => { throw new Error('rata.digitraffic.fi 503'); } });
  const v = store.state.version;
  assert.match((await bad.run('trains')).status.error, /503/);
  assert.equal(store.state.version, v);
  // a user removed the table: the next poll makes it again
  await req('POST', '/api/ops', { by: 'user', ops: [{ op: 'deleteTable', name: 'Weather' }] });
  const again = await store.feeds.run('weather');
  assert.equal(again.status.created, true);
  // persisted
  assert.deepEqual(new Store(dir).init().settings().feeds.map((f) => f.id).sort(), ['trains', 'weather']);
  assert.equal((await req('DELETE', '/api/feeds?id=weather')).status, 200);
  assert.equal((await req('DELETE', '/api/feeds?id=weather')).status, 404);
  assert.ok(S.findTable(store.doc('main'), 'Weather'), 'removing a feed keeps its table');
  clearFeedCache();
});

test('syncOps handles a moved table and extra columns the user added', () => {
  const st = S.create('x');
  S.apply(st, { op: 'set', range: 'C3', values: [['Train', 'Lat', 'Lon', 'Speed', 'Updated', 'Note'], ['5', 60, 24, 10, '', 'mine']] });
  S.apply(st, { op: 'table', name: 'Trains', range: 'C3:H4' });
  const r = syncOps(st, { kind: 'trains', table: 'Trains' }, [{ Train: '5', Lat: 61, Lon: 24, Speed: 10, Updated: '' }]);
  assert.deepEqual(r.ops, [{ op: 'updateRows', table: 'Trains', rows: [1], set: { Lat: 61 } }]);
  for (const op of r.ops) S.apply(st, op);
  assert.equal(String(st.sheets[0].cells.D4.v), '61');
  assert.equal(st.sheets[0].cells.H4.v, 'mine', "the user's own column is left alone");
});

// ------------------------------------------------------------------ NLS tile proxy
test('NLS tiles: key stays on the server, tiles are cached, bad requests refused', async () => {
  const seen = [];
  const up = http.createServer((q, s) => { seen.push(q.url); s.writeHead(q.url.includes('api-key=goodkey123') ? 200 : 403, { 'content-type': 'image/png' }); s.end(Buffer.from([137, 80, 78, 71])); });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
  process.env.NLS_TILE_BASE = `http://127.0.0.1:${up.address().port}/wmts`;
  try {
    assert.equal((await req('GET', '/tiles/nls/maastokartta/5/18/9')).status, 503, 'no key yet');
    assert.match(await (await req('GET', '/api/config')).text(), /not set/);
    assert.equal((await req('POST', '/api/config', { nlsKey: 'x y' })).status, 400);
    await req('POST', '/api/config', { nlsKey: 'goodkey123' });
    assert.match(await (await req('GET', '/api/config')).text(), /nls-key: good…/, 'the key is never shown in full');
    const r1 = await req('GET', '/tiles/nls/maastokartta/5/18/9');
    assert.deepEqual([r1.status, r1.headers.get('content-type'), r1.headers.get('x-cache')], [200, 'image/png', 'miss']);
    assert.equal(seen.at(-1), '/wmts/maastokartta/default/WGS84_Pseudo-Mercator/5/9/18.png?api-key=goodkey123', 'z/row(y)/col(x) order');
    const r2 = await req('GET', '/tiles/nls/maastokartta/5/18/9');
    assert.equal(r2.headers.get('x-cache'), 'hit');
    assert.equal(seen.length, 1, 'served from the cache');
    assert.equal((await req('GET', '/tiles/nls/ortokuva/3/1/1')).headers.get('content-type'), 'image/jpeg');
    assert.equal((await req('GET', '/tiles/nls/secret/1/0/0')).status, 404);
    assert.equal((await req('GET', '/tiles/nls/maastokartta/2/9/0')).status, 400, 'x out of range');
    assert.equal((await req('GET', '/tiles/nls/maastokartta/17/0/0')).status, 400);
    assert.ok([400, 404].includes((await req('GET', '/tiles/nls/maastokartta/1/%2e%2e/0')).status), 'no path tricks');
    assert.equal(seen.length, 2, 'nothing odd reached NLS');
    await req('POST', '/api/config', { nlsKey: 'wrongkey999' });
    assert.equal((await req('GET', '/tiles/nls/taustakartta/4/1/1')).status, 503, 'a rejected key reads as "needs a key"');
  } finally { delete process.env.NLS_TILE_BASE; up.close(); }
});

test('map basemaps include imagery and the Finnish maps', () => {
  assert.deepEqual(S.MAP_BASES, ['dark', 'light', 'bright', 'satellite', 'aerial', 'topo', 'fi', 'none']);
  const st = S.create('t');
  S.apply(st, { op: 'set', cells: { A1: 'Lat', B1: 'Lon', A2: '60', B2: '24' } });
  S.apply(st, { op: 'table', name: 'P', range: 'A1:B2' });
  S.apply(st, { op: 'addChart', id: 'm', type: 'map', layers: ['P'], basemap: 'aerial', at: 'D1' });
  assert.throws(() => S.apply(st, { op: 'updateChart', id: 'm', basemap: 'google' }), /satellite/);
});
