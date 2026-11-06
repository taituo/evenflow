// Studio runtime: one ACP session per agent box on a studio canvas, each in its own git worktree, every step
// recorded as SQL, every file change snapshotted into a shadow git, checked by deterministic monitors, and
// surfaced as gates when a human is needed. The canvas layout itself is an ordinary versioned spread doc.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AcpClient } from './acp.js';
import { SessionDB } from './db.js';
import { Shadow, git, isGitRepo } from './shadow.js';
import { builtinMonitors, commandMonitors, runCommandMonitor } from './monitors.js';
import { jsonToOps } from '../sql.js';
import { Terms } from './terms.js';
import { Director, DIRECTOR_PRIMER } from './director.js';
import { arrange as arrangeOps } from '../../public/canvases/studio/layout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const COLORS = ['#7f77dd', '#1d9e75', '#d85a30', '#378add', '#d4537e', '#ba7517', '#5dcaa5', '#e24b4a', '#97c459', '#afa9ec'];
const uid = (p) => p + crypto.randomBytes(4).toString('hex');
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent';
const lastSentence = (t) => { const s = String(t || '').trim().split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim()); return (s.at(-1) || '').slice(0, 240); };
const httpErr = (status, message) => Object.assign(new Error(message), { status });

export function defaultPresets() {
  return {
    mock: { label: 'Mock agent (demo, no model)', command: [process.execPath, path.join(ROOT, 'bin', 'mock-acp.mjs')] },
    kiro: { label: 'Kiro CLI', command: 'kiro-cli acp --agent-engine=v3' },
    claude: { label: 'Claude Code (ACP adapter)', command: 'claude-code-acp' },
    gemini: { label: 'Gemini CLI', command: 'gemini --experimental-acp' },
  };
}

export class Studio {
  constructor(store, opts = {}) {
    this.store = store;
    this.dir = path.join(store.dir, 'studio');
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new SessionDB(path.join(this.dir, 'sessions.sqlite'));
    this.rt = new Map();          // agent id -> Runtime
    this.target = null;           // what the user points at: { doc, kind: 'agent'|'panel', id, ts }
    this.env = opts.env || {};
    this.autoStart = opts.autoStart !== false;
    this.url = opts.url || null;   // set by the server once it listens; agents reach the studio tools through it
    this.terms = new Terms((doc, kind, payload) => this.store.emit({ type: 'studio', doc, agent: null, kind, ts: Date.now(), ...payload }));
    this.director = new Director(this);
  }

  /** MCP servers handed to every ACP session: the studio's own tools (fork, spawn, show, note, status). */
  mcpServers(agentId) {
    if (!this.url || process.env.STUDIO_MCP === '0') return [];
    return [{ name: 'studio', command: process.execPath, args: [path.join(ROOT, 'bin', 'studio-mcp.mjs')], env: [{ name: 'STUDIO_URL', value: this.url }, { name: 'STUDIO_AGENT', value: agentId }, ...(process.env.SPREAD_TOKEN ? [{ name: 'SPREAD_TOKEN', value: process.env.SPREAD_TOKEN }] : [])] }];
  }

  init() {
    for (const id of this.store.state.order) {
      const d = this.store.state.docs[id];
      if (d.type !== 'studio') continue;
      for (const a of d.agents) this.runtime(d.id, a.id);
    }
    // layout changes made by anyone (undo, restore, another tab) keep the runtimes in step
    this.off = this.store.subscribe((e) => {
      if (e.type !== 'batch' && e.type !== 'docs') return;
      const d = this.store.state.docs[e.doc];
      if (e.type === 'docs' && !d) { for (const r of this.rt.values()) if (r.doc === e.doc) this.drop(r.id); return; }
      if (!d || d.type !== 'studio') return;
      const pids = new Set(d.panels.map((p) => p.id));
      for (const t of this.terms.list()) if (t.id.startsWith(d.id + ':') && !pids.has(t.id.slice(d.id.length + 1))) this.terms.kill(t.id);
      const ids = new Set(d.agents.map((a) => a.id));
      for (const r of [...this.rt.values()]) if (r.doc === d.id && !ids.has(r.id)) this.drop(r.id);
      for (const a of d.agents) if (!this.rt.has(a.id)) this.runtime(d.id, a.id);
    });
    this.director.init();
    return this;
  }
  close() { this.director.close(); this.closed = true; clearTimeout(this.mirrorTimer); this.off?.(); for (const r of this.rt.values()) r.stop(); this.terms.close(); this.db.close(); }

  presets() {
    const s = this.store.settings().studioAgents || {};
    let env = {};
    try { env = JSON.parse(process.env.STUDIO_AGENTS || '{}'); } catch {}
    return { ...defaultPresets(), ...s, ...env };
  }
  emit(doc, agent, kind, payload = {}) {
    this.store.emit({ type: 'studio', doc, agent, kind, ts: Date.now(), ...payload });
    if (doc && this.mirrorOn !== false && ['status', 'monitor', 'snapshot', 'gates', 'plan'].includes(kind)) this.mirrorSoon(doc);
  }

  // ---------------------------------------------------------------- the dashboard twin
  /**
   * Mirror every studio canvas into an ordinary sheet ("<doc>-dash"): an Agents table and a Monitors table with
   * traffic lights. So spread's Live mode, the TV remote, SQL over tables and time replay all work on the agents.
   */
  mirrorSoon(doc) {
    if (this.closed) return;
    this.mirrorDocs = this.mirrorDocs || new Set();
    this.mirrorDocs.add(doc);
    if (this.mirrorTimer) return;
    this.mirrorTimer = setTimeout(() => { this.mirrorTimer = null; const ds = [...this.mirrorDocs]; this.mirrorDocs.clear(); for (const d of ds) { try { this.mirror(d); } catch (e) { console.error('studio mirror', e.message); } } }, 1500);
    this.mirrorTimer.unref?.();
  }
  mirror(docId) {
    const d = this.store.state.docs[docId];
    if (!d || d.type !== 'studio' || !d.agents.length) return;
    const gates = this.db.openGates();
    const agents = d.agents.map((a) => {
      const r = this.rt.get(a.id);
      const snaps = this.db.snapshots(a.id);
      const reds = this.db.monitorsAt(a.id).filter((m) => m.level === 'red').length;
      return { Agent: a.name, Status: r?.status || 'stopped', Turn: r?.turn || 0, Snapshots: Math.max(0, snaps.length - 1), Lines: snaps.slice(1).reduce((n, s) => n + s.adds + s.dels, 0), Red: reds, Gates: gates.filter((g) => g.agent === a.id).length, Said: r?.subtitle || '' };
    });
    const monitors = d.agents.flatMap((a) => this.db.monitorsAt(a.id).filter((m) => m.level !== 'skip').map((m) => ({ Agent: a.name, Monitor: m.monitor, Level: m.level, Summary: m.summary || '' })));
    const key = JSON.stringify([agents, monitors]);
    if (this.mirrorKey?.[docId] === key) return;
    (this.mirrorKey ||= {})[docId] = key;
    const id = `${docId}-dash`;
    let dash = this.store.state.docs[id];
    const ops = [];
    if (!dash) {
      this.store.createDoc({ type: 'sheet', title: `${d.title} dashboard`, id, by: 'studio' });
      dash = this.store.state.docs[id];
      ops.push({ op: 'renameSheet', sheet: dash.sheets[0].name, name: 'Agents' },
        { op: 'set', sheet: 'Agents', cells: { B2: `${d.title} — agents`, B3: 'Mirrored from the studio canvas. Live mode, replay and SQL work on it like on any sheet.' } },
        { op: 'format', sheet: 'Agents', range: 'B2', style: { b: true, fs: 22 } }, { op: 'format', sheet: 'Agents', range: 'B3', style: { i: true, color: '#5f6368' } },
        { op: 'resize', sheet: 'Agents', cols: { A: 24, B: 90, C: 90, I: 360, K: 90, L: 90, M: 70, N: 420 } });
      this.store.batch({ doc: id, by: 'studio', ops, label: 'studio dashboard' });
      ops.length = 0;
    }
    const first = !TYPES_HAS(dash, 'Agents');
    ops.push(...jsonToOps(dash, 'Agents', agents, 'Agents!B5'));
    ops.push(...jsonToOps(dash, 'Monitors', monitors.length ? monitors : [{ Agent: '', Monitor: '', Level: '', Summary: '' }], 'Agents!K5'));
    if (first) {
      ops.push({ op: 'cond', sheet: 'Agents', range: 'C6:C200', id: 'status', rules: [{ when: '=', value: 'error', light: 'red' }, { when: '=', value: 'waiting', light: 'amber' }, { when: '=', value: 'working', light: 'blue' }, { when: '=', value: 'idle', light: 'green' }, { when: 'notEmpty', light: 'gray' }] },
        { op: 'cond', sheet: 'Agents', range: 'G6:G200', id: 'reds', rules: [{ when: '>', value: 0, light: 'red' }, { when: '=', value: 0, light: 'green' }] },
        { op: 'cond', sheet: 'Agents', range: 'H6:H200', id: 'gates', rules: [{ when: '>', value: 0, light: 'amber' }] },
        { op: 'cond', sheet: 'Agents', range: 'M6:M400', id: 'levels', rules: [{ when: '=', value: 'red', light: 'red' }, { when: '=', value: 'amber', light: 'amber' }, { when: '=', value: 'green', light: 'green' }, { when: '=', value: 'running', light: 'blue' }] },
        { op: 'format', sheet: 'Agents', ranges: ['B5:I5', 'K5:N5'], style: { b: true } });
    }
    this.store.batch({ doc: id, by: 'studio', ops, label: 'agents' });
  }

