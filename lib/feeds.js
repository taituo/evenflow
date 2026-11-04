// Open data feeds: Finnish real-time sources polled into named tables. Every poll that changes something is one
// versioned batch (by "feed"), so the grid, Live, the change feed, maps and time replay all just work.
//   trains       Digitraffic rail: where every running train is now              (Fintraffic, CC BY 4.0)
//   ships        Digitraffic marine: AIS positions of vessels in an area         (Fintraffic, CC BY 4.0)
//   roadweather  Digitraffic road: road weather stations (air, road surface, wind) (Fintraffic, CC BY 4.0)
//   weather      Finnish Meteorological Institute: latest observations by place  (FMI, CC BY 4.0)
// Feeds live in data/settings.json (not in the workbook); their rows land in the workbook.
import { TYPES } from '../public/shared/types/index.js';
import { parseRange, addr } from '../public/shared/a1.js';

const UA = 'Spread/1 (spreadsheet dashboard)';
const T = (ms) => new Date(ms).toLocaleTimeString('fi-FI', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\./g, ':');
const inBox = (b, lon, lat) => !b || (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3]);
const round = (n, d = 5) => (typeof n === 'number' && isFinite(n) ? +n.toFixed(d) : null);

/** Default fetcher: JSON or text, with the headers Digitraffic asks for (gzip is mandatory there; fetch sends it). */
export async function httpGet(url, { text } = {}) {
  const r = await fetch(url, { headers: { 'Digitraffic-User': UA, 'accept-encoding': 'gzip', accept: text ? '*/*' : 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return text ? r.text() : r.json();
}

const cache = new Map();   // slow-changing metadata (station names, ship names)
async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ms) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
export const clearFeedCache = () => cache.clear();

/** FMI "simple" WFS: <BsWfs:BsWfsElement> with pos, Time, ParameterName, ParameterValue → { lat, lon, values:{p:{v,t}} } */
export function parseFmiSimple(xml) {
  const out = { lat: null, lon: null, values: {} };
  for (const m of String(xml).matchAll(/<BsWfs:BsWfsElement[\s\S]*?<\/BsWfs:BsWfsElement>/g)) {
    const el = m[0];
    const pos = /<gml:pos>\s*([-\d.]+)\s+([-\d.]+)\s*<\/gml:pos>/.exec(el);
    const t = /<BsWfs:Time>([^<]+)<\/BsWfs:Time>/.exec(el)?.[1];
    const p = /<BsWfs:ParameterName>([^<]+)<\/BsWfs:ParameterName>/.exec(el)?.[1];
    const v = /<BsWfs:ParameterValue>([^<]+)<\/BsWfs:ParameterValue>/.exec(el)?.[1];
    if (pos) { out.lat = +pos[1]; out.lon = +pos[2]; }
    if (!p || v == null || /nan/i.test(v)) continue;
    const ts = Date.parse(t);
    if (!out.values[p] || ts >= out.values[p].t) out.values[p] = { v: +v, t: ts };
  }
  return out;
}

export const KINDS = {
  trains: {
    title: 'Trains (Digitraffic)', table: 'Trains', every: 30, min: 15, columns: ['Train', 'Lat', 'Lon', 'Speed', 'Updated'], credit: 'Fintraffic / digitraffic.fi, CC BY 4.0',
    about: 'Every running train in Finland: position and speed, updated about every 15 s. Options: bbox, limit.',
    async rows(get, o) {
      const list = await get((o.base || 'https://rata.digitraffic.fi') + '/api/v1/train-locations/latest/');
      return list.filter((x) => x?.location?.coordinates && inBox(o.bbox, ...x.location.coordinates))
        .map((x) => ({ Train: String(x.trainNumber), Lat: round(x.location.coordinates[1]), Lon: round(x.location.coordinates[0]), Speed: x.speed ?? null, Updated: x.timestamp ? T(Date.parse(x.timestamp)) : '' }));
    },
  },
  ships: {
    title: 'Ships (AIS, Digitraffic)', table: 'Ships', every: 60, min: 30, columns: ['Ship', 'MMSI', 'Lat', 'Lon', 'Speed', 'Course', 'Updated'], credit: 'Fintraffic / digitraffic.fi, CC BY 4.0',
    bbox: [24.5, 59.95, 25.4, 60.25],   // off Helsinki
    about: 'Vessel positions from AIS in an area (default: off Helsinki). Speed in knots. Options: bbox [minLon,minLat,maxLon,maxLat], limit.',
    async rows(get, o) {
      const base = o.base || 'https://meri.digitraffic.fi';
      const [loc, meta] = await Promise.all([get(base + '/api/ais/v1/locations'), cached(base + 'vessels', 36e5, () => get(base + '/api/ais/v1/vessels')).catch(() => [])]);
      const names = new Map((Array.isArray(meta) ? meta : []).map((v) => [v.mmsi, String(v.name || '').trim()]));
      const box = o.bbox || this.bbox;
      return (loc.features || []).filter((f) => f?.geometry?.coordinates && inBox(box, ...f.geometry.coordinates))
        .sort((a, b) => (b.properties?.timestampExternal || 0) - (a.properties?.timestampExternal || 0))
        .map((f) => {
          const p = f.properties || {}, mmsi = p.mmsi ?? f.mmsi;
          return { Ship: names.get(mmsi) || String(mmsi), MMSI: String(mmsi), Lat: round(f.geometry.coordinates[1]), Lon: round(f.geometry.coordinates[0]), Speed: p.sog ?? null, Course: p.cog ?? null, Updated: p.timestampExternal ? T(p.timestampExternal) : '' };
        });
    },
  },
  roadweather: {
    title: 'Road weather (Digitraffic)', table: 'RoadWeather', every: 300, min: 60, columns: ['Station', 'Lat', 'Lon', 'Air', 'Road', 'Wind'], credit: 'Fintraffic / digitraffic.fi, CC BY 4.0',
    about: 'Road weather stations: air and road surface temperature (°C), average wind (m/s). Options: bbox, limit (default 60).',
    async rows(get, o) {
      const base = o.base || 'https://tie.digitraffic.fi';
      const [st, data] = await Promise.all([cached(base + 'wstations', 864e5, () => get(base + '/api/weather/v1/stations')), get(base + '/api/weather/v1/stations/data')]);
      const where = new Map((st.features || []).map((f) => [f.id ?? f.properties?.id, { name: f.properties?.name || String(f.id), lon: f.geometry?.coordinates?.[0], lat: f.geometry?.coordinates?.[1] }]));
      const val = (s, ...names) => { for (const n of names) { const x = (s.sensorValues || []).find((v) => v.name === n); if (x && x.value != null) return x.value; } return null; };
      const rows = [];
      for (const s of data.stations || []) {
        const w = where.get(s.id);
        if (!w || w.lat == null || !inBox(o.bbox, w.lon, w.lat)) continue;
        rows.push({ Station: w.name, Lat: round(w.lat), Lon: round(w.lon), Air: val(s, 'ILMA'), Road: val(s, 'TIE_1', 'TIE_2'), Wind: val(s, 'KESKITUULI') });
      }
      return rows.filter((r) => r.Air != null || r.Road != null);
    },
    limit: 60,
  },
  weather: {
    title: 'Weather (FMI)', table: 'Weather', every: 600, min: 300, columns: ['Place', 'Lat', 'Lon', 'Temp', 'Wind', 'Humidity', 'Updated'], credit: 'Finnish Meteorological Institute, CC BY 4.0',
    places: ['Helsinki', 'Turku', 'Tampere', 'Jyväskylä', 'Kuopio', 'Oulu', 'Rovaniemi', 'Utsjoki'],
    about: 'Latest weather observations (°C, m/s, %) for places. Options: places ["Helsinki", …].',
    async rows(get, o) {
      const since = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 19) + 'Z';
      const out = [];
      for (const place of o.places || this.places) {
        const url = `${o.base || 'https://opendata.fmi.fi'}/wfs?service=WFS&version=2.0.0&request=getFeature&storedquery_id=fmi::observations::weather::simple&place=${encodeURIComponent(place)}&parameters=t2m,ws_10min,rh&starttime=${since}`;
        const r = parseFmiSimple(await get(url, { text: true }));
        if (r.lat == null) continue;
        const t = Math.max(0, ...Object.values(r.values).map((x) => x.t));
        out.push({ Place: place, Lat: r.lat, Lon: r.lon, Temp: r.values.t2m?.v ?? null, Wind: r.values.ws_10min?.v ?? null, Humidity: r.values.rh?.v ?? null, Updated: t ? T(t) : '' });
      }
      return out;
    },
  },
};

const MAX_ROWS = 500;
const keyOf = (k, row) => String(row[KINDS[k].columns[0]] ?? '');
const show = (v) => (v == null ? '' : String(v));

/** The ops that bring the feed's table up to date: create it, or update / append / remove records by key. */
export function syncOps(doc, feed, rows) {
  const K = KINDS[feed.kind], cols = K.columns;
  const tab = TYPES.sheet.tables(doc).find((x) => x.t.name.toLowerCase() === feed.table.toLowerCase());
  if (!tab) {
    const ops = [];
    const sheet = feed.sheet || feed.table;
    if (!doc.sheets.some((s) => s.name.toLowerCase() === sheet.toLowerCase())) ops.push({ op: 'addSheet', name: sheet });
    const at = parseRange(feed.at || 'A1');
    ops.push({ op: 'set', sheet, range: addr(at.c1, at.r1), values: [cols, ...rows.map((r) => cols.map((c) => r[c] ?? ''))] });
    ops.push({ op: 'table', sheet, name: feed.table, range: `${addr(at.c1, at.r1)}:${addr(at.c1 + cols.length - 1, at.r1 + Math.max(1, rows.length))}` });
    if (feed.map) ops.push({ op: 'addChart', sheet, id: 'map' + feed.table, type: 'map', title: K.title, at: addr(at.c1 + cols.length + 1, at.r1), w: 640, h: 420, basemap: feed.kind === 'ships' ? 'satellite' : 'dark', layers: [{ table: feed.table, label: cols[0] }] });
    return { ops, created: true, added: rows.length, updated: 0, removed: 0 };
  }
  const tcols = TYPES.sheet.tableColumns(tab.sh, tab.R);
  const have = new Map();   // key → { i: record number (1-based), rec }
  for (let r = tab.R.r1 + 1; r <= tab.R.r2; r++) {
    const rec = {};
    tcols.forEach((c, i) => { rec[c] = show(tab.sh.cells[addr(tab.R.c1 + i, r)]?.v); });
    const k = rec[tcols[0]];
    if (k !== '' && !have.has(k)) have.set(k, { i: r - tab.R.r1, rec });
  }
  const ops = [];
  let added = 0, updated = 0;
  const seen = new Set(), append = [];
  for (const row of rows) {
    const k = keyOf(feed.kind, row);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const old = have.get(k);
    if (!old) { append.push(Object.fromEntries(cols.filter((c) => tcols.includes(c)).map((c) => [c, row[c] ?? '']))); added++; continue; }
    const set = {};
    for (const c of cols) if (tcols.includes(c) && c !== tcols[0] && show(row[c]) !== old.rec[c]) set[c] = row[c] ?? '';
    if (Object.keys(set).length) { ops.push({ op: 'updateRows', table: tab.t.name, rows: [old.i], set }); updated++; }   // by record number: exact, even with look-alike keys
  }
  const gone = feed.keep ? [] : [...have].filter(([k]) => !seen.has(k)).map(([, x]) => x.i);
  if (gone.length) ops.push({ op: 'removeRows', table: tab.t.name, rows: gone });
  if (append.length) ops.push({ op: 'appendRows', table: tab.t.name, rows: append });
  const removed = gone.length;
  return { ops, created: false, added, updated, removed };
}

export class Feeds {
  constructor(store, { get = httpGet } = {}) {
    this.store = store; this.get = get; this.timers = new Map(); this.status = new Map();
  }
  list() { return this.store.settings().feeds || []; }
  save(list) { this.store.saveSettings({ feeds: list }); }
  start() { for (const f of this.list()) if (f.on !== false) this.schedule(f); return this; }
  stop() { for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); }
  schedule(f) {
    clearInterval(this.timers.get(f.id));
    const t = setInterval(() => this.run(f.id).catch(() => {}), f.every * 1000);
    t.unref?.();
    this.timers.set(f.id, t);
  }
  /** add or change a feed: { kind, id?, doc?, table?, sheet?, at?, every?, bbox?, places?, limit?, map?, keep?, on? } */
  async add(o) {
    const K = KINDS[o.kind];
    if (!K) throw Object.assign(new Error(`kind: ${Object.keys(KINDS).join(' | ')}`), { status: 400 });
    const id = String(o.id || o.kind).replace(/[^\w-]/g, '').slice(0, 40) || o.kind;
    const every = Math.max(K.min, Math.min(86400, +o.every || K.every));
    if (o.bbox != null && !(Array.isArray(o.bbox) && o.bbox.length === 4 && o.bbox.every((n) => typeof n === 'number') && o.bbox[0] < o.bbox[2] && o.bbox[1] < o.bbox[3])) throw Object.assign(new Error('bbox: [minLon, minLat, maxLon, maxLat]'), { status: 400 });
    if (o.places != null && !(Array.isArray(o.places) && o.places.length && o.places.length <= 30 && o.places.every((p) => typeof p === 'string' && p.trim()))) throw Object.assign(new Error('places: ["Helsinki", …] (1–30)'), { status: 400 });
    const doc = this.store.doc(o.doc).id;
    const table = String(o.table || K.table);
    if (!/^[A-Za-z_][\w]{0,40}$/.test(table)) throw Object.assign(new Error('table: a table name (letters, digits, _)'), { status: 400 });
    const f = { id, kind: o.kind, doc, table, sheet: o.sheet || undefined, at: o.at || undefined, every, bbox: o.bbox || undefined, places: o.places || undefined, limit: Math.max(1, Math.min(MAX_ROWS, +o.limit || K.limit || 200)), map: !!o.map, keep: !!o.keep, on: o.on !== false };
    this.save([...this.list().filter((x) => x.id !== id), JSON.parse(JSON.stringify(f))]);
    if (f.on) this.schedule(f);
    return this.run(id);
  }
  remove(id) {
    const list = this.list();
    if (!list.some((x) => x.id === id)) throw Object.assign(new Error(`No feed "${id}"`), { status: 404 });
    clearInterval(this.timers.get(id)); this.timers.delete(id); this.status.delete(id);
    this.save(list.filter((x) => x.id !== id));
  }
  setOn(id, on) {
    const list = this.list(), f = list.find((x) => x.id === id);
    if (!f) throw Object.assign(new Error(`No feed "${id}"`), { status: 404 });
    f.on = on;
    this.save(list);
    if (on) this.schedule(f); else { clearInterval(this.timers.get(id)); this.timers.delete(id); }
    return f;
  }
  /** Poll once: fetch, diff, write one batch. Returns the status. */
  async run(id) {
    const f = this.list().find((x) => x.id === id);
    if (!f) throw Object.assign(new Error(`No feed "${id}"`), { status: 404 });
    const K = KINDS[f.kind];
    const st = { at: Date.now(), ok: false };
    this.status.set(id, st);
    try {
      let rows = await K.rows(this.get, f);
      st.found = rows.length;
      rows = rows.slice(0, f.limit);
      const doc = this.store.doc(f.doc);
      const r = syncOps(doc, f, rows);
      Object.assign(st, { rows: rows.length, added: r.added, updated: r.updated, removed: r.removed, created: r.created });
      if (r.ops.length) st.version = this.store.batch({ doc: f.doc, by: 'feed', who: K.title, color: '#00897b', label: `feed ${f.id}`, ops: r.ops }).v;
      st.ok = true;
    } catch (e) { st.error = e.message; }
    return { ...f, status: st };
  }
  describe() {
    const list = this.list();
    if (!list.length) return 'no feeds — cm feed kinds · cm feed add trains --map';
    return list.map((f) => {
      const s = this.status.get(f.id);
      const when = s ? new Date(s.at).toISOString().slice(11, 19) + ' UTC' : 'not yet';
      return `${f.id}  ${f.kind} → ${f.doc}:${f.table} every ${f.every}s${f.on === false ? ' (paused)' : ''}${f.bbox ? ' bbox ' + f.bbox.join(',') : ''}${f.places ? ' places ' + f.places.join(',') : ''}  · last ${when}: ${s ? (s.ok ? `${s.rows} rows (+${s.added} ~${s.updated} -${s.removed})${s.found > s.rows ? `, ${s.found} found (limit ${f.limit})` : ''}` : 'ERROR ' + s.error) : '—'}  [${KINDS[f.kind].credit}]`;
    }).join('\n');
  }
}
export const describeKinds = () => Object.entries(KINDS).map(([k, K]) => `${k.padEnd(12)} → table ${K.table} [${K.columns.join(' | ')}] every ${K.every}s (min ${K.min})\n             ${K.about}\n             source: ${K.credit}`).join('\n');
