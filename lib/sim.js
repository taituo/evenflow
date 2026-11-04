// Session simulator: a race weekend's sessions (race, qualifying, practice) on a circuit, written into named tables
// once per tick as ordinary versioned batches — so the grid, Live, maps, the change feed and time replay all just
// work, and every session can be replayed from its milestones. Seeded and deterministic.
//
// It is also a template for any tracking: things moving along a line (Cars + Circuit), one followed closely
// (Live: telemetry of the focus car), a person's vitals, slow context (weather), rolling traces for charts.
//
//   cm sim start race --laps 20 --speed 4        cm sim focus LEC        cm sim stop
//   POST /api/sim { action: start|stop|focus|layout, session, laps, minutes, speed, focus, seed, doc }
import { buildTrack } from '../public/shared/track.js';
import { TYPES } from '../public/shared/types/index.js';
import { colToName, nameToCol } from '../public/shared/a1.js';

// ------------------------------------------------------------------ the circuit (an original lakeside park layout)
// control points in metres-ish (x right, y down), driven in this order; scaled to LENGTH below
const OUTLINE = [[360, 402], [270, 396], [130, 366], [60, 350], [35, 320], [45, 282], [30, 255], [15, 190], [25, 145], [45, 100], [70, 65], [120, 40], [170, 35], [215, 55], [255, 90], [280, 140], [330, 200], [375, 235], [425, 240], [480, 212], [530, 196], [590, 190], [640, 195], [680, 210], [760, 250], [775, 282], [730, 340], [670, 346], [630, 340], [620, 380], [600, 405], [480, 406]];
const LENGTH = 5278;
const TURNS = { 1: 1, 2: 2, 3: 4, 4: 5, 5: 7, 6: 10, 7: 11, 8: 12, 9: 19, 10: 20, 11: 24, 12: 26, 13: 28, 14: 30 };   // turn → control point
const ZONES = [{ name: 'DRS Zone 1', from: 24, to: 26, kind: 'drs' }, { name: 'DRS Zone 2', from: 30, to: 1, kind: 'drs' }];

// ------------------------------------------------------------------ the grid (2026 season names; telemetry is simulated)
export const ROSTER = [
  ['LEC', 'C. Leclerc', 16, 'Ferrari', '#dc0000'], ['HAM', 'L. Hamilton', 44, 'Ferrari', '#dc0000'],
  ['RUS', 'G. Russell', 63, 'Mercedes', '#27f4d2'], ['ANT', 'K. Antonelli', 12, 'Mercedes', '#27f4d2'],
  ['VER', 'M. Verstappen', 1, 'Red Bull', '#3671c6'], ['HAD', 'I. Hadjar', 6, 'Red Bull', '#3671c6'],
  ['NOR', 'L. Norris', 4, 'McLaren', '#ff8000'], ['PIA', 'O. Piastri', 81, 'McLaren', '#ff8000'],
  ['ALO', 'F. Alonso', 14, 'Aston Martin', '#229971'], ['STR', 'L. Stroll', 18, 'Aston Martin', '#229971'],
  ['GAS', 'P. Gasly', 10, 'Alpine', '#0093cc'], ['COL', 'F. Colapinto', 43, 'Alpine', '#0093cc'],
  ['ALB', 'A. Albon', 23, 'Williams', '#64c4ff'], ['SAI', 'C. Sainz', 55, 'Williams', '#64c4ff'],
  ['LAW', 'L. Lawson', 30, 'Racing Bulls', '#6692ff'], ['LIN', 'A. Lindblad', 41, 'Racing Bulls', '#6692ff'],
  ['OCO', 'E. Ocon', 31, 'Haas', '#b6babd'], ['BEA', 'O. Bearman', 87, 'Haas', '#b6babd'],
  ['HUL', 'N. Hülkenberg', 27, 'Audi', '#00e701'], ['BOR', 'G. Bortoleto', 5, 'Audi', '#00e701'],
  ['BOT', 'V. Bottas', 77, 'Cadillac', '#c0c0c0'], ['PER', 'S. Pérez', 11, 'Cadillac', '#c0c0c0'],
];
const TEAM_GAP = { McLaren: 0, Ferrari: 0.002, Mercedes: 0.003, 'Red Bull': 0.004, Williams: 0.01, 'Aston Martin': 0.011, 'Racing Bulls': 0.012, Haas: 0.013, Alpine: 0.015, Audi: 0.016, Cadillac: 0.021 };
const COMPOUND = { soft: { grip: 1.012, wear: 1 / 18 }, medium: { grip: 1.0, wear: 1 / 28 }, hard: { grip: 0.99, wear: 1 / 40 } };

// ------------------------------------------------------------------ deterministic randomness
function rng(seed) { let a = seed >>> 0 || 1; return () => { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return ((a >>> 0) % 1e9) / 1e9; }; }