  studioDoc(id) {
    const d = this.store.doc(id || this.store.state.order.find((x) => this.store.state.docs[x].type === 'studio'));
    if (d.type !== 'studio') throw httpErr(400, `[${d.id}] is not a studio canvas`);
    return d;
  }
  ensureDoc() {
    const have = this.store.state.order.find((x) => this.store.state.docs[x].type === 'studio');
    if (have) return this.store.state.docs[have];
    const e = this.store.createDoc({ type: 'studio', title: 'Studio', id: 'studio', by: 'studio' });
    return this.store.state.docs[e.doc];
  }
  agentDef(id) {
    for (const docId of this.store.state.order) {
      const d = this.store.state.docs[docId];
      if (d.type === 'studio') { const a = d.agents.find((x) => x.id === id); if (a) return { doc: d, a }; }
    }
    throw httpErr(404, `No agent "${id}"`);
  }
  runtime(docId, id) {
    let r = this.rt.get(id);
    if (!r) { r = new Runtime(this, docId, id); this.rt.set(id, r); }
    return r;
  }
  get(id) { this.agentDef(id); return this.runtime(this.agentDef(id).doc.id, id); }
  drop(id) { const r = this.rt.get(id); if (r) { r.stop(); this.rt.delete(id); } }

  /** The project every agent box works on. Unset: a demo project in the data directory (a git repo). */
  async root(d) {
    if (d.root) return d.root;
    const r = process.env.STUDIO_ROOT ? path.resolve(process.env.STUDIO_ROOT) : await this.demoProject();
    this.store.batch({ doc: d.id, by: 'studio', ops: [{ op: 'setRoot', root: r }], label: 'studio root' });
    return r;
  }
  async demoProject() {
    const dir = path.join(this.dir, 'demo-project');
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), '# Demo project\n\nA tiny repository for trying the studio: point an agent box at it and ask for something.\n');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-project', version: '0.1.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
      fs.writeFileSync(path.join(dir, 'src', 'index.js'), "export function hello(name = 'world') {\n  return `hello ${name}`;\n}\n");
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
      await git(['init', '-q', '-b', 'main'], { cwd: dir });
      await git(['add', '-A'], { cwd: dir });
      await git(['-c', 'user.name=studio', '-c', 'user.email=studio@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'demo project'], { cwd: dir });
    }
    return dir;
  }

  /** A working directory for a new agent box: a git worktree on its own branch when the root is a git repo. */
  async workdir(root, id, name, { worktree = true, from = 'HEAD', sparse = null } = {}) {
    if (!worktree || !(await isGitRepo(root))) return { cwd: root, branch: null };
    const dir = path.join(this.dir, 'wt', id);
    const branch = `studio/${slug(name)}-${id.slice(-4)}`;
    if (sparse?.length) {
      // a monorepo slice: only these directories are checked out (cone mode), the rest stays in git
      await git(['worktree', 'add', '-q', '--no-checkout', '-b', branch, dir, from], { cwd: root });
      await git(['sparse-checkout', 'set', '--cone', ...sparse.map((p) => p.replace(/^\.?\/+|\/+$/g, ''))], { cwd: dir });
      await git(['checkout', '-q', branch], { cwd: dir });
    } else await git(['worktree', 'add', '-q', '-b', branch, dir, from], { cwd: root });
    return { cwd: dir, branch };
  }

  // ---------------------------------------------------------------- the API's verbs
  async createAgent(b = {}) {
    if (b.role === 'director') {
      // the director watches and steers the screen; it works in the project root and writes no code
      b = { worktree: false, w: 460, h: 380, name: 'Director', ...b, primer: DIRECTOR_PRIMER + (b.primer || '') };
    }
    const d = b.doc ? this.studioDoc(b.doc) : this.ensureDoc();
    const presets = this.presets();
    const preset = b.command ? null : (b.preset || (presets.mock && Object.keys(presets)[0]) || 'mock');
    if (!b.command && !presets[preset]) throw httpErr(400, `No agent preset "${preset}". Presets: ${Object.keys(presets).join(', ')}`);
    const id = b.id && /^[\w-]{3,40}$/.test(b.id) ? b.id : uid('a');
    const n = d.agents.length;
    const name = String(b.name || `${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ''}`).slice(0, 40);
    const root = await this.root(d);
    const sparse = Array.isArray(b.sparse) ? b.sparse.filter(Boolean) : typeof b.sparse === 'string' && b.sparse.trim() ? b.sparse.split(/[,\s]+/).filter(Boolean) : null;
    const wd = b.cwd ? { cwd: path.resolve(b.cwd), branch: b.branch || null } : await this.workdir(root, id, name, { worktree: b.worktree !== false, sparse });
    const agent = { id, name, color: b.color || COLORS[n % COLORS.length], ...(b.x != null && b.y != null ? { x: b.x, y: b.y } : freeSpot(d, b.w ?? 640, b.h ?? 480, b.near || { x: 80, y: 80 })), w: b.w ?? 640, h: b.h ?? 480, preset, command: b.command || null, cwd: wd.cwd, branch: wd.branch, worktree: !!wd.branch, scope: b.scope || [], forkOf: b.forkOf || null, sparse, why: b.why || null, role: b.role || null };
    this.store.batch({ doc: d.id, by: b.by || 'studio', who: b.who, color: b.whoColor, ops: [{ op: 'addAgent', agent }], label: `agent ${name}` });
    const r = this.runtime(d.id, id);
    if (b.primer) r.primer = b.primer;
    if (b.start !== false && this.autoStart) {
      r.start().then(() => { if (b.prompt) r.prompt(b.prompt, b.by || 'user'); }).catch(() => {});
    }
    return { id, name, cwd: wd.cwd, branch: wd.branch, doc: d.id };
  }

  async removeAgent(id, by = 'user') {
    const { doc } = this.agentDef(id);
    this.drop(id);
    this.store.batch({ doc: doc.id, by, ops: [{ op: 'removeAgent', id }], label: 'remove agent' });
    return { ok: true };
  }

  async fork(id, b = {}) {
    const src = this.get(id);
    const snaps = this.db.snapshots(id);
    if (!snaps.length) throw httpErr(400, 'Nothing to fork yet (no snapshots)');
    const s = b.snap == null ? snaps.at(-1) : snaps.find((x) => x.n === +b.snap);
    if (!s) throw httpErr(404, `No snapshot #${b.snap}`);
    const { doc, a } = this.agentDef(id);
    const nid = uid('a');
    let name = String(b.name || `${a.name}·${s.n}`).slice(0, 37);
    for (let k = 2; doc.agents.some((x) => x.name === name); k++) name = `${String(b.name || `${a.name}·${s.n}`).slice(0, 34)}·${k}`;
    // working directory: a worktree from the same commit as the source box, then the snapshot laid over it
    let wd;
    const root = await this.root(doc);
    if (a.branch && (await isGitRepo(root))) {
      const from = (await git(['rev-parse', 'HEAD'], { cwd: src.cwd })).trim();
      wd = await this.workdir(root, nid, name, { from, sparse: a.sparse });
      const want = new Set(await src.shadow.ls(s.commit));
      const have = (await git(['ls-files', '-z', ...(a.sparse?.length ? ['--', ...a.sparse] : [])], { cwd: wd.cwd })).split('\0').filter(Boolean);
      for (const f of have) if (!want.has(f)) fs.rmSync(path.join(wd.cwd, f), { force: true });
      await src.shadow.materialize(s.commit, wd.cwd);
    } else {
      const dir = path.join(this.dir, 'wt', nid);
      await src.shadow.materialize(s.commit, dir);
      wd = { cwd: dir, branch: null };
    }
    const why = b.reason ? String(b.reason).slice(0, 600) : null;
    let primer = null;
    if (b.conversation !== false) {
      const history = this.transcript(id, s.seq ?? this.db.lastSeq());
      primer = `[Studio: you are a fork of agent ${a.name} at snapshot #${s.n} ("${s.reason || 'snapshot'}"). Your working directory is exactly as it was at that moment; anything ${a.name} did later is not here.${why ? ` Why this fork exists: ${why}` : ''} The conversation so far:]\n${history}\n[End of the earlier conversation. Continue from here.]\n\n`;
    } else if (why) primer = `[Studio: you were started by ${a.name} from its working directory at snapshot #${s.n}. Why: ${why}]\n\n`;
    const r = await this.createAgent({ doc: doc.id, id: nid, name, preset: b.preset || a.preset, command: b.preset ? null : a.command, cwd: wd.cwd, branch: wd.branch, color: b.color, near: { x: a.x, y: a.y }, w: a.w, h: a.h, forkOf: { agent: id, snap: s.n, kind: b.kind || 'fork', by: b.by || 'user' }, primer, scope: a.scope, sparse: a.sparse, why, role: b.role || null, by: b.by, prompt: b.prompt });
    this.db.addEvent({ agent: nid, kind: 'system', text: `${b.kind === 'spawn' ? 'Started' : 'Forked'} from ${a.name} at snapshot #${s.n}${why ? ` — ${why}` : ''}` });
    if (b.by && b.by !== 'user') this.runtime(doc.id, id).gate('info', `${b.kind === 'spawn' ? 'started' : 'spun off'} ${name}`, why || `from snapshot #${s.n}`, { agent: nid });
    return { ...r, branch: wd.branch, from: { agent: id, snap: s.n }, why };
  }

  /**
   * A sub-agent started by a box (or the user) for a side task — a review, tests, docs.
   * mode "same": it works in the very same folder (sees uncommitted work, no new branch).
   * mode "worktree": a new worktree with the files of the box's latest snapshot, but a fresh conversation.
   */
  async spawn(id, b = {}) {
    const { doc, a } = this.agentDef(id);
    if ((b.mode || 'worktree') === 'same') {
      const name = String(b.name || `${a.name}·${b.role || 'sub'}`).slice(0, 40);
      const why = b.reason ? String(b.reason).slice(0, 600) : null;
      const primer = `[Studio: you are a sub-agent of ${a.name}, working in the same folder (its uncommitted work is here).${why ? ` Why: ${why}` : ''}${b.role === 'review' ? ' Your job is to review — do not edit files.' : ''}]\n\n`;
      const r = await this.createAgent({ doc: doc.id, name, preset: b.preset || a.preset, command: b.preset ? null : a.command, cwd: a.cwd, branch: a.branch, near: { x: a.x, y: a.y }, w: Math.round(a.w * 0.8), h: Math.round(a.h * 0.8), forkOf: { agent: id, kind: 'spawn', mode: 'same', by: b.by || 'user' }, why, role: b.role || null, primer, by: b.by, prompt: b.prompt || (b.role === 'review' ? 'Review the current changes in this folder (git diff). List concrete findings and a verdict.' : undefined) });
      this.db.addEvent({ agent: r.id, kind: 'system', text: `Started by ${a.name} in the same folder${why ? ` — ${why}` : ''}` });
      if (b.by && b.by !== 'user') this.runtime(doc.id, id).gate('info', `started ${name}`, why || 'in the same folder', { agent: r.id });
      return { ...r, mode: 'same' };
    }
    return { ...(await this.fork(id, { ...b, kind: 'spawn', conversation: false, name: b.name || `${a.name}·${b.role || 'sub'}` })), mode: 'worktree' };
  }

  /** Add a panel to a studio canvas (headless: works without any browser). */
  openPanel(docId, p, by = 'studio') {
    const d = this.studioDoc(docId);
    const w = p.w ?? ({ terminal: 640, preview: 800, map: 620 }[p.kind] || 380), h = p.h ?? ({ terminal: 380, preview: 520, map: 440 }[p.kind] || 240);
    const near = p.near || (p.source?.agent && d.agents.find((a) => a.id === p.source.agent)) || { x: 80, y: 80 };
    const panel = { id: p.id || uid('p'), kind: p.kind || 'note', title: p.title ?? '', text: p.text ?? '', source: p.source || null, color: p.color || null, w, h, ...(p.x != null && p.y != null ? { x: p.x, y: p.y } : freeSpot(d, w, h, { x: near.x, y: near.y }, 30)) };
    this.store.batch({ doc: d.id, by, ops: [{ op: 'addPanel', panel }], label: panel.kind });
    return panel;
  }

  /**
   * What the screens show, driven by anyone (an agent, a script, voice glue): focus a box or panel, fit, arrange,
   * scrub, open panels, theme, idle. Panels are created in the doc (headless); the rest goes to every open view.
   */
  view(b = {}) {
    const d = this.studioDoc(b.doc || this.ensureDoc().id);
    const out = { ok: true };
    if (b.open) {
      const o = typeof b.open === 'string' ? { kind: b.open } : b.open;
      const src = o.agent ? this.agentDef(o.agent).a : null;
      const panel = this.openPanel(d.id, { kind: o.kind, title: o.title ?? (o.kind === 'terminal' ? `Terminal · ${src?.name || 'project'}` : o.kind === 'map' ? `Code map · ${src?.name || 'project'}` : o.kind === 'preview' ? o.url || 'Preview' : 'Note'), text: o.text, source: { ...(o.agent ? { agent: o.agent } : {}), ...(o.url ? { url: o.url } : {}), ...(o.paths ? { paths: o.paths } : {}), ...(o.cmd ? { cmd: o.cmd } : {}) }, near: src, x: o.x, y: o.y, w: o.w, h: o.h }, b.by || 'agent');
      out.panel = panel.id;
      b.focus ??= { panel: panel.id };
    }
    if (b.arrange) {
      // arranging is layout, so it happens here, once, in the doc — headless, versioned, the same on every screen
      const focus = b.focus?.agent || (typeof b.focus === 'string' ? b.focus : null) || this.target?.id || null;
      const ops = arrangeOps(d, String(b.arrange), { focus });
      if (ops.length) this.store.batch({ doc: d.id, by: b.by || 'agent', ops, label: `arrange ${b.arrange}` });
      out.moved = ops.length;
      b.fit ??= true;
    }
    // move / resize boxes and panels, and pin panels to the screen ("float") — layout, so ops in the doc
    const ops = [];
    for (const m of [].concat(b.move || [])) {
      if (!m?.id) continue;
      const set = {};
      for (const k of ['x', 'y', 'w', 'h']) if (Number.isFinite(+m[k])) set[k] = Math.round(+m[k]);
      if (!Object.keys(set).length) continue;
      if (d.agents.some((a) => a.id === m.id)) ops.push({ op: 'updateAgent', id: m.id, set });
      else if (d.panels.some((p) => p.id === m.id)) ops.push({ op: 'updatePanel', id: m.id, set });
      else throw httpErr(404, `Nothing called "${m.id}" on the canvas`);
    }
    for (const f of [].concat(b.float || [])) {
      const pid = f?.panel || f?.id;
      if (!pid) continue;
      if (!d.panels.some((p) => p.id === pid)) throw httpErr(404, `No panel "${pid}"`);
      ops.push({ op: 'updatePanel', id: pid, set: { float: f.off ? null : { x: f.x ?? 0.62, y: f.y ?? 0.08, w: f.w ?? 0.34, h: f.h ?? 0.42 } } });
    }
    if (ops.length) { this.store.batch({ doc: d.id, by: b.by || 'agent', ops, label: 'move' }); out.moved = (out.moved || 0) + ops.length; }
    const mode = b.mode === 'focus' || b.mode === 'canvas' ? b.mode : null;
    this.store.emit({ type: 'studio', doc: d.id, agent: null, kind: 'view', ts: Date.now(), by: b.by || 'agent', reason: b.reason ? String(b.reason).slice(0, 200) : null, focus: b.focus || null, fit: !!b.fit, scrub: b.scrub === undefined ? undefined : b.scrub, theme: b.theme || null, tray: b.tray ?? null, idle: b.idle ?? null, mode, tab: b.tab || null });
    return out;
  }

  /** Files of the project (or a box, as of a snapshot) and who touched what — for the code map. */
  async codemap({ doc: docId, agent, snap, paths } = {}) {
    const d = this.studioDoc(docId || this.ensureDoc().id);
    const prefixes = (Array.isArray(paths) ? paths : String(paths || '').split(',')).map((p) => p.trim().replace(/^\.?\/+|\/+$/g, '')).filter(Boolean);
    const keep = (f) => !prefixes.length || prefixes.some((p) => f === p || f.startsWith(p + '/'));
    let files = [];
    if (agent) {
      const r = this.get(agent);
      await r.shadow.init();
      const snaps = this.db.snapshots(agent);
      const s = snap != null ? snaps.find((x) => x.n === +snap) : snaps.at(-1);
      if (s) {
        const out = await r.shadow.g(['ls-tree', '-r', '-l', '-z', s.commit], { max: 64 << 20 });
        for (const rec of out.split('\0')) { const m = /^\d+ blob \w+\s+(\d+|-)\t(.+)$/s.exec(rec); if (m && keep(m[2])) files.push({ path: m[2], size: +m[1] || 0 }); }
      }
    }
    if (!files.length) {
      const root = agent ? this.get(agent).cwd : await this.root(d);
      let list = [];
      try { list = (await git(['ls-files', '-z'], { cwd: root, max: 64 << 20 })).split('\0').filter(Boolean); } catch { list = []; }
      for (const f of list.slice(0, 30000)) if (keep(f)) { try { files.push({ path: f, size: fs.statSync(path.join(root, f)).size }); } catch {} }
    }
    const touched = {};
    for (const a of d.agents) for (const s of this.db.snapshots(a.id).slice(1)) for (const f of s.files || []) {
      if (!keep(f.path)) continue;
      const t = (touched[f.path] ||= {});
      const x = (t[a.id] ||= { adds: 0, dels: 0, n: 0, last: 0 });
      x.adds += f.adds; x.dels += f.dels; x.n++; x.last = Math.max(x.last, s.ts);
    }
    return { files: files.slice(0, 30000), touched, truncated: files.length > 30000 };
  }

  /** The conversation up to an event, as compact text (for forks and restarts without session/load). */
  transcript(agent, uptoSeq, max = 14000) {
    const ev = this.db.eventsBefore(agent, uptoSeq, 2000);
    let lines = [];   // [seq, text]
    for (const e of ev) {
      if (e.kind === 'rewind' && e.json?.cut != null && e.json.mode !== 'files') { lines = lines.filter(([s]) => s < e.json.cut); lines.push([e.seq, `  [studio] ${e.text}`]); }
      else if (e.kind === 'user') lines.push([e.seq, `User: ${e.text}`]);
      else if (e.kind === 'agent') lines.push([e.seq, `You: ${e.text}`]);
      else if (e.kind === 'tool') lines.push([e.seq, `  [${e.toolKind || 'tool'}] ${e.title || ''} (${e.status || ''})`]);
      else if (e.kind === 'system' || e.kind === 'rewind') lines.push([e.seq, `  [studio] ${e.text}`]);
    }
    let t = lines.map(([, x]) => x).join('\n');
    if (t.length > max) t = '…\n' + t.slice(-max);
    return t || '(nothing yet)';
  }

  async review(id, b = {}) {
    const src = this.get(id);
    const { doc, a } = this.agentDef(id);
    const snaps = this.db.snapshots(id);
    if (snaps.length < 2) throw httpErr(400, `${a.name} has not changed anything yet`);
    const from = snaps.find((x) => x.n === +(b.from ?? 0)) || snaps[0];
    const to = b.to != null ? snaps.find((x) => x.n === +b.to) : snaps.at(-1);
    if (!to || to.n <= from.n) throw httpErr(400, 'review: to must be after from');
    const files = await src.shadow.numstat(from.commit, to.commit);
    const patch = await src.shadow.diff(from.commit, to.commit);
    const lights = this.db.monitorsAt(id, to.n);
    const icon = { green: '✓', amber: '⚠', red: '✗' };
    const header = `${a.name} #${from.n}→#${to.n} · ${files.length} file${files.length === 1 ? '' : 's'} +${files.reduce((s, f) => s + f.adds, 0)} −${files.reduce((s, f) => s + f.dels, 0)}${lights.length ? ' · ' + lights.filter((m) => m.level !== 'skip').map((m) => `${m.monitor} ${icon[m.level] || '·'}`).join(' ') : ''}`;
    const pid = uid('p');
    const panel = { id: pid, kind: 'review', title: `Review · ${a.name} #${from.n}→#${to.n}`, text: header + '\n\n…', ...freeSpot(doc, Math.max(420, Math.min(a.w, 640)), 300, { x: a.x, y: a.y }, 30), w: Math.max(420, Math.min(a.w, 640)), h: 300, color: a.color, source: { agent: id, from: from.n, to: to.n } };
    this.store.batch({ doc: doc.id, by: b.by || 'studio', ops: [{ op: 'addPanel', panel }], label: 'review' });
    const reds = lights.filter((m) => m.level === 'red' || m.level === 'amber').map((m) => `- ${m.monitor} (${m.level}): ${m.summary}`).join('\n');
    const prompt = `You are reviewing a code change made by another agent. Do not edit any files and do not run commands. Reply with a short list of concrete findings (file:line, what is wrong, why it matters) and end with one line "Verdict: …".\n\nDeterministic monitors on this change:\n${reds || '- all green'}\n\n\`\`\`diff\n${patch.slice(0, 120000)}\n\`\`\``;
    const command = b.command || this.presets()[b.preset || a.preset]?.command || a.command;
    this.runReviewer(doc.id, pid, header, command, src.cwd, prompt).catch(() => {});
    return { panel: pid, header };
  }

  async runReviewer(docId, pid, header, command, cwd, prompt) {
    let text = '';
    const c = new AcpClient({ command, cwd, env: this.env, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onWriteFile: async () => { throw new Error('reviewer is read-only'); }, onReadFile: async (p) => ({ content: readInside(cwd, p.path) }) });
    const stream = () => this.emit(docId, null, 'panel', { panel: pid, text: `${header}\n\n${text}` });
    c.on('update', (u) => { if (u.update?.sessionUpdate === 'agent_message_chunk' && u.update.content?.type === 'text') { text += u.update.content.text; stream(); } });
    try {
      c.start();
      await c.initialize();
      await c.newSession(cwd);
      await c.prompt(prompt);
    } catch (e) { text += `\n\n(reviewer failed: ${e.message})`; }
    finally { c.stop(); }
    const d = this.store.state.docs[docId];
    if (d?.panels.some((p) => p.id === pid)) this.store.batch({ doc: docId, by: 'studio', ops: [{ op: 'updatePanel', id: pid, set: { text: `${header}\n\n${text.trim() || '(no answer)'}` } }], label: 'review done' });
    this.emit(docId, null, 'panel', { panel: pid, done: true });
  }

  setTarget(t) { this.target = t && t.id ? { doc: t.doc || null, kind: t.kind === 'panel' ? 'panel' : 'agent', id: String(t.id), ts: Date.now() } : null; return this.target; }

  /**
   * Voice / text in, routed to what the user is pointing at. A few words are commands, the rest is a prompt
   * (an agent box) or text (a panel). `target` overrides the pointer.
   */
  async say(text, target, by = 'voice') {
    text = String(text || '').trim();
    if (!text) throw httpErr(400, 'say: empty text');
    const t = target?.id ? target : this.target;
    if (!t) throw httpErr(409, 'Nothing is targeted: point at an agent box or a panel, or pass target');
    if (t.kind === 'panel') {
      const d = this.studioDoc(t.doc);
      const p = d.panels.find((x) => x.id === t.id);
      if (!p) throw httpErr(404, 'No such panel');
      this.store.batch({ doc: d.id, by, ops: [{ op: 'updatePanel', id: p.id, set: { text: p.text + (p.text && !p.text.endsWith('\n') ? '\n' : '') + text } }] });
      return { routed: 'panel', id: p.id };
    }
    const r = this.get(t.id);
    const w = text.toLowerCase().replace(/[.!?,]/g, '').trim();
    if (/^(stop|seis|peru|cancel|keskeytä)$/.test(w)) { r.cancel(); return { routed: 'cancel', id: r.id }; }
    const perm = this.db.openGates().find((g) => g.agent === r.id && g.kind === 'permission');
    if (perm && /^(yes|kyllä|joo|ok|allow|salli|okei)$/.test(w)) { this.answer(perm.id, perm.json.options.find((o) => o.kind?.startsWith('allow'))?.optionId); return { routed: 'allow', id: r.id }; }
    if (perm && /^(no|ei|reject|deny|älä)$/.test(w)) { this.answer(perm.id, perm.json.options.find((o) => o.kind?.startsWith('reject'))?.optionId); return { routed: 'reject', id: r.id }; }
    r.prompt(text, by);
    return { routed: 'prompt', id: r.id, queued: r.status === 'working' };
  }

  answer(gateId, optionId) {
    const g = this.db.gate(gateId);
    if (!g) throw httpErr(404, 'No such gate');
    if (g.kind !== 'permission') { this.dismiss(gateId, 'dismissed'); return { ok: true }; }
    const r = this.rt.get(g.agent);
    const ok = r?.resolvePermission(gateId, optionId);
    if (!ok) { this.db.resolveGate(gateId, 'stale'); this.emitGates(g.agent); }
    return { ok: !!ok };
  }
  dismiss(gateId, why = 'dismissed') {
    const g = this.db.gate(gateId);
    if (!g) throw httpErr(404, 'No such gate');
    if (g.kind === 'permission') return this.answer(gateId, null);
    this.db.resolveGate(gateId, why);
    this.emitGates(g.agent);
    return { ok: true };
  }
  emitGates(agent) {
    let doc = null;
    try { doc = this.agentDef(agent).doc.id; } catch {}
    this.emit(doc, agent, 'gates', { gates: this.db.openGates() });
  }

  state(docId) {
    const d = this.studioDoc(docId);
    return {
      doc: d.id, root: d.root, presets: Object.fromEntries(Object.entries(this.presets()).map(([k, v]) => [k, { label: v.label || k }])),
      agents: d.agents.map((a) => this.runtime(d.id, a.id).info()),
      gates: this.db.openGates().filter((g) => d.agents.some((a) => a.id === g.agent)),
      target: this.target, seq: this.db.lastSeq(),
    };
  }
}

