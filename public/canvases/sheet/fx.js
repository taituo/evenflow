// Change effects for Live: what a value does on screen when the data behind it changes.
//   morph    — digits roll to their new value (numbers); text morphs glyph by glyph
//   scramble — a glow, then characters churn through glyphs and settle on the new text
//   vapor    — the old text evaporates upward, the new one condenses back in
//   glow     — the new value lights up and fades back to normal
//   none     — just change
// Every effect ends with el.textContent === the new text; the element is never left half-animated.

export const FX = ['morph', 'scramble', 'vapor', 'glow', 'none'];
const GLYPHS = '░▒▓█▚▞#%&*+=<>/\\0123456789ABCDEFXYZ';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const isNumText = (t) => /^[-+]?[\d\s.,]*\d[\d\s.,]*%?$/.test(String(t).trim()) || /^[€$£]?\s?[-+]?[\d.,\s]+\s?[€$£%]?$/.test(String(t).trim());

/** The text an element is showing — or settling on, if an effect is running. */
export const textOf = (el) => (el.__fx ? el.__fx.to : el.textContent);

export function fxText(el, to, kind = 'morph') {
  const from = textOf(el);
  if (from === to) return;
  stop(el);
  if (kind === 'none' || !el.isConnected) { el.textContent = to; return; }
  if (reduced()) kind = 'glow';
  if (kind === 'morph' && !(isNumText(from) && isNumText(to))) kind = from && to ? 'scramble' : 'vapor';
  const job = { to, timers: [], raf: 0 };
  el.__fx = job;
  el.classList.add('fx-on');
  ({ morph, scramble, vapor, glow })[kind](el, from, to, job);
}

function stop(el) {
  const j = el.__fx;
  if (!j) return;
  j.timers.forEach(clearTimeout);
  cancelAnimationFrame(j.raf);
  el.__fx = null;
  el.classList.remove('fx-on', 'fx-glow', 'fx-scramble');
  el.textContent = j.to;
}
function done(el, job, delay = 0) {
  job.timers.push(setTimeout(() => { if (el.__fx === job) stop(el); }, delay));
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Digit roll: each changed character is a little column; old slides out, new slides in, staggered right-to-left
function morph(el, from, to, job) {
  const a = from.padStart(to.length), b = to.padStart(from.length);
  let html = '';
  for (let i = 0; i < b.length; i++) {
    const o = a[i] ?? ' ', n = b[i];
    const delay = (b.length - 1 - i) * 45;
    if (o === n) html += `<span class="fx-c">${esc(n)}</span>`;
    else {
      const up = /\d/.test(o) && /\d/.test(n) ? +n > +o : true;
      html += `<span class="fx-roll ${up ? 'up' : 'down'}" style="--d:${delay}ms"><span class="fx-o">${esc(o === ' ' ? ' ' : o)}</span><span class="fx-n">${esc(n === ' ' ? '' : n)}</span></span>`;
    }
  }
  el.innerHTML = html;
  el.classList.add('fx-glow');
  done(el, job, 520 + b.length * 45);
}

// Glyph churn: a glow, then each position cycles random glyphs and locks onto its final character
function scramble(el, from, to, job) {
  el.classList.add('fx-glow', 'fx-scramble');
  const len = Math.max(from.length, to.length);
  const t0 = performance.now(), dur = 420 + Math.min(len, 24) * 28;
  let frames = 0;
  const frame = (now) => {
    if (el.__fx !== job) return;
    // time-based, but never fewer than ~6 visible steps (a slow screen still sees the churn)
    const t = Math.min((now - t0) / dur, ++frames / 6);
    let s = '';
    for (let i = 0; i < len; i++) {
      const lock = 0.25 + (i / Math.max(1, len)) * 0.7;      // left locks first
      if (t >= lock) s += to[i] ?? '';
      else if (t < 0.12) s += from[i] ?? '';
      else s += to[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    el.textContent = s;
    if (t < 1) job.raf = requestAnimationFrame(frame);
    else done(el, job, 300);
  };
  job.raf = requestAnimationFrame(frame);
}

// Vapor: characters drift up and blur away (staggered), then the new text condenses from below
function vapor(el, from, to, job) {
  const chars = (s, cls) => [...s].map((ch, i) => `<span class="${cls}" style="--i:${i}">${esc(ch === ' ' ? ' ' : ch)}</span>`).join('');
  const outMs = from ? 360 + Math.min(from.length, 30) * 14 : 0;
  if (from) el.innerHTML = chars(from, 'fx-vout');
  job.timers.push(setTimeout(() => {
    if (el.__fx !== job) return;
    el.innerHTML = chars(to, 'fx-vin');
    done(el, job, 480 + Math.min(to.length, 30) * 18);
  }, outMs));
}

function glow(el, from, to, job) {
  el.textContent = to;
  el.classList.add('fx-glow');
  done(el, job, 1200);
}

/** Rows: new ones condense in; removed ones evaporate first (calls rebuild when they're gone). */
export function vaporRowsOut(trs, then) {
  if (!trs.length || reduced()) { then(); return; }
  trs.forEach((tr, i) => { tr.style.setProperty('--i', i); tr.classList.add('fx-row-out'); });
  setTimeout(then, 520 + trs.length * 40);
}
export function vaporRowsIn(trs) {
  if (reduced()) return;
  trs.forEach((tr, i) => {
    tr.style.setProperty('--i', i);
    tr.classList.add('fx-row-in');
    tr.addEventListener('animationend', () => tr.classList.remove('fx-row-in'), { once: true });
  });
}
