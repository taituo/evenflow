// Time replay for Live: rebuild the workbook as it was at `from` (the server undoes later batches with their
// recorded inverses), then play every batch up to `to` on a virtual clock — sped up, with quiet stretches squeezed —
// so the cards animate exactly as they did live. A clock overlay shows the time and date being replayed.
import { applyDocOp } from '../../shared/types/index.js';

const SPEEDS = [10, 60, 360, 3600];
const QUIET = 2.5;   // seconds of playback at most for a stretch where nothing happened
const clone = (x) => JSON.parse(JSON.stringify(x));
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function createReplay({ root, getDoc, setDoc, render, report }) {
  let rp = null;
  const ui = document.createElement('div');
  ui.className = 'lv-replay';
  ui.innerHTML = `
    <div class="lv-rp-ctl">
      <div class="lv-rp-clock"><b class="lv-rp-time"></b><div><span class="lv-rp-tag">REPLAY <em></em></span><span class="lv-rp-date"></span></div></div>
      <button class="lv-btn" data-rp="restart" title="From the start">⏮</button>
      <button class="lv-btn" data-rp="play" title="Play / pause (space)">⏸</button>
      <button class="lv-btn" data-rp="speed" title="Speed">×60</button>
      <div class="lv-rp-track" title="Drag to scrub"><div class="lv-rp-ticks"></div><i class="lv-rp-fill"></i><b class="lv-rp-head"></b></div>
      <span class="lv-rp-cap"></span>
      <button class="lv-btn" data-rp="stop" title="Back to live data (Esc)">✕ Live</button>
    </div>`;
  root.append(ui);
  const $ = (s) => ui.querySelector(s);

  // virtual time (t, epoch ms) ↔ playback time (p, seconds): piecewise linear, quiet gaps capped
  function segments() {
    const { from, to } = rp.data;
    const pts = [...new Set([from, ...rp.data.frames.map((f) => f.ts), to])].sort((a, b) => a - b);
    const segs = [];
    let p = 0.6;   // a short lead-in so the first change is seen happening
    segs.push({ t0: from, t1: from, p0: 0, p1: p });
    for (let i = 0; i + 1 < pts.length; i++) {
      let dp = (pts[i + 1] - pts[i]) / 1000 / rp.speed;
      const fast = rp.gaps && dp > QUIET;
      if (fast) dp = QUIET;
      segs.push({ t0: pts[i], t1: pts[i + 1], p0: p, p1: p + dp, fast });
      p += dp;
    }
    rp.segs = segs; rp.pEnd = p;
  }
  const seg = (p) => rp.segs.find((s) => p <= s.p1) || rp.segs.at(-1);
  const tAt = (p) => { const s = seg(p); return s.p1 === s.p0 ? s.t1 : s.t0 + ((s.t1 - s.t0) * (p - s.p0)) / (s.p1 - s.p0); };
  const pAt = (t) => { const s = rp.segs.find((x) => t <= x.t1 && x.t1 > x.t0) || rp.segs.at(-1); return s.t1 === s.t0 ? s.p1 : s.p0 + ((s.p1 - s.p0) * (t - s.t0)) / (s.t1 - s.t0); };

  async function start(o = {}) {
    const docId = getDoc().id;
    const q = new URLSearchParams({ doc: docId, from: String(o.from ?? '-1h'), format: 'json' });
    if (o.to != null) q.set('to', String(o.to));
    const r = await fetch('/api/replay?' + q);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'replay failed');
    if (rp) stop(true);
    rp = { data, saved: getDoc(), speed: o.speed || 60, gaps: o.gaps !== false, loop: !!o.loop, p: 0, applied: 0, playing: true, last: performance.now(), raf: 0, caption: '' };
    setDoc(clone(data.start));
    segments();
    root.classList.add('lv-replaying');
    $('.lv-rp-ticks').innerHTML = data.frames.map((f) => `<i style="left:${((pAt(f.ts) / rp.pEnd) * 100).toFixed(2)}%;--c:${f.color || (f.by === 'user' ? '#4ea1ff' : '#b388ff')}" title="${esc(new Date(f.ts).toLocaleTimeString())} ${esc(f.who || f.by)}"></i>`).join('');
    render();
    rp.raf = requestAnimationFrame(tick);
    report();
    return data;
  }
  function stop(quiet) {
    if (!rp) return;
    cancelAnimationFrame(rp.raf);
    setDoc(rp.saved);
    rp = null;
    root.classList.remove('lv-replaying');
    if (!quiet) { render(); report(); }
  }
  function applyUntil(t) {
    const F = rp.data.frames;
    let n = 0;
    while (rp.applied < F.length && F[rp.applied].ts <= t) {
      const f = F[rp.applied++];
      for (const op of f.ops) { try { applyDocOp(getDoc(), op); } catch {} }
      rp.caption = `${f.who || f.by}${f.label ? ' · ' + f.label : f.touched.length ? ' · ' + f.touched.map((x) => (x.sheet ? x.sheet + '!' : '') + x.range).join(', ') : ''}`;
      n++;
    }
    return n;
  }
  function seek(p) {
    rp.p = Math.max(0, Math.min(rp.pEnd, p));
    const t = tAt(rp.p);
    const F = rp.data.frames;
    if (rp.applied && F[rp.applied - 1].ts > t) { setDoc(clone(rp.data.start)); rp.applied = 0; rp.caption = ''; }
    applyUntil(t);
    render();
    paint();
  }
  function tick(now) {
    if (!rp) return;
    const dt = Math.min(1, (now - rp.last) / 1000);   // slow devices drop frames, not time
    rp.last = now;
    if (rp.playing) rp.p = Math.min(rp.pEnd, rp.p + dt);
    if (applyUntil(tAt(rp.p))) render();
    if (rp.playing && rp.p >= rp.pEnd) {
      if (rp.loop) { rp.endAt ||= now; if (now - rp.endAt > 2500) { rp.endAt = 0; seek(0); } }
      else { rp.playing = false; report(); }
    }
    paint();
    rp.raf = requestAnimationFrame(tick);
  }
  let lastSec = '';
  function paint() {
    const t = tAt(rp.p), d = new Date(t), s = seg(rp.p);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (time !== lastSec) { $('.lv-rp-time').textContent = time; lastSec = time; }
    $('.lv-rp-date').textContent = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });
    $('.lv-rp-tag em').textContent = s?.fast && rp.playing ? '⏩' : rp.p >= rp.pEnd ? '■ end' : rp.playing ? '' : '⏸';
    const k = rp.pEnd ? rp.p / rp.pEnd : 1;
    $('.lv-rp-fill').style.width = k * 100 + '%';
    $('.lv-rp-head').style.left = k * 100 + '%';
    $('[data-rp=play]').textContent = rp.playing ? '⏸' : rp.p >= rp.pEnd ? '↻' : '▶';
    $('[data-rp=speed]').textContent = '×' + rp.speed;
    $('.lv-rp-cap').textContent = rp.caption;
  }
  function toggle() {
    if (!rp) return false;
    if (rp.p >= rp.pEnd) seek(0);
    rp.playing = !rp.playing;
    rp.last = performance.now();
    report();
    return true;
  }
  function setSpeed(v) {
    const t = tAt(rp.p);
    rp.speed = v;
    segments();
    rp.p = pAt(t);
    $('.lv-rp-ticks').querySelectorAll('i').forEach((el, i) => { el.style.left = ((pAt(rp.data.frames[i].ts) / rp.pEnd) * 100).toFixed(2) + '%'; });
  }
  /** next/prev: jump to the next or previous change */
  function step(dir) {
    const F = rp.data.frames;
    if (dir > 0) { const f = F[rp.applied]; if (f) seek(pAt(f.ts) + 1e-6); }
    else { const f = F[rp.applied - 2]; seek(f ? pAt(f.ts) + 1e-6 : 0); }
    rp.playing = false;
    report();
  }

  ui.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rp]');
    if (!b || !rp) return;
    const a = b.dataset.rp;
    if (a === 'play') toggle();
    else if (a === 'restart') { seek(0); rp.playing = true; }
    else if (a === 'speed') setSpeed(SPEEDS[(SPEEDS.indexOf(rp.speed) + 1) % SPEEDS.length] || 60);
    else if (a === 'stop') stop();
  });
  const track = $('.lv-rp-track');
  let scrub = null;
  track.addEventListener('pointerdown', (e) => { if (!rp) return; scrub = e.pointerId; track.setPointerCapture(e.pointerId); move(e); });
  track.addEventListener('pointermove', (e) => { if (scrub === e.pointerId) move(e); });
  track.addEventListener('pointerup', () => { scrub = null; });
  function move(e) { const r = track.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * rp.pEnd); }

  return {
    start, stop, toggle, step,
    get active() { return !!rp; },
    play: () => { if (rp && !rp.playing) toggle(); },
    pause: () => { if (rp && rp.playing) toggle(); },
    state: () => rp && { from: rp.data.from, to: rp.data.to, at: Math.round(tAt(rp.p)), speed: rp.speed, playing: rp.playing, ended: rp.p >= rp.pEnd, changes: rp.data.frames.length, applied: rp.applied, note: rp.data.note },
    destroy: () => { if (rp) cancelAnimationFrame(rp.raf); rp = null; ui.remove(); },
  };
}

/** The presets offered by the ⏱ button. */
export const REPLAY_PRESETS = [
  { label: 'Last 15 min', from: '-15m' },
  { label: 'Last hour', from: '-1h' },
  { label: 'Today', from: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return +d; } },
  { label: 'Last 24 h', from: '-24h' },
  { label: 'Since last milestone', from: 'last' },
];