/** A place for a w×h rectangle near `at` that overlaps no box or panel (tries right, below, then further out). */
export function freeSpot(doc, w, h, at, gap = 50) {
  const items = [...doc.agents, ...doc.panels];
  const hits = (x, y) => items.some((i) => x < i.x + i.w + gap && x + w + gap > i.x && y < i.y + i.h + gap && y + h + gap > i.y);
  if (!hits(at.x, at.y)) return { x: at.x, y: at.y };
  for (let ring = 0; ring < 12; ring++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1], [2, 0], [0, 2]]) {
      const x = Math.round(at.x + dx * (w + gap) * (ring + 1) * (dx ? 1 : 0)), y = Math.round(at.y + dy * (h + gap) * (ring + 1) * (dy ? 1 : 0));
      if (!hits(x, y)) return { x, y };
    }
  }
  return { x: at.x, y: at.y + (h + gap) * 13 };
}

const TYPES_HAS = (doc, name) => doc.sheets.some((sh) => (sh.tables || []).some((t) => t.name.toLowerCase() === name.toLowerCase()));

function readInside(cwd, p) {
  const abs = path.resolve(cwd, p);
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) throw new Error('outside the working directory');
  return fs.readFileSync(abs, 'utf8');
}

class Runtime {
  constructor(studio, doc, id) {
    this.s = studio; this.db = studio.db; this.doc = doc; this.id = id;
    this.status = 'stopped';
    this.client = null;
    this.turn = 0;
    this.msg = null;          // { seq, kind, text } — the message being streamed
    this.plan = null;
    this.subtitle = '';
    this.sentence = '';
    this.queue = [];
    this.perms = new Map();   // gate id -> resolve
    this.notes = [];          // studio notes for the next prompt (rewinds)
    this.primer = null;       // fork / restart context for the next prompt
    this.mon = { hunks: [], syntaxBroken: new Map(), secrets: [], testReds: [], depsSeen: false };
    this.levels = new Map();  // monitor -> level (current)
    this.monGates = new Map();// monitor -> open gate id
    this.cmdRunning = new Map();
    this.snapTimer = null;
    this.snapReason = null;
    const { a } = studio.agentDef(id);
    this.cwd = a.cwd;
    this.shadow = new Shadow(path.join(studio.dir, 'shadow', id + '.git'), a.cwd);
    const prev = this.db.agent(id);
    this.sessionId = prev?.session_id || null;
    for (const g of this.db.openGates()) if (g.agent === id && g.kind === 'permission') this.db.resolveGate(g.id, 'stale');   // the process that asked is gone
    for (const g of this.db.openGates()) if (g.agent === id && g.kind === 'monitor') this.monGates.set(g.json?.monitor, g.id);
    for (const m of this.db.monitorsAt(id)) this.levels.set(m.monitor, m.level);
    const snaps = this.db.snapshots(id);
    this.snapCount = snaps.length;
    this.turn = this.db.lastTurn(id);
    // a rewind not yet followed by a prompt still owes the agent its note (survives a server restart)
    const tail = this.db.eventsBefore(id, 1e15, 80);
    const rw = tail.findLastIndex((e) => e.kind === 'rewind');
    if (rw >= 0 && !tail.slice(rw).some((e) => e.kind === 'user') && tail[rw].json?.note) this.notes.push(tail[rw].json.note);
  }
  get def() { return this.s.agentDef(this.id).a; }
  mcp() { const def = this.def; return this.s.presets()[def.preset]?.mcp === false ? [] : this.s.mcpServers(this.id); }
  emit(kind, payload) { this.s.emit(this.doc, this.id, kind, payload); }
  setStatus(st, extra) { this.status = st; this.emit('status', { status: st, turn: this.turn, ...extra }); }

