// Studio view: coding agents (ACP sessions) as boxes on an infinite canvas.
//
//   draw a box (Shift+drag, or N)  → a new agent in its own git worktree (optionally a sparse slice of a monorepo)
//   hover + type                   → talk to what is under the pointer (agent box: a prompt; panel: text)
//   zoom out / in                  → boxes turn into tiles; zoom in for the whole session (semantic zoom)
//   bottom tray                    → every diff of every agent, scrollable, with a timeline you can scrub or play
//   right column                   → gates: where an agent needs you (permission, a red monitor, a finished turn)
//   panels                         → notes, snippets, reviews, real terminals, live previews, code maps
//   ⌘K                             → spotlight: every command by name
//   ⌘\ (focus mode)                → a classic coding UI around one agent; panels can float over either mode
//   idle                           → panels fade one by one; a shader stays, with the agents' voices over it
//
// Only the layout is a versioned doc (ctx.doc). Everything the agents do arrives as `studio` events.
import { mountBody } from './panels.js';
import { MODES, arrange, snapshotLayout, applyLayout } from './layout.js';
import { Saver } from './saver.js';
import { Focus } from './focus.js';

const STYLE_ID = 'studio-css';
const TEXT_KINDS = new Set(['note', 'review', 'prompt', 'sql', 'snippet']);
const TOOL_ICON = { read: '◎', edit: '✎', delete: '⌫', move: '⇄', search: '⌕', execute: '▶', think: '◌', fetch: '⇣', switch_mode: '⇆', other: '•' };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = (p) => p + Math.random().toString(36).slice(2, 10);
const ago = (ts) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const LEVEL_RANK = { red: 3, amber: 2, running: 1, green: 0, skip: -1 };
const PROMPT_MIME = 'application/x-studio-prompt';

