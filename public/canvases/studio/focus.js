// Focus mode: a classic coding UI around one agent. The agents on the left, the selected agent's session and a
// composer in the middle, its changes / terminals / previews / notes as tabs on the right.
//
// Nothing is copied: the same box and panel elements the canvas shows are moved into place, so switching modes is
// instant, terminals keep running and the transcript keeps streaming. Panels can also float — pinned to the screen
// (fractions of it), on top of either mode — and the director can switch modes, open tabs, float and move things
// through the same view command as everything else (POST /api/studio/view, studio_show).

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ICON = { terminal: '⌨', preview: '▣', map: '▦', review: '✓', note: '¶', prompt: '❯', snippet: '⧉', sql: '⛁' };
const PROMPT_MIME = 'application/x-studio-prompt';

export class Focus {
  constructor(v) {
    this.v = v;
    this.fa = localStorage.getItem('studio.fa.' + v.docId) || null;   // the focused agent
    this.tab = 'changes';
    this.rp = clamp(+(localStorage.getItem('studio.rp') || 0) || 480, 320, 1400);
    this.build();
  }
  get on() { return this.v.mode === 'focus'; }

  build() {
    const v = this.v;
    const f = el('div', 'st-focus');
    f.innerHTML = `
      <aside class="fx-side">
        <div class="fx-brand"><b>Evenflow</b><span class="root"></span></div>
        <button class="fx-new" data-x="new"><span>＋</span>New agent<kbd>N</kbd></button>
        <div class="fx-h">Agents</div>
        <div class="fx-list"></div>
        <div class="fx-gslot"></div>
        <div class="fx-foot"><button data-h="mode" title="Back to the canvas (⌘\\)">⊞ Canvas</button><button data-h="director"></button><button data-h="theme"></button><button data-h="spot" title="Spotlight">⌘K</button></div>
      </aside>
      <main class="fx-main">
        <div class="fx-session"></div>
        <div class="fx-composer"><div class="fx-ask" hidden></div><div class="box"><textarea rows="1" spellcheck="false"></textarea>
          <div class="row"><span class="stat"></span><span class="grow"></span><span class="hint"><kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line</span><button class="btn" data-x="stop" title="Interrupt (⌥.)">■ Stop</button><button class="btn pri" data-x="send">Send</button></div></div></div>
      </main>
      <div class="fx-grip" title="Drag to resize"></div>
      <section class="fx-pane"><div class="fx-tabs"></div><div class="fx-body"><div class="fx-changes"><div class="fx-sum"></div></div><div class="fx-pslot"></div></div></section>`;
    v.r.append(f);
    this.el = f;
    const $ = (s) => f.querySelector(s);
    this.list = $('.fx-list'); this.session = $('.fx-session'); this.ta = $('.fx-composer textarea'); this.ask = $('.fx-ask');
    this.tabsEl = $('.fx-tabs'); this.changes = $('.fx-changes'); this.sum = $('.fx-sum'); this.pslot = $('.fx-pslot'); this.gslot = $('.fx-gslot');
    f.style.setProperty('--rp', this.rp + 'px');

    $('.fx-foot').onclick = (e) => { const b = e.target.closest('button[data-h]'); if (b) v.hudAction(b); };
    $('.fx-new').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); v.picker({}, r.right + 8, r.top); };
    this.list.onclick = (e) => { const r = e.target.closest('[data-id]'); if (r) this.select(r.dataset.id); };
    this.list.ondblclick = (e) => { const r = e.target.closest('[data-id]'); if (r) v.setMode('canvas'); };
    // drop a prompt bubble or a snippet onto an agent in the list: send it there
    this.list.addEventListener('dragover', (e) => { const r = e.target.closest('[data-id]'); if (!r) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; this.list.querySelectorAll('.drop').forEach((x) => x.classList.toggle('drop', x === r)); r.classList.add('drop'); });
    this.list.addEventListener('dragleave', (e) => { if (!this.list.contains(e.relatedTarget)) this.list.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); });
    this.list.addEventListener('drop', (e) => {
      const r = e.target.closest('[data-id]');
      this.list.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
      if (!r) return;
      const prompt = e.dataTransfer.getData(PROMPT_MIME), text = prompt || e.dataTransfer.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      v.prompt(r.dataset.id, prompt ? prompt : `Look at this:\n\`\`\`\n${text}\n\`\`\``);
      v.toast(`${prompt ? 'Prompt' : 'Snippet'} sent to ${v.name(r.dataset.id)}`);
    });

    // composer
    const ta = this.ta;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(240, ta.scrollHeight) + 'px'; };
    this.grow = grow;
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
      else if (e.key === 'Escape') { ta.blur(); v.r.focus({ preventScroll: true }); }
      else if (e.key === 'ArrowUp' && !ta.value && this.fa) {   // recall the last prompt
        const last = [...v.rtOf(this.fa).events].reverse().find((x) => x.kind === 'user');
        if (last) { e.preventDefault(); ta.value = last.text; grow(); }
      }
    });
    $('.fx-composer .row').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.x === 'send') this.send(); else if (b.dataset.x === 'stop' && this.fa) v.cancel(this.fa); };
    this.ask.onclick = (e) => { const b = e.target.closest('[data-gate]'); if (b) v.answer(b.dataset.gate, b.dataset.opt); };

    // right pane
    this.tabsEl.onclick = (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) {
        const act = e.target.closest('[data-t]')?.dataset.t;
        if (act === 'float') return this.toggleFloat(t.dataset.tab);
        if (act === 'close') return this.closeTab(t.dataset.tab, e.target.closest('[data-t]'));
        return this.setTab(t.dataset.tab);
      }
      const add = e.target.closest('[data-x="add"]');
      if (add) this.addMenu(add);
    };
    this.sum.onclick = (e) => { const f2 = e.target.closest('.f'); if (f2 && this.fa) v.showFile(this.fa, f2.dataset.path); };
    const grip = $('.fx-grip');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = this.rp;
      const mv = (ev) => { this.rp = clamp(w0 + (x0 - ev.clientX), 320, Math.max(320, v.r.clientWidth - 248 - 380)); f.style.setProperty('--rp', this.rp + 'px'); v.r.style.setProperty('--rp', this.rp + 'px'); };
      const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); localStorage.setItem('studio.rp', String(this.rp)); };
      grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up);
    });
    v.r.style.setProperty('--rp', this.rp + 'px');

    // floating panels: dragged and resized in screen space, saved as fractions of the screen
    v.on(v.floatEl, 'pointerdown', (e) => this.floatDown(e));
  }

  // ---------------------------------------------------------------- mode
  enter() {
    const v = this.v;
    if (v.target?.kind === 'agent' && v.agentDef(v.target.id)) this.fa = v.target.id;
    if (v.hover?.kind === 'agent') this.fa = v.hover.id;
    this.savedFilter = v.filter;
    this.changes.append(v.$('.st-tray'));
    this.gslot.append(v.gatesEl);
    this.el.querySelector('.fx-brand .root').textContent = v.$('.st-brand .root').textContent;
    this.ensureAgent();
    if (this.fa) { v.setFilter(this.fa, true); v.setTarget({ kind: 'agent', id: this.fa }); }
    setTimeout(() => { v.lazyDiffs(); if (!v.r.querySelector('.st-input,.st-spot,.st-pick')) this.ta.focus({ preventScroll: true }); }, 30);
  }
  leave() {
    const v = this.v;
    v.r.append(v.$('.st-tray'));
    v.r.append(v.gatesEl);
    v.filter = this.savedFilter ?? null;
    v.renderFilter(); v.renderTray(); v.renderTimelineHead();
  }
  ensureAgent() {
    const ags = this.v.doc?.agents || [];
    if (!this.fa || !ags.some((a) => a.id === this.fa)) this.fa = (ags.find((a) => a.role !== 'director') || ags[0])?.id || null;
  }

  /** Put every box and panel where it belongs: the focused agent in the middle, its panels as tabs, floats on top. */
  place() {
    const v = this.v, d = v.doc;
    if (!d) return;
    const on = this.on;
    if (on) this.ensureAgent();
    if (on && this.pending && v.agentDef(this.pending)) { this.fa = this.pending; this.pending = null; v.setFilter(this.fa, true); v.setTarget({ kind: 'agent', id: this.fa }); }
    for (const [id, n] of v.agentEls) {
      if (on && id === this.fa) { if (n.parentElement !== this.session) this.session.append(n); n.classList.add('in-focus'); }
      else if (n.parentElement !== v.world) { n.classList.remove('in-focus'); v.world.append(n); }
    }
    const empty = this.session.querySelector('.fx-empty');
    if (on && !this.fa && !empty) this.session.append(el('div', 'fx-empty', `<b>No agents yet.</b><span>Each agent is an ACP session in its own git worktree.</span><button class="btn pri">＋ New agent</button>`));
    else if ((this.fa || !on) && empty) empty.remove();
    const em = this.session.querySelector('.fx-empty button');
    if (em) em.onclick = (e) => { const r = e.target.getBoundingClientRect(); v.picker({}, r.left, r.bottom + 8); };
    if (on && this.tab !== 'changes' && !this.tabs().some((p) => p.id === this.tab)) this.tab = 'changes';
    for (const p of d.panels) {
      const n = v.panelEls.get(p.id);
      if (!n) continue;
      n.querySelector('[data-a="float"]')?.classList.toggle('on', !!p.float);
      if (p.float) {
        if (n.parentElement !== v.floatEl) v.floatEl.append(n);
        n.classList.add('is-float'); n.classList.remove('in-pane', 'lod-chip');
        if (this.fdrag?.id !== p.id) Object.assign(n.style, { left: p.float.x * 100 + '%', top: p.float.y * 100 + '%', width: p.float.w * 100 + '%', height: p.float.h * 100 + '%' });
      } else if (on && this.tab === p.id) {
        if (n.parentElement !== this.pslot) this.pslot.append(n);
        n.classList.add('in-pane'); n.classList.remove('is-float', 'lod-chip');
      } else {
        if (n.parentElement !== v.world) v.world.append(n);
        if (n.classList.contains('is-float') || n.classList.contains('in-pane')) { n.classList.remove('is-float', 'in-pane'); Object.assign(n.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px' }); }
      }
    }
    this.changes.hidden = on && this.tab !== 'changes';
    this.pslot.hidden = !on || this.tab === 'changes';
    if (on) this.paint();
  }

  /** The tabs of the right pane: changes, then the focused agent's panels, then the project's (unowned) ones. */
  tabs() {
    const v = this.v;
    const ps = (v.doc?.panels || []).filter((p) => !p.float);
    return [...ps.filter((p) => p.source?.agent && p.source.agent === this.fa), ...ps.filter((p) => !p.source?.agent || !v.agentDef(p.source.agent))];
  }
  select(id, tab) {
    const v = this.v;
    if (!v.agentDef(id)) return;
    const changed = id !== this.fa;
    this.fa = id;
    try { localStorage.setItem('studio.fa.' + v.docId, id); } catch {}
    v.setTarget({ kind: 'agent', id });
    if (!this.on) return;
    if (changed) v.setFilter(id, true);
    if (tab) this.tab = tab;
    this.place();
    if (changed) { const log = v.agentEls.get(id)?.querySelector('.st-log'); if (log) log.scrollTop = log.scrollHeight; }
  }
  setTab(t) {
    this.tab = t || 'changes';
    this.place();
    if (this.tab === 'changes') setTimeout(() => this.v.lazyDiffs(), 20);
    else setTimeout(() => this.v.bodies.get(this.tab)?.fit?.(), 20);
  }
  /** Bring something into view in focus mode (instead of flying the camera). */
  reveal(kind, id) {
    const v = this.v;
    if (kind === 'agent') return this.select(id);
    const p = v.doc.panels.find((x) => x.id === id);
    if (!p) return;
    if (p.float) { const n = v.panelEls.get(id); n?.classList.remove('flash'); void n?.offsetWidth; n?.classList.add('flash'); return; }
    if (p.source?.agent && v.agentDef(p.source.agent)) this.select(p.source.agent, id);
    else this.setTab(id);
  }

  // ---------------------------------------------------------------- floating
  toggleFloat(pid) {
    const v = this.v, p = v.doc.panels.find((x) => x.id === pid);
    if (!p) return;
    let float = null;
    if (!p.float) {
      const n = v.panelEls.get(pid), R = v.r.getBoundingClientRect(), b = n.getBoundingClientRect();
      const w = clamp(b.width / R.width, 0.2, 0.46), h = clamp(b.height / R.height, 0.24, 0.6);
      const seen = b.width > 40 && b.left >= R.left && b.top >= R.top && b.right <= R.right + 1 && b.bottom <= R.bottom + 1 && !n.classList.contains('in-pane');
      const stack = v.doc.panels.filter((x) => x.float).length;
      float = seen ? { x: clamp((b.left - R.left) / R.width, 0, 1 - w), y: clamp((b.top - R.top) / R.height, 0, 1 - h), w, h }
        : { x: clamp(1 - w - 0.02 - stack * 0.02, 0, 1 - w), y: clamp(0.07 + stack * 0.04, 0, 1 - h), w, h };
    } else if (this.on && (p.source?.agent === this.fa || !p.source?.agent)) this.tab = pid;
    v.ctx.submit([{ op: 'updatePanel', id: pid, set: { float } }], float ? 'float' : 'unfloat');
    v.syncLayout();
    v.toast(float ? 'Floating — stays on screen in both modes (⧉ again to put it back)' : 'Back in place');
  }
  floatDown(e) {
    const v = this.v, n = e.target.closest('.st-panel');
    if (!n || e.button !== 0) return;
    const titleGrip = e.target.closest('.st-ph .t') && document.activeElement !== e.target;
    const rs = e.target.closest('.st-resize');
    if (!rs && (!e.target.closest('.st-ph') || (e.target.closest('button,input') && !titleGrip))) return;
    e.preventDefault();
    const R = v.r.getBoundingClientRect(), b = n.getBoundingClientRect();
    const d = { id: n.dataset.id, mode: rs ? 'resize' : 'move', x: e.clientX, y: e.clientY, l: b.left - R.left, t: b.top - R.top, w: b.width, h: b.height, moved: false };
    this.fdrag = d;
    n.classList.add('dragging');
    n.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      if (d.mode === 'move') Object.assign(n.style, { left: clamp(d.l + dx, -d.w + 60, R.width - 60) + 'px', top: clamp(d.t + dy, 0, R.height - 34) + 'px' });
      else Object.assign(n.style, { width: clamp(d.w + dx, 220, R.width) + 'px', height: clamp(d.h + dy, 120, R.height) + 'px' });
    };
    const up = () => {
      n.removeEventListener('pointermove', mv); n.removeEventListener('pointerup', up); n.removeEventListener('pointercancel', up);
      n.classList.remove('dragging');
      this.fdrag = null;
      if (!d.moved) return;
      const nb = n.getBoundingClientRect();
      const w = clamp(nb.width / R.width, 0.08, 1), h = clamp(nb.height / R.height, 0.08, 1);
      const float = { x: clamp((nb.left - R.left) / R.width, 0, 1 - w), y: clamp((nb.top - R.top) / R.height, 0, 1 - h), w, h };
      v.ctx.submit([{ op: 'updatePanel', id: d.id, set: { float } }], d.mode === 'move' ? 'move' : 'resize');
      v.syncLayout();
    };
    n.addEventListener('pointermove', mv); n.addEventListener('pointerup', up); n.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- tabs
  addMenu(anchor) {
    const v = this.v, id = this.fa;
    v.popList(anchor, [
      { label: 'Terminal in this worktree', kbd: '⌥T', run: () => v.openKind('terminal', id) },
      { label: 'Preview a running UI…', run: () => { const u = prompt('URL or port of the running app', 'http://localhost:5173'); if (u) v.openKind('preview', id, { url: u }); } },
      { label: 'Code map', kbd: '⌥M', run: () => v.openKind('map', id) },
      { label: 'Note', run: () => v.openKind('note', id) },
      { label: 'Review the changes', kbd: '⌥R', run: () => v.review(id) },
    ].filter((x) => id || !/worktree|Review/.test(x.label)), 240);
  }
  closeTab(pid, btn) {
    if (!btn.classList.contains('arm')) { btn.classList.add('arm'); btn.textContent = '?'; btn.title = 'Click again to delete'; setTimeout(() => { btn.classList.remove('arm'); btn.textContent = '✕'; }, 1800); return; }
    this.v.ctx.submit([{ op: 'removePanel', id: pid }], 'delete panel');
    if (this.tab === pid) this.tab = 'changes';
    this.v.syncLayout();
  }

  // ---------------------------------------------------------------- composer
  send() {
    const t = this.ta.value.trim();
    if (!t || !this.fa) return;
    this.ta.value = '';
    this.grow();
    this.v.prompt(this.fa, t);
  }

  // ---------------------------------------------------------------- painting
  dirty() {
    if (!this.on || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.paint(); });
  }
  paint() {
    if (!this.on) return;
    this.renderList(); this.renderTabs(); this.renderComposer(); this.renderSum();
  }
  renderList() {
    const v = this.v;
    const html = v.doc.agents.map((a) => {
      const r = v.rtOf(a.id), st = r.info.status || 'stopped';
      const g = v.gates.filter((x) => x.agent === a.id && x.kind !== 'info');
      const red = v.lightsAt(a.id).some((x) => x.level === 'red');
      const line = r.info.status === 'error' ? `✗ ${r.info.error || 'error'}` : r.info.subtitle || [a.role, a.branch].filter(Boolean).join(' · ') || a.cwd || '';
      return `<div class="fx-ag ${a.id === this.fa ? 'on' : ''} s-${esc(st)}" data-id="${esc(a.id)}" style="--c:${esc(a.color)}" title="${esc(a.cwd || '')}">
        <i></i><div class="tx"><div class="l1"><b>${a.role === 'director' ? '◎ ' : ''}${esc(a.name)}</b>${red ? '<span class="red" title="A monitor is red">●</span>' : ''}<span class="pill ${esc(st)}">${esc(st)}</span></div><div class="l2">${esc(line)}</div></div>${g.length ? `<span class="g ${g.some((x) => x.blocking) ? 'blk' : ''}" title="${esc(g.map((x) => x.title).join('\n'))}">${g.length}</span>` : ''}</div>`;
    }).join('');
    if (this.list.innerHTML !== html) this.list.innerHTML = html || '<div class="fx-none">Nothing running yet.</div>';
  }
  renderTabs() {
    const v = this.v;
    const snaps = this.fa ? v.snapsOf(this.fa).filter((s) => s.n > 0).length : 0;
    const t = this.tabs();
    const html = `<button class="tab ${this.tab === 'changes' ? 'on' : ''}" data-tab="changes"><span class="ic">±</span><span class="t">Changes</span>${snaps ? `<span class="n">${snaps}</span>` : ''}</button>`
      + t.map((p) => `<button class="tab ${this.tab === p.id ? 'on' : ''}" data-tab="${esc(p.id)}" style="--c:${esc(p.color || (p.source?.agent ? v.color(p.source.agent) : '#a1a1aa'))}" title="${esc(p.title || p.kind)}"><span class="ic">${ICON[p.kind] || '¶'}</span><span class="t">${esc(p.title || p.kind)}</span><i data-t="float" title="Float it over the screen">⧉</i><i data-t="close" title="Delete">✕</i></button>`).join('')
      + `<button class="add" data-x="add" title="Terminal, preview, code map, note…">＋</button>`;
    if (this.tabsEl.dataset.h !== html) { this.tabsEl.innerHTML = html; this.tabsEl.dataset.h = html; this.tabsEl.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  renderComposer() {
    const v = this.v, id = this.fa;
    const row = this.el.querySelector('.fx-composer .row'), stat = row.querySelector('.stat');
    if (!id) { stat.textContent = ''; this.ta.placeholder = 'Make an agent first'; this.ta.disabled = true; this.ask.hidden = true; return; }
    this.ta.disabled = false;
    const a = v.agentDef(id), r = v.rtOf(id), st = r.info.status || 'stopped';
    this.el.querySelector('.fx-composer').style.setProperty('--c', a.color);
    this.ta.placeholder = st === 'working' ? `Queue a message for ${a.name}…` : `Message ${a.name}…`;
    stat.innerHTML = `<i></i>${esc(a.name)} · ${esc(st === 'working' ? `working${r.info.turn ? ' · turn ' + r.info.turn : ''}` : st === 'stopped' ? 'stopped — sending starts it' : st)}${r.info.queue ? ` · +${r.info.queue} queued` : ''}`;
    row.querySelector('[data-x="stop"]').hidden = !['working', 'waiting'].includes(st);
    const perm = v.gates.find((g) => g.agent === id && g.kind === 'permission');
    this.ask.hidden = !perm;
    if (perm) {
      const key = perm.id;
      if (this.ask.dataset.g !== key) {
        this.ask.dataset.g = key;
        this.ask.innerHTML = `<span class="q"><b>${esc(a.name)} asks</b> ${esc(perm.title)}</span><span class="grow"></span>${(perm.json?.options || []).map((o) => `<button class="btn ${o.kind?.startsWith('allow') ? 'ok' : 'no'}" data-gate="${esc(perm.id)}" data-opt="${esc(o.optionId)}">${esc(o.name)}${o.kind === 'allow_once' ? ' <kbd>Y</kbd>' : o.kind === 'reject_once' ? ' <kbd>N</kbd>' : ''}</button>`).join('')}`;
      }
    } else this.ask.dataset.g = '';
  }
  renderSum() {
    const v = this.v, n = this.fa && v.agentEls.get(this.fa);
    if (!n) { this.sum.innerHTML = ''; return; }
    const fc = n.querySelector('.fc').textContent, files = n.querySelector('.st-files').innerHTML;
    const lights = v.lightsAt(this.fa).filter((x) => x.level !== 'skip');
    const html = `<div class="h"><b>Files</b><span>${esc(fc || 'none yet')}</span><span class="grow"></span><div class="lights">${lights.map((x) => `<span class="light ${esc(x.level)}" title="${esc(x.summary || '')}"><i></i>${esc(x.monitor)}</span>`).join('')}</div></div>${fc ? `<div class="st-files">${files}</div>` : ''}`;
    if (this.sum.dataset.h !== html) { this.sum.innerHTML = html; this.sum.dataset.h = html; }
  }

  // ---------------------------------------------------------------- keys (when nothing is focused)
  onKey(e) {
    const v = this.v, k = e.key, id = this.fa;
    if (k === 'Escape') { if (!v.closeOverlays()) { if (v.playing) v.stopPlay(); else if (v.T != null) v.scrub(null); } return true; }
    if (k === 'Enter' || k === '/') { e.preventDefault(); this.ta.focus(); return true; }
    const perm = id && v.gates.find((g) => g.agent === id && g.kind === 'permission');
    if (perm && /^[yan]$/i.test(k)) {
      const want = { y: 'allow_once', a: 'allow_always', n: 'reject_once' }[k.toLowerCase()];
      const o = perm.json.options.find((x) => x.kind === want) || perm.json.options.find((x) => x.kind?.startsWith(k.toLowerCase() === 'n' ? 'reject' : 'allow'));
      if (o) { e.preventDefault(); v.answer(perm.id, o.optionId); return true; }
    }
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'j' || k === 'k') {
      const ags = v.doc.agents, i = ags.findIndex((a) => a.id === id);
      const nx = ags[clamp(i + (k === 'ArrowDown' || k === 'j' ? 1 : -1), 0, ags.length - 1)];
      if (nx) { e.preventDefault(); this.select(nx.id); }
      return true;
    }
    const map = { '[': () => v.step(-1), ']': () => v.step(1), '?': () => v.help(), g: () => v.nextGate(), p: () => v.togglePlay(), b: () => this.setTab('changes'), d: () => v.directorMenu(this.el.querySelector('[data-h="director"]')), n: () => { const b = this.el.querySelector('.fx-new').getBoundingClientRect(); v.picker({}, b.right + 8, b.top); } };
    if (map[k]) { e.preventDefault(); map[k](); return true; }
    const selText = window.getSelection()?.toString();
    if ((k === 's' || k === 'S') && selText?.trim()) { e.preventDefault(); v.snippet(selText, null); return true; }
    if (k.length === 1 && !e.repeat && /\S/.test(k) && id) {   // just start typing: it goes to the composer
      e.preventDefault();
      this.ta.focus();
      this.ta.setRangeText(k, this.ta.value.length, this.ta.value.length, 'end');
      this.grow();
      return true;
    }
    return false;
  }
}