  info() {
    const snaps = this.db.snapshots(this.id);
    const last = snaps.at(-1), base = snaps[0];
    return {
      id: this.id, status: this.status, turn: this.turn, sessionId: this.sessionId, cwd: this.cwd, plan: this.plan, subtitle: this.subtitle,
      queue: this.queue.length, agentInfo: this.client?.agentInfo || this.db.agent(this.id)?.agent_info || null, error: this.error || null,
      snapshots: snaps.map((s) => ({ n: s.n, ts: s.ts, reason: s.reason, adds: s.adds, dels: s.dels, files: s.files.length, seq: s.seq })),
      lights: this.db.monitorsAt(this.id).map((m) => ({ monitor: m.monitor, level: m.level, summary: m.summary, snap: m.snap })),
      totals: last && base && last !== base ? { from: base.n, to: last.n } : null,
    };
  }

  async start() {
    if (this.client && !this.client.closed) return;
    const def = this.def;
    const presets = this.s.presets();
    const command = def.command || presets[def.preset]?.command;
    if (!command) throw httpErr(400, `No command for agent ${def.name}`);
    if (!fs.existsSync(this.cwd)) throw httpErr(400, `Working directory is gone: ${this.cwd}`);
    this.error = null;
    this.setStatus('starting');
    await this.shadow.init();
    this.db.putAgent({ id: this.id, doc: this.doc, name: def.name, command: Array.isArray(command) ? command.join(' ') : command, cwd: this.cwd, root: this.s.store.state.docs[this.doc]?.root, branch: def.branch, forkOf: def.forkOf });
    if (!this.snapCount) await this.snapshot('base');
    else await this.snapshot('changes while stopped');
    const c = new AcpClient({
      command, cwd: this.cwd, env: this.s.env,
      onPermission: (p) => this.askPermission(p),
      onReadFile: async (p) => {
        const text = readInside(this.cwd, p.path);
        if (p.line || p.limit) { const L = text.split('\n'); const a = Math.max(0, (p.line || 1) - 1); return { content: L.slice(a, p.limit ? a + p.limit : undefined).join('\n') }; }
        return { content: text };
      },
      onWriteFile: async (p) => {
        const abs = path.resolve(this.cwd, p.path);
        if (!abs.startsWith(this.cwd + path.sep)) throw new Error('outside the working directory');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // writes that go through us are snapshotted before the agent hears back: exact attribution, no races
        await this.snapChain;
        fs.writeFileSync(abs, p.content);
        const tool = this.openTool(abs);
        await this.snapshot(tool?.title || `write ${path.relative(this.cwd, abs)}`, tool?.toolId).catch(() => {});
        return null;
      },
    });
    this.client = c;
    c.on('update', (u) => this.onUpdate(u.update || {}));
    c.on('exit', ({ error }) => this.onExit(error));
    try {
      c.start();
      await c.initialize();
      if (this.sessionId && c.agentCapabilities.loadSession) {
        this.loading = true;
        try { await c.loadSession(this.sessionId, this.cwd, this.mcp()); }
        catch { this.sessionId = null; }
        finally { this.loading = false; }
      }
      if (!this.sessionId || c.sessionId !== this.sessionId) {
        const had = this.db.events(this.id, 0, 1).length > 0;
        await c.newSession(this.cwd, this.mcp());
        if (had && !this.primer) this.primer = `[Studio: the agent process was restarted and the old session could not be loaded. The conversation so far:]\n${this.s.transcript(this.id, this.db.lastSeq())}\n[End of the earlier conversation.]\n\n`;
      }
      this.sessionId = c.sessionId;
      this.db.setSession(this.id, this.sessionId, c.agentInfo);
      this.watch();
      this.setStatus('idle');
      this.pump();
    } catch (e) {
      this.error = e.message;
      this.db.addEvent({ agent: this.id, kind: 'error', text: `Could not start: ${e.message}` });
      this.gate('error', 'could not start', e.message);
      c.stop();
      this.setStatus('error', { error: e.message });
      throw httpErr(502, `Agent did not start: ${e.message}`);
    }
  }

