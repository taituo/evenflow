// Idle mode: when nobody touches the studio, the panels fade out one by one and a paper shader is left, with the
// agents' names and what they are saying floating over it — a screensaver that shows the agents working.
// The shader's colors come from the agents, and it moves faster the more of them are working. Any input wakes it.
import * as PS from '../../vendor/paper-shaders/index.js';

export class Saver {
  constructor(view) {
    this.v = view;
    this.el = view.r.querySelector('.st-saver');
    this.ticker = view.r.querySelector('.st-ticker');
    this.secs = (() => { const s = localStorage.getItem('studio.idle'); return s == null ? 60 : +s; })();
    this.on = false;
    this.wake = this.wake.bind(this);
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) addEventListener(ev, this.wake, { passive: true, capture: true });
    this.arm();
  }
  setDelay(secs) { this.secs = secs; localStorage.setItem('studio.idle', String(secs)); this.arm(); }
  arm() { clearTimeout(this.t); if (this.secs > 0 && !this.on) this.t = setTimeout(() => this.sleep(), this.secs * 1000); }
  items() {
    const v = this.v;
    const cx = v.cam.x + v.box().width / 2 / v.cam.z, cy = v.cam.y + v.box().height / 2 / v.cam.z;
    const els = [...v.agentEls.entries()].map(([id, el]) => ({ el, a: v.agentDef(id) })).concat([...v.panelEls.entries()].map(([id, el]) => ({ el, a: v.doc.panels.find((p) => p.id === id) })))
      .filter((x) => x.a).sort((p, q) => Math.hypot(q.a.x + q.a.w / 2 - cx, q.a.y + q.a.h / 2 - cy) - Math.hypot(p.a.x + p.a.w / 2 - cx, p.a.y + p.a.h / 2 - cy)).map((x) => x.el);
    return [...v.r.querySelectorAll('.st-help, .st-subs, .st-links'), ...els, ...v.r.querySelectorAll('.st-gates, .st-target, .st-hud')];
  }
  sleep() {
    if (this.on || this.v.r.querySelector('.st-input, .st-spot, .st-pick') || document.activeElement?.closest?.('textarea, input, .vt')) return this.arm();
    this.on = true;
    this.v.r.classList.add('idle');
    this.mount();
    this.paint();
    const list = this.items();
    list.forEach((el, i) => { el._fadeT = setTimeout(() => el.classList.add('fade'), 300 + i * 260); });
    this.tick = setInterval(() => this.paint(), 1500);
  }
  wake() {
    if (!this.on) return this.arm();
    this.on = false;
    clearInterval(this.tick);
    this.v.r.classList.remove('idle');
    const list = this.v.r.querySelectorAll('.fade');
    [...list].reverse().forEach((el, i) => { clearTimeout(el._fadeT); setTimeout(() => el.classList.remove('fade'), i * 40); });
    for (const el of this.items()) clearTimeout(el._fadeT);
    setTimeout(() => { if (!this.on) { try { this.mountObj?.dispose(); } catch {} this.mountObj = null; this.el.innerHTML = ''; } }, 1800);
    this.arm();
  }
  colors() {
    const dark = this.v.r.dataset.theme === 'dark';
    const ag = this.v.doc.agents.map((a) => a.color).slice(0, 3);
    const base = dark ? ['#07070a', '#15151c'] : ['#f2f2f5', '#e4e4ec'];
    return [base[0], ...(ag.length ? ag : ['#6366f1', '#14b8a6']), base[1]].slice(0, 6);
  }
  speed() { const w = [...this.v.rt.values()].filter((r) => r.info.status === 'working' || r.info.status === 'waiting').length; return 0.08 + Math.min(0.5, w * 0.14); }
  mount() {
    try {
      const C = (x) => PS.getShaderColorFromString(x);
      const cols = this.colors();
      const uni = { u_colors: cols.map(C), u_colorsCount: cols.length, u_distortion: 0.85, u_swirl: 0.55, u_grainMixer: 0, u_grainOverlay: 0.05, u_fit: PS.ShaderFitOptions.cover, u_rotation: 0, u_scale: 1, u_offsetX: 0, u_offsetY: 0, u_originX: 0.5, u_originY: 0.5, u_worldWidth: 0, u_worldHeight: 0 };
      if (this.mountObj) { this.mountObj.setUniforms(uni); this.mountObj.setSpeed(this.speed()); return; }
      this.el.innerHTML = '';
      this.mountObj = new PS.ShaderMount(this.el, PS.meshGradientFragmentShader, uni, { premultipliedAlpha: false }, this.speed(), 0, 1);
    } catch { this.el.style.background = `linear-gradient(135deg, ${this.colors().join(', ')})`; }
  }
  /** Names and last sentences over the shader, and the shader's speed follows the work. */
  paint() {
    if (!this.on) return;
    try { this.mountObj?.setSpeed(this.speed()); } catch {}
    const v = this.v;
    this.ticker.innerHTML = v.doc.agents.slice(0, 6).map((a) => {
      const r = v.rtOf(a.id).info;
      const gates = v.gates.filter((g) => g.agent === a.id).length;
      return `<div class="t ${r.status === 'working' ? 'working' : ''}" style="--c:${a.color}"><i></i><b>${esc(a.name)}<small>${esc(r.status || '')}${gates ? ` · ${gates} waiting for you` : ''}</small></b><span>${esc(r.subtitle || '')}</span></div>`;
    }).join('');
  }
}
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
