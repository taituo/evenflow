// Native canvas chart renderer: column, bar, line, area, pie, kpi. No libraries.
import { isErr } from '../../shared/formula.js';
import { vizImage, getPack } from './viz-dom.js';
import { fitMercator } from '../../shared/types/sheet.js';
import { buildTrack } from '../../shared/track.js';

let redraw = () => {};
/** The grid calls this so SVG visuals can repaint once their image has loaded. */
export const setRedraw = (fn) => { redraw = fn; };

export const THEMES = {
  light: { series: ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#12b5cb', '#f9ab00', '#e52592', '#5f6368'], ink: '#3c4043', muted: '#80868b', grid: '#e8eaed', axis: '#bdc1c6', bg: '#fff', border: '#dadce0', slice: '#fff', title: true, value: '#202124' },
  glassDark: { series: ['rgba(16,16,40,.92)', 'rgba(16,16,40,.6)', 'rgba(16,16,40,.4)', 'rgba(16,16,40,.25)', 'rgba(16,16,40,.78)', 'rgba(16,16,40,.5)', 'rgba(16,16,40,.32)'], ink: 'rgba(16,16,40,.92)', muted: 'rgba(16,16,40,.62)', grid: 'rgba(16,16,40,.14)', axis: 'rgba(16,16,40,.35)', bg: null, border: null, slice: null, title: false, value: '#101028' },
  glass: { series: ['rgba(255,255,255,.96)', 'rgba(255,255,255,.62)', 'rgba(255,255,255,.38)', 'rgba(255,255,255,.22)', 'rgba(255,255,255,.80)', 'rgba(255,255,255,.50)', 'rgba(255,255,255,.30)'], ink: 'rgba(255,255,255,.95)', muted: 'rgba(255,255,255,.66)', grid: 'rgba(255,255,255,.14)', axis: 'rgba(255,255,255,.35)', bg: null, border: null, slice: null, title: false, value: '#fff', font: '"SF Pro Display", "Inter", system-ui, sans-serif' },
};
export const SERIES = THEMES.light.series;
let T = THEMES.light;
let SER = T.series, INK = T.ink, MUTED = T.muted, GRID = T.grid;

function nice(min, max, count = 5) {
  if (min === max) { max = min + 1; min = Math.min(0, min); }
  const span = max - min;
  const raw = span / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
}
const fmtN = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return +(v / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return +(v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return +(v / 1e3).toFixed(1) + 'k';
  return String(+v.toFixed(2));
};
function ellipsize(g, t, w) {
  if (g.measureText(t).width <= w) return t;
  while (t.length > 1 && g.measureText(t + '…').width > w) t = t.slice(0, -1);
  return t + '…';
}

/** r = {x,y,w,h} in CSS px; z = zoom */
export function drawChart(g, r, ch, data, z, selected, theme = 'light') {
  T = THEMES[theme] || THEMES.light;
  SER = T.series; INK = T.ink; MUTED = T.muted; GRID = T.grid;
  const f = (n) => Math.max(8, n * z);
  g.save();
  g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
  if (T.bg) { g.fillStyle = T.bg; g.fillRect(r.x, r.y, r.w, r.h); }
  const pad = 12 * z;
  let top = r.y + pad;
  if (T.title && ch.title && ch.type !== 'kpi') {
    g.fillStyle = INK; g.font = `600 ${f(14)}px system-ui, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(ellipsize(g, ch.title, r.w - 2 * pad), r.x + pad, top);
    top += f(14) + 8 * z;
  }
  const area = { x: r.x + pad, y: top, w: r.w - 2 * pad, h: r.y + r.h - pad - top };
  try {
    if (data.map) mapSketch(g, area, data.map, z, f);
    else if (data.track) trackSketch(g, area, data.track, z, f);
    else if (data.viz) viz(g, area, data.viz, f);
    else if (data.kpi) kpi(g, r, ch, data.kpi, z, f, data.kpi2);
    else if (!data.series.length || !data.labels.length) empty(g, area, f);
    else if (ch.type === 'pie') pie(g, area, data, z, f);
    else axisChart(g, area, ch, data, z, f);
  } catch (e) { empty(g, area, f, 'chart error'); }
  g.restore();
  if (!T.border && !selected) return;
  g.strokeStyle = selected ? '#1a73e8' : T.border;
  g.lineWidth = selected ? 2 : 1;
  g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  if (selected) { g.fillStyle = '#1a73e8'; g.fillRect(r.x + r.w - 7, r.y + r.h - 7, 8, 8); }
}

/** The grid's picture of a map: points (and routes) projected to fit, on a plain chart — Live shows the real map. */
function mapSketch(g, a, m, z, f) {
  const layers = m.layers.filter((L) => !L.hidden);
  const pts = layers.flatMap((L) => L.points);
  g.fillStyle = T.bg ? '#eef3f8' : 'rgba(255,255,255,.06)';
  g.beginPath(); g.roundRect?.(a.x, a.y, a.w, a.h, 6 * z); g.fill();
  g.strokeStyle = T.bg ? '#dde5ee' : 'rgba(255,255,255,.08)'; g.lineWidth = 1;
  for (let i = 1; i < 6; i++) { const x = a.x + (a.w * i) / 6, y = a.y + (a.h * i) / 6; g.beginPath(); g.moveTo(x, a.y); g.lineTo(x, a.y + a.h); g.moveTo(a.x, y); g.lineTo(a.x + a.w, y); g.stroke(); }
  const err = m.layers.find((L) => L.error);
  if (!pts.length) return empty(g, a, f, err ? err.error.slice(0, 80) : 'no points (lat/lon)');
  const { project } = fitMercator(pts, a.w, a.h, 22 * z);
  const P = (p) => { const [x, y] = project(p.lat, p.lon); return [a.x + x, a.y + y]; };
  for (const L of layers) {
    if (!L.route || L.points.length < 2) continue;
    g.strokeStyle = L.points[0].color; g.globalAlpha = 0.7; g.lineWidth = 2.5 * z; g.setLineDash([6 * z, 4 * z]);
    g.beginPath(); L.points.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
  }
  g.font = `600 ${f(11)}px system-ui`; g.textBaseline = 'middle'; g.textAlign = 'left';
  for (const p of pts) {
    const [x, y] = P(p);
    g.fillStyle = p.color; g.strokeStyle = T.bg ? '#fff' : 'rgba(0,0,0,.5)'; g.lineWidth = 2 * z;
    g.beginPath(); g.arc(x, y, 6 * z, 0, Math.PI * 2); g.fill(); g.stroke();
    if (pts.length <= 40 && p.label) { g.fillStyle = INK; g.fillText(ellipsize(g, p.label, 120 * z), x + 9 * z, y); }
  }
  g.fillStyle = MUTED; g.font = `${f(10)}px system-ui`; g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillText(`${pts.length} point${pts.length === 1 ? '' : 's'} · the full map is in ▶ Live`, a.x + a.w - 6 * z, a.y + a.h - 4 * z);
}

/** The grid's picture of a track card: the line, zones, and the moving points where they are now. */
const SECT = ['#ff2d55', '#ffa21a', '#ff2bd6', '#3ddc97', '#4ea1ff', '#c084fc'];
const trackCache = new Map();
function trackSketch(g, a, t, z, f) {
  const fr = (d) => ((d % 1) + 1) % 1;
  const items = t.layers.filter((L) => !L.hidden).flatMap((L) => L.items);
  if (t.layout === 'line') {
    const y = a.y + a.h / 2, X = (d) => a.x + 10 * z + fr(d) * (a.w - 20 * z);
    g.strokeStyle = GRID; g.lineWidth = 1; g.beginPath(); g.moveTo(a.x, y); g.lineTo(a.x + a.w, y); g.stroke();
    for (const zo of t.zones) { g.fillStyle = zo.color || '#16a34a'; g.globalAlpha = 0.5; g.fillRect(X(zo.from), a.y, Math.max(4 * z, X(zo.to) - X(zo.from)), a.h); g.globalAlpha = 1; }
    for (const it of items) { g.fillStyle = it.color; g.beginPath(); g.arc(X(it.dist), y, 5 * z, 0, 7); g.fill(); }
    return;
  }
  const key = JSON.stringify([t.points, t.open]);
  let T = trackCache.get(key);
  if (T === undefined) { T = t.points?.length > 2 ? buildTrack(t.points, { closed: !t.open }) : null; if (trackCache.size > 20) trackCache.clear(); trackCache.set(key, T); }
  if (!T) return empty(g, a, f, t.errors[0]?.slice(0, 80) || 'no track shape (X, Y points)');
  const b = T.box, k = Math.min((a.w - 30 * z) / (b.x2 - b.x1 || 1), (a.h - 30 * z) / (b.y2 - b.y1 || 1));
  const ox = a.x + (a.w - (b.x2 - b.x1) * k) / 2, oy = a.y + (a.h - (b.y2 - b.y1) * k) / 2;
  const P = (x, y) => [ox + (x - b.x1) * k, oy + (y - b.y1) * k];
  const line = (f0, f1) => { g.beginPath(); const n = Math.max(2, Math.ceil((f1 - f0) * 300)); for (let i = 0; i <= n; i++) { const p = T.at(f0 + ((f1 - f0) * i) / n); const [x, y] = P(p.x, p.y); i ? g.lineTo(x, y) : g.moveTo(x, y); } };
  g.lineJoin = g.lineCap = 'round';
  g.strokeStyle = T.closed && T_BG() ? '#d5dae2' : '#2a2b33'; g.lineWidth = 9 * z; line(0, 1); g.stroke();
  for (const zo of t.zones) { g.strokeStyle = zo.color || '#22c55e'; g.globalAlpha = 0.6; g.lineWidth = 7 * z; line(fr(zo.from), fr(zo.to) < fr(zo.from) ? fr(zo.to) + 1 : fr(zo.to)); g.stroke(); g.globalAlpha = 1; }
  const cuts = [0, ...(t.sectors || []), 1];
  for (let i = 0; i + 1 < cuts.length; i++) { g.strokeStyle = t.sectors ? SECT[i % SECT.length] : '#ff9f1a'; g.lineWidth = 2.2 * z; line(cuts[i], cuts[i + 1]); g.stroke(); }
  g.font = `700 ${f(8)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const it of items) {
    const p = T.at(it.dist), [x, y] = P(p.x, p.y);
    g.fillStyle = it.color; g.strokeStyle = '#fff'; g.lineWidth = 1.2 * z;
    g.beginPath(); g.arc(x, y, 7 * z, 0, 7); g.fill(); g.stroke();
    if (items.length <= 30) { g.fillStyle = '#fff'; g.fillText(it.label.slice(0, 3), x, y + 0.5); }
  }
}
const T_BG = () => !!T.bg;

function empty(g, a, f, msg = 'no numeric data') {
  g.fillStyle = MUTED; g.font = `${f(12)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(msg, a.x + a.w / 2, a.y + a.h / 2);
}

function kpi(g, r, ch, k, z, f, k2) {
  if (k2) {
    // two figures side by side; the second one smaller, with its own caption
    const w1 = r.w * 0.58;
    kpi(g, { ...r, w: w1 }, ch, k, z, f);
    const v2 = k2.value, t2 = typeof v2 === 'number' ? v2.toLocaleString(undefined, { maximumFractionDigits: 2 }) : k2.text || '—';
    let size = Math.min(r.h * 0.32, 40 * z);
    g.font = `500 ${size}px system-ui, sans-serif`;
    while (size > 9 && g.measureText(t2).width > r.w - w1 - 18 * z) { size -= 2; g.font = `500 ${size}px system-ui, sans-serif`; }
    g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.fillStyle = isErr(v2) ? '#d93025' : T.value;
    g.fillText(t2, r.x + r.w - 14 * z, r.y + r.h - 16 * z);
    if (k2.label) { g.fillStyle = MUTED; g.font = `500 ${f(11)}px system-ui, sans-serif`; g.fillText(ellipsize(g, k2.label, r.w - w1 - 18 * z), r.x + r.w - 14 * z, r.y + r.h - 16 * z - size - 4 * z); }
    g.textAlign = 'left';
    return;
  }
  const label = ch.title || k.label;
  g.textAlign = 'left';
  g.fillStyle = MUTED; g.font = `500 ${f(13)}px system-ui, sans-serif`; g.textBaseline = 'top';
  if (label) g.fillText(ellipsize(g, label, r.w - 24 * z), r.x + 14 * z, r.y + 12 * z);
  const v = k.value;
  const text = typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : k.text || '—';
  let size = Math.min(r.h * 0.5, 64 * z);
  g.font = `600 ${size}px system-ui, sans-serif`;
  while (size > 10 && g.measureText(text).width > r.w - 28 * z) { size -= 2; g.font = `600 ${size}px system-ui, sans-serif`; }
  g.fillStyle = isErr(v) ? '#d93025' : T.value; g.textBaseline = 'alphabetic';
  g.fillText(text, r.x + 14 * z, r.y + r.h - 16 * z);
}

function viz(g, a, d, f) {
  if (!getPack(d.pack)) { empty(g, a, f, `no pack “${d.pack}”`); return; }
  const dpr = globalThis.devicePixelRatio || 1;
  const s = Math.min(a.w, a.h);
  const img = vizImage(d.pack, d.value, d.label, s * dpr, s * dpr, redraw, d);
  if (img) g.drawImage(img, a.x + (a.w - s) / 2, a.y + (a.h - s) / 2, s, s);
}

function legend(g, a, series, z, f) {
  if (series.length < 2) return 0;
  g.font = `${f(11)}px system-ui`; g.textBaseline = 'middle'; g.textAlign = 'left';
  let x = a.x, y = a.y + a.h - f(11) / 2;
  for (const [i, s] of series.entries()) {
    const w = g.measureText(s.name).width + 22 * z;
    if (x + w > a.x + a.w && x > a.x) { x = a.x; y -= f(11) + 6 * z; }
    g.fillStyle = SER[i % SER.length]; g.fillRect(x, y - 4 * z, 10 * z, 8 * z);
    g.fillStyle = INK; g.fillText(s.name, x + 14 * z, y);
    x += w;
  }
  return a.y + a.h - y + f(11);
}

function axisChart(g, a, ch, data, z, f) {
  const horiz = ch.type === 'bar';
  const lg = legend(g, a, data.series, z, f);
  const plot = { ...a, h: a.h - (lg ? lg + 6 * z : 0) };
  const vals = data.series.flatMap((s) => s.values).filter((v) => v !== null);
  if (!vals.length) return empty(g, a, f);
  // a trace (gradient line/area) or an explicit min/max scales to its data, not from zero
  const traceLike = (ch.type === 'line' || ch.type === 'area') && Array.isArray(ch.colors) && ch.colors.length >= 2 && ch.axes && ch.axes !== 'all';
  const lo0 = typeof ch.min === 'number' ? ch.min : traceLike ? Math.min(...vals) : Math.min(0, ...vals);
  const hi0 = typeof ch.max === 'number' ? ch.max : traceLike ? Math.max(...vals) : Math.max(0, ...vals);
  const sc = traceLike && typeof ch.min !== 'number' ? (() => { const pad = (hi0 - lo0) * 0.12 || 1; return { lo: lo0 - pad, hi: hi0 + pad, step: (hi0 - lo0 + 2 * pad) / 4 }; })() : nice(lo0, hi0);
  g.font = `${f(11)}px system-ui`;
  const tickW = Math.max(...[sc.lo, sc.hi].map((v) => g.measureText(fmtN(v)).width)) + 8 * z;
  const labelH = f(11) + 8 * z;
  const n = data.labels.length;
  const maxLabelW = Math.max(...data.labels.map((l) => g.measureText(l).width));
  const catW = horiz ? Math.min(maxLabelW + 8 * z, plot.w * 0.35) : 0;
  const P = horiz
    ? { x: plot.x + catW, y: plot.y, w: plot.w - catW, h: plot.h - labelH }
    : { x: plot.x + tickW, y: plot.y + 4 * z, w: plot.w - tickW, h: plot.h - labelH - 4 * z };
  const pos = (v) => (horiz ? P.x + ((v - sc.lo) / (sc.hi - sc.lo)) * P.w : P.y + P.h - ((v - sc.lo) / (sc.hi - sc.lo)) * P.h);
  // grid + ticks
  const ax = ch.axes || 'all', showY = ax === 'all' || ax === 'y', showX = ax === 'all' || ax === 'x';
  if (!showY) { P.w += P.x - plot.x; P.x = plot.x; }
  if (!showX) P.h += labelH;
  g.strokeStyle = GRID; g.lineWidth = 1; g.fillStyle = MUTED;
  for (let v = sc.lo; v <= sc.hi + sc.step / 2 && ax !== 'none'; v += sc.step) {
    const p = Math.round(pos(v)) + 0.5;
    g.beginPath();
    if (horiz) { g.moveTo(p, P.y); g.lineTo(p, P.y + P.h); } else { g.moveTo(P.x, p); g.lineTo(P.x + P.w, p); }
    g.stroke();
    if (!showY) continue;
    if (horiz) { g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(fmtN(v), p, P.y + P.h + 4 * z); }
    else { g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(fmtN(v), P.x - 6 * z, p); }
  }
  const zero = pos(Math.max(sc.lo, Math.min(0, sc.hi)));
  const band = (horiz ? P.h : P.w) / n;
  // category labels (skip to avoid overlap)
  g.fillStyle = MUTED;
  const every = horiz ? Math.max(1, Math.ceil((f(11) + 2) / band)) : Math.max(1, Math.ceil((maxLabelW + 8 * z) / band));
  data.labels.forEach((l, i) => {
    if (i % every || !showX) return;
    const c = (horiz ? P.y : P.x) + band * (i + 0.5);
    if (horiz) { g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(ellipsize(g, l, catW - 6 * z), P.x - 6 * z, c); }
    else { g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(ellipsize(g, l, band * every - 4 * z), c, P.y + P.h + 4 * z); }
  });
  if (ch.type === 'column' || ch.type === 'bar') {
    const k = data.series.length;
    const inner = band * 0.72, bw = inner / k;
    data.series.forEach((s, j) => {
      g.fillStyle = SER[j % SER.length];
      s.values.forEach((v, i) => {
        if (v === null) return;
        const start = (horiz ? P.y : P.x) + band * i + (band - inner) / 2 + bw * j;
        const p = pos(v);
        const rect = horiz ? [Math.min(zero, p), start, Math.abs(p - zero), Math.max(1, bw - 1)] : [start, Math.min(zero, p), Math.max(1, bw - 1), Math.abs(p - zero)];
        if (!T.bg && g.roundRect) { g.beginPath(); g.roundRect(...rect, Math.min(6 * z, rect[2] / 2, rect[3] / 2)); g.fill(); }
        else g.fillRect(...rect);
      });
    });
  } else {
    // colors: ["#ff2d55", "#7b2cff"] → a gradient line over a fading gradient fill (a telemetry trace)
    const grad = Array.isArray(ch.colors) && ch.colors.length >= 2 && ch.colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)) ? ch.colors : null;
    const lineFill = (pts) => {
      const top = Math.min(...pts.filter(Boolean).map((p) => p[1]));
      const lg = g.createLinearGradient(P.x, 0, P.x + P.w, 0);
      grad.forEach((c, i) => lg.addColorStop(i / (grad.length - 1), c));
      const fg = g.createLinearGradient(0, top, 0, zero);
      fg.addColorStop(0, grad[0] + 'cc'); fg.addColorStop(0.55, grad[grad.length - 1] + '66'); fg.addColorStop(1, grad[grad.length - 1] + '00');
      return { lg, fg };
    };
    data.series.forEach((s, j) => {
      const col = SER[j % SER.length];
      const pts = s.values.map((v, i) => (v === null ? null : [P.x + band * (i + 0.5), pos(v)]));
      if (grad && j === 0 && pts.some(Boolean)) {
        const { lg, fg } = lineFill(pts);
        if (ch.type === 'area') {
          g.fillStyle = fg; g.beginPath();
          let started = false, lastX = 0;
          pts.forEach((p) => { if (!p) return; if (!started) { g.moveTo(p[0], zero); started = true; } g.lineTo(p[0], p[1]); lastX = p[0]; });
          g.lineTo(lastX, zero); g.closePath(); g.fill();
        }
        g.strokeStyle = lg; g.lineWidth = Math.max(1.5, 2.2 * z); g.lineJoin = 'round';
        g.shadowColor = grad[0]; g.shadowBlur = 8 * z;
        g.beginPath(); let pen = false;
        for (const p of pts) { if (!p) { pen = false; continue; } if (pen) g.lineTo(...p); else { g.moveTo(...p); pen = true; } }
        g.stroke(); g.shadowBlur = 0;
        return;
      }
      if (ch.type === 'area') {
        g.fillStyle = col + '33';
        g.beginPath();
        let started = false, lastX = 0;
        pts.forEach((p) => { if (!p) return; if (!started) { g.moveTo(p[0], zero); started = true; } g.lineTo(p[0], p[1]); lastX = p[0]; });
        if (started) { g.lineTo(lastX, zero); g.closePath(); g.fill(); }
      }
      g.strokeStyle = col; g.lineWidth = Math.max(1.5, 2 * z); g.lineJoin = 'round';
      g.beginPath();
      let pen = false;
      for (const p of pts) { if (!p) { pen = false; continue; } if (pen) g.lineTo(...p); else { g.moveTo(...p); pen = true; } }
      g.stroke();
      if (band > 10 * z) { g.fillStyle = col; for (const p of pts) if (p) { g.beginPath(); g.arc(p[0], p[1], 2.5 * z, 0, Math.PI * 2); g.fill(); } }
    });
  }
  // axis line
  g.strokeStyle = T.axis; g.lineWidth = 1; g.beginPath();
  if (horiz) { g.moveTo(Math.round(zero) + 0.5, P.y); g.lineTo(Math.round(zero) + 0.5, P.y + P.h); }
  else { g.moveTo(P.x, Math.round(zero) + 0.5); g.lineTo(P.x + P.w, Math.round(zero) + 0.5); }
  g.stroke();
}

function pie(g, a, data, z, f) {
  const s = data.series[0];
  const items = data.labels.map((l, i) => ({ l, v: s.values[i] })).filter((x) => x.v > 0);
  const total = items.reduce((t, x) => t + x.v, 0);
  if (!total) return empty(g, a, f);
  const legendW = Math.min(a.w * 0.42, 160 * z);
  const R = Math.max(10, Math.min((a.w - legendW) / 2, a.h / 2) - 4 * z);
  const cx = a.x + (a.w - legendW) / 2, cy = a.y + a.h / 2;
  let ang = -Math.PI / 2;
  items.forEach((x, i) => {
    const d = (x.v / total) * Math.PI * 2;
    g.fillStyle = SER[i % SER.length];
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, ang, ang + d); g.closePath(); g.fill();
    if (T.slice) { g.strokeStyle = T.slice; g.lineWidth = 1.5; g.stroke(); }
    else { g.save(); g.globalCompositeOperation = 'destination-out'; g.strokeStyle = '#000'; g.lineWidth = 3 * z; g.stroke(); g.restore(); }
    if (d > 0.35) {
      const m = ang + d / 2;
      g.fillStyle = T.bg ? '#fff' : T === THEMES.glassDark ? 'rgba(255,255,255,.9)' : 'rgba(20,20,40,.75)'; g.font = `600 ${f(11)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(Math.round((x.v / total) * 100) + '%', cx + Math.cos(m) * R * 0.62, cy + Math.sin(m) * R * 0.62);
    }
    ang += d;
  });
  g.font = `${f(11)}px system-ui`; g.textAlign = 'left'; g.textBaseline = 'middle';
  const lh = f(11) + 6 * z;
  const lx = a.x + a.w - legendW + 8 * z;
  let ly = cy - (Math.min(items.length, Math.floor(a.h / lh)) * lh) / 2 + lh / 2;
  items.slice(0, Math.floor(a.h / lh)).forEach((x, i) => {
    g.fillStyle = SER[i % SER.length]; g.fillRect(lx, ly - 4 * z, 10 * z, 8 * z);
    g.fillStyle = INK; g.fillText(ellipsize(g, x.l, legendW - 24 * z), lx + 14 * z, ly);
    ly += lh;
  });
}
