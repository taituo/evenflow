// Live track card: a circuit (or any route) drawn from points, things moving along it by distance, zones, marks,
// sectors and a glowing trail behind one of them. Movement is continuous: each point glides from its previous
// distance to the new one over the time between updates, always forwards along the line (laps wrap).
// layout "line" shows the same data as distance along the track: an axis, zones as bands, a marker with a bubble.
import { buildTrack } from '../../shared/track.js';

const NS = 'http://www.w3.org/2000/svg';
const SECTOR = ['#ff2d55', '#ffa21a', '#ff2bd6', '#3ddc97', '#4ea1ff', '#c084fc'];
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const frac = (d) => ((d % 1) + 1) % 1;
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent?.append(e); return e; };

export function mountTrack(host) {
  host.innerHTML = '';
  const svg = el('svg', { class: 'lv-trk', preserveAspectRatio: 'xMidYMid meet' }, host);
  let shapeSig = '', T = null, data = null, g = {}, items = new Map(), raf = 0, dead = false, W = 0, H = 0, lineSig = '';

  function geometry(d) {
    const sig = JSON.stringify([d.points, d.open, d.layout]);
    if (sig === shapeSig && (d.layout === 'line' || T)) return false;
    shapeSig = sig;
    T = d.layout === 'loop' && d.points?.length > 2 ? buildTrack(d.points, { closed: !d.open }) : null;
    return true;
  }
  function frame(d) {
    svg.innerHTML = '';
    items = new Map();
    const defs = el('defs', {}, svg);
    defs.innerHTML = `<filter id="tg" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter><pattern id="chk" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#fff"/><rect width="2" height="2" fill="#111"/><rect x="2" y="2" width="2" height="2" fill="#111"/></pattern>`;
    if (d.layout === 'line') {
      const r = host.getBoundingClientRect();
      W = Math.max(300, r.width); H = Math.max(120, r.height);
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      g = { axis: el('g', { class: 'ax' }, svg), zones: el('g', {}, svg), trail: el('g', {}, svg), items: el('g', {}, svg) };
      return;
    }
    if (!T) return;
    const b = T.box, span = Math.max(b.x2 - b.x1, b.y2 - b.y1), pad = span * 0.16;
    g.vb = { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad };
    svg.setAttribute('viewBox', `${b.x1 - pad} ${b.y1 - pad} ${b.x2 - b.x1 + pad * 2} ${b.y2 - b.y1 + pad * 2}`);
    const u = span / 400;   // one "pixel" at a 400-wide card
    svg.style.setProperty('--u', u);
    g = { u, base: el('g', {}, svg), zones: el('g', {}, svg), line: el('g', {}, svg), trail: el('g', {}, svg), marks: el('g', {}, svg), items: el('g', {}, svg) };
    const full = T.path();
    el('path', { d: full, class: 'trk-edge', 'stroke-width': 30 * u }, g.base);
    // a dotted line along the outside of the track
    const dots = el('g', { class: 'trk-dots' }, g.base), n = Math.round(T.length / (7 * u));
    for (let i = 0; i < n; i++) { const { p, nx, ny } = out(i / n); el('circle', { cx: +(p.x + nx * 15 * u).toFixed(1), cy: +(p.y + ny * 15 * u).toFixed(1), r: 1.1 * u }, dots); }
    el('path', { d: full, class: 'trk-road', 'stroke-width': 16 * u }, g.base);
    // centre line, colored by sector
    const cuts = [0, ...(d.sectors || []), 1];
    for (let i = 0; i + 1 < cuts.length; i++) el('path', { d: T.path(cuts[i], cuts[i + 1]), class: 'trk-line', stroke: d.sectors ? SECTOR[i % SECTOR.length] : '#ff9f1a', 'stroke-width': 3.5 * u }, g.line);
    // start / finish
    const s = T.at(0), nx = -Math.sin(s.a), ny = Math.cos(s.a);
    const fin = el('line', { x1: s.x - nx * 10 * u, y1: s.y - ny * 10 * u, x2: s.x + nx * 10 * u, y2: s.y + ny * 10 * u, stroke: 'url(#chk)', 'stroke-width': 5 * u }, g.base);
    fin.setAttribute('class', 'trk-fin');
  }
  /** outward normal at f (away from the middle of the shape) */
  function out(f) {
    const p = T.at(f), b = T.box, cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    let nx = -Math.sin(p.a), ny = Math.cos(p.a);
    if ((p.x - cx) * nx + (p.y - cy) * ny < 0) { nx = -nx; ny = -ny; }
    return { p, nx, ny };
  }
  function decorations(d) {
    const sig = JSON.stringify([d.zones, d.marks, W, H]);
    if (sig === lineSig) return;
    lineSig = sig;
    g.zones.innerHTML = ''; if (g.marks) g.marks.innerHTML = '';
    if (d.layout === 'line') return lineAxis(d);
    if (!T) return;
    const u = g.u;
    for (const z of d.zones) {
      el('path', { d: T.path(frac(z.from), frac(z.to) < frac(z.from) ? frac(z.to) + 1 : frac(z.to)), class: 'trk-zone', stroke: z.color || '#22c55e', 'stroke-width': 11 * u }, g.zones);
      if (z.label) callout(frac(z.from) + ((frac(z.to) - frac(z.from) + 1) % 1) / 2, z.label, 58);
    }
    for (const m of d.marks) {
      const short = String(m.label).length <= 3;
      if (short) {
        const { p, nx, ny } = out(frac(m.at)), x = p.x + nx * 26 * u, y = p.y + ny * 26 * u;
        el('rect', { x: x - 12 * u, y: y - 10 * u, width: 24 * u, height: 20 * u, rx: 3 * u, class: 'trk-mk' }, g.marks);
        const t = el('text', { x, y: y + 4.5 * u, class: 'trk-mkt', 'font-size': 12 * u }, g.marks); t.textContent = m.label;
      } else callout(frac(m.at), m.label, 46);
    }
  }
  function callout(f, text, dist) {
    const u = g.u, { p, nx, ny } = out(f);
    let x = p.x + nx * dist * u, y = p.y + ny * dist * u;
    const words0 = String(text).length * 3.8 * u + 12 * u;
    if (g.vb) { x = Math.max(g.vb.x1 + words0, Math.min(g.vb.x2 - words0, x)); y = Math.max(g.vb.y1 + 24 * u, Math.min(g.vb.y2 - 24 * u, y)); }
    el('line', { x1: p.x, y1: p.y, x2: x, y2: y, class: 'trk-lead', 'stroke-width': 1.5 * u }, g.marks);
    el('circle', { cx: p.x, cy: p.y, r: 3.5 * u, class: 'trk-dot' }, g.marks);
    const words = String(text).split(/\s+/), lines = [];
    for (const w of words) { if (lines.length && (lines.at(-1) + ' ' + w).length <= 16) lines[lines.length - 1] += ' ' + w; else lines.push(w); }
    const w = Math.max(...lines.map((l) => l.length)) * 7.4 * u + 18 * u, h = lines.length * 15 * u + 10 * u;
    el('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 4 * u, class: 'trk-box' }, g.marks);
    lines.forEach((l, i) => { const t = el('text', { x, y: y - h / 2 + 18 * u + i * 15 * u, class: 'trk-boxt', 'font-size': 12 * u }, g.marks); t.textContent = l; });
  }
  // ---------------------------------------------------------------- line layout
  const lx = (f) => 40 + frac(f) * (W - 80);
  function lineAxis(d) {
    const top = 26, bot = H - 52;
    g.axis.innerHTML = '';
    const L = d.length;
    const steps = L ? niceSteps(L) : [0, 0.25, 0.5, 0.75, 1].map((x) => x);
    for (const s of steps) {
      const x = lx(L ? s / L : s) + (s === (L || 1) ? W - 80 : 0) * 0;
      const xx = 40 + (L ? s / L : s) * (W - 80);
      el('line', { x1: xx, y1: top, x2: xx, y2: bot, class: 'ln-grid' }, g.axis);
      const t = el('text', { x: xx, y: bot + 20, class: 'ln-lab' }, g.axis); t.textContent = L ? (s === 0 ? '0' : s >= 1000 && s % 1000 === 0 ? s : s) : Math.round(s * 100) + '%';
      void x;
    }
    for (let i = 0; i <= 50; i++) { const xx = 40 + (i / 50) * (W - 80); el('line', { x1: xx, y1: bot - 4, x2: xx, y2: bot, class: 'ln-tick' }, g.axis); }
    const cap = el('text', { x: 40, y: H - 10, class: 'ln-cap' }, g.axis); cap.textContent = L ? 'Distance along track (m)' : 'Distance along track';
    for (const z of d.zones) {
      const x1 = lx(z.from), x2 = Math.max(x1 + 14, lx(z.to) < x1 ? x1 + 14 : Math.min(x1 + 26, lx(z.to)));
      el('rect', { x: x1, y: top, width: x2 - x1, height: bot - top, class: 'ln-zone', fill: z.color || '#16a34a' }, g.zones);
      const t = el('text', { x: 0, y: 0, class: 'ln-zt', transform: `translate(${(x1 + x2) / 2 + 4} ${(top + bot) / 2}) rotate(-90)` }, g.zones); t.textContent = z.label;
    }
    g.mid = (top + bot) / 2;
  }
  function niceSteps(L) {
    const raw = L / 6, p = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
    const out = []; for (let s = 0; s <= L + 1e-9; s += st) out.push(Math.round(s));
    return out;
  }

  // ---------------------------------------------------------------- moving things
  function update(d) {
    data = d;
    const r = host.getBoundingClientRect();
    if (geometry(d) || (d.layout === 'line' && (Math.abs(r.width - W) > 2 || Math.abs(r.height - H) > 2))) { frame(d); lineSig = ''; }
    if (!g.items) return;
    decorations(d);
    const now = performance.now(), seen = new Set();
    for (const L of d.layers) {
      if (L.hidden) continue;
      for (const it of L.items) {
        const k = L.name + '::' + it.key;
        seen.add(k);
        let e = items.get(k);
        if (!e) {
          const grp = el('g', { class: 'trk-it' }, g.items);
          const c = el('circle', { r: 1, class: 'trk-c' }, grp), t = el('text', { class: 'trk-ct' }, grp);
          e = { grp, c, t, from: it.dist, to: it.dist, t0: now, dur: 1, it };
          items.set(k, e);
          if (d.layout === 'line') { e.bub = el('g', { class: 'ln-bub' }, g.items); e.bub.innerHTML = '<rect rx="3"/><text></text>'; }
        }
        // glide forwards; a jump back (a replay seek, a reset) is instant
        const cur = pos(e, now);
        if (it.dist !== e.to) {
          const back = it.dist < cur - 0.0001 && !(e.to - it.dist > 0.5);
          e.dur = back ? 1 : Math.max(250, Math.min(2500, now - (e.lastAt || now - 1000)));
          e.from = back ? it.dist : cur; e.to = it.dist; e.t0 = now; e.lastAt = now;
        }
        e.it = it;
        e.c.setAttribute('fill', it.color);
        e.t.textContent = it.label.length > 4 ? it.label.slice(0, 3).toUpperCase() : it.label;
        e.grp.classList.toggle('lead', !!d.trail && (it.label === d.trail || it.key === d.trail));
      }
    }
    for (const [k, e] of items) if (!seen.has(k)) { e.grp.remove(); e.bub?.remove(); items.delete(k); }
    cancelAnimationFrame(raf);
    tick();
  }
  const pos = (e, now) => e.from + (e.to - e.from) * Math.min(1, (now - e.t0) / e.dur);
  function tick() {
    if (dead || !data) return;
    const now = performance.now();
    let moving = false;
    const u = g.u || 1, line = data.layout === 'line';
    for (const e of items.values()) {
      const d = pos(e, now);
      if (now - e.t0 < e.dur) moving = true;
      let x, y;
      if (line) { x = lx(d); y = g.mid; }
      else if (T) { const p = T.at(d); x = p.x; y = p.y; }
      else continue;
      const lead = e.grp.classList.contains('lead'), r = (line ? 7 : 13 * u) * (lead && !line ? 1.15 : 1);
      e.c.setAttribute('cx', x); e.c.setAttribute('cy', y); e.c.setAttribute('r', r);
      e.t.setAttribute('x', x); e.t.setAttribute('y', y + (line ? 0 : 3.6 * u));
      e.t.setAttribute('font-size', line ? 0 : 9.5 * u);
      if (line && e.bub && e.it.value != null) {
        const txt = e.bub.querySelector('text'), rect = e.bub.querySelector('rect');
        txt.textContent = e.it.value; txt.setAttribute('x', x); txt.setAttribute('y', g.mid - 22);
        const w = e.it.value.length * 7.5 + 16;
        rect.setAttribute('x', x - w / 2); rect.setAttribute('y', g.mid - 37); rect.setAttribute('width', w); rect.setAttribute('height', 22);
      }
      e.d = d;
    }
    // trail: a glowing stretch of line behind the traced point
    g.trail.innerHTML = '';
    const lead = [...items.values()].find((e) => e.grp.classList.contains('lead')) || (line ? [...items.values()][0] : null);
    if (lead && lead.d != null) {
      if (line) {
        el('line', { x1: 40, y1: g.mid, x2: lx(lead.d), y2: g.mid, class: 'ln-trail', stroke: lead.it.color }, g.trail);
      } else if (T) {
        const p = T.path(lead.d - 0.22, lead.d);
        el('path', { d: p, class: 'trk-trail-glow', stroke: lead.it.color, 'stroke-width': 9 * u, filter: 'url(#tg)' }, g.trail);
        el('path', { d: p, class: 'trk-trail', stroke: lead.it.color, 'stroke-width': 4 * u }, g.trail);
      }
    }
    if (moving) raf = requestAnimationFrame(tick);
  }
  return {
    update,
    resize: () => { if (data?.layout === 'line') update(data); },
    destroy: () => { dead = true; cancelAnimationFrame(raf); host.innerHTML = ''; },
    state: () => ({ points: items.size, shape: !!T }),
  };
}
