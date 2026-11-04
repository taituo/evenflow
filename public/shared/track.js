// Track geometry, shared by the grid, Live and the simulator: a smooth closed (or open) line through control points,
// positions by distance along it, and curvature (for speed profiles). Pure; no DOM.

/** Catmull-Rom through points [[x,y]…] → dense samples; closed loops wrap. */
export function buildTrack(points, { closed = true, per = 14 } = {}) {
  const P = points.filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));
  if (P.length < 2) return null;
  const n = P.length, out = [];
  const get = (i) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(closed ? [...out[0]] : [...P[n - 1]]);
  const cum = [0];
  for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  const length = cum[cum.length - 1];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of out) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  const T = { closed, samples: out, cum, length, box: { x1, y1, x2, y2 } };
  /** point at a fraction of the lap (wraps for loops; 16.42 → 0.42) → {x, y, a (radians)} */
  T.at = (f) => {
    let u = closed ? ((f % 1) + 1) % 1 : Math.max(0, Math.min(1, f));
    const s = u * length;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const k = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    const a = out[lo], b = out[hi];
    return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, a: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  /** SVG path of the part between fractions f0..f1 (or the whole line) */
  T.path = (f0 = 0, f1 = 1) => {
    if (f0 === 0 && f1 === 1) return 'M' + out.map(([x, y]) => `${+x.toFixed(1)} ${+y.toFixed(1)}`).join('L') + (closed ? 'Z' : '');
    const pts = [];
    const span = f1 - f0, steps = Math.max(2, Math.ceil(Math.abs(span) * out.length));
    for (let i = 0; i <= steps; i++) { const p = T.at(f0 + (span * i) / steps); pts.push(`${+p.x.toFixed(1)} ${+p.y.toFixed(1)}`); }
    return 'M' + pts.join('L');
  };
  /** radius of curvature around fraction f (large on straights) */
  T.radius = (f, d = 0.006) => {
    const a = T.at(f - d), b = T.at(f), c = T.at(f + d);
    const A = Math.hypot(b.x - a.x, b.y - a.y), B = Math.hypot(c.x - b.x, c.y - b.y), C = Math.hypot(c.x - a.x, c.y - a.y);
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    return area < 1e-9 ? Infinity : (A * B * C) / (4 * area);
  };
  return T;
}

/** lat/lon → plane (Web Mercator, y down), so a GPS route can be a track */
export function projectLatLon(points) {
  const X = (lon) => (lon + 180) / 360, Y = (lat) => { const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  return points.map(([lat, lon]) => [X(lon) * 1e6, Y(lat) * 1e6]);
}

/** The fraction of a lap (or of an open route) a distance value means: laps as a float (16.42), or metres with a length. */
export function fractionOf(v, length) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return length ? v / length : v;
}