  stop() {
    this.unwatch();
    for (const [g, res] of this.perms) { res({ outcome: { outcome: 'cancelled' } }); this.db.resolveGate(g, 'stopped'); }
    this.perms.clear();
    if (this.client && !this.client.closed) { this.stopping = true; this.client.stop(); }
    this.client = null;
    if (this.status !== 'error') this.setStatus('stopped');
  }

  onExit(error) {
    this.unwatch();
    this.closeMsg();
    if (this.stopping) { this.stopping = false; return; }
    this.client = null;
    if (error) {
      this.error = error;
      this.db.addEvent({ agent: this.id, kind: 'error', text: error });
      this.gate('error', 'agent process stopped', error);
      this.setStatus('error', { error });
    } else this.setStatus('stopped');
  }

  watch() {
    this.unwatch();
    try {
      this.watcher = fs.watch(this.cwd, { recursive: true }, (ev, f) => {
        if (!f || /(^|[/\\])(\.git|node_modules|\.studio)([/\\]|$)/.test(f)) return;
        this.scheduleSnapshot('files changed', null, 900, true);
      });
      this.watcher.on('error', () => this.unwatch());
    } catch { this.watcher = null; }
  }
  unwatch() { try { this.watcher?.close(); } catch {} this.watcher = null; }

