// The director: something that runs the screen, so the person in front of it sees what matters without driving.
//
//   off     the screen is yours
//   auto    deterministic rules, no model: a permission or a red monitor brings that box (and its diff) into view,
//           a new box or fork re-arranges the canvas, a dev server an agent starts opens as a preview next to it,
//           a lone working agent is followed, a quiet studio zooms out to the whole picture
//   agent   a director *agent* (any ACP agent, in a box with role "director") gets a digest of what happened and
//           decides with its studio tools (studio_show: focus, preview, scrub, arrange) — the rules above still
//           open previews and report, the agent decides where the camera goes
//
// The director never fights you: while you are using the studio (pointer, keys) it only reports, it does not move.
// Every move it makes is a view command with a reason, shown on screen.

const QUIET_MS = 15000;     // after the user touched the studio, the director only reports
const GAP_MS = 3500;        // at most one camera move this often
const DIGEST_MS = 12000;    // how often a director agent hears about new things
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))\/?[^\s"'<>)\]]*/gi;

export const DIRECTOR_PRIMER = `[Studio: you are the DIRECTOR of this studio's screen. You do not write code. Other agents work in boxes on a canvas; every few seconds you get a digest of what happened. Decide what the person watching should see right now and make it so with your studio tools:
- studio_show {focus: "<agent id>"} — bring a box into view (one that needs the person, or the most interesting work)
- studio_show {open: {kind: "preview", url: "http://localhost:PORT", agent: "<agent id>"}} — show a running UI
- studio_show {scrub: <snapshot>, agent: "<agent id>"} or {scrub: "live"} — show a moment in the diff timeline
- studio_show {arrange: "tree" | "grid" | "focus"} and {fit: true} — the overall layout
Always pass "reason": one short sentence the person will read on screen. Prefer stillness: move only when it helps. Answer each digest with one short line.]

`;

export class Director {
  constructor(studio) {
    this.s = studio;
    this.docs = new Map();   // doc id -> { lastMove, lastPri, active, previewed:Set, gates:Set, notes:[], digestT, pending }
  }
  init() {
    this.off = this.s.store.subscribe((e) => { try { this.onEvent(e); } catch (err) { console.error('director', err.message); } });
    return this;
  }
  close() { this.off?.(); for (const d of this.docs.values()) { clearTimeout(d.digestT); clearTimeout(d.followT); clearTimeout(d.overviewT); } }
  st(docId) {
    let d = this.docs.get(docId);
    if (!d) { d = { lastMove: 0, lastPri: -1, active: 0, previewed: new Set(), gates: new Set(), notes: [], working: new Set() }; this.docs.set(docId, d); }
    return d;
  }
  mode(docId) { return this.s.store.state.docs[docId]?.config?.director || 'off'; }
  /** The person touched the studio (the view reports pointer and keys every few seconds). */
  activity(docId) { this.st(docId).active = Date.now(); }
  directorBox(docId) { return this.s.store.state.docs[docId]?.agents.find((a) => a.role === 'director') || null; }
  name(id) { try { return this.s.agentDef(id).a.name; } catch { return id; } }

  onEvent(e) {
    if (e.type === 'batch') {
      const d = this.s.store.state.docs[e.doc];
      if (d?.type !== 'studio' || this.mode(d.id) === 'off') return;
      const added = (e.ops || []).filter((o) => o.op === 'addAgent' && o.agent?.role !== 'director');
      if (added.length && e.by !== 'director') {
        const a = added.at(-1).agent;
        this.note(d.id, `new box ${a.name} (agent ${a.id})${a.forkOf ? ` from ${this.name(a.forkOf.agent)}${a.why ? ': ' + a.why : ''}` : ''}`);
        if (this.mode(d.id) === 'auto') this.propose(d.id, { arrange: a.forkOf ? 'tree' : 'grid', focus: { agent: a.id } }, 2, `${a.forkOf ? `${this.name(a.forkOf.agent)} spun off` : 'New box'} ${a.name}${a.why ? ' — ' + a.why : ''}`);
      }
      return;
    }
    if (e.type !== 'studio' || !e.doc) return;
    const docId = e.doc;
    const mode = this.mode(docId);
    if (mode === 'off') return;
    const d = this.st(docId);
    const agent = e.agent;
    if (agent && this.directorBox(docId)?.id === agent) return;   // the director's own box is not news
    switch (e.kind) {
      case 'gates': {
        for (const g of e.gates || []) {
          if (d.gates.has(g.id)) continue;
          d.gates.add(g.id);
          if (this.directorBox(docId)?.id === g.agent) continue;
          const who = this.name(g.agent);
          if (g.kind === 'permission') { this.note(docId, `${who} (agent ${g.agent}) asks permission: ${g.title}`); this.propose(docId, { focus: { agent: g.agent } }, 3, `${who} asks: ${g.title}`); }
          else if (g.kind === 'monitor') { this.note(docId, `${who} (agent ${g.agent}): ${g.title} — ${g.detail} (snapshot ${g.json?.snap})`); this.propose(docId, { focus: { agent: g.agent }, scrub: g.json?.snap != null ? { agent: g.agent, snap: g.json.snap } : undefined, tray: true }, 2, `${who}: ${g.title}`); }
          else if (g.kind === 'error') { this.note(docId, `${who} (agent ${g.agent}) failed: ${g.detail}`); this.propose(docId, { focus: { agent: g.agent } }, 3, `${who} stopped: ${String(g.detail || '').slice(0, 80)}`); }
          else if (g.kind === 'turn') { this.note(docId, `${who} (agent ${g.agent}) finished a turn: ${g.detail}`); this.overviewSoon(docId); }
        }
        return;
      }
      case 'status': {
        if (e.status === 'working') d.working.add(agent); else d.working.delete(agent);
        if (mode === 'auto' && e.status === 'working') this.followSoon(docId);
        if (!d.working.size) this.overviewSoon(docId);
        return;
      }
      case 'say': this.urls(docId, agent, e.text); return;
      case 'tool': for (const c of e.event?.json?.content || []) if (c.text) this.urls(docId, agent, c.text); return;
      case 'snapshot': if (e.snap?.files?.length) this.note(docId, `${this.name(agent)} (agent ${agent}) changed ${e.snap.files.map((f) => f.path).slice(0, 4).join(', ')}${e.snap.files.length > 4 ? ' …' : ''} — snapshot ${e.snap.n}: ${e.snap.reason}`, true); return;
    }
  }

  /** A dev server an agent mentions (http://localhost:5173) opens once, as a preview next to that agent. */
  urls(docId, agent, text) {
    if (!agent || !text) return;
    const d = this.st(docId);
    for (const m of String(text).matchAll(URL_RE)) {
      const port = +m[1];
      if (!port || port === this.ownPort() || d.previewed.has(port)) continue;
      d.previewed.add(port);
      const url = m[0].replace(/[.,;:]+$/, '');
      this.note(docId, `${this.name(agent)} (agent ${agent}) started a server: ${url}`);
      try {
        const r = this.s.view({ doc: docId, by: 'director', reason: `${this.name(agent)} started ${url}`, open: { kind: 'preview', agent, url, title: url }, focus: this.quiet(docId) ? false : undefined });
        d.lastMove = Date.now();
        void r;
      } catch (err) { console.error('director preview', err.message); }
    }
  }
  ownPort() { try { return +new URL(this.s.url).port; } catch { return 0; } }
  quiet(docId) { return Date.now() - this.st(docId).active < QUIET_MS; }

  /** Move the camera, unless the person is busy (then: only tell them) or a more important move just happened. */
  propose(docId, cmd, pri, reason) {
    const d = this.st(docId);
    if (this.mode(docId) === 'agent' && this.directorBox(docId)) { this.digestSoon(docId); return; }
    const now = Date.now();
    if (this.quiet(docId) || (now - d.lastMove < GAP_MS && pri <= d.lastPri)) {
      this.s.store.emit({ type: 'studio', doc: docId, agent: null, kind: 'view', ts: now, by: 'director', reason, report: true });
      return;
    }
    d.lastMove = now; d.lastPri = pri;
    clearTimeout(d.followT); clearTimeout(d.overviewT);
    try { this.s.view({ doc: docId, by: 'director', reason, ...cmd }); } catch (err) { console.error('director', err.message); }
    setTimeout(() => { if (d.lastPri === pri) d.lastPri = -1; }, GAP_MS * 3).unref?.();
  }
  followSoon(docId) {
    const d = this.st(docId);
    clearTimeout(d.followT);
    d.followT = setTimeout(() => {
      if (d.working.size !== 1 || this.quiet(docId)) return;
      const id = [...d.working][0];
      this.propose(docId, { focus: { agent: id } }, 0, `Following ${this.name(id)}`);
    }, 2500);
    d.followT.unref?.();
  }
  overviewSoon(docId) {
    const d = this.st(docId);
    clearTimeout(d.overviewT);
    d.overviewT = setTimeout(() => {
      if (d.working.size || this.quiet(docId) || this.mode(docId) !== 'auto') return;
      if (this.s.db.openGates().some((g) => g.blocking)) return;
      this.propose(docId, { fit: true }, 0, 'All quiet — the whole picture');
    }, 9000);
    d.overviewT.unref?.();
  }

  // ------------------------------------------------------------ director agent: digests
  note(docId, line, minor = false) {
    const d = this.st(docId);
    d.notes.push({ ts: Date.now(), line, minor });
    if (d.notes.length > 60) d.notes = d.notes.slice(-60);
    if (this.mode(docId) === 'agent') this.digestSoon(docId);
  }
  digestSoon(docId) {
    const d = this.st(docId);
    if (d.digestT) return;
    const wait = Math.max(1500, DIGEST_MS - (Date.now() - (d.lastDigest || 0)));
    d.digestT = setTimeout(() => { d.digestT = null; this.digest(docId); }, wait);
    d.digestT.unref?.();
  }
  digest(docId) {
    const d = this.st(docId);
    const box = this.directorBox(docId);
    if (!box || !d.notes.some((n) => !n.minor)) return;
    const r = this.s.rt.get(box.id);
    if (r && r.status === 'working') return this.digestSoon(docId);
    const doc = this.s.store.state.docs[docId];
    const notes = d.notes.splice(0);
    d.lastDigest = Date.now();
    const boxes = doc.agents.filter((a) => a.role !== 'director').map((a) => { const rr = this.s.rt.get(a.id); return `${a.name} (agent ${a.id}): ${rr?.status || 'stopped'}${rr?.subtitle ? ` — "${rr.subtitle.slice(0, 100)}"` : ''}`; });
    const text = `[Director digest]\nWhat happened:\n${notes.map((n) => '- ' + n.line).join('\n')}\nBoxes now:\n${boxes.map((b) => '- ' + b).join('\n')}\nThe person ${this.quiet(docId) ? 'is using the studio right now — only move if it really matters' : 'is watching'}.`;
    this.s.get(box.id).prompt(text, 'director');
  }
}