export function circuit() {
  const raw = buildTrack(OUTLINE, { closed: true, per: 16 });
  const k = LENGTH / raw.length;
  const pts = OUTLINE.map(([x, y]) => [+(x * k).toFixed(1), +(y * k).toFixed(1)]);
  const T = buildTrack(pts, { closed: true, per: 16 });
  // where each control point sits along the lap
  const fAt = (i) => { let best = 0, bd = Infinity; for (let s = 0; s < T.samples.length; s++) { const d = Math.hypot(T.samples[s][0] - pts[i][0], T.samples[s][1] - pts[i][1]); if (d < bd) { bd = d; best = s; } } return +(T.cum[best] / T.length).toFixed(4); };
  // speed profile: corner limit from the radius, then acceleration / braking limits forwards and backwards
  const N = 1000, dx = T.length / N, VMAX = 88, ALAT = 17, ACC = 9, DEC = 30;
  const v = Array.from({ length: N }, (_, i) => Math.min(VMAX, Math.sqrt(ALAT * Math.max(8, T.radius(i / N, 0.004)))));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < N * 2; i++) { const a = (i - 1) % N, b = i % N; v[b] = Math.min(v[b], Math.sqrt(v[a] ** 2 + 2 * ACC * dx)); }
    for (let i = N * 2 - 2; i >= 0; i--) { const a = (i + 1) % N, b = i % N; v[b] = Math.min(v[b], Math.sqrt(v[a] ** 2 + 2 * DEC * dx)); }
  }
  const turns = Object.entries(TURNS).map(([n, i]) => ({ label: String(n).padStart(2, '0'), at: fAt(i) }));
  const zones = ZONES.map((z) => ({ name: z.name, from: fAt(z.from), to: fAt(z.to) }));
  const lapTime = v.reduce((s, x) => s + dx / x, 0);
  const speedAt = (f) => { const u = (((f % 1) + 1) % 1) * N, i = Math.floor(u) % N, j = (i + 1) % N, k2 = u - Math.floor(u); return v[i] + (v[j] - v[i]) * k2; };
  const brakingAt = (f) => speedAt(f + 0.004) < speedAt(f) - 0.4;
  return { T, pts, turns, zones, length: T.length, lapTime, speedAt, brakingAt, sectors: [0.33, 0.67] };
}