  // ------------------------------------------------------------ conversation
  prompt(text, by = 'user') {
    text = String(text || '').trim();
    if (!text) return;
    for (const g of this.db.openGates()) if (g.agent === this.id && g.kind === 'turn') this.db.resolveGate(g.id, 'answered');
    this.queue.push({ text, by });
    this.emit('queue', { queue: this.queue.length });
    if (!this.client || this.client.closed) { if (this.status !== 'starting') this.start().catch(() => {}); return; }
    this.pump();
  }

  async pump() {
    if (this.status !== 'idle' || !this.queue.length || !this.client) return;
    const { text, by } = this.queue.shift();
    this.turn++;
    this.setStatus('working', { queue: this.queue.length });
    // every turn is tracked in the worktree: a snapshot just before it (or the latest, if nothing changed since)
    let mark = null;
    try { mark = (await this.snapshot(`before turn ${this.turn}`)) || this.db.snapshots(this.id).at(-1) || null; } catch {}
    const seq = this.db.addEvent({ agent: this.id, kind: 'user', text, json: { by }, turn: this.turn });
    this.db.addTurn({ agent: this.id, turn: this.turn, seq, snap: mark?.n ?? null, text: text.slice(0, 400) });
    this.emit('event', { event: { seq, ts: Date.now(), kind: 'user', text, json: { by }, turn: this.turn } });
    this.s.emitGates(this.id);
    let full = text;
    if (this.notes.length) { full = this.notes.join('\n') + '\n\n' + full; this.notes = []; }
    if (this.primer) { full = this.primer + full; this.primer = null; }
    let stop = 'end_turn';
    try { stop = (await this.client.prompt(full))?.stopReason || 'end_turn'; }
    catch (e) { stop = 'error'; this.db.addEvent({ agent: this.id, kind: 'error', text: e.message, turn: this.turn }); this.emit('event', { event: { kind: 'error', text: e.message, ts: Date.now() } }); }
    this.closeMsg();
    const tseq = this.db.addEvent({ agent: this.id, kind: 'turn', status: stop, turn: this.turn });
    this.emit('event', { event: { seq: tseq, ts: Date.now(), kind: 'turn', status: stop, turn: this.turn } });
    await this.snapshot('end of turn ' + this.turn);
    if (!this.client) return;
    this.setStatus('idle');
    if (!this.queue.length && stop !== 'cancelled') this.gate('turn', 'waiting for you', this.subtitle || `turn ${this.turn} ended (${stop})`);
    this.pump();
  }