/** Light markdown: code fences, inline code, bold. Input is escaped first. */
function md(text) {
  return String(text || '').split(/```/).map((p, i) => (i % 2 ? `<pre>${esc(p.replace(/^[\w-]*\n/, ''))}</pre>` : esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'))).join('');
}

/** Unified diff → [{ path, status, hunks: [{ header, rows: [{ t: ' '|'+'|'-', o, n, s }] }] }] */
function parseDiff(patch) {
  const files = [];
  let f = null, h = null, o = 0, n = 0;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('diff --git ')) { f = { path: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), status: 'M', hunks: [] }; files.push(f); h = null; continue; }
    if (!f) continue;
    if (line.startsWith('new file')) { f.status = 'A'; continue; }
    if (line.startsWith('deleted file')) { f.status = 'D'; continue; }
    if (/^(\+\+\+ |--- |index |similarity|old mode|new mode)/.test(line)) continue;
    if (line.startsWith('Binary')) { f.binary = true; continue; }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { h = { header: line, rows: [] }; f.hunks.push(h); o = +m[1]; n = +m[2]; continue; }
    if (!h || line.startsWith('\\') || line === '') continue;
    const t = line[0];
    if (t === '+') h.rows.push({ t, o: '', n: n++, s: line.slice(1) });
    else if (t === '-') h.rows.push({ t, o: o++, n: '', s: line.slice(1) });
    else h.rows.push({ t: ' ', o: o++, n: n++, s: line.slice(1) });
  }
  return files;
}

export function mount(root, ctx) {
  if (!document.getElementById(STYLE_ID)) {
    const l = document.createElement('link');
    l.id = STYLE_ID; l.rel = 'stylesheet'; l.href = '/canvases/studio/studio.css';
    document.head.append(l);
  }
  const v = new StudioView(root, ctx);
  return { unmount: () => v.destroy(), reload: () => v.syncLayout(true), remote: () => v.syncLayout(), studio: (e) => v.onStudio(e), resized: () => v.render() };
}

class StudioView {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.root = root;
    this.docId = ctx.docId;
    this.rt = new Map();
    this.gates = [];
    this.presets = {};
    this.timeline = [];
    this.T = null;
    this.sel = null;
    this.filter = null;
    this.hover = null;
    this.target = null;
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2 };
    this.diffCache = new Map();
    this.agentEls = new Map();
    this.panelEls = new Map();
    this.bodies = new Map();       // panel id -> controller (terminal, preview, map)
    this.hadCam = !!this.loadCam();
    this.cam = this.loadCam() || { x: -60, y: -60, z: 0.85 };
    this.trayH = +(localStorage.getItem('studio.trayH') || 0) || 280;
    this.trayOff = localStorage.getItem('studio.trayOff') === '1';
    this.themePref = localStorage.getItem('studio.theme') || 'system';
    this.mode = 'canvas';
    this.build();
    this.applyTheme();
    this.bind();
    this.syncLayout(true);
    if (localStorage.getItem('studio.mode') === 'focus') this.setMode('focus');
    this.load();
    this.saver = new Saver(this);
    this.renderDirector();
    // tell the director the person is here, so it reports instead of moving the camera
    const beat = () => { const now = Date.now(); if (now - (this.beatT || 0) > 4000) { this.beatT = now; this.ctx.post('/api/studio/activity', { doc: this.docId }).catch(() => {}); } };
    for (const ev of ['pointerdown', 'keydown', 'wheel']) this.on(this.r, ev, beat, { passive: true });
    this.on(this.r, 'pointermove', (e) => { if (e.buttons) beat(); }, { passive: true });
    this.tick = setInterval(() => { this.renderGates(); this.renderTimelineHead(); }, 15000);
  }

  // ================================================================ setup
  build() {
    const r = el('div', 'st');
    r.tabIndex = 0;
    r.innerHTML = `
      <div class="st-saver"></div>
      <div class="st-canvas"><div class="st-grid"></div><div class="st-world"><svg class="st-links"></svg></div></div>
      <div class="st-float"></div>
      <div class="st-ticker"></div>
      <div class="st-hud"><div class="st-brand"><b>Studio</b><span class="root"></span></div>
        <div class="st-seg"><span class="z"></span><button data-h="fit" title="Fit everything (Esc)">Fit</button><button data-h="arrange" title="Arrange boxes · saved layouts (L)">Arrange</button><button data-h="mode" title="Focus mode: a classic coding view of one agent, panels as tabs (⌘\\)">◧ Focus</button><button data-h="director" title="Director: who runs the screen — you, the built-in rules, or a director agent (D)"></button><button data-h="theme" title="Light / dark / system"></button><button data-h="spot" title="Spotlight">⌘K</button></div></div>
      <div class="st-target" title="Typing and voice go here (point at a box to change)"><span>→</span><span class="chip">nothing yet</span></div>
      <div class="st-gates"></div>
      <div class="st-subs off"><div class="who"><i></i><span></span></div><div><span class="line"></span></div></div>
      <div class="st-help"><span><kbd>Shift</kbd> drag — new agent</span><span>point + type — talk</span><span>select + <kbd>S</kbd> — snippet</span><span><kbd>⌘K</kbd> commands</span><span><kbd>?</kbd> keys</span></div>
      <div class="st-tray"><div class="st-tgrip"></div>
        <div class="st-thead"><span class="lbl" title="Show / hide (B)">Changes</span><div class="st-filter"></div>
          <button class="tb prev" title="Previous snapshot ([)">‹</button><button class="tb play" title="Replay: step through every change (P)">▶ Replay</button><button class="tb next" title="Next snapshot (])">›</button>
          <div class="st-tl"><span class="now">now</span></div><button class="tb golive live">● Live</button></div>
        <div class="st-tbody"></div></div>`;
    this.root.innerHTML = '';
    this.root.append(r);
    this.$ = (s) => r.querySelector(s);
    this.r = r;
    this.canvas = this.$('.st-canvas');
    this.world = this.$('.st-world');
    this.links = this.$('.st-links');
    this.grid = this.$('.st-grid');
    this.gatesEl = this.$('.st-gates');
    this.subs = this.$('.st-subs');
    this.tbody = this.$('.st-tbody');
    this.tl = this.$('.st-tl');
    this.floatEl = this.$('.st-float');
    this.focus = new Focus(this);
    this.applyTray();
    setTimeout(() => r.focus({ preventScroll: true }));
  }

  applyTheme() {
    const sys = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const t = this.themePref === 'system' ? sys : this.themePref;
    this.r.dataset.theme = t;
    for (const b of this.r.querySelectorAll('[data-h="theme"]')) b.textContent = { system: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }[this.themePref];
    if (this.root.id === 'studio') document.documentElement.style.background = getComputedStyle(this.r).getPropertyValue('--bg');
    if (this.saver?.on) this.saver.mount();
  }
  setTheme(t) { this.themePref = t; localStorage.setItem('studio.theme', t); this.applyTheme(); }
  /** Canvas (every box on the infinite canvas) or focus (a classic coding UI around one agent). */
  setMode(m) {
    m = m === 'focus' ? 'focus' : 'canvas';
    if (m === this.mode) return;
    this.closeOverlays?.();
    this.mode = m;
    try { localStorage.setItem('studio.mode', m); } catch {}
    this.r.classList.toggle('focus', m === 'focus');
    if (m === 'focus') this.focus.enter(); else this.focus.leave();
    this.syncLayout();
    if (m === 'canvas') { this.render(); const id = this.focus.fa; if (id && this.agentDef(id)) setTimeout(() => this.zoomTo('agent', id), 30); }
  }
  hudAction(b) {
    ({ fit: () => this.fit(), arrange: () => this.arrangeMenu(b), director: () => this.directorMenu(b), theme: () => this.setTheme({ system: 'light', light: 'dark', dark: 'system' }[this.themePref]), spot: () => this.spotlight(), mode: () => this.setMode(this.mode === 'focus' ? 'canvas' : 'focus') })[b.dataset.h]?.();
  }

  bind() {
    const c = this.canvas;
    this.on(c, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.on(c, 'pointerdown', (e) => this.onDown(e));
    this.on(window, 'pointermove', (e) => this.onMove(e));
    this.on(window, 'pointerup', (e) => this.onUp(e));
    this.on(this.r, 'keydown', (e) => this.onKey(e));
    this.on(window, 'keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || !this.r.isConnected) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); this.spotlight(); }
      else if (e.key === '\\' || e.code === 'Backslash') { e.preventDefault(); this.setMode(this.mode === 'focus' ? 'canvas' : 'focus'); }
    });
    this.on(window, 'keyup', (e) => { if (e.code === 'Space') this.space = false; });
    this.on(window, 'resize', () => this.render());
    this.on(matchMedia('(prefers-color-scheme: dark)'), 'change', () => this.applyTheme());
    this.on(c, 'dblclick', (e) => {
      if (e.target.closest('.st-agent,.st-panel')) return;
      const w = this.toWorld(e.clientX, e.clientY);
      this.newPanel({ x: w.x - 170, y: w.y - 30, focus: true });
    });
    // snippets and prompts: drag text from anywhere onto the canvas (a panel) or onto a box (a prompt)
    this.on(this.r, 'dragstart', (e) => {
      const bubble = e.target.closest?.('.ev.user > div');
      if (bubble) { e.dataTransfer.setData(PROMPT_MIME, bubble.dataset.text || bubble.firstChild.textContent); e.dataTransfer.setData('text/plain', bubble.dataset.text || ''); e.dataTransfer.effectAllowed = 'copy'; }
    });
    this.on(c, 'dragover', (e) => {
      if (![...e.dataTransfer.types].some((t) => t === 'text/plain' || t === PROMPT_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const a = this.hitAgentAt(e.clientX, e.clientY);
      if (a !== this.dropOn) { if (this.dropOn) this.agentEls.get(this.dropOn)?.classList.remove('drop'); this.dropOn = a; if (a) this.agentEls.get(a)?.classList.add('drop'); }
    });
    this.on(c, 'dragleave', (e) => { if (!c.contains(e.relatedTarget) && this.dropOn) { this.agentEls.get(this.dropOn)?.classList.remove('drop'); this.dropOn = null; } });
    this.on(c, 'drop', (e) => {
      const prompt = e.dataTransfer.getData(PROMPT_MIME), text = prompt || e.dataTransfer.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      if (this.dropOn) this.agentEls.get(this.dropOn)?.classList.remove('drop');
      const agent = this.hitAgentAt(e.clientX, e.clientY);
      this.dropOn = null;
      if (agent) { this.prompt(agent, prompt ? prompt : `Look at this:\n\`\`\`\n${text}\n\`\`\``); this.toast(`${prompt ? 'Prompt' : 'Snippet'} sent to ${this.name(agent)}`); return; }
      const w = this.toWorld(e.clientX, e.clientY);
      this.snippet(text, w, prompt ? 'prompt' : null);
    });
    // HUD
    this.$('.st-seg').onclick = (e) => { const b = e.target.closest('button'); if (b) this.hudAction(b); };
    // tray
    this.$('.st-thead .lbl').onclick = () => this.toggleTray();
    this.$('.st-thead .golive').onclick = () => this.scrub(null);
    this.$('.st-thead .prev').onclick = () => this.step(-1);
    this.$('.st-thead .next').onclick = () => this.step(1);
    this.$('.st-thead .play').onclick = () => this.togglePlay();
    this.on(this.tl, 'pointerdown', (e) => { this.stopPlay(); this.tlDrag = true; this.tl.setPointerCapture(e.pointerId); this.scrubAtX(e.clientX); });
    this.on(this.tl, 'pointermove', (e) => { if (this.tlDrag) this.scrubAtX(e.clientX); });
    this.on(this.tl, 'pointerup', () => { this.tlDrag = false; });
    this.on(this.$('.st-tgrip'), 'pointerdown', (e) => {
      e.preventDefault();
      const y0 = e.clientY, h0 = this.trayH;
      const mv = (ev) => { this.trayH = clamp(h0 + (y0 - ev.clientY), 120, innerHeight - 160); this.trayOff = false; this.applyTray(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); localStorage.setItem('studio.trayH', this.trayH); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    this.on(this.tbody, 'scroll', () => this.lazyDiffs());
  }
  on(t, ev, fn, o) { t.addEventListener(ev, fn, o); (this.offs ||= []).push(() => t.removeEventListener(ev, fn, o)); }
  destroy() {
    for (const f of this.offs || []) f();
    for (const b of this.bodies.values()) b.destroy?.();
    clearInterval(this.tick);
    this.stopPlay();
    this.saver?.wake();
    this.saveCam();
    this.ctx.post('/api/studio/target', {}).catch(() => {});
  }
  toast(msg, err) {
    const t = el('div', 'st-toast' + (err ? ' err' : ''), esc(msg));
    this.r.append(t);
    setTimeout(() => t.remove(), err ? 4500 : 2200);
  }

  // ================================================================ data
  async load() {
    try {
      const st = await this.ctx.get(`/api/studio?format=json&doc=${encodeURIComponent(this.docId)}`);
      this.presets = st.presets || {};
      this.gates = st.gates || [];
      this.$('.st-brand .root').textContent = st.root || 'draw a box to start — the first one creates a demo repo';
      this.$('.st-brand .root').title = st.root || '';
      const [timeline] = await Promise.all([this.ctx.get(`/api/studio/timeline?doc=${encodeURIComponent(this.docId)}`), ...st.agents.map((a) => this.loadAgent(a))]);
      this.timeline = timeline;
      for (const a of this.doc.agents) this.updateAgent(a.id);
      if (st.target?.id) this.setTarget(st.target, true);
      this.renderGates(); this.renderTray(); this.renderTimelineHead();
      if (!this.hadCam && this.doc.agents.length) this.fit(false);
    } catch (e) { this.toast(e.message, true); }
  }
  async loadAgent(info) {
    const r = this.rtOf(info.id);
    r.info = info;
    const [events, mons] = await Promise.all([this.ctx.get(`/api/studio/events?agent=${info.id}&before=999999999999&limit=600`), this.ctx.get(`/api/studio/monitors?agent=${info.id}`)]);
    r.events = events; r.bySeq = new Map(events.map((e) => [e.seq, e])); r.mons = mons;
    r.loaded = true;
    this.renderLog(info.id);
  }
  rtOf(id) {
    let r = this.rt.get(id);
    if (!r) { r = { info: { id, status: 'stopped', lights: [], snapshots: [], plan: null, subtitle: '' }, events: [], bySeq: new Map(), nodes: new Map(), mons: [] }; this.rt.set(id, r); }
    return r;
  }
  get doc() { return this.ctx.doc; }
  agentDef(id) { return this.doc.agents.find((a) => a.id === id); }
  color(id) { return this.agentDef(id)?.color || '#71717a'; }
  name(id) { return this.agentDef(id)?.name || id; }
  snapsOf(id) { return this.timeline.filter((s) => s.agent === id); }
  snapAt(id) {
    const s = this.snapsOf(id);
    if (this.T == null) return s.at(-1) || null;
    let best = null;
    for (const x of s) if (x.ts <= this.T) best = x;
    return best;
  }
  lightsAt(id) {
    const r = this.rtOf(id);
    if (this.T == null) return r.info.lights || [];
    const s = this.snapAt(id);
    if (!s) return [];
    const m = new Map();
    for (const x of r.mons) if (x.snap <= s.n && x.level !== 'running') m.set(x.monitor, x);
    return [...m.values()];
  }

  // ================================================================ studio events (live)
  onStudio(e) {
    if (e.doc && e.doc !== this.docId && e.kind !== 'gates') return;
    if (e.kind === 'term' || e.kind === 'snapshot') for (const b of this.bodies.values()) b.studio?.(e);
    if (e.kind === 'term') return;
    if (e.kind === 'view') return this.onView(e);
    if (e.kind === 'panel') return this.streamPanel(e);
    if (e.kind === 'gates') { this.gates = (e.gates || []).filter((g) => this.agentDef(g.agent)); this.renderGates(); for (const a of this.doc.agents) this.renderHeader(a.id); return; }
    const id = e.agent;
    if (!id || !this.agentDef(id)) return;
    const r = this.rtOf(id);
    switch (e.kind) {
      case 'status': r.info.status = e.status; r.info.turn = e.turn; if (e.error) r.info.error = e.error; this.renderHeader(id); this.renderFoot(id); break;
      case 'queue': r.info.queue = e.queue; this.renderFoot(id); break;
      case 'chunk': this.addChunk(id, e); break;
      case 'event': case 'tool': this.addEvent(id, e.event); break;
      case 'plan': r.info.plan = e.plan; this.renderPlan(id); break;
      case 'snapshot': {
        this.timeline.push({ agent: id, ...e.snap });
        r.info.snapshots = [...(r.info.snapshots || []), e.snap];
        this.renderSide(id); this.renderTimelineHead(); this.appendCard(this.timeline.at(-1));
        break;
      }
      case 'monitor': {
        r.mons.push({ snap: e.snap, monitor: e.monitor, level: e.level, summary: e.summary });
        const L = r.info.lights || (r.info.lights = []);
        const i = L.findIndex((x) => x.monitor === e.monitor);
        const m = { monitor: e.monitor, level: e.level, summary: e.summary, snap: e.snap };
        if (i >= 0) L[i] = m; else L.push(m);
        this.renderHeader(id); this.renderSide(id); this.markCard(id, e.snap);
        break;
      }
      case 'say': r.info.subtitle = e.text; this.renderFoot(id); this.subtitle(id, e.text); if (this.saver?.on) this.saver.paint(); break;
      case 'mode': r.info.mode = e.mode; break;
    }
  }
  /** Display commands from agents and scripts (POST /api/studio/view). Layout changes already arrived as ops. */
  onView(e) {
    if (e.mode && !e.report) this.setMode(e.mode);
    if (e.theme) this.setTheme(e.theme);
    if (e.tray != null && !!e.tray === this.trayOff) this.toggleTray();
    if (e.idle === true) this.saver.sleep(); else if (e.idle === false) this.saver.wake();
    if (e.scrub === null) this.scrub(null);
    else if (e.scrub?.agent != null) { this.setFilter(e.scrub.agent, true); this.selectSnap(e.scrub.agent, +e.scrub.snap, true); }
    const f = e.focus;
    const go = () => {
      if (f?.panel) this.zoomTo('panel', f.panel);
      else if (f?.agent) { this.zoomTo('agent', f.agent); this.setTarget({ kind: 'agent', id: f.agent }); }
      else if (e.fit) this.fit();
      if (e.tab && this.mode === 'focus') this.focus.setTab(e.tab);
    };
    if (e.report) { this.toast(`◎ ${e.reason}`); return; }   // the director only reports while you are busy
    setTimeout(go, 120);   // let the layout ops of the same command land first
    const who = e.by === 'director' ? 'Director' : e.by?.startsWith('agent:') ? this.name(e.by.slice(6)) : e.by;
    if (e.by && e.by !== 'user' && (f || e.fit || e.reason || e.mode)) this.toast(`◎ ${who}${e.reason ? ': ' + e.reason : ' changed the view'}`);
  }

  addChunk(id, e) {
    const r = this.rtOf(id);
    let ev = r.bySeq.get(e.seq);
    if (!ev) {
      ev = { seq: e.seq, ts: e.ts, kind: e.msg, text: e.text, turn: e.turn };
      r.events.push(ev); r.bySeq.set(e.seq, ev);
      this.logAppend(id, this.eventNode(id, ev));
      return;
    }
    ev.text += e.text;
    const node = r.nodes.get(e.seq);
    if (!node || this.T != null) return;
    const log = node.parentElement;
    const stick = log && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (ev.kind === 'agent') node.innerHTML = md(ev.text); else node.textContent = ev.text;
    if (stick) log.scrollTop = log.scrollHeight;
  }

  // ================================================================ layout sync (the versioned doc)
  syncLayout(full) {
    const d = this.doc;
    if (!d) return;
    const ids = new Set(d.agents.map((a) => a.id));
    for (const [id, node] of this.agentEls) if (!ids.has(id)) { node.remove(); this.agentEls.delete(id); }
    let missing = false;
    for (const a of d.agents) {
      let node = this.agentEls.get(a.id);
      if (!node) { node = this.makeAgent(a); this.agentEls.set(a.id, node); this.world.append(node); if (!this.rt.has(a.id)) missing = true; this.renderLog(a.id); }
      if (!(this.drag && this.drag.id === a.id)) Object.assign(node.style, { left: a.x + 'px', top: a.y + 'px', width: a.w + 'px', height: a.h + 'px' });
      node.style.setProperty('--c', a.color);
      this.updateAgent(a.id);
    }
    const pids = new Set(d.panels.map((p) => p.id));
    for (const [id, node] of this.panelEls) if (!pids.has(id)) { node.remove(); this.panelEls.delete(id); this.bodies.get(id)?.destroy?.(); this.bodies.delete(id); }
    for (const p of d.panels) {
      let node = this.panelEls.get(p.id);
      if (node && node.dataset.kind !== p.kind) { node.remove(); this.bodies.get(p.id)?.destroy?.(); this.bodies.delete(p.id); node = null; }
      if (!node) { node = this.makePanel(p); this.panelEls.set(p.id, node); this.world.append(node); const b = mountBody(this, node, p); if (b) this.bodies.set(p.id, b); }
      if (!(this.drag && this.drag.id === p.id)) Object.assign(node.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px' });
      node.style.setProperty('--c', p.color || (p.source?.agent ? this.color(p.source.agent) : '#a1a1aa'));
      node.className = node.className.replace(/\b(note|review|prompt|sql|snippet|terminal|preview|map)\b/g, '').trim() + ' ' + p.kind;
      const ti = node.querySelector('.t');
      if (document.activeElement !== ti && ti.value !== p.title) ti.value = p.title;
      const ta = node.querySelector('textarea');
      if (ta && document.activeElement !== ta && !node.classList.contains('streaming') && ta.value !== p.text) ta.value = p.text;
      this.bodies.get(p.id)?.update?.(p);
    }
    this.focus?.place();
    this.renderLinks();
    this.render();
    this.renderDirector?.();
    if (missing) this.refreshState();
    if (full) this.$('.st-brand .root').textContent = d.root || this.$('.st-brand .root').textContent;
    this.renderFilter();
  }
  refreshState() {
    clearTimeout(this.rsTimer);
    this.rsTimer = setTimeout(async () => {
      try {
        const st = await this.ctx.get(`/api/studio?format=json&doc=${encodeURIComponent(this.docId)}`);
        this.presets = st.presets || this.presets;
        this.$('.st-brand .root').textContent = st.root || '';
        for (const info of st.agents) if (!this.rtOf(info.id).loaded) await this.loadAgent(info); else this.rtOf(info.id).info = { ...this.rtOf(info.id).info, ...info };
        this.timeline = await this.ctx.get(`/api/studio/timeline?doc=${encodeURIComponent(this.docId)}`);
        for (const a of this.doc.agents) this.updateAgent(a.id);
        this.renderTray(); this.renderTimelineHead();
      } catch (e) { this.toast(e.message, true); }
    }, 200);
  }

  // ================================================================ camera
  loadCam() { try { return JSON.parse(localStorage.getItem('studio.cam.' + this.docId) || 'null'); } catch { return null; } }
  saveCam() { try { localStorage.setItem('studio.cam.' + this.docId, JSON.stringify(this.cam)); } catch {} }
  box() { return this.canvas.getBoundingClientRect(); }
  toWorld(sx, sy) { const b = this.box(); return { x: this.cam.x + (sx - b.left) / this.cam.z, y: this.cam.y + (sy - b.top) / this.cam.z }; }
  render() {
    const { x, y, z } = this.cam;
    this.world.style.transform = `translate(${-x * z}px, ${-y * z}px) scale(${z})`;
    this.world.style.setProperty('--inv', String(1 / z));
    const g = 22 * z;
    this.grid.style.backgroundSize = `${g}px ${g}px`;
    this.grid.style.backgroundPosition = `${-x * z % g}px ${-y * z % g}px`;
    this.$('.st-seg .z').textContent = `${Math.round(z * 100)}%`;
    for (const a of this.doc?.agents || []) {
      const n = this.agentEls.get(a.id);
      if (!n) continue;
      const sw = n.classList.contains('in-focus') ? 1e4 : a.w * z;
      const lod = sw < 280 ? 'chip' : sw < 430 ? 'card' : 'full';
      if (n.dataset.lod !== lod) { n.dataset.lod = lod; n.classList.remove('lod-chip', 'lod-card', 'lod-full'); n.classList.add('lod-' + lod); }
      n.classList.toggle('narrow', sw < 600);
    }
    for (const p of this.doc?.panels || []) { const n = this.panelEls.get(p.id); if (n) n.classList.toggle('lod-chip', !p.float && !n.classList.contains('in-pane') && p.w * z < 200); }
    clearTimeout(this.camTimer);
    this.camTimer = setTimeout(() => this.saveCam(), 400);
  }
  zoomAt(sx, sy, z) {
    const w = this.toWorld(sx, sy), b = this.box();
    this.cam.z = clamp(z, 0.05, 3);
    this.cam.x = w.x - (sx - b.left) / this.cam.z;
    this.cam.y = w.y - (sy - b.top) / this.cam.z;
    this.render();
  }
  flyTo(rect, pad = 60, animate = true) {
    const b = this.box();
    const side = this.gates.length && b.width > 1100 ? 340 : 0;
    const W = b.width - side;
    const z = clamp(Math.min(W / (rect.w + pad * 2), b.height / (rect.h + pad * 2)), 0.05, 1.6);
    const to = { z, x: rect.x + rect.w / 2 - W / 2 / z, y: rect.y + rect.h / 2 - b.height / 2 / z };
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { this.cam = to; return this.render(); }
    const from = { ...this.cam }, t0 = performance.now(), D = 340;
    cancelAnimationFrame(this.fly);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3);
      const zz = Math.exp(Math.log(from.z) + (Math.log(to.z) - Math.log(from.z)) * e);
      const cx0 = from.x + W / 2 / from.z, cy0 = from.y + b.height / 2 / from.z, cx1 = to.x + W / 2 / to.z, cy1 = to.y + b.height / 2 / to.z;
      const cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
      this.cam = { z: zz, x: cx - W / 2 / zz, y: cy - b.height / 2 / zz };
      this.render();
      if (k < 1) this.fly = requestAnimationFrame(step);
    };
    this.fly = requestAnimationFrame(step);
  }
  fit(animate = true) {
    if (this.mode === 'focus') return;
    const items = [...this.doc.agents, ...this.doc.panels.filter((p) => !p.float)];
    if (!items.length) return this.flyTo({ x: 0, y: 0, w: 1200, h: 700 }, 40, animate);
    const x1 = Math.min(...items.map((i) => i.x)), y1 = Math.min(...items.map((i) => i.y));
    const x2 = Math.max(...items.map((i) => i.x + i.w)), y2 = Math.max(...items.map((i) => i.y + i.h));
    this.flyTo({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, 80, animate);
  }
  zoomTo(kind, id) {
    if (this.mode === 'focus') return this.focus.reveal(kind, id);
    const it = kind === 'panel' ? this.doc.panels.find((p) => p.id === id) : this.agentDef(id);
    if (it?.float) return this.focus.reveal('panel', id);
    if (it) this.flyTo(it, 40);
  }

  // ================================================================ pointer
  onWheel(e) {
    e.preventDefault();
    const sc = e.target.closest('.st-log,.st-files,textarea,.st-term');
    if (sc && !e.ctrlKey && !e.metaKey && sc.scrollHeight > sc.clientHeight + 2 && this.cam.z > 0.45) { sc.scrollTop += e.deltaY; return; }
    if (e.ctrlKey || e.metaKey || e.altKey) { this.zoomAt(e.clientX, e.clientY, this.cam.z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022))); return; }
    const k = e.deltaMode ? 30 : 1;
    this.cam.x += (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k / this.cam.z;
    this.cam.y += (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k / this.cam.z;
    this.render();
  }
  hit(sx, sy) {
    const w = this.toWorld(sx, sy);
    for (const p of [...this.doc.panels].reverse()) if (!p.float && w.x >= p.x && w.x <= p.x + p.w && w.y >= p.y && w.y <= p.y + p.h) return { kind: 'panel', id: p.id };
    for (const a of [...this.doc.agents].reverse()) if (w.x >= a.x && w.x <= a.x + a.w && w.y >= a.y && w.y <= a.y + a.h) return { kind: 'agent', id: a.id };
    return null;
  }
  hitAgentAt(sx, sy) {
    const w = this.toWorld(sx, sy);
    return [...this.doc.agents].reverse().find((a) => w.x >= a.x && w.x <= a.x + a.w && w.y >= a.y && w.y <= a.y + a.h)?.id || null;
  }
  onDown(e) {
    const titleGrip = e.target.closest('.st-ph .t') && document.activeElement !== e.target;
    if (!titleGrip && e.target.closest('button,textarea,input,select,a,.ev.tool,.st-files .f,.st-snaps i,.st-term,.st-map svg,.st-frame,.ev.user > div')) return;
    const onBox = e.target.closest('.st-agent,.st-panel');
    const b = this.box();
    const sx = e.clientX - b.left, sy = e.clientY - b.top;
    if (e.button === 1 || this.space || (!onBox && e.button === 0 && !e.shiftKey && !this.drawMode)) {
      e.preventDefault();
      this.pan = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y };
      this.canvas.classList.add('panning');
      return;
    }
    if (!onBox && e.button === 0 && (e.shiftKey || this.drawMode)) {
      e.preventDefault();
      const band = el('div', 'st-band', '<span>new agent</span>');
      this.canvas.append(band);
      this.band = { x0: sx, y0: sy, el: band };
      this.drawBand(sx, sy);
      return;
    }
    if (!onBox || e.button !== 0) return;
    const isAgent = onBox.classList.contains('st-agent');
    const id = onBox.dataset.id;
    const grip = e.target.closest('.st-ah,.chip,.st-ph');
    const resize = e.target.closest('.st-resize');
    if (!grip && !resize) return;
    e.preventDefault();
    const it = isAgent ? this.agentDef(id) : this.doc.panels.find((p) => p.id === id);
    this.drag = { kind: isAgent ? 'agent' : 'panel', id, el: onBox, mode: resize ? 'resize' : 'move', x: e.clientX, y: e.clientY, it: { ...it }, moved: false };
    if (!isAgent) onBox.classList.add('dragging');
  }
  onMove(e) {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (this.pan) {
      this.cam.x = this.pan.cx - (e.clientX - this.pan.x) / this.cam.z;
      this.cam.y = this.pan.cy - (e.clientY - this.pan.y) / this.cam.z;
      this.render();
      return;
    }
    if (this.band) { const b = this.box(); this.drawBand(e.clientX - b.left, e.clientY - b.top); return; }
    if (this.drag) {
      const d = this.drag, dx = (e.clientX - d.x) / this.cam.z, dy = (e.clientY - d.y) / this.cam.z;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      if (d.mode === 'move') Object.assign(d.el.style, { left: Math.round(d.it.x + dx) + 'px', top: Math.round(d.it.y + dy) + 'px' });
      else Object.assign(d.el.style, { width: Math.max(160, Math.round(d.it.w + dx)) + 'px', height: Math.max(100, Math.round(d.it.h + dy)) + 'px' });
      if (d.kind === 'panel' && d.mode === 'move' && TEXT_KINDS.has(this.doc.panels.find((p) => p.id === d.id)?.kind)) {
        const h = this.hitAgentAt(e.clientX, e.clientY);
        if (h !== d.dropOn) { if (d.dropOn) this.agentEls.get(d.dropOn)?.classList.remove('drop'); d.dropOn = h; if (h) this.agentEls.get(h)?.classList.add('drop'); }
      }
      this.renderLinks();
      return;
    }
    if (!this.r.contains(e.target) || !e.target.closest('.st-canvas')) return;
    const h = this.hit(e.clientX, e.clientY);
    if ((h?.id || null) !== (this.hover?.id || null)) {
      for (const n of this.world.querySelectorAll('.hot')) n.classList.remove('hot');
      this.hover = h;
      if (h) (h.kind === 'agent' ? this.agentEls : this.panelEls).get(h.id)?.classList.add('hot');
      if (h) this.setTarget(h);
    }
  }
  onUp(e) {
    if (this.pan) { this.pan = null; this.canvas.classList.remove('panning'); return; }
    if (this.band) {
      const { x0, y0, el: band } = this.band;
      band.remove();
      this.band = null; this.drawMode = false; this.canvas.classList.remove('drawing');
      const b = this.box();
      const x1 = e.clientX - b.left, y1 = e.clientY - b.top;
      const a = this.toWorld(Math.min(x0, x1) + b.left, Math.min(y0, y1) + b.top), c = this.toWorld(Math.max(x0, x1) + b.left, Math.max(y0, y1) + b.top);
      let rect = { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(c.x - a.x), h: Math.round(c.y - a.y) };
      if (rect.w < 160 || rect.h < 120) rect = { x: Math.round(a.x), y: Math.round(a.y), w: 640, h: 480 };
      this.picker(rect, e.clientX, e.clientY);
      return;
    }
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      d.el.classList.remove('dragging');
      if (!d.moved) return;
      const L = parseFloat(d.el.style.left), T = parseFloat(d.el.style.top), W = parseFloat(d.el.style.width), H = parseFloat(d.el.style.height);
      if (d.kind === 'panel' && d.dropOn) {
        this.agentEls.get(d.dropOn)?.classList.remove('drop');
        Object.assign(d.el.style, { left: d.it.x + 'px', top: d.it.y + 'px' });
        this.sendPanel(d.id, d.dropOn);
        return;
      }
      const set = d.mode === 'move' ? { x: Math.round(L), y: Math.round(T) } : { w: Math.round(W), h: Math.round(H) };
      this.ctx.submit([{ op: d.kind === 'agent' ? 'updateAgent' : 'updatePanel', id: d.id, set }], d.mode);
      this.syncLayout();
    }
  }
  drawBand(x, y) {
    const { x0, y0, el: b } = this.band;
    Object.assign(b.style, { left: Math.min(x0, x) + 'px', top: Math.min(y0, y) + 'px', width: Math.abs(x - x0) + 'px', height: Math.abs(y - y0) + 'px' });
  }
  setTarget(t, quiet) {
    if (!t || (this.target && this.target.id === t.id)) return;
    this.target = { kind: t.kind, id: t.id };
    const p = t.kind === 'panel' ? this.doc.panels.find((x) => x.id === t.id) : null;
    const name = t.kind === 'agent' ? this.name(t.id) : p?.title || p?.kind || 'panel';
    const col = t.kind === 'agent' ? this.color(t.id) : p?.color || '#a1a1aa';
    this.$('.st-target .chip').innerHTML = `<i style="background:${esc(col)}"></i>${esc(name)}`;
    if (quiet) return;
    clearTimeout(this.tgTimer);
    this.tgTimer = setTimeout(() => this.ctx.post('/api/studio/target', { doc: this.docId, ...this.target }).catch(() => {}), 120);
  }

  // ================================================================ keys
  onKey(e) {
    if (e.target.closest?.('textarea,input,.vt')) return;
    if (this.mode === 'focus' && !e.metaKey && !e.ctrlKey && !e.altKey && this.focus.onKey(e)) return;
    if (e.code === 'Space' && !e.repeat) { this.space = true; e.preventDefault(); return; }
    const k = e.key, h = this.hover;
    const agent = h?.kind === 'agent' ? h.id : null;
    if (e.metaKey || e.ctrlKey) {
      const b = this.box();
      if (k === '0') { e.preventDefault(); this.fit(); }
      else if (k === '=' || k === '+') { e.preventDefault(); this.zoomAt(b.left + b.width / 2, b.top + b.height / 2, this.cam.z * 1.25); }
      else if (k === '-') { e.preventDefault(); this.zoomAt(b.left + b.width / 2, b.top + b.height / 2, this.cam.z / 1.25); }
      return;
    }
    if (e.altKey) {
      const target = agent || (this.target?.kind === 'agent' ? this.target.id : null);
      if (!target) return;
      e.preventDefault();
      ({ KeyR: () => this.review(target), KeyF: () => this.fork(target), KeyZ: () => this.zoomTo('agent', target), KeyS: () => this.startStop(target), Period: () => this.cancel(target), KeyT: () => this.openKind('terminal', target), KeyM: () => this.openKind('map', target), KeyD: () => this.setFilter(target) })[e.code]?.();
      return;
    }
    if (k === 'Escape') {
      if (this.closeOverlays()) return;
      if (this.playing) return this.stopPlay();
      if (this.T != null) return this.scrub(null);
      return this.fit();
    }
    // a text selection anywhere + S → a snippet panel on the canvas
    const selText = window.getSelection()?.toString();
    if ((k === 's' || k === 'S') && selText?.trim()) { e.preventDefault(); return this.snippet(selText, this.toWorld(this.mouse.x, this.mouse.y)); }
    if (k === '[') return this.step(-1);
    if (k === ']') return this.step(1);
    if (k === '?') return this.help();
    if (k === 'Enter' || k === '/') { e.preventDefault(); return this.openInput(h || this.target, ''); }
    const perm = agent && this.gates.find((g) => g.agent === agent && g.kind === 'permission');
    if (perm && /^[yan]$/i.test(k)) {
      const want = { y: 'allow_once', a: 'allow_always', n: 'reject_once' }[k.toLowerCase()];
      const o = perm.json.options.find((x) => x.kind === want) || perm.json.options.find((x) => x.kind?.startsWith(k.toLowerCase() === 'n' ? 'reject' : 'allow'));
      if (o) { e.preventDefault(); return this.answer(perm.id, o.optionId); }
    }
    const printable = k.length === 1 && !e.repeat;
    if (h?.kind === 'agent' && printable) { e.preventDefault(); return this.openInput(h, k); }
    if (h?.kind === 'panel' && printable) {
      const n = this.panelEls.get(h.id);
      const ta = n?.querySelector('textarea');
      if (ta) { e.preventDefault(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.setRangeText(k, ta.value.length, ta.value.length, 'end'); ta.dispatchEvent(new Event('input')); return; }
      const vt = n?.querySelector('.vt');
      if (vt) { e.preventDefault(); vt.focus(); this.bodies.get(h.id)?.focus?.(); vt.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); return; }
      return;
    }
    switch (k) {
      case 'n': this.drawMode = true; this.canvas.classList.add('drawing'); this.toast('Drag a box for the new agent (Esc cancels)'); return;
      case 't': { const w = this.toWorld(this.mouse.x, this.mouse.y); return this.newPanel({ x: w.x - 20, y: w.y - 20, focus: true }); }
      case 'g': return this.nextGate();
      case 'b': return this.toggleTray();
      case 'l': return this.arrangeMenu(this.$('[data-h="arrange"]'));
      case 'p': return this.togglePlay();
      case 'd': return this.directorMenu(this.$('[data-h="director"]'));
      case '0': return this.fit();
    }
    if (printable && /\S/.test(k)) { e.preventDefault(); this.openInput(null, k); }
  }
  closeOverlays() {
    let any = false;
    for (const s of ['.st-input', '.st-spot', '.st-pick', '.st-help-ov']) { const n = this.r.querySelector(s); if (n) { n.remove(); any = true; } }
    if (this.drawMode) { this.drawMode = false; this.canvas.classList.remove('drawing'); any = true; }
    if (any) this.r.focus({ preventScroll: true });
    return any;
  }

  // ================================================================ agent boxes
  makeAgent(a) {
    const n = el('div', 'st-agent lod-full');
    n.dataset.id = a.id;
    n.innerHTML = `
      <div class="chip"><div class="nm"><i></i><span></span></div><span class="pill"></span><div class="lights"></div><div class="g"></div><div class="say"></div></div>
      <div class="st-ah"><span class="dot"></span><span class="nm"></span><span class="pill"></span><span class="meta"></span><span class="grow"></span><div class="lights"></div>
        <div class="acts"><button data-a="run" title="Start / stop (⌥S)">▶</button><button data-a="review" title="Review the changes (⌥R)">✓</button><button data-a="fork" title="Fork at the scrub point (⌥F)">⑂</button><button data-a="term" title="Terminal in this worktree (⌥T)">⌨</button><button data-a="zoom" title="Zoom (⌥Z)">⤢</button><button data-a="more" title="More">⋯</button></div></div>
      <div class="st-why" hidden></div>
      <div class="st-ab"><div class="st-main"><div class="st-plan" hidden><div class="bar"><b></b></div><ol></ol></div><div class="st-log"></div></div>
        <div class="st-side"><h5>Files <span class="fc"></span></h5><div class="st-files"></div><h5>Monitors</h5><div class="st-mons"></div><div class="st-snaps"></div></div></div>
      <div class="st-foot"><span class="say"></span><span class="q"></span></div>
      <div class="st-resize"></div>`;
    n.querySelector('.st-ah .acts').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      ({ run: () => this.startStop(a.id), review: () => this.review(a.id), fork: () => this.fork(a.id), term: () => this.openKind('terminal', a.id), zoom: () => this.zoomTo('agent', a.id), more: () => this.moreMenu(a.id, b) })[b.dataset.a]?.();
    };
    n.querySelector('.chip').ondblclick = () => this.zoomTo('agent', a.id);
    n.querySelector('.st-ah').ondblclick = (e) => { if (!e.target.closest('button')) this.zoomTo('agent', a.id); };
    n.querySelector('.st-log').onclick = (e) => {
      const rw = e.target.closest('.rw');
      if (rw) return this.rewindMenu(a.id, +rw.dataset.turn, rw);
      const t = e.target.closest('.ev.tool');
      if (t) return this.openTool(a.id, +t.dataset.seq);
      const b = e.target.closest('[data-gate]');
      if (b) this.answer(b.dataset.gate, b.dataset.opt);
    };
    n.querySelector('.st-files').onclick = (e) => { const f = e.target.closest('.f'); if (f) this.showFile(a.id, f.dataset.path); };
    n.querySelector('.st-snaps').onclick = (e) => { const s = e.target.closest('i'); if (s) this.selectSnap(a.id, +s.dataset.n); };
    return n;
  }
  updateAgent(id) { this.renderHeader(id); this.renderPlan(id); this.renderSide(id); this.renderFoot(id); }
  renderHeader(id) {
    const n = this.agentEls.get(id), a = this.agentDef(id);
    if (!n || !a) return;
    const r = this.rtOf(id), st = r.info.status || 'stopped';
    n.className = n.className.replace(/\bs-\w+/g, '').trim() + ' s-' + st;
    for (const q of n.querySelectorAll('.nm span, .st-ah .nm')) q.textContent = a.name;
    for (const p of n.querySelectorAll('.pill')) { p.className = 'pill ' + st; p.textContent = st === 'working' && r.info.turn ? `working · ${r.info.turn}` : st; }
    const parent = a.forkOf ? `${a.forkOf.kind === 'spawn' ? '↳' : '⑂'} ${this.name(a.forkOf.agent)}${a.forkOf.snap != null ? '#' + a.forkOf.snap : ''}${a.forkOf.mode === 'same' ? ' · same folder' : ''}` : null;
    const meta = [a.role, a.branch, parent, a.sparse?.length ? `sparse: ${a.sparse.join(', ')}` : null, r.info.agentInfo?.name].filter(Boolean).join(' · ');
    const m = n.querySelector('.meta'); m.textContent = meta; m.title = a.cwd || '';
    const why = n.querySelector('.st-why');
    why.hidden = !a.why;
    if (a.why) why.innerHTML = `<b>${a.forkOf?.by?.startsWith('agent') ? `${esc(this.name(a.forkOf.agent))} spun this off` : 'Why this box'}:</b> ${esc(a.why)}`;
    const lights = this.lightsAt(id).filter((x) => x.level !== 'skip').sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level]);
    const loud = lights.filter((x) => x.level !== 'green'), greens = lights.length - loud.length;
    const html = loud.map((x) => `<span class="light ${x.level}" title="${esc(x.monitor)}: ${esc(x.summary || '')}"><i></i>${esc(x.monitor)}</span>`).join('') + (greens ? `<span class="light green" title="${esc(lights.filter((x) => x.level === 'green').map((x) => x.monitor).join(', '))}"><i></i>${loud.length ? greens : 'all ' + greens}</span>` : '');
    for (const L of n.querySelectorAll('.lights')) L.innerHTML = html;
    const g = this.gates.filter((x) => x.agent === id && x.kind !== 'info');
    n.querySelector('.chip .g').textContent = g.length ? `${g.some((x) => x.blocking) ? '■' : '□'} ${g[0].kind === 'permission' ? 'asks: ' : ''}${g[0].title}` : '';
    n.querySelector('[data-a="run"]').textContent = ['stopped', 'error'].includes(st) ? '▶' : '■';
    this.focus?.dirty();
  }
  renderPlan(id) {
    const n = this.agentEls.get(id);
    if (!n) return;
    const plan = this.rtOf(id).info.plan;
    const box = n.querySelector('.st-plan');
    box.hidden = !plan?.length;
    if (!plan?.length) return;
    const done = plan.filter((p) => p.status === 'completed').length;
    box.querySelector('.bar b').style.width = `${(done / plan.length) * 100}%`;
    box.querySelector('ol').innerHTML = plan.map((p) => `<li class="${esc(p.status)}">${esc(p.content)}</li>`).join('');
  }
  renderFoot(id) {
    const n = this.agentEls.get(id);
    if (!n) return;
    const r = this.rtOf(id);
    const say = r.info.status === 'error' ? `✗ ${r.info.error || 'error'}` : r.info.subtitle || (r.info.status === 'stopped' ? 'Stopped — ▶ to start, or just type to it' : '');
    n.querySelector('.st-foot .say').textContent = say;
    n.querySelector('.chip .say').textContent = r.info.subtitle || '';
    n.querySelector('.st-foot .q').textContent = r.info.queue ? `+${r.info.queue} queued` : '';
    this.focus?.dirty();
  }
  renderSide(id) {
    const n = this.agentEls.get(id);
    if (!n) return;
    const snaps = this.snapsOf(id), cur = this.snapAt(id);
    const files = new Map();
    for (const s of snaps) {
      if (cur && s.n > cur.n) break;
      for (const f of s.files || []) {
        const o = files.get(f.path) || { path: f.path, adds: 0, dels: 0, status: f.status, n: s.n };
        o.adds += f.adds; o.dels += f.dels; o.n = s.n;
        if (f.status === 'D') o.status = 'D'; else if (o.status === 'D') o.status = 'M';
        files.set(f.path, o);
      }
    }
    const list = [...files.values()].sort((a, b) => b.n - a.n);
    n.querySelector('.fc').textContent = list.length ? `${list.length} · +${list.reduce((s, f) => s + f.adds, 0)} −${list.reduce((s, f) => s + f.dels, 0)}` : '';
    n.querySelector('.st-files').innerHTML = list.length ? list.map((f) => `<div class="f" data-path="${esc(f.path)}" title="${esc(f.path)}"><span class="p st-${f.status}">${esc(f.path)}</span><span class="a">+${f.adds}</span><span class="d">−${f.dels}</span></div>`).join('') : '<div style="color:var(--dim);font-size:11.5px;padding:4px 8px">No changes yet</div>';
    const lights = this.lightsAt(id).filter((x) => x.level !== 'skip').sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level]);
    n.querySelector('.st-mons').innerHTML = lights.map((x) => `<div class="m ${x.level}" title="${esc(x.summary || '')}"><i></i><b>${esc(x.monitor)}</b><span>${esc(x.summary || '')}</span></div>`).join('') || '<div style="color:var(--dim);font-size:11.5px">Checked on every snapshot</div>';
    const redAt = new Set(this.rtOf(id).mons.filter((m) => m.level === 'red').map((m) => m.snap));
    this.focus?.dirty();
    n.querySelector('.st-snaps').innerHTML = snaps.map((s) => `<i data-n="${s.n}" class="${cur && s.n === cur.n && this.T != null ? 'on' : ''} ${redAt.has(s.n) ? 'red' : ''}" title="#${s.n} ${esc(s.reason || '')} · +${s.adds} −${s.dels}"></i>`).join('');
  }

  // ---------------------------------------------------------------- transcript
  renderLog(id) {
    const n = this.agentEls.get(id);
    if (!n) return;
    const log = n.querySelector('.st-log');
    const r = this.rtOf(id);
    r.nodes = new Map();
    log.innerHTML = '';
    const evs = this.T == null ? r.events : r.events.filter((e) => (e.ts || 0) <= this.T);
    // turns a conversation rewind took back stay visible, greyed: [cut, rewind event)
    const gone = evs.filter((e) => e.kind === 'rewind' && e.json?.mode !== 'files' && e.json?.cut != null).map((e) => [e.json.cut, e.seq]);
    for (const ev of evs.slice(-400)) {
      const node = this.eventNode(id, ev);
      if (ev.seq != null && gone.some(([a, b]) => ev.seq >= a && ev.seq < b)) node.classList.add('rewound');
      log.append(node);
    }
    if (!r.events.length) log.innerHTML = `<div class="ev system" style="color:var(--dim)">${esc(this.agentDef(id)?.cwd || '')}<br>Point here and type to give ${esc(this.name(id))} a task.</div>`;
    log.scrollTop = log.scrollHeight;
  }
  eventNode(id, ev) {
    let node;
    switch (ev.kind) {
      case 'user': {
        node = el('div', 'ev user', `${ev.turn ? `<button class="rw" data-turn="${ev.turn}" title="Rewind to before this message — the conversation, the files, or both">⟲</button>` : ''}<div draggable="true" title="Drag onto another box to send it there, or onto the canvas">${esc(ev.text)}<small>${esc(ev.json?.by && ev.json.by !== 'user' ? ev.json.by + ' · ' : '')}${hhmm(ev.ts)}</small></div>`);
        node.lastChild.dataset.text = ev.text;
        break;
      }
      case 'agent': node = el('div', 'ev agent', md(ev.text)); break;
      case 'thought': node = el('div', 'ev thought', esc(ev.text)); break;
      case 'tool': {
        node = el('div', 'ev tool', `<span class="k">${ev.title?.startsWith('studio_') ? '◫' : TOOL_ICON[ev.toolKind] || '•'}</span><span class="t"></span><span class="s ${esc(ev.status)}">${ev.status === 'completed' ? '✓' : ev.status === 'failed' ? '✗' : '…'}</span>`);
        node.querySelector('.t').textContent = ev.title || ev.toolId || 'tool';
        node.dataset.seq = ev.seq;
        const out = (ev.json?.content || []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n');
        if (out && ev.toolKind !== 'read') { const w = el('div'); w.append(node, el('div', 'ev tool-out', esc(out.slice(0, 1200)))); node = w; }
        break;
      }
      case 'plan': node = el('div', 'ev', ''); node.hidden = true; break;
      case 'permission': {
        const g = this.gates.find((x) => x.id === ev.json?.gate);
        node = el('div', 'ev perm', `<div class="q"><b>Permission</b> · ${esc(ev.title || '')}</div>${g ? `<div class="opts">${ev.json.options.map((o) => `<button class="btn ${o.kind?.startsWith('allow') ? 'ok' : 'no'}" data-gate="${esc(g.id)}" data-opt="${esc(o.optionId)}">${esc(o.name)}${o.kind === 'allow_once' ? ' <kbd>Y</kbd>' : o.kind === 'allow_always' ? ' <kbd>A</kbd>' : o.kind === 'reject_once' ? ' <kbd>N</kbd>' : ''}</button>`).join('')}</div>` : '<div class="q" style="color:var(--dim)">answered</div>'}`);
        break;
      }
      case 'turn': node = el('div', 'ev turn', `turn ${ev.turn || ''} · ${esc(ev.status || '')}`); break;
      case 'rewind': node = el('div', `ev rewind ${esc(ev.json?.mode || '')}`, `<span>⟲ ${esc(ev.text)}</span>`); break;
      case 'error': node = el('div', 'ev error', esc(ev.text)); break;
      default: node = el('div', 'ev system', esc(ev.text || ev.kind));
    }
    if (ev.seq != null) this.rtOf(id).nodes.set(ev.seq, node);
    return node;
  }
  logAppend(id, node) {
    const log = this.agentEls.get(id)?.querySelector('.st-log');
    if (!log || this.T != null) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (log.querySelector('.ev.system:only-child')) log.innerHTML = '';
    log.append(node);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  addEvent(id, ev) {
    if (!ev) return;
    const r = this.rtOf(id);
    if (ev.seq != null && r.bySeq.has(ev.seq)) {
      Object.assign(r.bySeq.get(ev.seq), ev);
      const old = r.nodes.get(ev.seq);
      const fresh = this.eventNode(id, r.bySeq.get(ev.seq));
      if (old?.isConnected) (old.parentElement?.classList.contains('st-log') ? old : old.parentElement).replaceWith(fresh);
      return;
    }
    r.events.push(ev);
    if (ev.seq != null) r.bySeq.set(ev.seq, ev);
    if (ev.kind === 'rewind') return this.renderLog(id);
    this.logAppend(id, this.eventNode(id, ev));
    if (ev.kind === 'permission') this.renderGates();
  }

  // ================================================================ panels
  makePanel(p) {
    const n = el('div', 'st-panel ' + p.kind);
    n.dataset.id = p.id;
    n.dataset.kind = p.kind;
    const text = TEXT_KINDS.has(p.kind);
    n.innerHTML = `<div class="st-ph"><span class="kind">${esc(p.kind)}</span><input class="t" spellcheck="false" placeholder="Untitled"><button data-a="float" title="Float: pin it over the screen, in canvas and focus mode">⧉</button><button data-a="zoom" title="Zoom">⤢</button><button data-a="del" title="Delete">✕</button></div>
      ${text ? `<textarea spellcheck="false" placeholder="Write here. Drag this panel onto an agent box to send it."></textarea>
      <div class="st-pf"><span class="grow"></span><button class="btn" data-a="copy">Copy</button><button class="btn" data-a="send">Send to…</button></div>` : '<div class="st-body"></div>'}<div class="st-resize"></div>`;
    const ti = n.querySelector('.t');
    ti.value = p.title;
    ti.addEventListener('change', () => this.ctx.submit([{ op: 'updatePanel', id: p.id, set: { title: ti.value } }], 'title'));
    ti.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') ti.blur(); });
    ti.addEventListener('dblclick', () => { ti.focus(); ti.select(); });
    const ta = n.querySelector('textarea');
    if (ta) {
      ta.value = p.text;
      let tm = null;
      ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => this.ctx.submit([{ op: 'updatePanel', id: p.id, set: { text: ta.value } }], 'note'), 500); n.querySelector('.grow').textContent = 'editing…'; });
      ta.addEventListener('blur', () => { clearTimeout(tm); const cur = this.doc.panels.find((x) => x.id === p.id); if (cur && cur.text !== ta.value) this.ctx.submit([{ op: 'updatePanel', id: p.id, set: { text: ta.value } }], 'note'); n.querySelector('.grow').textContent = ''; });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ta.blur(); this.r.focus({ preventScroll: true }); } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.sendPanel(p.id); } });
    }
    n.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.closest('.st-body')) return;
      const a = b.dataset.a;
      if (a === 'zoom') this.zoomTo('panel', p.id);
      else if (a === 'float') this.focus.toggleFloat(p.id);
      else if (a === 'del') { if (b.classList.contains('arm')) { this.ctx.submit([{ op: 'removePanel', id: p.id }], 'delete panel'); this.syncLayout(); } else { b.classList.add('arm'); b.textContent = '?'; setTimeout(() => { b.classList.remove('arm'); b.textContent = '✕'; }, 1800); } }
      else if (a === 'copy') navigator.clipboard?.writeText(ta.value).then(() => this.toast('Copied'));
      else if (a === 'send') this.sendMenu(p.id, b);
    });
    return n;
  }
  newPanel({ x, y, text = '', title = 'Note', kind = 'note', focus = false, w, h, source = null, color = null }) {
    const id = uid('p');
    w ??= { terminal: 640, preview: 820, map: 620 }[kind] || 360;
    h ??= { terminal: 380, preview: 540, map: 440 }[kind] || 230;
    const fa = this.mode === 'focus' && this.focus.fa && this.agentDef(this.focus.fa);
    if (fa) {   // in focus mode a new panel belongs to the focused agent: a tab now, next to its box on the canvas
      source ??= { agent: fa.id };
      const below = this.doc.panels.filter((p) => p.source?.agent === fa.id && p.x >= fa.x + fa.w);
      x = fa.x + fa.w + 30; y = below.length ? Math.max(...below.map((p) => p.y + p.h)) + 20 : fa.y;
    }
    this.ctx.submit([{ op: 'addPanel', panel: { id, x: Math.round(x), y: Math.round(y), w, h, title, text, kind, source, color } }], kind);
    this.syncLayout();
    if (fa) this.focus.setTab(id);
    if (focus) setTimeout(() => { const n = this.panelEls.get(id); (n?.querySelector('textarea') || n?.querySelector('.vt'))?.focus(); }, 40);
    return id;
  }
  /** A piece of text grabbed from a transcript, a diff, anywhere — as a panel on the canvas. */
  snippet(text, at, kind) {
    at ||= this.toWorld(this.mouse.x, this.mouse.y);
    const t = String(text).replace(/\s+$/, '');
    const code = kind !== 'prompt' && (t.includes('\n') || /[{};=()]/.test(t));
    const lines = t.split('\n');
    const w = clamp(Math.max(...lines.map((l) => l.length)) * (code ? 7.4 : 7) + 40, 260, 640), h = clamp(lines.length * 20 + 90, 120, 420);
    this.newPanel({ x: at.x - 20, y: at.y - 20, w, h, kind: kind || (code ? 'snippet' : 'note'), title: kind === 'prompt' ? 'Prompt' : code ? 'Snippet' : 'Note', text: t });
    window.getSelection()?.removeAllRanges();
  }
  /** Open a terminal / code map / preview panel next to a box (or for the project). */
  async openKind(kind, agentId, extra = {}) {
    try {
      const r = await this.ctx.post('/api/studio/view', { doc: this.docId, by: 'user', open: { kind, agent: agentId || undefined, ...extra } });
      setTimeout(() => this.zoomTo('panel', r.panel), 150);
    } catch (e) { this.toast(e.message, true); }
  }
  streamPanel(e) {
    const n = this.panelEls.get(e.panel);
    if (!n) return;
    const ta = n.querySelector('textarea');
    if (!ta) return;
    if (e.done) { n.classList.remove('streaming'); n.querySelector('.grow').textContent = ''; return; }
    n.classList.add('streaming');
    n.querySelector('.grow').textContent = 'reviewing…';
    if (document.activeElement !== ta) { ta.value = e.text; ta.scrollTop = ta.scrollHeight; }
  }
  sendMenu(pid, anchor) {
    const items = this.doc.agents.map((a) => ({ label: a.name, color: a.color, run: () => this.sendPanel(pid, a.id) }));
    if (!items.length) return this.toast('No agent boxes yet — Shift+drag to make one', true);
    this.popList(anchor, items);
  }
  async sendPanel(pid, agentId) {
    const p = this.doc.panels.find((x) => x.id === pid);
    const ta = this.panelEls.get(pid)?.querySelector('textarea');
    const text = (ta?.value ?? p?.text ?? '').trim();
    if (!text) return this.toast('The panel is empty', true);
    if (!agentId) return this.sendMenu(pid, this.panelEls.get(pid).querySelector('[data-a="send"]'));
    const msg = p?.kind === 'review' ? `Here is a review of your changes. Address the findings:\n\n${text}` : p?.kind === 'snippet' ? `Look at this:\n\`\`\`\n${text}\n\`\`\`` : text;
    await this.prompt(agentId, msg);
    this.toast(`Sent to ${this.name(agentId)}`);
  }
  popList(anchor, items, width = 260) {
    this.r.querySelector('.st-pick')?.remove();
    const m = el('div', 'st-pick');
    m.innerHTML = `<div class="presets">${items.map((it, i) => (it === '-' ? '<hr style="border:0;border-top:1px solid var(--line);margin:4px 0">' : `<button data-i="${i}">${it.color ? `<span style="width:8px;height:8px;border-radius:50%;background:${esc(it.color)}"></span>` : ''}${esc(it.label)}${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`)).join('')}</div>`;
    const rb = anchor.getBoundingClientRect(), b = this.r.getBoundingClientRect();
    Object.assign(m.style, { width: width + 'px', left: clamp(rb.left - b.left, 8, b.width - width - 12) + 'px', top: clamp(rb.bottom - b.top + 6, 8, b.height - 60 - items.length * 38) + 'px' });
    m.onclick = (e) => { const x = e.target.closest('button[data-i]'); if (x) { m.remove(); this.r.focus({ preventScroll: true }); items[+x.dataset.i].run(); } };
    m.tabIndex = 0;
    m.onkeydown = (e) => { if (e.key === 'Escape') { m.remove(); this.r.focus({ preventScroll: true }); } };
    this.r.append(m);
    m.focus();
    setTimeout(() => addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.remove(); removeEventListener('pointerdown', off, true); } }, true));
  }

  // ================================================================ director
  renderDirector() {
    if (!this.doc) return;
    const m = this.doc.config?.director || 'off';
    for (const b of this.r.querySelectorAll('[data-h="director"]')) {
      b.textContent = { off: '◎ Director off', auto: '◎ Director: rules', agent: '◎ Director: agent' }[m];
      b.classList.toggle('on', m !== 'off');
    }
  }
  directorMenu(anchor) {
    const set = async (mode, preset) => {
      try { const r = await this.ctx.post('/api/studio/director', { doc: this.docId, mode, preset, by: 'user' }); this.toast(mode === 'off' ? 'The screen is yours' : mode === 'auto' ? 'Director: built-in rules run the screen' : 'Director agent runs the screen'); if (r.box && mode === 'agent') setTimeout(() => this.zoomTo('agent', r.box), 300); } catch (e) { this.toast(e.message, true); }
    };
    this.popList(anchor, [
      { label: 'Off — the screen is yours', run: () => set('off') },
      { label: 'Rules — permissions, red monitors, new boxes and servers come into view', run: () => set('auto') },
      ...Object.keys(this.presets).map((k) => ({ label: `Agent — a director box (${this.presets[k].label || k}) decides`, run: () => set('agent', k) })),
    ], 360);
  }

  // ================================================================ layouts
  arrangeMenu(anchor) {
    const d = this.doc;
    const focus = this.target?.kind === 'agent' ? this.target.id : null;
    const items = Object.entries(MODES).map(([k, label]) => ({ label, run: () => this.applyOps(arrange(d, k, { focus }), `arrange ${k}`) }));
    items.push('-', { label: 'Save this layout…', run: () => { const name = prompt('Layout name', `Layout ${(d.layouts || []).length + 1}`); if (name) { this.ctx.submit([{ op: 'saveLayout', name, items: snapshotLayout(d) }], 'save layout'); this.toast(`Saved “${name}”`); } } });
    for (const L of d.layouts || []) items.push({ label: `↺ ${L.name}`, run: () => this.applyOps(applyLayout(d, L), `layout ${L.name}`) });
    if ((d.layouts || []).length) items.push({ label: 'Delete a saved layout…', run: () => { const name = prompt(`Delete which layout? (${d.layouts.map((l) => l.name).join(', ')})`); if (name && d.layouts.some((l) => l.name === name)) this.ctx.submit([{ op: 'removeLayout', name }], 'delete layout'); } });
    this.popList(anchor, items, 240);
  }
  applyOps(ops, label) {
    if (!ops.length) return this.fit();
    this.ctx.submit(ops, label);
    this.syncLayout();
    setTimeout(() => this.fit(), 30);
  }

  // ================================================================ floating input
  openInput(target, initial) {
    this.closeOverlays();
    const box = el('div', 'st-input');
    const b = this.r.getBoundingClientRect();
    Object.assign(box.style, { left: clamp(this.mouse.x - b.left - 40, 12, b.width - 560) + 'px', top: clamp(this.mouse.y - b.top + 16, 12, b.height - 200) + 'px' });
    let t = target ? { ...target } : null;
    const world = this.toWorld(this.mouse.x, this.mouse.y);
    const label = () => {
      if (!t) return '<span class="chip" style="--c:#a1a1aa"><i></i>new note here</span>';
      if (t.kind === 'panel') { const p = this.doc.panels.find((x) => x.id === t.id); return `<span class="chip" style="--c:${esc(p?.color || '#a1a1aa')}"><i></i>${esc(p?.title || p?.kind || 'panel')}</span>${p?.kind === 'terminal' ? '<span>runs in the terminal</span>' : ''}`; }
      const st = this.rtOf(t.id).info.status;
      return `<span class="chip" style="--c:${esc(this.color(t.id))}"><i></i>${esc(this.name(t.id))}</span><span>${st === 'working' ? 'is working — this will be queued' : st === 'stopped' ? 'is stopped — this starts it' : ''}</span>`;
    };
    box.innerHTML = `<div class="to">To <span class="tgt"></span><span class="grow"></span><kbd>Tab</kbd> next</div><textarea rows="2" placeholder="Type, or speak…"></textarea><div class="hint"><span><kbd>↵</kbd> send</span><span><kbd>⇧↵</kbd> new line</span><span><kbd>Esc</kbd> close</span></div>`;
    const tgt = box.querySelector('.tgt');
    const paint = () => { tgt.innerHTML = label(); box.style.setProperty('--c', t?.kind === 'agent' ? this.color(t.id) : '#a1a1aa'); };
    paint();
    const ta = box.querySelector('textarea');
    ta.value = initial || '';
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(260, ta.scrollHeight) + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); box.remove(); this.r.focus({ preventScroll: true }); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const ring = [...this.doc.agents.map((a) => ({ kind: 'agent', id: a.id })), null];
        const i = ring.findIndex((r) => (r?.id || null) === (t?.id || null));
        t = ring[(i + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
        if (t) this.setTarget(t);
        return paint();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) return;
        box.remove();
        this.r.focus({ preventScroll: true });
        if (!t) return this.newPanel({ x: world.x - 20, y: world.y - 10, text });
        if (t.kind === 'panel') {
          const p = this.doc.panels.find((x) => x.id === t.id);
          if (p?.kind === 'terminal') return this.ctx.post('/api/studio/term/input', { id: `${this.docId}:${p.id}`, data: text + '\r' }).catch((er) => this.toast(er.message, true));
          if (p) { this.ctx.submit([{ op: 'updatePanel', id: p.id, set: { text: p.text + (p.text && !p.text.endsWith('\n') ? '\n' : '') + text } }], 'note'); this.syncLayout(); }
          return;
        }
        this.prompt(t.id, text);
      }
    });
    this.r.append(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    grow();
  }

  // ================================================================ actions
  async prompt(id, text) { try { await this.ctx.post('/api/studio/prompt', { agent: id, text, by: 'user' }); } catch (e) { this.toast(e.message, true); } }
  async startStop(id) {
    const st = this.rtOf(id).info.status;
    try { await this.ctx.post(['stopped', 'error'].includes(st) ? '/api/studio/start' : '/api/studio/stop', { agent: id }); } catch (e) { this.toast(e.message, true); }
  }
  async cancel(id) { try { await this.ctx.post('/api/studio/cancel', { agent: id }); this.toast(`Interrupted ${this.name(id)}`); } catch (e) { this.toast(e.message, true); } }
  async review(id) {
    const s = this.snapAt(id);
    try { const r = await this.ctx.post('/api/studio/review', { agent: id, to: s?.n }); this.toast(`Reviewing ${r.header}`); } catch (e) { this.toast(e.message, true); }
  }
  async fork(id, n) {
    const s = n != null ? { n } : this.snapAt(id);
    if (!s) return this.toast('Nothing to fork yet', true);
    try { const r = await this.ctx.post('/api/studio/fork', { agent: id, snap: s.n }); this.toast(`Forked ${this.name(id)} at #${s.n} → ${r.name}`); } catch (e) { this.toast(e.message, true); }
  }
  async spawn(id, mode, role, promptText) {
    try { const r = await this.ctx.post('/api/studio/spawn', { agent: id, mode, role, prompt: promptText, by: 'user' }); this.toast(`${r.name} ${mode === 'same' ? 'works in the same folder' : 'has its own worktree'}`); } catch (e) { this.toast(e.message, true); }
  }
  /** ⟲ on a prompt: take the conversation, the files, or both back to just before it. */
  rewindMenu(id, turn, anchor) {
    const ev = this.rtOf(id).events.find((e) => e.kind === 'user' && e.turn === turn);
    const go = (mode) => this.rewindTurn(id, turn, mode, ev?.text);
    this.popList(anchor, [
      { label: 'Rewind the conversation — keep the files', run: () => go('conversation') },
      { label: 'Rewind the conversation and the files', run: () => go('both') },
      { label: 'Rewind the files only', run: () => go('files') },
      '-',
      { label: 'Fork a new box from here instead', run: async () => { try { const t = (await this.ctx.get(`/api/studio/turns?agent=${id}`)).find((x) => x.turn === turn); if (t?.snap != null) this.fork(id, t.snap); } catch (e) { this.toast(e.message, true); } } },
    ], 330);
  }
  async rewindTurn(id, turn, mode, text) {
    try {
      await this.ctx.post('/api/studio/rewind', { agent: id, turn, mode });
      this.toast({ conversation: `${this.name(id)}: conversation back to before turn ${turn} · files kept — it will be told to check`, both: `${this.name(id)}: conversation and files back to before turn ${turn}`, files: `${this.name(id)}: files back to before turn ${turn}` }[mode]);
      this.scrub(null);
      if (mode !== 'files' && text) {   // the rewound prompt comes back for editing, like taking a message back
        if (this.mode === 'focus' && this.focus.fa === id) { this.focus.ta.value = text; this.focus.grow(); this.focus.ta.focus(); }
        else this.openInput({ kind: 'agent', id }, text);
      }
    } catch (e) { this.toast(e.message, true); }
  }
  async rewind(id, n) {
    try { await this.ctx.post('/api/studio/rewind', { agent: id, snap: n }); this.toast(`${this.name(id)} rewound to #${n}`); this.scrub(null); } catch (e) { this.toast(e.message, true); }
  }
  async answer(gate, option) { try { await this.ctx.post('/api/studio/gate', { gate, option }); } catch (e) { this.toast(e.message, true); } }
  async dismiss(gate) { try { await this.ctx.post('/api/studio/gate', { gate, dismiss: true }); } catch (e) { this.toast(e.message, true); } }
  async removeAgent(id) {
    try { const r = await fetch(`/api/studio/agents?id=${encodeURIComponent(id)}&by=user`, { method: 'DELETE' }); if (!r.ok) throw new Error((await r.json()).error || 'remove failed'); } catch (e) { this.toast(e.message, true); }
  }
  moreMenu(id, anchor) {
    const a = this.agentDef(id);
    this.popList(anchor, [
      { label: this.mode === 'focus' ? 'Show on the canvas' : 'Open in focus mode', kbd: '⌘\\', run: () => { if (this.mode === 'focus') this.setMode('canvas'); else { this.focus.fa = id; this.setMode('focus'); } } },
      { label: 'Reviewer in the same folder', run: () => this.spawn(id, 'same', 'review') },
      { label: 'Sub-agent in its own worktree…', run: () => { const t = prompt(`Task for a sub-agent working on a copy of ${a.name}'s files`); if (t) this.spawn(id, 'worktree', null, t); } },
      { label: 'Terminal here', kbd: '⌥T', run: () => this.openKind('terminal', id) },
      { label: 'Code map', kbd: '⌥M', run: () => this.openKind('map', id) },
      { label: 'Preview a running UI…', run: () => { const u = prompt('URL or port of the running app (e.g. 5173, http://localhost:3000, :6901 for a voxl desktop)', 'http://localhost:5173'); if (u) this.openKind('preview', id, { url: u }); } },
      '-',
      { label: 'Rename…', run: () => { const nm = prompt('Name', a.name); if (nm) { this.ctx.submit([{ op: 'updateAgent', id, set: { name: nm } }], 'rename'); this.syncLayout(); } } },
      { label: 'Scope (globs)…', run: () => { const s = prompt('Files this agent may change (comma separated globs, e.g. src/**, test/**). Empty = anywhere.', (a.scope || []).join(', ')); if (s != null) { this.ctx.submit([{ op: 'updateAgent', id, set: { scope: s.split(',').map((x) => x.trim()).filter(Boolean) } }], 'scope'); this.syncLayout(); } } },
      { label: 'Interrupt', kbd: '⌥.', run: () => this.cancel(id) },
      { label: 'Diffs of this agent only', kbd: '⌥D', run: () => this.setFilter(id) },
      { label: 'Copy working directory path', run: () => navigator.clipboard?.writeText(a.cwd || '').then(() => this.toast('Copied ' + a.cwd)) },
      { label: 'Remove box (keeps the worktree)', run: () => { if (confirm(`Remove ${a.name}? The process stops; its worktree, branch and history stay on disk.`)) this.removeAgent(id); } },
    ], 280);
  }
  openTool(id, seq) {
    const ev = this.rtOf(id).bySeq.get(seq);
    if (!ev) return;
    const s = this.snapsOf(id).find((x) => x.seq >= seq);
    if (s && s.n > 0) { this.setFilter(id, true); this.selectSnap(id, s.n, true); } else this.toast(ev.title + (ev.status ? ` · ${ev.status}` : ''));
  }
  showFile(id, path) {
    const s = this.snapsOf(id).filter((s) => (s.files || []).some((f) => f.path === path) && (this.T == null || s.ts <= this.T)).at(-1);
    if (!s) return;
    this.setFilter(id, true);
    this.selectSnap(id, s.n, true, path);
  }
  showFileAny(path) {
    const s = this.timeline.filter((s) => (s.files || []).some((f) => f.path === path)).at(-1);
    if (!s) return this.toast(`${path} — not changed by any agent yet`);
    this.showFile(s.agent, path);
  }
  nextGate() {
    if (!this.gates.length) return this.toast('Nobody needs you right now');
    this.gateIdx = ((this.gateIdx ?? -1) + 1) % this.gates.length;
    const g = this.gates[this.gateIdx];
    this.zoomTo('agent', g.agent);
    this.setTarget({ kind: 'agent', id: g.agent });
    this.renderGates(g.id);
  }

  // ================================================================ new agent picker
  picker(rect, sx, sy) {
    this.closeOverlays();
    const keys = Object.keys(this.presets);
    if (!keys.length) keys.push('mock');
    let pick = localStorage.getItem('studio.preset');
    if (!keys.includes(pick)) pick = keys[0];
    const m = el('div', 'st-pick');
    m.innerHTML = `<h6>New agent</h6><div class="presets">${keys.map((k, i) => `<button data-k="${esc(k)}" class="${k === pick ? 'on' : ''}">${esc(this.presets[k]?.label || k)}<kbd>${i + 1}</kbd></button>`).join('')}</div>
      <input class="nm" placeholder="Name (optional)"><textarea class="pr" rows="3" placeholder="First task (optional) — or type to it later"></textarea>
      <input class="sp" placeholder="Only these paths — sparse checkout for a monorepo (optional): services/auth, libs/common">
      <div class="row"><span class="grow">Own git worktree and branch · ↵ create</span><button class="btn" data-x="cancel">Cancel</button><button class="btn pri" data-x="go">Create</button></div>`;
    const b = this.r.getBoundingClientRect();
    Object.assign(m.style, { left: clamp(sx - b.left, 8, b.width - 392) + 'px', top: clamp(sy - b.top, 8, b.height - 380) + 'px' });
    const go = async () => {
      m.remove();
      this.r.focus({ preventScroll: true });
      localStorage.setItem('studio.preset', pick);
      try {
        const r = await this.ctx.post('/api/studio/agents', { doc: this.docId, preset: pick, name: m.querySelector('.nm').value.trim() || undefined, prompt: m.querySelector('.pr').value.trim() || undefined, sparse: m.querySelector('.sp').value.trim() || undefined, ...rect, by: 'user', who: this.ctx.me?.name });
        this.toast(`${r.name} → ${r.branch || r.cwd}`);
        if (this.mode === 'focus') { this.focus.pending = r.id; this.focus.place(); }
      } catch (e) { this.toast(e.message, true); }
    };
    m.onclick = (e) => {
      const p = e.target.closest('[data-k]');
      if (p) { pick = p.dataset.k; m.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('on', x === p)); return; }
      const x = e.target.closest('[data-x]');
      if (x?.dataset.x === 'go') go(); else if (x?.dataset.x === 'cancel') { m.remove(); this.r.focus({ preventScroll: true }); }
    };
    m.onkeydown = (e) => {
      if (e.key === 'Escape') { m.remove(); this.r.focus({ preventScroll: true }); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
      else if (!e.target.closest('input,textarea') && keys[+e.key - 1]) { pick = keys[+e.key - 1]; m.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('on', x.dataset.k === pick)); }
    };
    this.r.append(m);
    m.querySelector('.pr').focus();
  }

  // ================================================================ gates
  renderGates(focusId) {
    this.focus?.dirty();
    const list = this.gates, box = this.gatesEl;
    if (!list.length) { box.innerHTML = ''; return; }
    const need = list.filter((g) => g.kind !== 'info').length;
    box.innerHTML = `<h4>${need ? `Needs you <b>${need}</b>` : 'Updates'}</h4>`;
    for (const g of list) {
      const n = el('div', `gate${g.blocking ? ' blocking' : ''}${g.id === focusId ? ' focus' : ''}`);
      n.style.setProperty('--c', this.color(g.agent));
      let acts = '';
      if (g.kind === 'permission') acts = (g.json?.options || []).map((o) => `<button class="btn ${o.kind?.startsWith('allow') ? 'ok' : 'no'}" data-opt="${esc(o.optionId)}">${esc(o.name)}</button>`).join('');
      else if (g.kind === 'turn') acts = `<button class="btn" data-x="reply">Reply</button><button class="btn" data-x="review">Review</button><button class="btn" data-x="dismiss">Dismiss</button>`;
      else if (g.kind === 'monitor') acts = `<button class="btn" data-x="show">Show</button><button class="btn" data-x="fix">Ask to fix</button><button class="btn" data-x="dismiss">Dismiss</button>`;
      else if (g.kind === 'error') acts = `<button class="btn" data-x="restart">Restart</button><button class="btn" data-x="dismiss">Dismiss</button>`;
      else if (g.kind === 'info') acts = `<button class="btn" data-x="goto">Show</button><button class="btn" data-x="dismiss">OK</button>`;
      const kind = { permission: 'asks', monitor: 'monitor', turn: 'turn done', error: 'error', info: 'spun off' }[g.kind] || g.kind;
      n.innerHTML = `<div class="h"><i></i><b>${esc(this.name(g.agent))}</b><span class="k">${esc(kind)}</span><span class="age">${ago(g.ts)}</span></div><div class="ti">${esc(g.title)}</div>${g.detail ? `<div class="d">${esc(g.detail)}</div>` : ''}<div class="a">${acts}</div>`;
      n.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) { this.zoomTo('agent', g.agent); this.setTarget({ kind: 'agent', id: g.agent }); return; }
        if (this.mode === 'focus' && g.agent !== this.focus.fa) this.focus.select(g.agent);
        if (b.dataset.opt) return this.answer(g.id, b.dataset.opt);
        const x = b.dataset.x;
        if (x === 'dismiss') this.dismiss(g.id);
        else if (x === 'reply') { this.setTarget({ kind: 'agent', id: g.agent }); this.openInput({ kind: 'agent', id: g.agent }, ''); }
        else if (x === 'review') { this.review(g.agent); this.dismiss(g.id); }
        else if (x === 'show') { this.zoomTo('agent', g.agent); if (g.json?.snap != null) { this.setFilter(g.agent, true); this.selectSnap(g.agent, g.json.snap, true); } }
        else if (x === 'fix') this.prompt(g.agent, `The ${g.json?.monitor || ''} monitor is red: ${g.detail}. Fix it.`);
        else if (x === 'restart') this.ctx.post('/api/studio/start', { agent: g.agent }).then(() => this.dismiss(g.id)).catch((er) => this.toast(er.message, true));
        else if (x === 'goto') { const to = g.json?.agent || g.agent; this.zoomTo('agent', to); this.setTarget({ kind: 'agent', id: to }); this.dismiss(g.id); }
      };
      box.append(n);
    }
    for (const a of this.doc.agents) { const r = this.rtOf(a.id); for (const ev of r.events.filter((e) => e.kind === 'permission')) { const old = r.nodes.get(ev.seq); if (old?.isConnected) old.replaceWith(this.eventNode(a.id, ev)); } }
  }

  // ================================================================ subtitles
  subtitle(id, text) {
    const t = this.target?.kind === 'agent' ? this.target.id : null;
    if (t && t !== id && this.rtOf(t).info.status === 'working') return;
    const s = this.subs;
    s.style.setProperty('--c', this.color(id));
    s.querySelector('.who span').textContent = this.name(id);
    const line = s.querySelector('.line');
    line.innerHTML = String(text).split(/(\s+)/).map((w) => (/\s/.test(w) ? w : `<span>${esc(w)}</span>`)).join('');
    s.classList.remove('off');
    const spans = [...line.querySelectorAll('span')];
    clearInterval(this.subTimer); clearTimeout(this.subHide);
    let i = 0;
    this.subTimer = setInterval(() => { if (i < spans.length) spans[i++].classList.add('on'); else clearInterval(this.subTimer); }, 70);
    this.subHide = setTimeout(() => s.classList.add('off'), 4500 + spans.length * 70);
  }

  // ================================================================ tray: timeline, replay, diffs
  applyTray() {
    this.r.style.setProperty('--tray', (this.trayOff ? 38 : this.trayH) + 'px');
    this.r.classList.toggle('tray-off', this.trayOff);
    localStorage.setItem('studio.trayOff', this.trayOff ? '1' : '0');
    this.render?.();
  }
  toggleTray() { if (this.mode === 'focus') return this.focus.setTab('changes'); this.trayOff = !this.trayOff; this.applyTray(); if (!this.trayOff) this.lazyDiffs(); }
  setFilter(id, force) { this.filter = force ? id : this.filter === id ? null : id; this.renderFilter(); this.renderTray(); this.renderTimelineHead(); }
  renderFilter() {
    const f = this.$('.st-filter');
    if (!f) return;
    const ags = this.doc?.agents || [];
    f.innerHTML = ags.length > 1 ? `<button class="${this.filter ? '' : 'on'}" data-id="">All</button>` + ags.map((a) => `<button data-id="${esc(a.id)}" class="${this.filter === a.id ? 'on' : ''}"><i style="background:${esc(a.color)}"></i>${esc(a.name)}</button>`).join('') : '';
    f.onclick = (e) => { const b = e.target.closest('button'); if (b) { this.filter = b.dataset.id || null; this.renderFilter(); this.renderTray(); this.renderTimelineHead(); } };
  }
  visibleSnaps() { return this.timeline.filter((s) => s.n > 0 && (!this.filter || s.agent === this.filter) && this.agentDef(s.agent)); }
  timeScale() {
    const all = this.timeline.filter((s) => this.agentDef(s.agent) && (!this.filter || s.agent === this.filter));
    if (!all.length) return null;
    const ts = [...new Set(all.map((s) => s.ts))].sort((a, b) => a - b);
    const end = Math.max(Date.now(), ts.at(-1) + 1);
    const pts = [ts[0]], v = [0];
    for (let i = 1; i < ts.length; i++) { pts.push(ts[i]); v.push(v[i - 1] + Math.min(ts[i] - ts[i - 1], 20000) + 400); }
    pts.push(end); v.push(v.at(-1) + Math.min(end - ts.at(-1), 20000) + 400);
    const total = v.at(-1) || 1;
    const pos = (t) => { if (t <= pts[0]) return 0; for (let i = 1; i < pts.length; i++) if (t <= pts[i]) return (v[i - 1] + (v[i] - v[i - 1]) * ((t - pts[i - 1]) / Math.max(1, pts[i] - pts[i - 1]))) / total; return 1; };
    const time = (p) => { const x = p * total; for (let i = 1; i < v.length; i++) if (x <= v[i]) return pts[i - 1] + (pts[i] - pts[i - 1]) * ((x - v[i - 1]) / Math.max(1, v[i] - v[i - 1])); return end; };
    return { pos, time, all };
  }
  renderTimelineHead() {
    const sc = this.timeScale();
    this.tl.querySelectorAll('i,.head').forEach((x) => x.remove());
    const live = this.$('.st-thead .golive');
    live.className = 'tb golive ' + (this.T == null ? 'live' : 'past');
    live.textContent = this.T == null ? '● Live' : `${hhmm(this.T)} — back to live`;
    const play = this.$('.st-thead .play');
    play.classList.toggle('on', !!this.playing);
    play.textContent = this.playing ? '❚❚ Pause' : '▶ Replay';
    if (!sc) return;
    for (const s of sc.all) {
      if (s.n === 0) continue;
      const i = el('i');
      if (this.rtOf(s.agent).mons.some((m) => m.snap === s.n && m.level === 'red')) i.className = 'red';
      i.style.left = `${sc.pos(s.ts) * 100}%`;
      i.style.background = this.color(s.agent);
      i.title = `${this.name(s.agent)} #${s.n} ${s.reason || ''}`;
      this.tl.append(i);
    }
    if (this.T != null) { const h = el('div', 'head'); h.style.left = `${sc.pos(this.T) * 100}%`; h.dataset.t = hhmm(this.T); this.tl.append(h); }
  }
  scrubAtX(x) {
    const sc = this.timeScale();
    if (!sc) return;
    const r = this.tl.getBoundingClientRect();
    const p = clamp((x - r.left) / r.width, 0, 1);
    if (p > 0.995) return this.scrub(null);
    const t = sc.time(p);
    let best = null;
    for (const s of this.visibleSnaps()) if (!best || Math.abs(s.ts - t) < Math.abs(best.ts - t)) best = s;
    if (best) { this.sel = { agent: best.agent, n: best.n }; this.scrub(best.ts); } else this.scrub(t);
  }
  step(d) {
    const list = this.visibleSnaps();
    if (!list.length) return false;
    let i = this.T == null ? list.length : list.findIndex((s) => this.sel && s.agent === this.sel.agent && s.n === this.sel.n);
    if (i < 0) i = list.findIndex((s) => s.ts > this.T) - 1;
    i = clamp(i + d, 0, list.length);
    if (i >= list.length) { this.scrub(null); return false; }
    this.sel = { agent: list[i].agent, n: list[i].n };
    this.scrub(list[i].ts);
    return true;
  }
  /** Replay: from the scrub point (or the beginning) step through every change, then back to live. */
  togglePlay() {
    if (this.playing) return this.stopPlay();
    const list = this.visibleSnaps();
    if (!list.length) return this.toast('Nothing to replay yet');
    if (this.T == null) { this.sel = { agent: list[0].agent, n: list[0].n }; this.scrub(list[0].ts); }
    this.playing = setInterval(() => { if (!this.step(1)) this.stopPlay(); }, 1100);
    this.renderTimelineHead();
  }
  stopPlay() { if (!this.playing) return; clearInterval(this.playing); this.playing = null; this.renderTimelineHead(); }
  scrub(T) {
    const was = this.T;
    this.T = T;
    if (T == null) { this.sel = null; this.stopPlay(); }
    for (const a of this.doc.agents) { this.renderHeader(a.id); this.renderSide(a.id); if (was !== T) this.renderLog(a.id); }
    this.renderTimelineHead();
    for (const c of this.tbody.querySelectorAll('.dcard')) {
      c.classList.toggle('future', T != null && +c.dataset.ts > T);
      c.classList.toggle('sel', !!this.sel && c.dataset.agent === this.sel.agent && +c.dataset.n === this.sel.n);
    }
    const selEl = this.sel && this.tbody.querySelector(`.dcard[data-agent="${this.sel.agent}"][data-n="${this.sel.n}"]`);
    if (selEl) { selEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); this.loadDiff(selEl); }
    else if (T == null) this.tbody.scrollTop = this.tbody.scrollHeight;
  }
  selectSnap(agent, n, open, path) {
    const s = this.timeline.find((x) => x.agent === agent && x.n === n);
    if (!s) return;
    if (open && this.mode === 'focus') { if (agent !== this.focus.fa) this.focus.select(agent); this.focus.setTab('changes'); }
    else if (this.trayOff && open) this.toggleTray();
    this.sel = { agent, n };
    this.scrub(s.ts);
    if (path) {
      const card = this.tbody.querySelector(`.dcard[data-agent="${agent}"][data-n="${n}"]`);
      this.loadDiff(card).then(() => card?.querySelector(`.dfile[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  }
  renderTray() {
    const list = this.visibleSnaps();
    this.tbody.innerHTML = '';
    if (!list.length) { this.tbody.innerHTML = `<div class="dempty"><b>No changes yet.</b><br>Every file an agent touches becomes a snapshot here — a diff, its monitors, and a moment you can replay, rewind or fork from.</div>`; return; }
    for (const s of list) this.tbody.append(this.card(s));
    this.tbody.scrollTop = this.tbody.scrollHeight;
    this.lazyDiffs();
  }
  appendCard(s) {
    if (!s || s.n === 0 || (this.filter && s.agent !== this.filter)) return;
    const stick = this.tbody.scrollHeight - this.tbody.scrollTop - this.tbody.clientHeight < 120;
    this.tbody.querySelector('.dempty')?.remove();
    const c = this.card(s);
    if (this.T != null) c.classList.add('future');
    this.tbody.append(c);
    if (stick && this.T == null) this.tbody.scrollTop = this.tbody.scrollHeight;
    this.lazyDiffs();
  }
  card(s) {
    const c = el('div', 'dcard');
    c.dataset.agent = s.agent; c.dataset.n = s.n; c.dataset.ts = s.ts;
    c.style.setProperty('--c', this.color(s.agent));
    c.innerHTML = `<header><span class="ag"><i></i>${esc(this.name(s.agent))}</span><span class="n">#${s.n}</span><span class="r"></span><span class="mk"></span><span class="num"><span class="a">+${s.adds}</span> <span class="d">−${s.dels}</span></span><span class="ts">${hhmm(s.ts)}</span>
      <span class="acts"><button data-x="go" title="Show the studio as it was here">⏪ here</button><button data-x="fork" title="New agent from this moment">⑂ fork</button><button data-x="rewind" title="Put the working directory back to this snapshot">↺ rewind</button><button data-x="snip" title="The diff as a snippet on the canvas">⧉ grab</button></span></header><div class="body"></div>`;
    c.querySelector('.r').textContent = s.reason || '';
    c.querySelector('.r').title = s.reason || '';
    this.markCard(s.agent, s.n, c);
    c.querySelector('header').onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) { this.sel = { agent: s.agent, n: s.n }; return this.loadDiff(c); }
      const x = b.dataset.x;
      if (x === 'go') { this.sel = { agent: s.agent, n: s.n }; this.scrub(s.ts); }
      else if (x === 'fork') this.fork(s.agent, s.n);
      else if (x === 'rewind') { if (b.classList.contains('arm')) this.rewind(s.agent, s.n); else { b.classList.add('arm'); b.textContent = '↺ sure?'; setTimeout(() => { b.classList.remove('arm'); b.textContent = '↺ rewind'; }, 2500); } }
      else if (x === 'snip') { const d = await this.fetchDiff(s.agent, s.n); const b2 = this.box(); this.snippet(d.patch, this.toWorld(b2.left + b2.width / 2, b2.top + b2.height / 3)); }
    };
    return c;
  }
  markCard(agent, n, c) {
    c = c || this.tbody.querySelector(`.dcard[data-agent="${agent}"][data-n="${n}"]`);
    if (!c) return;
    const ms = this.rtOf(agent).mons.filter((m) => m.snap === n && (m.level === 'red' || m.level === 'amber'));
    c.querySelector('.mk').innerHTML = ms.map((m) => `<b class="${m.level}" title="${esc(m.summary || '')}">${esc(m.monitor)}</b>`).join('');
  }
  lazyDiffs() {
    if (this.trayOff && this.mode !== 'focus') return;
    const top = this.tbody.scrollTop, bot = top + this.tbody.clientHeight + 300;
    for (const c of this.tbody.querySelectorAll('.dcard:not([data-loaded])')) { const y = c.offsetTop; if (y + c.offsetHeight >= top - 300 && y <= bot) this.loadDiff(c); }
  }
  async fetchDiff(agent, n) {
    const k = agent + ':' + n;
    if (!this.diffCache.has(k)) this.diffCache.set(k, this.ctx.get(`/api/studio/diff?agent=${agent}&snap=${n}`));
    return this.diffCache.get(k);
  }
  async loadDiff(c) {
    if (!c || c.dataset.loaded) return;
    c.dataset.loaded = '1';
    const stick = this.T == null && this.tbody.scrollHeight - this.tbody.scrollTop - this.tbody.clientHeight < 120;
    try { await this.fillDiff(c); } finally { if (stick) this.tbody.scrollTop = this.tbody.scrollHeight; }
  }
  async fillDiff(c) {
    const body = c.querySelector('.body');
    try {
      const d = await this.fetchDiff(c.dataset.agent, +c.dataset.n);
      const files = parseDiff(d.patch);
      if (!files.length) { body.innerHTML = '<div class="dempty" style="padding:10px">No content changes (mode or binary)</div>'; return; }
      body.innerHTML = '';
      for (const f of files) {
        const big = f.hunks.reduce((s, h) => s + h.rows.length, 0) > 400;
        const n = el('div', 'dfile' + (big ? ' collapsed' : ''));
        n.dataset.path = f.path;
        const a = f.hunks.reduce((s, h) => s + h.rows.filter((r) => r.t === '+').length, 0), dl = f.hunks.reduce((s, h) => s + h.rows.filter((r) => r.t === '-').length, 0);
        n.innerHTML = `<div class="fh"><b>${esc(f.path)}</b><span>${f.status === 'A' ? 'new' : f.status === 'D' ? 'deleted' : ''}</span><span style="color:var(--green)">+${a}</span><span style="color:var(--red)">−${dl}</span>${big ? '<span>(large — click)</span>' : ''}</div>`;
        const rows = [];
        for (const h of f.hunks) {
          rows.push(`<tr class="hunk"><td class="ln"></td><td class="ln"></td><td>${esc(h.header)}</td></tr>`);
          for (const r of h.rows) rows.push(`<tr class="${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}"><td class="ln">${r.o}</td><td class="ln">${r.n}</td><td class="c">${r.t === ' ' ? ' ' : r.t}${esc(r.s)}</td></tr>`);
        }
        if (f.binary) rows.push('<tr><td></td><td></td><td>binary file</td></tr>');
        n.append(el('table', null, rows.join('')));
        n.querySelector('.fh').onclick = () => n.classList.toggle('collapsed');
        body.append(n);
      }
    } catch (e) { body.innerHTML = `<div class="dempty" style="padding:10px">${esc(e.message)}</div>`; delete c.dataset.loaded; }
  }

  renderLinks() {
    const paths = [];
    const rectOf = (x, elx) => (elx ? { x: parseFloat(elx.style.left), y: parseFloat(elx.style.top), w: parseFloat(elx.style.width), h: parseFloat(elx.style.height) } : x);
    for (const a of this.doc.agents) {
      if (!a.forkOf) continue;
      const p = this.agentDef(a.forkOf.agent);
      if (!p) continue;
      const P = rectOf(p, this.agentEls.get(p.id)), A = rectOf(a, this.agentEls.get(a.id));
      const right = A.x >= P.x + P.w;
      const x1 = right ? P.x + P.w : P.x + P.w / 2, y1 = right ? P.y + 20 : P.y + P.h, x2 = right ? A.x : A.x + A.w / 2, y2 = right ? A.y + 20 : A.y;
      const d = right ? `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${y1 + 60} ${x2},${y2 - 60} ${x2},${y2}`;
      const label = `${a.forkOf.kind === 'spawn' ? '↳' : '⑂'}${a.forkOf.snap != null ? ' #' + a.forkOf.snap : ''}${a.forkOf.mode === 'same' ? ' same folder' : ''}`;
      paths.push(`<path d="${d}" stroke="${esc(a.color)}"/><text class="why" x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2 - 6}" fill="${esc(a.color)}">${esc(label)}</text>`);
    }
    this.links.innerHTML = paths.join('');
  }

  // ================================================================ spotlight + help
  spotlight() {
    this.closeOverlays();
    const s = el('div', 'st-spot');
    s.innerHTML = '<input placeholder="Command, agent, a URL to preview, or SQL: select … from events"><ul></ul>';
    const input = s.querySelector('input'), ul = s.querySelector('ul');
    const hov = this.hover?.kind === 'agent' ? this.hover.id : this.target?.kind === 'agent' ? this.target.id : null;
    const mid = () => { const b = this.box(); return this.toWorld(b.left + b.width / 2, b.top + b.height / 2); };
    const cmds = () => {
      const L = [];
      for (const k of Object.keys(this.presets)) L.push({ i: '＋', t: `New agent · ${this.presets[k].label || k}`, run: () => { const w = mid(); localStorage.setItem('studio.preset', k); this.picker({ x: Math.round(w.x - 320), y: Math.round(w.y - 240), w: 640, h: 480 }, innerWidth / 2 - 190, innerHeight / 4); } });
      L.push({ i: '¶', t: 'New note', x: 'T', run: () => { const w = mid(); this.newPanel({ x: w.x - 180, y: w.y - 110, focus: true }); } });
      L.push({ i: '⌨', t: 'Terminal in the project root', run: () => this.openKind('terminal', null) });
      L.push({ i: '▦', t: 'Code map of the project', run: () => this.openKind('map', null) });
      for (const a of this.doc.agents) {
        const c = a.color, st = this.rtOf(a.id).info.status;
        L.push({ c, t: `Go to ${a.name}`, x: st, run: () => this.zoomTo('agent', a.id) });
        L.push({ c, t: `Focus on ${a.name}`, x: 'focus mode', run: () => { this.focus.fa = a.id; if (this.mode === 'focus') this.focus.select(a.id); else this.setMode('focus'); } });
        L.push({ c, t: `Review ${a.name}`, x: '⌥R', run: () => this.review(a.id) });
        L.push({ c, t: `Fork ${a.name}`, x: '⌥F', run: () => this.fork(a.id) });
        L.push({ c, t: `Reviewer for ${a.name} in the same folder`, run: () => this.spawn(a.id, 'same', 'review') });
        L.push({ c, t: `Terminal in ${a.name}'s worktree`, x: '⌥T', run: () => this.openKind('terminal', a.id) });
        L.push({ c, t: `Code map of ${a.name}`, x: '⌥M', run: () => this.openKind('map', a.id) });
        L.push({ c, t: `${['stopped', 'error'].includes(st) ? 'Start' : 'Stop'} ${a.name}`, x: '⌥S', run: () => this.startStop(a.id) });
        L.push({ c, t: `Interrupt ${a.name}`, x: '⌥.', run: () => this.cancel(a.id) });
        L.push({ c, t: `Diffs of ${a.name}`, x: '⌥D', run: () => this.setFilter(a.id) });
      }
      L.push({ i: '◧', t: this.mode === 'focus' ? 'Canvas mode — every box on the canvas' : 'Focus mode — a classic coding view of one agent', x: '⌘\\', run: () => this.setMode(this.mode === 'focus' ? 'canvas' : 'focus') });
      for (const p of this.doc.panels) {
        L.push({ i: '¶', t: `Go to ${p.kind} “${p.title || p.kind}”`, run: () => this.zoomTo('panel', p.id) });
        L.push({ i: '⧉', t: `${p.float ? 'Unfloat' : 'Float'} ${p.kind} “${p.title || p.kind}”`, run: () => this.focus.toggleFloat(p.id) });
      }
      for (const [k, label] of Object.entries(MODES)) L.push({ i: '▤', t: `Arrange: ${label}`, run: () => this.applyOps(arrange(this.doc, k, { focus: hov }), `arrange ${k}`) });
      for (const Lt of this.doc.layouts || []) L.push({ i: '↺', t: `Layout: ${Lt.name}`, run: () => this.applyOps(applyLayout(this.doc, Lt), `layout ${Lt.name}`) });
      for (const [m, t] of [['off', 'Director off — the screen is yours'], ['auto', 'Director: built-in rules'], ['agent', 'Director: a director agent decides']]) L.push({ i: '◎', t, run: () => this.ctx.post('/api/studio/director', { doc: this.docId, mode: m, by: 'user' }).catch((e) => this.toast(e.message, true)) });
      L.push({ i: '◉', t: 'Next gate', x: 'G', run: () => this.nextGate() });
      L.push({ i: '▶', t: 'Replay all changes', x: 'P', run: () => this.togglePlay() });
      L.push({ i: '●', t: 'Back to live', run: () => this.scrub(null) });
      L.push({ i: '⤢', t: 'Fit everything', x: 'Esc', run: () => this.fit() });
      L.push({ i: '▤', t: this.trayOff ? 'Show changes' : 'Hide changes', x: 'B', run: () => this.toggleTray() });
      for (const t of ['light', 'dark', 'system']) L.push({ i: '◐', t: `Theme: ${t}`, run: () => this.setTheme(t) });
      L.push({ i: '☾', t: 'Screensaver now', run: () => this.saver.sleep() });
      for (const s2 of [30, 60, 300, 0]) L.push({ i: '☾', t: s2 ? `Screensaver after ${s2 < 60 ? s2 + ' s' : s2 / 60 + ' min'} idle` : 'Screensaver off', x: this.saver.secs === s2 ? '✓' : '', run: () => this.saver.setDelay(s2) });
      L.push({ i: '▦', t: 'Agents dashboard (sheet, Live mode)', run: () => { location.href = `/#${this.docId}-dash`; } });
      L.push({ i: '?', t: 'Keyboard shortcuts', x: '?', run: () => this.help() });
      if (hov) L.sort((a, b) => (b.t.includes(this.name(hov)) ? 1 : 0) - (a.t.includes(this.name(hov)) ? 1 : 0));
      return L;
    };
    const all = cmds();
    let shown = all, idx = 0;
    const paint = () => {
      const raw = input.value.trim(), q = raw.toLowerCase();
      if (/^(select|with|pragma)\b/.test(q)) shown = [{ i: '⛁', t: 'Run SQL → a panel', x: 'sessions.sqlite', run: () => this.sqlPanel(raw) }];
      else if (/^(https?:\/\/|localhost|127\.0\.0\.1|:\d{2,5}$|\d{4,5}$)/.test(q)) shown = [{ i: '▣', t: `Preview ${raw}`, run: () => this.openKind('preview', hov, { url: raw }) }];
      else shown = q ? all.filter((c) => q.split(/\s+/).every((w) => c.t.toLowerCase().includes(w))) : all;
      idx = clamp(idx, 0, Math.max(0, shown.length - 1));
      ul.innerHTML = shown.slice(0, 80).map((c, i) => `<li class="${i === idx ? 'on' : ''}" data-i="${i}">${c.c ? `<span class="c" style="background:${esc(c.c)}"></span>` : `<span class="i">${esc(c.i || '')}</span>`}${esc(c.t)}${c.x ? `<span class="x">${esc(c.x)}</span>` : ''}</li>`).join('') || '<li style="color:var(--dim)">No match</li>';
    };
    const run = (i) => { const c = shown[i]; if (!c) return; s.remove(); this.r.focus({ preventScroll: true }); c.run(); };
    input.oninput = () => { idx = 0; paint(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, shown.length - 1); paint(); ul.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); paint(); ul.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); run(idx); }
      else if (e.key === 'Escape') { s.remove(); this.r.focus({ preventScroll: true }); }
    };
    ul.onclick = (e) => { const li = e.target.closest('li[data-i]'); if (li) run(+li.dataset.i); };
    this.r.append(s);
    paint();
    input.focus();
  }
  async sqlPanel(sql) {
    try {
      const out = await this.ctx.post('/api/studio/sql', { sql });
      const w = this.toWorld(this.box().left + this.box().width / 2, this.box().top + this.box().height / 2);
      this.newPanel({ x: w.x - 300, y: w.y - 160, w: 600, h: 320, title: sql.slice(0, 80), text: out, kind: 'sql' });
    } catch (e) { this.toast(e.message, true); }
  }
  help() {
    this.closeOverlays();
    const o = el('div', 'st-help-ov');
    const K = [
      ['Shift+drag', 'Draw a box → new agent'], ['N', 'Then drag: new agent'], ['point + type', 'Talk to the box under the pointer'], ['↵ or /', 'Floating input for what you point at'],
      ['Tab', '(in the input) next target'], ['T · double-click', 'New note'], ['select + S', 'Grab the selected text as a snippet'], ['drag text', 'Onto the canvas: a snippet · onto a box: send it'],
      ['drag a prompt', 'A prompt bubble onto another box: run it there'], ['drag a note', 'Onto a box: send it'], ['Y A N', 'Answer the permission of the box you point at'],
      ['⌥R ⌥F', 'Review · fork the box you point at'], ['⌥T ⌥M', 'Terminal · code map for it'], ['⌥S ⌥. ⌥Z', 'Start/stop · interrupt · zoom'],
      ['G', 'Next gate (who needs you)'], ['[ ]', 'Previous / next snapshot'], ['P', 'Replay every change'], ['Esc', 'Back to live · fit all'],
      ['⌘\\', 'Focus mode ⇄ canvas'], ['⧉', 'Float a panel over the screen (both modes)'], ['↑ ↓ (focus)', 'Previous / next agent'],
      ['L', 'Arrange · saved layouts'], ['D', 'Director: off · rules · agent'], ['B', 'Show / hide the changes tray'], ['drag · wheel', 'Pan'], ['pinch · ⌘ wheel', 'Zoom'], ['⌘K', 'Spotlight: commands, previews, SQL'],
    ];
    o.innerHTML = `<div><h3>Studio keys</h3>${K.map(([k, t]) => `<p><kbd>${esc(k)}</kbd><span>${esc(t)}</span></p>`).join('')}</div>`;
    o.onclick = () => { o.remove(); this.r.focus({ preventScroll: true }); };
    this.r.append(o);
  }
}