const fmtLap = (s) => (s == null || !isFinite(s) ? '' : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`);
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/Helsinki', hour12: false });
const round = (n, d = 1) => +n.toFixed(d);

// ------------------------------------------------------------------ one session's state
export class Session {
  constructor({ session = 'race', laps = 20, minutes = 15, seed = 7, focus = 'HAM', cars = 22, speed = 1, startTs = Date.now() } = {}) {
    if (!['race', 'qualifying', 'practice'].includes(session)) throw new Error('session: race | qualifying | practice');
    this.C = circuit();
    this.kind = session; this.laps = laps; this.minutes = minutes; this.speed = speed;
    this.r = rng(seed); this.seed = seed;
    this.t = 0;                 // simulated seconds since the start
    this.wall = startTs;        // simulated wall clock (for traces)
    this.flag = 'green';
    this.done = false;
    const r = this.r;
    const roster = ROSTER.slice(0, Math.max(2, Math.min(ROSTER.length, cars)));
    this.cars = roster.map(([code, name, no, team, color], i) => {
      const pace = 1 - (TEAM_GAP[team] ?? 0.015) - r() * 0.008;   // the car, then the driver's day
      return {
        code, name, no, team, color, pace, slot: i,
        dist: session === 'race' ? -i * 0.0024 : 0,             // staggered on the grid
        lap: 0, last: null, best: null, lapStart: 0, v: 0, tyre: session === 'race' ? (i % 3 === 0 ? 'medium' : 'soft') : 'soft', wear: 0, fuel: session === 'race' ? Math.min(100, 6 + laps * 1.6) : 30,
        out: session !== 'race' ? r() * 0.35 * (minutes * 60) : 0,   // practice: when it leaves the garage
        inPit: 0, garage: 0, stops: 0, plan: session === 'race' ? Math.round(laps * (0.38 + r() * 0.25)) : null, finished: false, top: 0,
      };
    });
    this.focus = this.cars.find((c) => c.code === focus) ? focus : this.cars[0].code;
    this.vitals = { hr: 128, br: 28, stress: 40 };
    this.traces = { speed: [], hr: [], br: [], stress: [] };
    this.weather = { temp: 24, sky: 'partly', wind: 3.1 };
    this.lapsOfFocus = [];
  }
  get title() { return { race: 'Race', qualifying: 'Qualifying', practice: 'Practice' }[this.kind]; }
  get timeLeft() { return this.kind === 'race' ? null : Math.max(0, this.minutes * 60 - this.t); }

  /** advance dt simulated seconds (small internal steps) */
  step(dt) {
    const C = this.C, r = this.r, sub = 0.25;
    for (let s = 0; s < dt - 1e-9; s += sub) {
      const h = Math.min(sub, dt - s);
      this.t += h; this.wall += h * 1000;
      for (const c of this.cars) {
        if (c.finished) { c.v = Math.max(0, c.v - 6 * h); c.dist += (c.v * h) / C.length; continue; }   // cool-down: rolls on slowly
        if (this.kind !== 'race' && this.t < c.out) { c.v = 0; continue; }
        if (c.garage > 0) { c.garage -= h; c.v = 0; if (c.garage <= 0) { c.lapStart = this.t; c.tyre = 'soft'; c.wear = 0; } continue; }
        if (c.inPit > 0) {   // pit lane: slow, then fresh tyres
          c.inPit -= h; c.v = 22; c.dist += (22 * h) / C.length;
          if (c.inPit <= 0) { c.tyre = c.tyre === 'soft' ? 'medium' : 'hard'; c.wear = 0; c.stops++; }
          continue;
        }
        const f = c.dist;
        const grip = COMPOUND[c.tyre].grip * (1 - c.wear * 0.035) * (1 + (100 - c.fuel) * 0.00012);
        let target = C.speedAt(f) * c.pace * grip * (0.995 + r() * 0.01);
        if (this.flag === 'sc') target = Math.min(target, 48);
        const wasStart = this.kind === 'race' && c.lap === 0 && f < 0.02 && this.t < 8;
        if (wasStart) target = Math.min(target, 12 + this.t * 9);
        c.v += Math.max(-38 * h, Math.min(11 * h, target - c.v));
        c.top = Math.max(c.top, c.v);
        const before = Math.floor(c.dist);
        c.dist += (c.v * h) / C.length;
        if (Math.floor(c.dist) > before && c.dist > 0.01) this.lapDone(c);
      }
    }
    this.updateVitals(dt);
    if (this.kind !== 'race' && this.timeLeft <= 0 && this.flag !== 'chequered') this.flag = 'chequered';
    if (this.kind !== 'race' && this.flag === 'chequered' && this.cars.every((c) => c.finished || c.garage > 0 || this.t < c.out || c.dist === 0)) this.done = true;
    if (this.finishAt != null && this.t - this.finishAt > 150) this.done = true;   // stragglers after the flag
  }
  lapDone(c) {
    const over = c.v > 0 ? ((c.dist - Math.floor(c.dist)) * this.C.length) / c.v : 0;   // the line was crossed `over` seconds ago
    const at = this.t - over, lt = at - c.lapStart;
    if (c.lap > 0) {   // the first crossing ends the out-lap (or the grid) — not timed
      c.last = lt;
      if (!c.best || lt < c.best) c.best = lt;
      if (c.code === this.focus) this.lapsOfFocus.push({ lap: c.lap, time: lt, best: c.best });
    }
    c.lap++; c.lapStart = at;
    c.wear += COMPOUND[c.tyre].wear; c.fuel = Math.max(0, c.fuel - 1.6);   // % of the tank per lap
    if (this.kind === 'race') {
      if (c.lap > this.laps || this.flag === 'chequered') {   // took the flag
        c.finished = true; (this.finishOrder ||= []).push(c);
        if (this.flag !== 'chequered') { this.flag = 'chequered'; this.finishAt = this.t; }
      } else if (c.plan && c.lap === c.plan && c.stops === 0) c.inPit = 22;
      if (this.cars.every((x) => x.finished)) this.done = true;
    } else if (this.timeLeft <= 0) c.finished = true;
    else if (c.lap > 2 && this.r() < 0.22) c.garage = 40 + this.r() * 70;   // practice: back to the garage now and then
  }
  updateVitals(dt) {
    const f = this.car();
    const braking = this.C.brakingAt(f.dist), load = f.v / 90;
    const base = this.kind === 'race' ? 150 : 128;
    const want = { hr: base + load * 18 + (braking ? 14 : 0) + Math.sin(this.t / 7) * 3, br: 26 + load * 14 + (braking ? 6 : 0), stress: 35 + (this.kind === 'race' ? 20 : 0) + (braking ? 18 : 0) + (this.flag === 'sc' ? -15 : 0) };
    const k = Math.min(1, dt / 3);
    for (const x of ['hr', 'br', 'stress']) this.vitals[x] += (want[x] - this.vitals[x]) * k + (this.r() - 0.5) * 2;
  }
  car(code = this.focus) { return this.cars.find((c) => c.code === code) || this.cars[0]; }
  order() {
    const live = (c) => (this.kind === 'race' ? -(c.finished ? 1e6 - (this.finishOrder?.indexOf(c) ?? 0) : c.dist) : c.best ?? 1e9 + c.slot);
    return [...this.cars].sort((a, b) => live(a) - live(b));
  }

  /** telemetry of the focus car right now (plausible numbers from speed, braking and history) */
  telemetry() {
    const c = this.car(), C = this.C, r = this.r;
    const kmh = c.v * 3.6, braking = C.brakingAt(c.dist), corner = C.T.radius(c.dist, 0.004);
    const gear = c.v < 1 ? 0 : Math.min(8, 1 + Math.floor(kmh / 42));
    const rpm = c.v < 1 ? 4 : Math.min(15, 6.5 + ((kmh % 42) / 42) * 5.5 + gear * 0.35);
    const left = corner < 200 && Math.sin(C.T.at(c.dist).a - C.T.at(c.dist + 0.004).a) > 0;   // which way the car is turning
    // tyres heat on the outside of a corner and under braking (fronts), cool on straights; wear adds heat
    const t0 = 90 + c.wear * 25 + (c.v < 40 ? -8 : 0), load = corner < 300 ? Math.min(22, 4500 / Math.max(60, corner)) : -3;
    const heat = this.heat ||= { FL: 0, FR: 0, RL: 0, RR: 0 };
    const want = { FL: (left ? 2 : load) + (braking ? 9 : 0), FR: (left ? load : 2) + (braking ? 9 : 0), RL: (left ? 0 : load * 0.8) + (braking ? 0 : 3), RR: (left ? load * 0.8 : 0) + (braking ? 0 : 3) };
    for (const k in heat) heat[k] += (want[k] - heat[k]) * 0.35;
    const tyres = Object.fromEntries(Object.keys(heat).map((k) => [k, t0 + heat[k] + r() * 1.5 - (k[0] === 'R' ? 2 : 0)]));
    const brake = (base) => (braking ? base + 250 + r() * 120 : base + r() * 60);
    return {
      speed: Math.round(kmh), rpm: round(rpm, 1), gear, throttle: braking ? 0 : corner < 150 ? 55 : 100, brake: braking ? 100 : 0,
      engine: Math.round(118 + (braking ? 0 : 18) + c.wear * 6), water: c.v > 70 ? 3 : 2, coolant: Math.round(92 + c.v / 9), fuel: Math.round(c.fuel),
      boost: round(c.v < 60 ? 6 + c.v / 12 : 14 + r() * 4, 0), drs: this.inZone(c.dist) && this.kind !== 'practice' ? 1 : 0,
      tyres: Object.fromEntries(Object.entries(tyres).map(([k, v]) => [k, Math.round(v)])),
      psi: { FL: round(21 + (tyres.FL - 88) / 12, 1), FR: round(21 + (tyres.FR - 88) / 12, 1), RL: round(19.5 + (tyres.RL - 88) / 12, 1), RR: round(19.5 + (tyres.RR - 88) / 12, 1) },
      life: Math.max(0, Math.round(100 * (1 - c.wear))),
      brakes: { FL: Math.round(brake(520)), FR: Math.round(brake(500)), RL: Math.round(brake(450)), RR: Math.round(brake(470)) },
    };
  }
  inZone(f) { const u = ((f % 1) + 1) % 1; return this.C.zones.some((z) => (z.from <= z.to ? u >= z.from && u <= z.to : u >= z.from || u <= z.to)); }
}

// ------------------------------------------------------------------ the workbook: tables the session writes, and the dashboard
const DATA = 'Data', DASH = 'Pitwall';
// the live key/value table the dashboard reads (column B = key, C = value, from row 3)
const KV = ['Session', 'Flag', 'Lap', 'Laps', 'LapText', 'Position', 'CurrentLap', 'Delta', 'BestLap', 'TopSpeed', 'Speed', 'RPM', 'Gear', 'Throttle', 'Brake', 'EngineTemp', 'WaterPressure', 'Coolant', 'Fuel', 'Boost', 'DRS', 'HeartRate', 'HRHigh', 'HRLow', 'Breaths', 'BRHigh', 'BRLow', 'Stress', 'STHigh', 'STLow', 'AirTemp', 'Sky', 'Driver', 'Number', 'Color', 'TimeLeft'];
const kvCell = (k) => { const i = KV.indexOf(k); if (i < 0) throw new Error('no key ' + k); return `C${3 + i}`; };
/** Ops that create the data tables and the Pitwall dashboard (run once per workbook). */
export function setupOps(S) {
  const C = S.C, ops = [];
  ops.push({ op: 'renameSheet', sheet: 'Sheet1', name: DASH });
  ops.push({ op: 'addSheet', name: DATA });
  const put = (at, rows, name) => {
    ops.push({ op: 'set', sheet: DATA, range: at, values: rows });
    const c = nameToCol(at.match(/[A-Z]+/)[0]), r = +at.match(/\d+/)[0];
    ops.push({ op: 'table', sheet: DATA, name, range: `${at}:${colToName(c + rows[0].length - 1)}${r + Math.max(1, rows.length - 1)}` });
  };
  put('B2', [['Key', 'Value'], ...KV.map((k) => [k, ''])], 'Live');
  put('E2', [['Corner', 'Temp', 'Pressure', 'Life', 'Brake'], ['FL', 90, 21, 100, 500], ['FR', 90, 21, 100, 500], ['RL', 88, 19.5, 100, 450], ['RR', 88, 19.5, 100, 450]], 'Tyres');
  // one row the car visual reads: four tyre temps, four brake temps, livery (formulas, so it follows the tables)
  // the inputs of the car and driver visuals, as columns of formulas (so they follow the tables)
  ops.push({ op: 'set', sheet: DATA, range: 'E9', values: [['Car'], ...['=F3', '=F4', '=F5', '=F6', '=I3', '=I4', '=I5', '=I6', '=' + kvCell('Color')].map((f) => [f])] });
  ops.push({ op: 'set', sheet: DATA, range: 'G9', values: [['Driver'], ['=' + kvCell('Number')], ['=' + kvCell('Color')]] });
  put('K2', [['Pos', 'Code', 'Driver', 'No', 'Team', 'Color', 'Lap', 'Dist', 'Gap', 'Last', 'Best', 'Tyre', 'Status'], ...S.cars.map((c, i) => [i + 1, c.code, c.name, c.no, c.team, c.color, 0, 0, '', '', '', c.tyre, ''])], 'Cars');
  put('Y2', [['X', 'Y'], ...C.pts], 'Circuit');
  put('AB2', [['Turn', 'At'], ...C.turns.map((t) => [t.label, t.at])], 'Turns');
  put('AE2', [['Name', 'From', 'To'], ...C.zones.map((z) => [z.name, z.from, z.to])], 'Zones');
  put('AI2', [['Mark', 'At'], ['Speed Trap', 0.03], ['DRS Detection Zone 1', +((C.zones[0].from - 0.03 + 1) % 1).toFixed(3)], ['DRS Detection Zone 2', +((C.zones[1].from - 0.03 + 1) % 1).toFixed(3)]], 'Callouts');
  put('AL2', [['Code', 'Dist', 'Speed', 'Color'], [S.focus, 0, '', S.car().color]], 'Focus');
  // rolling traces: append-only tables; the charts show their newest rows (last: N)
  put('AQ2', [['Time', 'Speed']], 'SpeedTrace');
  put('AT2', [['Time', 'BPM']], 'HeartTrace');
  put('AW2', [['Time', 'Breaths']], 'BreathTrace');
  put('AZ2', [['Time', 'Stress']], 'StressTrace');
  put('BC2', [['Lap', 'Time', 'Delta']], 'LapTimes');
  put('BG2', [['Time', 'Temp', 'Rain', 'Sky'], ['+1 h', 23, '20%', 'partly'], ['+2 h', 22, '20%', 'cloudy'], ['+3 h', 21, '40%', 'rain']], 'Forecast');
  // ---- the dashboard (Pitwall): every card anchored at A1 with pixel offsets — a 1600 × 880 composition
  const D = (o) => ops.push({ op: 'addChart', sheet: DASH, at: 'A1', ...o });
  const KVc = (k) => `${DATA}!${kvCell(k)}`;
  D({ id: 'drv', type: 'viz', pack: 'driver', value: `${DATA}!G10:G11`, label: '=' + KVc('Driver'), dx: 0, dy: 0, w: 250, h: 150 });
  for (const [i, [id, k, hi, lo, tr, pack, unit, lim]] of [
    ['hr', 'HeartRate', 'HRHigh', 'HRLow', 'HeartTrace', 'vital', 'BPM', [40, 200]], ['br', 'Breaths', 'BRHigh', 'BRLow', 'BreathTrace', 'vital', 'per min', [0, 60]], ['st', 'Stress', 'STHigh', 'STLow', 'StressTrace', 'dots', '', [0, 100]],
  ].entries()) {
    const y = 160 + i * 190;
    D({ id: id + 'Chart', type: 'area', table: tr, x: 'Time', axes: 'none', last: 40, title: { hr: 'Heart rate', br: 'Breaths per min', st: 'Stress level' }[id], colors: ['#2f7cf6', '#1d4ed8'], dx: 0, dy: y, w: 156, h: 180 });
    D({ id: id + 'Now', type: 'viz', pack, value: KVc(k), label: unit, min: lim[0], max: lim[1], dx: 160, dy: y, w: 90, h: 112 });
    D({ id: id + 'Hi', type: 'kpi', value: KVc(hi), value2: KVc(lo), title: 'High', label2: 'Low', dx: 160, dy: y + 116, w: 90, h: 64 });
  }
  D({ id: 'flag', type: 'viz', pack: 'race-flag', value: KVc('Flag'), label: '=' + KVc('Session'), title: 'Track', dx: 0, dy: 730, w: 250, h: 150 });
  // around the car
  const col1 = 262, car = 430, col2 = 768;
  D({ id: 'tFL', type: 'viz', pack: 'tyre-panel', value: `${DATA}!F3:H3`, label: 'FL tire', dx: col1, dy: 0, w: 160, h: 190 });
  D({ id: 'bFL', type: 'viz', pack: 'brake', value: `${DATA}!I3`, title: 'FL brakes', label: 'Temp', dx: col1, dy: 198, w: 160, h: 104 });
  D({ id: 'eng', type: 'viz', pack: 'arc', value: KVc('EngineTemp'), label: 'Engine temp (°C)', min: 60, max: 150, dx: col1, dy: 310, w: 160, h: 160 });
  D({ id: 'wat', type: 'viz', pack: 'pills', value: KVc('WaterPressure'), label: 'Water pressure (bar)', min: 0, max: 6, dx: col1, dy: 478, w: 160, h: 64 });
  D({ id: 'coo', type: 'viz', pack: 'bar', value: KVc('Coolant'), label: 'Coolant temp (°C)', min: 60, max: 130, dx: col1, dy: 548, w: 160, h: 64 });
  D({ id: 'fue', type: 'viz', pack: 'bar', value: KVc('Fuel'), label: 'Fuel (%)', min: 0, max: 100, dx: col1, dy: 618, w: 160, h: 64 });
  D({ id: 'tRL', type: 'viz', pack: 'tyre-panel', value: `${DATA}!F5:H5`, label: 'RL tire', dx: col1, dy: 690, w: 160, h: 190 });
  D({ id: 'car', type: 'viz', pack: 'car', value: `${DATA}!E10:E18`, label: '=' + KVc('Number'), dx: car, dy: 0, w: 330, h: 700 });
  D({ id: 'bRL', type: 'viz', pack: 'brake', value: `${DATA}!I5`, title: 'RL brakes', label: 'Temp', dx: car, dy: 710, w: 160, h: 170 });
  D({ id: 'bRR', type: 'viz', pack: 'brake', value: `${DATA}!I6`, title: 'RR brakes', label: 'Temp', dx: car + 170, dy: 710, w: 160, h: 170 });
  D({ id: 'tFR', type: 'viz', pack: 'tyre-panel', value: `${DATA}!F4:H4`, label: 'FR tire', dx: col2, dy: 0, w: 160, h: 190 });
  D({ id: 'bFR', type: 'viz', pack: 'brake', value: `${DATA}!I4`, title: 'FR brakes', label: 'Temp', dx: col2, dy: 198, w: 160, h: 104 });
  D({ id: 'rpm', type: 'viz', pack: 'dial', value: KVc('RPM'), label: 'x1000 (rpm)', min: 0, max: 15, dx: col2, dy: 310, w: 160, h: 180 });
  D({ id: 'bst', type: 'viz', pack: 'segments', value: KVc('Boost'), label: 'Boost (psi)', min: 0, max: 20, dx: col2, dy: 498, w: 160, h: 176 });
  D({ id: 'tRR', type: 'viz', pack: 'tyre-panel', value: `${DATA}!F6:H6`, label: 'RR tire', dx: col2, dy: 690, w: 160, h: 190 });
  // the circuit, the lap, the traces
  const R = 940;
  D({ id: 'trk', type: 'track', title: 'Spread Park Circuit', shape: { table: 'Circuit' }, layers: [{ table: 'Cars', at: 'Dist', label: 'Code', color: 'Color' }], zones: { table: 'Zones' }, marks: { table: 'Turns' }, sectors: C.sectors, trail: S.focus, dx: R, dy: 0, w: 500, h: 470 });
  D({ id: 'sky', type: 'viz', pack: 'weather', value: KVc('Sky'), title: 'Now', dx: R + 510, dy: 0, w: 150, h: 150 });
  D({ id: 'air', type: 'kpi', value: KVc('AirTemp'), title: 'Air °C', dx: R + 510, dy: 158, w: 150, h: 100 });
  D({ id: 'pos', type: 'viz', pack: 'position', value: KVc('Position'), title: '', dx: R, dy: 480, w: 100, h: 100 });
  D({ id: 'lap', type: 'kpi', value: KVc('LapText'), title: 'Lap', dx: R + 106, dy: 480, w: 130, h: 100 });
  D({ id: 'cur', type: 'kpi', value: KVc('CurrentLap'), value2: KVc('Delta'), title: 'Current lap', label2: 'Δ', dx: R + 242, dy: 480, w: 180, h: 100 });
  D({ id: 'bst2', type: 'kpi', value: KVc('BestLap'), title: 'Best lap', dx: R + 428, dy: 480, w: 116, h: 100 });
  D({ id: 'top', type: 'kpi', value: KVc('TopSpeed'), title: 'Top km/h', dx: R + 550, dy: 480, w: 110, h: 100 });
  D({ id: 'spd', type: 'area', table: 'SpeedTrace', x: 'Time', axes: 'x', last: 90, title: 'Speed', colors: ['#ff2d55', '#7b2cff'], dx: R, dy: 590, w: 660, h: 150 });
  D({ id: 'dst', type: 'track', layout: 'line', title: '', length: Math.round(C.length), layers: [{ table: 'Focus', at: 'Dist', label: 'Code', value: 'Speed', color: 'Color' }], zones: { table: 'Zones' }, dx: R, dy: 750, w: 660, h: 130 });
  ops.push({ op: 'view', sheet: DASH, theme: 'pitwall', font: 'display' });
  ops.push({ op: 'liveLayout', cards: 'outline', hidden: [] });
  return ops;
}

/** The ops for one tick: everything the dashboard reads, from the session's state. */
export function tickOps(S, doc) {
  const sh = doc.sheets.find((s) => s.name === DATA);
  const cur = (a) => sh?.cells[a]?.v;
  const cells = {};
  const put = (a, v) => { const s = v == null ? '' : typeof v === 'number' ? v : String(v); if (String(cur(a) ?? '') !== String(s)) cells[a] = s; };
  const tm = S.telemetry(), c = S.car(), order = S.order(), pos = order.indexOf(c) + 1;
  const kv = { Session: S.title, Flag: S.flag, Lap: Math.max(1, Math.min(S.laps, c.lap + 1)), Laps: S.kind === 'race' ? S.laps : '', LapText: S.kind === 'race' ? `${Math.max(1, Math.min(S.laps, c.lap + 1))}/${S.laps}` : `${c.lap}`, Position: pos,
    CurrentLap: fmtLap(S.t - c.lapStart), Delta: c.best && c.last ? `${c.last - c.best >= 0 ? '+' : '−'}${Math.abs(c.last - c.best).toFixed(3)}` : '', BestLap: fmtLap(c.best), TopSpeed: Math.round(c.top * 3.6),
    Speed: tm.speed, RPM: tm.rpm, Gear: tm.gear, Throttle: tm.throttle, Brake: tm.brake, EngineTemp: tm.engine, WaterPressure: tm.water, Coolant: tm.coolant, Fuel: tm.fuel, Boost: tm.boost, DRS: tm.drs,
    HeartRate: Math.round(S.vitals.hr), Breaths: Math.round(S.vitals.br), Stress: Math.round(S.vitals.stress), AirTemp: S.weather.temp, Sky: S.weather.sky, Driver: c.name, Number: c.no, Color: c.color,
    TimeLeft: S.timeLeft == null ? '' : `${Math.floor(S.timeLeft / 60)}:${String(Math.floor(S.timeLeft % 60)).padStart(2, '0')}` };
  // rolling traces and their highs / lows
  const tr = S.traces, stamp = clock(S.wall);
  const push = (k, v, n) => { tr[k].push([stamp, v]); if (tr[k].length > n) tr[k].shift(); };
  push('speed', tm.speed, 60); push('hr', kv.HeartRate, 40); push('br', kv.Breaths, 40); push('stress', kv.Stress, 40);
  const hl = (k) => [Math.max(...tr[k].map((x) => x[1])), Math.min(...tr[k].map((x) => x[1]))];
  [kv.HRHigh, kv.HRLow] = hl('hr'); [kv.BRHigh, kv.BRLow] = hl('br'); [kv.STHigh, kv.STLow] = hl('stress');
  KV.forEach((k) => put(kvCell(k), kv[k]));
  ['FL', 'FR', 'RL', 'RR'].forEach((k, i) => { put(`F${3 + i}`, tm.tyres[k]); put(`G${3 + i}`, tm.psi[k]); put(`H${3 + i}`, tm.life); put(`I${3 + i}`, tm.brakes[k]); });
  // the field
  const gapRef = order[0];
  S.cars.forEach((x, i) => {
    const r = 3 + i, p = order.indexOf(x) + 1;
    const gap = S.kind === 'race' ? (x === gapRef ? 'Leader' : `+${((gapRef.dist - x.dist) * S.C.lapTime).toFixed(1)}`) : x.best && order[0].best ? (x === order[0] ? 'Fastest' : `+${(x.best - order[0].best).toFixed(3)}`) : '';
    put(`K${r}`, p); put(`Q${r}`, Math.max(0, x.lap)); put(`R${r}`, +x.dist.toFixed(4)); put(`S${r}`, gap); put(`T${r}`, fmtLap(x.last)); put(`U${r}`, fmtLap(x.best)); put(`V${r}`, x.tyre);
    put(`W${r}`, x.finished ? 'finished' : x.inPit > 0 ? 'pit' : S.kind !== 'race' && S.t < x.out ? 'garage' : 'running');
  });
  put('AL3', c.code); put('AM3', +c.dist.toFixed(4)); put('AN3', `${tm.speed} km/h`); put('AO3', c.color);
  const ops = [];
  if (Object.keys(cells).length) ops.push({ op: 'set', sheet: DATA, cells });
  for (const [k, table, col] of [['speed', 'SpeedTrace', 'Speed'], ['hr', 'HeartTrace', 'BPM'], ['br', 'BreathTrace', 'Breaths'], ['stress', 'StressTrace', 'Stress']]) {
    const [t, v] = tr[k].at(-1);
    ops.push({ op: 'appendRows', table, rows: [{ Time: t, [col]: v }] });
  }
  // completed laps of the focus car → LapTimes (appended)
  const lt = TYPES.sheet.tables(doc).find((x) => x.t.name === 'LapTimes');
  const have = lt ? lt.R.r2 - lt.R.r1 : 0;
  const rows = S.lapsOfFocus.slice(have).map((l) => ({ Lap: l.lap, Time: fmtLap(l.time), Delta: l.best && l.time - l.best > 0.0005 ? `+${(l.time - l.best).toFixed(3)}` : 'best' }));
  if (rows.length) ops.push({ op: 'appendRows', table: 'LapTimes', rows });
  return ops;
}

// ------------------------------------------------------------------ running it inside the server
export class Sim {
  constructor(store) { this.store = store; this.S = null; this.timer = null; this.doc = null; this.tickMs = 1000; }
  status() {
    const S = this.S;
    if (!S) return { running: false };
    const c = S.car(), o = S.order();
    return { running: !!this.timer, doc: this.doc, seed: S.seed, session: S.kind, flag: S.flag, t: Math.round(S.t), speed: S.speed, laps: S.laps, focus: S.focus, leader: o[0].code, lap: Math.min(c.lap, S.kind === 'race' ? S.laps : c.lap), position: o.indexOf(c) + 1, done: S.done, timeLeft: S.timeLeft };
  }
  /** start: { session, laps, minutes, speed, focus, seed, doc, cars } */
  start(o = {}) {
    this.stop(true);
    const docId = String(o.doc || 'race').replace(/[^\w-]/g, '') || 'race';
    const S = new Session({ session: o.session || 'race', laps: Math.max(1, Math.min(80, +o.laps || 20)), minutes: Math.max(1, Math.min(120, +o.minutes || 15)), speed: Math.max(0.25, Math.min(20, +o.speed || 1)), focus: o.focus || 'HAM', seed: +o.seed || (Date.now() % 1e6) + 1, cars: +o.cars || 22 });
    const st = this.store;
    if (!st.state.docs[docId]) st.createDoc({ type: 'sheet', id: docId, title: 'Race weekend', by: 'sim' });
    const doc = st.doc(docId);
    if (!doc.sheets.some((s) => s.name === DATA)) st.batch({ doc: docId, by: 'sim', who: 'Simulator', label: 'pitwall setup', ops: setupOps(S) });
    else st.batch({ doc: docId, by: 'sim', who: 'Simulator', label: 'new session', ops: resetOps(S, doc) });
    this.S = S; this.doc = docId;
    this.mark = st.commit({ message: `${S.title} start${S.kind === 'race' ? ` (${S.laps} laps)` : ''}`, by: 'sim' });
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    return this.status();
  }
  tick() {
    const S = this.S;
    if (!S) return;
    if (!S.done) S.step(this.tickMs / 1000 * S.speed);
    const doc = this.store.state.docs[this.doc];
    if (!doc) return this.stop(true);
    const ops = tickOps(S, doc);
    if (ops.length) this.store.batch({ doc: this.doc, by: 'sim', who: 'Simulator', ops });
    if (S.done) { this.store.commit({ message: `${S.title} end — ${S.order()[0].name} ${S.kind === 'race' ? 'wins' : 'fastest'}`, by: 'sim' }); this.stop(true); }
  }
  stop(quiet) { clearInterval(this.timer); this.timer = null; if (!quiet && this.S && !this.S.done) this.store.commit({ message: `${this.S.title} stopped`, by: 'sim' }); }
  setFocus(code) {
    if (!this.S) throw Object.assign(new Error('no session — start one first'), { status: 409 });
    const c = this.S.cars.find((x) => x.code.toLowerCase() === String(code).toLowerCase());
    if (!c) throw Object.assign(new Error(`no car "${code}" (${this.S.cars.map((x) => x.code).join(' ')})`), { status: 404 });
    this.S.focus = c.code;
    this.S.traces = { speed: [], hr: [], br: [], stress: [] };
    const doc = this.store.doc(this.doc);
    const ops = [{ op: 'updateChart', id: 'trk', trail: c.code }, { op: 'updateChart', id: 'car', label: String(c.no) }];
    const lt = TYPES.sheet.tables(doc).find((x) => x.t.name === 'LapTimes');
    if (lt && lt.R.r2 > lt.R.r1) ops.push({ op: 'removeRows', table: 'LapTimes', rows: Array.from({ length: lt.R.r2 - lt.R.r1 }, (_, i) => i + 1) });
    this.S.lapsOfFocus = [];
    try { this.store.batch({ doc: this.doc, by: 'sim', who: 'Simulator', label: `focus ${c.code}`, ops: ops.filter((o) => o.op !== 'updateChart' || TYPES.sheet.allCharts(doc).some((x) => x.ch.id === o.id)) }); } catch {}
    return this.status();
  }
}

/** A new session on an existing workbook: the field back on the grid, laps cleared. */
function resetOps(S, doc) {
  const ops = [];
  for (const name of ['LapTimes', 'SpeedTrace', 'HeartTrace', 'BreathTrace', 'StressTrace']) {
    const t = TYPES.sheet.tables(doc).find((x) => x.t.name === name);
    if (t && t.R.r2 > t.R.r1) ops.push({ op: 'removeRows', table: name, rows: Array.from({ length: t.R.r2 - t.R.r1 }, (_, i) => i + 1) });
  }
  const cars = TYPES.sheet.tables(doc).find((x) => x.t.name === 'Cars');
  if (cars) {
    const cells = {};
    S.cars.forEach((c, i) => { const r = 3 + i; Object.assign(cells, { [`L${r}`]: c.code, [`M${r}`]: c.name, [`N${r}`]: c.no, [`O${r}`]: c.team, [`P${r}`]: c.color, [`R${r}`]: c.dist, [`Q${r}`]: 0, [`S${r}`]: '', [`T${r}`]: '', [`U${r}`]: '', [`V${r}`]: c.tyre }); });
    ops.push({ op: 'set', sheet: DATA, cells });
  }
  if (TYPES.sheet.allCharts(doc).some((x) => x.ch.id === 'trk')) ops.push({ op: 'updateChart', id: 'trk', trail: S.focus });
  if (TYPES.sheet.allCharts(doc).some((x) => x.ch.id === 'car')) ops.push({ op: 'updateChart', id: 'car', label: String(S.car().no) });
  return ops.length ? ops : [{ op: 'set', sheet: DATA, cells: { C3: S.title } }];
}
