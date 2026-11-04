// Live map card: MapLibre GL (vendored) with OpenFreeMap vector tiles, points from named tables.
// Points glide when their coordinates change and leave a fading trail; routes join a layer's points in order;
// the agent steers the camera with the chart's view / follow / focus fields. Without a network the map falls back
// to a blank basemap and the points still float on the Live background.
import { renderViz } from './viz-dom.js';

const STYLES = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
  bright: 'https://tiles.openfreemap.org/styles/liberty',
};
const BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } }] };
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let lib = null;
export function loadMapLib() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  return (lib ||= new Promise((ok, bad) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/maplibre/maplibre-gl.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = '/vendor/maplibre/maplibre-gl.js';
    s.onload = () => ok(window.maplibregl);
    s.onerror = () => { lib = null; bad(new Error('map library failed to load')); };
    document.head.append(s);
  }));
}

/** Mount a map in `host`. Returns { update(data, {focused}), resize(), destroy(), state() }. */
export function mountMap(host, { onMove } = {}) {
  let map = null, gl = null, data = null, opts = {}, base = null, offline = false, dead = false;
  const pins = new Map();         // key -> { m: Marker, el, p, from, to, t0, trail: [[lon,lat]] }
  let lastView = null, lastKeys = '', fitted = false, localFocus = null;
  const note = document.createElement('div');
  note.className = 'lv-mapnote';
  const info = document.createElement('div');
  info.className = 'lv-mapinfo';
  host.append(note, info);

  loadMapLib().then((maplibregl) => {
    if (dead) return;
    gl = maplibregl;
    base = data?.basemap || 'dark';
    map = new gl.Map({
      container: host, style: styleFor(base), center: [24.94, 60.17], zoom: 3,
      attributionControl: { compact: true }, fadeDuration: 0, cooperativeGestures: false,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false },
    });
    map.scrollZoom.disable();
    map.on('style.load', () => { addLayers(); paint(); });
    map.on('error', (e) => {
      // style or tiles unreachable (offline, blocked): keep the points, drop the basemap
      if (!offline && base !== 'none' && /style|Failed to fetch|NetworkError|AJAXError/i.test(String(e?.error?.message || e?.error || ''))) {
        offline = true;
        note.textContent = 'map offline — points only';
        map.setStyle(BLANK);
      }
    });
    map.on('click', () => { if (localFocus) { localFocus = null; paint(); } });
    map.on('moveend', () => onMove?.());   // the agent can read where the camera ended up
    if (data) apply();
  }).catch((e) => { note.textContent = e.message; });

  function styleFor(b) { return b === 'none' || offline ? BLANK : STYLES[b] || STYLES.dark; }
  function addLayers() {
    if (!map.getSource('sp-routes')) map.addSource('sp-routes', { type: 'geojson', data: fc([]) });
    if (!map.getSource('sp-trails')) map.addSource('sp-trails', { type: 'geojson', data: fc([]) });
    if (!map.getLayer('sp-routes')) map.addLayer({ id: 'sp-routes', type: 'line', source: 'sp-routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.75, 'line-dasharray': [2, 1.5] } });
    if (!map.getLayer('sp-trails')) map.addLayer({ id: 'sp-trails', type: 'line', source: 'sp-trails', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-blur': 3, 'line-opacity': 0.5 } });
  }
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const line = (coords, color) => ({ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: coords } });

  function update(d, o = {}) {
    data = d; opts = o;
    if (map) apply();
  }
  function visiblePoints() { return data.layers.filter((L) => !L.hidden).flatMap((L) => L.points.map((p) => ({ ...p, layer: L.name, id: L.name + '::' + p.key }))); }
  function apply() {
    if (opts.focused) map.scrollZoom.enable(); else map.scrollZoom.disable();
    const want = data.basemap || 'dark';
    if (want !== base) { base = want; if (!offline || want === 'none') map.setStyle(styleFor(want)); }
    const err = data.layers.find((L) => L.error);
    note.textContent = err ? err.error : offline ? 'map offline — points only' : '';
    const pts = visiblePoints();
    const now = performance.now();
    const seen = new Set();
    for (const p of pts) {
      seen.add(p.id);
      let pin = pins.get(p.id);
      if (!pin) {
        const el = document.createElement('div');
        el.className = 'lv-pin';
        el.innerHTML = '<i></i><div class="lv-pinviz"></div><span></span>';
        el.addEventListener('click', (e) => { e.stopPropagation(); localFocus = localFocus === p.id ? null : p.id; paint(); });
        pin = { el, m: new gl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map), to: [p.lon, p.lat], trail: [[p.lon, p.lat]] };
        pins.set(p.id, pin);
        el.classList.add('lv-pin-in');
      }
      const was = pin.p;
      pin.p = p;
      if (pin.to[0] !== p.lon || pin.to[1] !== p.lat) {
        pin.from = cur(pin, now); pin.to = [p.lon, p.lat]; pin.t0 = now;
        if (data.trail) { pin.trail.push(pin.to); if (pin.trail.length > 60) pin.trail.shift(); }
      }
      const el = pin.el;
      el.style.setProperty('--c', p.color);
      el.querySelector('span').textContent = p.label;
      const vh = el.querySelector('.lv-pinviz');
      el.classList.toggle('has-viz', !!p.viz);
      if (p.viz) renderViz(vh, p.viz.pack, p.viz.value, p.viz.label);
      if (was && (was.color !== p.color || JSON.stringify(was.viz) !== JSON.stringify(p.viz) || was.label !== p.label)) { el.classList.remove('lv-pin-pulse'); void el.offsetWidth; el.classList.add('lv-pin-pulse'); }
    }
    for (const [k, pin] of pins) if (!seen.has(k)) { pin.m.remove(); pins.delete(k); }
    // camera: agent view › follow › fit to the points
    const vjson = JSON.stringify(data.view);
    if (data.view && vjson !== lastView) {
      const v = data.view;
      const target = v.to ? pts.find((p) => p.label.toLowerCase() === String(v.to).toLowerCase() || p.key.toLowerCase() === String(v.to).toLowerCase()) : null;
      const center = v.lat != null ? [v.lon, v.lat] : target ? [target.lon, target.lat] : null;
      map.flyTo({ ...(center ? { center } : {}), zoom: v.zoom ?? (target ? Math.max(map.getZoom(), 14) : map.getZoom()), bearing: v.bearing ?? map.getBearing(), pitch: v.pitch ?? map.getPitch(), duration: 2200, essential: true });
      fitted = true;
    } else if (!data.view && !data.follow) {
      const keys = pts.map((p) => p.id).sort().join('|');
      if (lastView !== 'null' || keys !== lastKeys || !fitted) fit(pts, fitted);
      lastKeys = keys;
    }
    lastView = data.view ? vjson : 'null';
    paint();
    tick();
  }
  function fit(pts, animate) {
    if (!pts.length) return;
    const b = new gl.LngLatBounds();
    for (const p of pts) b.extend([p.lon, p.lat]);
    const pad = Math.min(60, host.clientWidth / 6, host.clientHeight / 6);
    map.fitBounds(b, { padding: pad, maxZoom: 15, duration: animate ? 1200 : 0 });
    fitted = true;
  }
  const cur = (pin, now) => {
    if (!pin.t0) return pin.to;
    const k = Math.min(1, (now - pin.t0) / 1400), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    return [pin.from[0] + (pin.to[0] - pin.from[0]) * e, pin.from[1] + (pin.to[1] - pin.from[1]) * e];
  };
  let raf = 0;
  function tick() {
    cancelAnimationFrame(raf);
    const now = performance.now();
    let moving = false;
    for (const pin of pins.values()) {
      if (!pin.t0) continue;
      const c = cur(pin, now);
      pin.m.setLngLat(c);
      if (now - pin.t0 >= 1400) pin.t0 = 0; else moving = true;
    }
    const f = data?.follow && [...pins.values()].find((x) => x.p.label.toLowerCase() === String(data.follow).toLowerCase() || x.p.key.toLowerCase() === String(data.follow).toLowerCase());
    if (f && map) {
      const c = cur(f, now);
      const ctr = map.getCenter();
      if (Math.abs(ctr.lng - c[0]) + Math.abs(ctr.lat - c[1]) > 1e-7) map.jumpTo({ center: c, zoom: map.getZoom() < 12 && !f.zoomed ? (f.zoomed = 14) : map.getZoom() });
    }
    paintLines(now);
    if (moving && !dead) raf = requestAnimationFrame(tick);
  }
  function paintLines(now) {
    if (!map?.getSource('sp-routes')) return;
    const routes = data.layers.filter((L) => L.route && !L.hidden && L.points.length > 1).map((L) => line(L.points.map((p) => { const pin = pins.get(L.name + '::' + p.key); return pin ? cur(pin, now) : [p.lon, p.lat]; }), L.points[0].color));
    map.getSource('sp-routes').setData(fc(routes));
    const trails = data.trail ? [...pins.values()].filter((x) => x.trail.length > 1).map((x) => line([...x.trail.slice(0, -1), cur(x, now)], x.p.color)) : [];
    map.getSource('sp-trails').setData(fc(trails));
  }
  function paint() {
    if (!data) return;
    const want = localFocus || (data.focus ? [...pins.keys()].find((k) => { const p = pins.get(k).p; return p.label.toLowerCase() === String(data.focus).toLowerCase() || p.key.toLowerCase() === String(data.focus).toLowerCase(); }) : null);
    for (const [k, pin] of pins) pin.el.classList.toggle('lv-pin-focus', k === want);
    const p = want && pins.get(want)?.p;
    info.classList.toggle('on', !!p);
    if (p) info.innerHTML = `<b>${esc(p.label)}</b><small>${esc(p.layer)} · ${esc(p.cell)}</small>` + Object.entries(p.row).map(([c, v]) => `<div><span>${esc(c)}</span>${esc(v)}</div>`).join('');
    paintLines(performance.now());
  }
  return {
    update,
    resize: () => map?.resize(),
    destroy: () => { dead = true; cancelAnimationFrame(raf); try { map?.remove(); } catch {} map = null; },
    state: () => (map ? { center: map.getCenter(), zoom: +map.getZoom().toFixed(2), basemap: base, offline, points: pins.size } : null),
  };
}