  cancel() {
    this.queue = [];
    for (const [g, res] of this.perms) { res({ outcome: { outcome: 'cancelled' } }); this.db.resolveGate(g, 'cancelled'); }
    this.perms.clear();
    this.client?.cancel();
    this.s.emitGates(this.id);
  }

  closeMsg() {
    if (this.msg?.kind === 'agent' && this.sentence.trim()) { this.subtitle = this.sentence.trim().slice(0, 240); this.emit('say', { text: this.subtitle, final: true }); }
    this.sentence = '';
    this.msg = null;
  }

  onUpdate(u) {
    if (this.loading) return;   // session/load replays history we already have
    const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const text = u.content?.type === 'text' ? u.content.text : u.content?.text || '';
      if (!text) return;
      const k = kind === 'agent_message_chunk' ? 'agent' : 'thought';
      if (!this.msg || this.msg.kind !== k) { this.closeMsg(); this.msg = { kind: k, seq: this.db.addEvent({ agent: this.id, kind: k, text: '', turn: this.turn }) }; }
      this.db.appendText(this.msg.seq, text);
      this.emit('chunk', { seq: this.msg.seq, msg: k, text, turn: this.turn });
      if (k === 'agent') {
        this.sentence += text;
        const parts = this.sentence.split(/(?<=[.!?…])\s+|\n+/);
        if (parts.length > 1) {
          for (const p of parts.slice(0, -1)) if (p.trim()) { this.subtitle = p.trim().slice(0, 240); this.emit('say', { text: this.subtitle }); }
          this.sentence = parts.at(-1);
        }
      }
      return;
    }
    if (kind === 'user_message_chunk') return;   // we record the prompt ourselves
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.closeMsg();
      const tid = u.toolCallId;
      let seq = tid ? this.db.toolSeq(this.id, tid) : null;
      const json = { locations: u.locations, rawInput: u.rawInput, content: summarizeContent(u.content) };
      if (seq == null) {
        seq = this.db.addEvent({ agent: this.id, kind: 'tool', toolId: tid, toolKind: u.kind || 'other', status: u.status || 'pending', title: u.title || tid, json, turn: this.turn });
      } else {
        const old = this.db.events(this.id, seq - 1, 1)[0];
        const merged = { ...(old?.json || {}) };
        for (const [k, v] of Object.entries(json)) if (v != null && !(Array.isArray(v) && !v.length)) merged[k] = v;
        this.db.updateTool(seq, { status: u.status, title: u.title, toolKind: u.kind, json: merged });
      }
      const ev = this.db.events(this.id, seq - 1, 1)[0];
      this.emit('tool', { event: ev });
      const writes = (u.content || []).some((c) => c.type === 'diff');
      const finished = ['completed', 'failed'].includes(u.status);
      if (finished && (writes || ['edit', 'delete', 'move', 'execute', 'other'].includes(ev?.toolKind))) this.snapshot(ev?.title || 'tool call', tid).catch(() => {});
      else if (writes) this.scheduleSnapshot(ev?.title || 'tool call', tid, 250);
      return;
    }
    if (kind === 'plan') {
      this.closeMsg();
      this.plan = (u.entries || []).map((e) => ({ content: String(e.content || '').slice(0, 300), status: e.status || 'pending', priority: e.priority || 'medium' }));
      const seq = this.db.addEvent({ agent: this.id, kind: 'plan', json: this.plan, turn: this.turn });
      this.emit('plan', { plan: this.plan, seq });
      return;
    }
    if (kind === 'current_mode_update') { this.mode = u.currentModeId; this.emit('mode', { mode: this.mode }); return; }
    if (kind === 'available_commands_update') { this.commands = (u.availableCommands || []).map((c) => ({ name: c.name, description: c.description })); return; }
  }

  /** The newest unfinished tool call (preferably one that names this file). */
  openTool(abs) {
    const ev = this.db.eventsBefore(this.id, this.db.lastSeq(), 40).reverse().filter((e) => e.kind === 'tool' && !['completed', 'failed'].includes(e.status));
    return ev.find((e) => (e.json?.locations || []).some((l) => path.resolve(this.cwd, l.path || '') === abs)) || ev[0] || null;
  }

  askPermission(p) {
    const gid = uid('g');
    const tc = p.toolCall || {};
    const options = (p.options || []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
    this.db.addGate({ id: gid, agent: this.id, kind: 'permission', title: tc.title || 'permission', detail: tc.rawInput?.command || tc.title || '', json: { options, toolCallId: tc.toolCallId, toolKind: tc.kind }, blocking: true });
    const seq = this.db.addEvent({ agent: this.id, kind: 'permission', title: tc.title, toolId: null, json: { gate: gid, options, toolCallId: tc.toolCallId }, turn: this.turn });
    this.setStatus('waiting');
    this.emit('event', { event: { seq, ts: Date.now(), kind: 'permission', title: tc.title, json: { gate: gid, options } } });
    this.s.emitGates(this.id);
    return new Promise((res) => this.perms.set(gid, res));
  }
  resolvePermission(gid, optionId) {
    const res = this.perms.get(gid);
    if (!res) return false;
    this.perms.delete(gid);
    const g = this.db.gate(gid);
    const opt = g?.json?.options.find((o) => o.optionId === optionId);
    this.db.resolveGate(gid, opt ? opt.name : 'cancelled');
    this.db.addEvent({ agent: this.id, kind: 'system', text: `Permission: ${opt ? opt.name : 'cancelled'} — ${g?.title || ''}`, turn: this.turn });
    res(opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
    if (this.status === 'waiting' && !this.perms.size) this.setStatus('working');
    this.s.emitGates(this.id);
    return true;
  }

  gate(kind, title, detail, json, blocking = false) {
    const id = uid('g');
    this.db.addGate({ id, agent: this.id, kind, title, detail, json, blocking });
    this.s.emitGates(this.id);
    return id;
  }

  // ------------------------------------------------------------ snapshots + monitors
  scheduleSnapshot(reason, toolId, delay = 150, weak = false) {
    if (!weak || !this.snapReason) { this.snapReason = reason; this.snapTool = toolId; }
    clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => this.snapshot(this.snapReason, this.snapTool).catch(() => {}), delay);
  }

  /** Snapshots (and the monitors on them) run strictly one after another, in the order they were asked for. */
  snapshot(reason, toolId) {
    clearTimeout(this.snapTimer);
    this.snapReason = null; this.snapTool = null;
    const p = (this.snapChain || Promise.resolve()).then(() => this._snapshot(reason, toolId));
    this.snapChain = p.catch((e) => console.error('snapshot', this.id, e.message));
    return p;
  }

  async _snapshot(reason, toolId) {
    await this.shadow.init();
    const r = await this.shadow.snapshot(reason);
    if (!r) return null;
    const n = this.snapCount++;
    const files = r.parent ? await this.shadow.numstat(r.parent, r.commit) : [];
    const snap = { agent: this.id, n, ts: Date.now(), commit: r.commit, parent: r.parent, reason: n === 0 ? 'base' : reason, toolId, seq: this.db.lastSeq(), files: files.map((f) => ({ path: f.path, adds: f.adds, dels: f.dels, status: f.status })), adds: files.reduce((s, f) => s + f.adds, 0), dels: files.reduce((s, f) => s + f.dels, 0) };
    this.db.addSnapshot(snap);
    this.emit('snapshot', { snap: { agent: this.id, n, ts: snap.ts, reason: snap.reason, adds: snap.adds, dels: snap.dels, files: snap.files.slice(0, 200), seq: snap.seq } });
    if (n > 0) await this.monitors(n, r.parent, r.commit, files).catch((e) => console.error('monitors', e));
    return snap;
  }

  async monitors(n, prev, cur, changed) {
    const snaps = this.db.snapshots(this.id);
    const base = snaps[0].commit;
    const { results } = await builtinMonitors({ shadow: this.shadow, base, prev, cur, n, state: this.mon, scope: this.def.scope || [] });
    for (const m of results) this.light(n, m);
    // command monitors run in the background, one at a time per monitor, always on the newest snapshot
    const root = this.s.store.state.docs[this.doc]?.root || this.cwd;
    for (const m of commandMonitors(fs.existsSync(path.join(this.cwd, '.studio')) ? this.cwd : root)) {
      if (m.match && !changed.some((f) => m.match.test(f.path))) continue;
      this.runCmd(m);
    }
  }
  async runCmd(m) {
    if (this.cmdRunning.get(m.id)) { this.cmdRunning.set(m.id, 'again'); return; }
    this.cmdRunning.set(m.id, true);
    const n = this.snapCount - 1;
    this.light(n, { monitor: m.id, level: 'running', summary: `running ${m.run}` });
    const res = await runCommandMonitor(m, this.cwd);
    this.light(n, res);
    const again = this.cmdRunning.get(m.id) === 'again';
    this.cmdRunning.delete(m.id);
    if (again) this.runCmd(m);
  }
  light(n, m) {
    this.db.putMonitor({ agent: this.id, snap: n, monitor: m.monitor, level: m.level, summary: m.summary, detail: m.detail });
    this.emit('monitor', { monitor: m.monitor, level: m.level, summary: m.summary, snap: n });
    if (m.level === 'running') return;
    this.levels.set(m.monitor, m.level);
    const open = this.monGates.get(m.monitor);
    if (m.level === 'red' && !open) {
      this.monGates.set(m.monitor, this.gate('monitor', `${m.monitor} is red`, m.summary, { monitor: m.monitor, snap: n }));
    } else if (m.level !== 'red' && open) {
      this.db.resolveGate(open, `cleared at #${n}`);
      this.monGates.delete(m.monitor);
      this.s.emitGates(this.id);
    }
  }

  /**
   * Rewind to just before turn t.
   *   conversation — the agent's conversation goes back (a new ACP session primed with the turns before t); the files
   *                  stay as they are now, and the next prompt is prefixed with: the project moved on, check the state.
   *   both         — the conversation and the worktree (the snapshot taken when turn t started).
   *   files        — only the worktree; the conversation carries on.
   * Nothing is deleted: rewound turns stay in the log (greyed), and the files before a rewind are a snapshot too.
   */
  async rewindTurn(t, mode = 'conversation') {
    if (!['conversation', 'both', 'files'].includes(mode)) throw httpErr(400, 'mode: conversation | both | files');
    const m = this.db.turnMark(this.id, t);
    if (!m) throw httpErr(404, `No turn ${t}`);
    if (this.status === 'working' || this.status === 'waiting' || this.status === 'starting') throw httpErr(409, `${this.def.name} is working — stop it first (.)`);
    let after = null;
    if (mode !== 'conversation') {
      const s = m.snap != null ? this.db.snapshot(this.id, m.snap) : null;
      if (!s) throw httpErr(409, `Turn ${t} has no snapshot to go back to`);
      await this.snapshot('before rewind');
      await this.shadow.restore(s.commit);
      after = await this.snapshot(`rewind to before turn ${t}`);
    }
    if (mode !== 'files') {
      // a fresh session that has only seen the turns before t
      this.queue = [];
      this.emit('queue', { queue: 0 });
      this.plan = null;
      this.emit('plan', { plan: null });
      const history = this.s.transcript(this.id, m.seq - 1);
      this.primer = `[Studio: your conversation was rewound to just before turn ${t}. The conversation so far:]\n${history}\n[End of the earlier conversation.]\n\n`;
      this.sessionId = null;
      if (this.client && !this.client.closed) {
        await this.client.newSession(this.cwd, this.mcp());
        this.sessionId = this.client.sessionId;
      }
      this.db.setSession(this.id, this.sessionId, this.client?.agentInfo || null);
      for (const g of this.db.openGates()) if (g.agent === this.id && g.kind === 'turn') this.db.resolveGate(g.id, 'rewound');
      this.s.emitGates(this.id);
    }
    const note = {
      conversation: `[Rewound: your conversation was rewound to just before turn ${t}, but the files were kept — the project has moved on since that point. Check the current state of the working directory (git status, git diff, re-read the files you need) before you continue.]`,
      both: `[Rewound: your conversation and the working directory were rewound to just before turn ${t}. The files are exactly as they were then; re-read them before editing.]`,
      files: `[Rewound: the user put your working directory back to how it was when turn ${t} started. Every file change after that is undone; re-read files before editing them.]`,
    }[mode];
    this.notes = this.notes.filter((x) => !x.startsWith('[Rewound:')).concat(note);
    const text = { conversation: `Rewound the conversation to before turn ${t} — files kept`, both: `Rewound the conversation and the files to before turn ${t}`, files: `Rewound the files to before turn ${t} — conversation kept` }[mode];
    const json = { turn: t, cut: m.seq, mode, snap: m.snap, after: after?.n ?? null, note };
    const seq = this.db.addEvent({ agent: this.id, kind: 'rewind', text, json, turn: this.turn });
    this.emit('event', { event: { seq, ts: Date.now(), kind: 'rewind', text, json, turn: this.turn } });
    return { turn: t, mode, snap: after?.n ?? null, kept: mode === 'conversation' };
  }

  async rewind(n) {
    const s = this.db.snapshot(this.id, n);
    if (!s) throw httpErr(404, `No snapshot #${n}`);
    if (this.status === 'working' || this.status === 'waiting') throw httpErr(409, `${this.def.name} is working — stop it first (.)`);
    await this.snapshot('before rewind');
    await this.shadow.restore(s.commit);
    const after = await this.snapshot(`rewind to #${n}`);
    // the same record and the same prefix as rewinding a turn's files
    const note = `[Rewound: the user put your working directory back to how it was at snapshot #${n} ("${s.reason || 'snapshot'}"). Every file change after that is undone; re-read files before editing them.]`;
    this.notes = this.notes.filter((x) => !x.startsWith('[Rewound:')).concat(note);
    const text = `Rewound the files to snapshot #${n} (${s.reason || 'snapshot'}) — conversation kept`;
    const json = { snap: n, mode: 'files', after: after?.n ?? null, note };
    const seq = this.db.addEvent({ agent: this.id, kind: 'rewind', text, json, turn: this.turn });
    this.emit('event', { event: { seq, ts: Date.now(), kind: 'rewind', text, json, turn: this.turn } });
    return { rewound: n, snap: after?.n ?? null };
  }
}

/** Keep tool-call content small in the database: diffs as stats + head, text clipped. */
function summarizeContent(content) {
  if (!Array.isArray(content) || !content.length) return null;
  return content.slice(0, 20).map((c) => {
    if (c.type === 'diff') {
      const o = (c.oldText || '').split('\n'), n = (c.newText || '').split('\n');
      return { type: 'diff', path: c.path, oldLines: c.oldText == null ? 0 : o.length, newLines: n.length };
    }
    if (c.type === 'content') return { type: 'text', text: String(c.content?.text ?? '').slice(0, 4000) };
    if (c.type === 'terminal') return { type: 'terminal', terminalId: c.terminalId };
    return { type: c.type };
  });
}
