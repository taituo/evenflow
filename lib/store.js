// Workspace store: docs, versioned op log, milestones (commits), live subscribers.
import { validatePack } from '../public/shared/viz.js';
import fs from 'node:fs';
import path from 'node:path';
import { TYPES, applyDocOp } from '../public/shared/types/index.js';
import { parseRange, splitSheet, rangeToString, parseAddr as parseAddrS, addr as addrS } from '../public/shared/a1.js';
import { relocate } from './format.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const LOG_MEM = 5000;
const STRUCTURAL = new Set(['move', 'insertRows', 'deleteRows', 'insertCols', 'deleteCols', 'renameSheet', 'addSheet', 'deleteSheet']);

const cleanName = (n) => String(n).replace(/[\u0000-\u001f<>"]/g, '').trim().slice(0, 40) || '?';
const cleanColor = (c) => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(c)) ? String(c) : '#888888');
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.subs = new Set();
    this.selection = null;
    this.calc = new Map(); // docId -> Map(cell -> display) for recalc diffs
    this.saveTimer = null;
    this.presence = new Map();   // id -> { id, name, color, doc, sheet, ranges, active, live, ts }
    this.screens = new Map();    // screen id -> what that Live view shows (cards, slide, focus…)
  }

  // ------------------------------------------------------------ settings (API keys, feeds): data/settings.json, not versioned
  settings() {
    if (!this._settings) { try { this._settings = JSON.parse(fs.readFileSync(path.join(this.dir, 'settings.json'), 'utf8')); } catch { this._settings = {}; } }
    return this._settings;
  }
  saveSettings(patch) {
    const s = { ...this.settings(), ...patch };
    for (const k of Object.keys(s)) if (s[k] == null || s[k] === '') delete s[k];
    this._settings = s;
    fs.writeFileSync(path.join(this.dir, 'settings.json'), JSON.stringify(s, null, 1));
    return s;
  }

  // ------------------------------------------------------------ SVG visual packs (spread-viz/1)
  loadViz(builtinDir) {
    this.viz = new Map();
    for (const f of fs.existsSync(builtinDir) ? fs.readdirSync(builtinDir).filter((x) => x.endsWith('.json')).sort() : []) {
      const r = validatePack(JSON.parse(fs.readFileSync(path.join(builtinDir, f), 'utf8')));
      if (r.ok) this.viz.set(r.pack.id, { ...r.pack, builtin: true, rev: 0 });
      else console.error(`viz pack ${f}: ${r.errors.join('; ')}`);
    }
    const fp = path.join(this.dir, 'viz.json');
    if (fs.existsSync(fp)) for (const p of JSON.parse(fs.readFileSync(fp, 'utf8'))) { const r = validatePack(p); if (r.ok) this.viz.set(r.pack.id, { ...r.pack, rev: p.rev || 1, by: p.by }); }
    return this;
  }
  putViz(p, by = 'agent') {
    const r = validatePack(p);
    if (!r.ok) throw httpErr(400, 'Invalid pack: ' + r.errors.join('; '), { errors: r.errors, warnings: r.warnings });
    const old = this.viz.get(r.pack.id);
    if (old?.builtin) throw httpErr(409, `"${r.pack.id}" is a built-in pack — pick another id`);
    if (!old && [...this.viz.values()].filter((x) => !x.builtin).length >= 200) throw httpErr(400, 'Too many packs (200)');
    const pack = { ...r.pack, rev: (old?.rev || 0) + 1, by };
    this.viz.set(pack.id, pack);
    this.saveViz();
    this.emit({ type: 'viz', action: old ? 'update' : 'add', id: pack.id, rev: pack.rev, by });
    return { pack, warnings: r.warnings, replaced: !!old };
  }
  deleteViz(id, by = 'agent') {
    const p = this.viz.get(id);
    if (!p) throw httpErr(404, `No pack "${id}"`);
    if (p.builtin) throw httpErr(409, `"${id}" is built in`);
    this.viz.delete(id);
    this.saveViz();
    this.emit({ type: 'viz', action: 'delete', id, by });
  }
  saveViz() {
    fs.writeFileSync(path.join(this.dir, 'viz.json'), JSON.stringify([...this.viz.values()].filter((x) => !x.builtin), null, 1));
  }

  // ------------------------------------------------------------ screens (open Live views)
  setScreen(b) {
    const id = String(b.screen || 'default').replace(/[^\w-]/g, '').slice(0, 40) || 'default';
    if (!b.open) { if (this.screens.delete(id)) this.emitScreens(); return; }
    if (this.screens.size > 50 && !this.screens.has(id)) return;
    const name = String(b.name || id).replace(/[\u0000-\u001f<>"]/g, '').slice(0, 40);
    this.screens.set(id, { ...b, screen: id, name, ts: Date.now() });
    this.emitScreens();
  }
  screenList() {
    const now = Date.now();
    for (const [k, v] of this.screens) if (now - v.ts > 90000) this.screens.delete(k);
    return [...this.screens.values()].sort((a, b) => b.ts - a.ts);
  }
  /** Back-compat: the most recently updated screen. */
  get live() { return this.screenList()[0] || null; }
  emitScreens() {
    clearTimeout(this.scrTimer);
    this.scrTimer = setTimeout(() => this.emit({ type: 'screens', screens: this.screenList().map((x) => ({ screen: x.screen, name: x.name, mode: x.mode, sheet: x.sheet, focus: x.focus, slide: x.slide, playing: x.playing, replay: x.replay || null, cards: (x.cards || []).map((c) => ({ key: c.key, kind: c.kind, title: c.title, summary: c.summary, visible: c.visible })) })) }), 150);
  }

  // ------------------------------------------------------------ people
  touchPresence(p) {
    if (!p?.id || typeof p.id !== 'string') return;
    const clean = { id: p.id.slice(0, 40) };
    if (p.name != null) clean.name = cleanName(p.name);
    if (p.color != null) clean.color = cleanColor(p.color);
    for (const k of ['doc', 'sheet', 'active']) if (k in p) clean[k] = p[k] == null ? null : String(p[k]).slice(0, 100);
    if ('ranges' in p) clean.ranges = Array.isArray(p.ranges) ? p.ranges.slice(0, 20).map((r) => String(r).slice(0, 60)) : null;
    if ('live' in p) clean.live = p.live && typeof p.live === 'object' ? { mode: String(p.live.mode || '').slice(0, 10), sheet: String(p.live.sheet || '').slice(0, 100), focus: p.live.focus ? String(p.live.focus).slice(0, 100) : null, slide: +p.live.slide || null } : null;
    if (this.presence.size > 200 && !this.presence.has(clean.id)) return;
    this.presence.set(clean.id, { ...this.presence.get(clean.id), ...clean, ts: Date.now() });
    this.emitPresence();
  }
  leavePresence(id) { if (this.presence.delete(id)) this.emitPresence(); }
  people() {
    const now = Date.now();
    for (const [k, v] of this.presence) if (now - v.ts > 45000) this.presence.delete(k);
    return [...this.presence.values()];
  }
  emitPresence() {
    clearTimeout(this.presTimer);
    this.presTimer = setTimeout(() => this.emit({ type: 'presence', people: this.people() }), 120);
  }

  /** History of one cell, following it backwards through moves and row/column inserts/deletes. */
  cellHistory(docId, sheet, A, limit = 60) {
    const out = [];
    let key = { sheet, A };
    for (let i = this.log.length - 1; i >= 0 && out.length < limit && key; i--) {
      const e = this.log[i];
      if (e.doc !== docId) continue;
      for (let j = e.changes.length - 1; j >= 0 && key; j--) {
        const c = e.changes[j];
        if (c.k === 'set' && c.sheet === key.sheet && c.cell === key.A) out.push({ v: e.v, ts: e.ts, by: e.by, who: e.who, old: c.old, new: c.new, at: `${c.sheet}!${c.cell}`, t: c.t });
        else if (c.k === 'move' && ((c.toSheet || c.sheet) === key.sheet || c.sheet === key.sheet)) {
          const D = parseRange(c.to), R = parseRange(c.from), p = parseAddrS(key.A);
          if ((c.toSheet || c.sheet) === key.sheet && p.c >= D.c1 && p.c <= D.c2 && p.r >= D.r1 && p.r <= D.r2) {
            out.push({ v: e.v, ts: e.ts, by: e.by, who: e.who, moved: `${c.sheet}!${c.from} → ${c.toSheet || c.sheet}!${c.to}` });
            key = { sheet: c.sheet, A: addrS(p.c - D.c1 + R.c1, p.r - D.r1 + R.r1) };
          } else if (c.sheet === key.sheet && p.c >= R.c1 && p.c <= R.c2 && p.r >= R.r1 && p.r <= R.r2) {
            // this cell's earlier contents were cut away to the destination: its history ends here
            out.push({ v: e.v, ts: e.ts, by: e.by, who: e.who, moved: `${c.sheet}!${c.from} → ${c.toSheet || c.sheet}!${c.to}`, away: true });
            key = null;
          }
        } else if ((c.k === 'rows' || c.k === 'cols') && c.sheet === key.sheet) {
          const p = parseAddrS(key.A);
          const R = parseRange(c.at.includes(':') ? c.at : `${c.at}:${c.at}`);
          const at = c.k === 'rows' ? R.r1 : R.c1, n = c.count;
          let v = c.k === 'rows' ? p.r : p.c;
          if (c.action === 'insert') { if (v >= at && v < at + n) { key = null; break; } if (v >= at + n) v -= n; }
          else if (v >= at) v += n;
          key = { sheet: key.sheet, A: c.k === 'rows' ? addrS(p.c, v) : addrS(v, p.r) };
        }
      }
    }
    return out;
  }
  /** History of a named table: every annotated cell change inside it, plus its structure changes. */
  tableHistory(docId, name, limit = 100) {
    const out = [];
    const lc = name.toLowerCase();
    for (let i = this.log.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.log[i];
      if (e.doc !== docId) continue;
      for (const c of e.changes) {
        if (c.k === 'set' && c.t && (c.t.toLowerCase().startsWith(lc + '[') || c.t.toLowerCase() === lc + ' header')) out.push({ v: e.v, ts: e.ts, by: e.by, who: e.who, at: `${c.sheet}!${c.cell}`, t: c.t, old: c.old, new: c.new });
        else if (c.k === 'table' && (c.name || '').toLowerCase() === lc) out.push({ v: e.v, ts: e.ts, by: e.by, who: e.who, table: `${c.action}${c.range ? ' ' + c.range : ''}${c.to ? ' → ' + c.to : ''}` });
      }
    }
    return out;
  }

  init() {
    fs.mkdirSync(path.join(this.dir, 'commits'), { recursive: true });
    const sp = path.join(this.dir, 'state.json');
    if (fs.existsSync(sp)) this.state = JSON.parse(fs.readFileSync(sp, 'utf8'));
    else { this.state = { version: 0, docs: {}, order: [] }; this.seed(); }
    this.log = [];
    const lp = path.join(this.dir, 'log.jsonl');
    if (fs.existsSync(lp)) {
      const lines = fs.readFileSync(lp, 'utf8').split('\n').filter(Boolean);
      for (const l of lines.slice(-LOG_MEM)) { try { this.log.push(JSON.parse(l)); } catch {} }
    }
    const cp = path.join(this.dir, 'commits.json');
    this.commits = fs.existsSync(cp) ? JSON.parse(fs.readFileSync(cp, 'utf8')) : [];
    for (const id of this.state.order) this.recalcDiff(id);
    this.flush();
    return this;
  }

  seed() {
    const main = TYPES.sheet.create('Workbook');
    main.sheets[0].name = 'Budget';
    this.state.docs.main = { id: 'main', ...main };
    this.state.order.push('main');
    const d = this.state.docs.main;
    applyDocOp(d, { op: 'set', range: 'A1', values: [
      ['Item', 'Qty', 'Price', 'Total', 'Check'],
      ['Servos', 4, 12.5, '=B2*C2', '=IF(D2>100,"over budget","ok")'],
      ['Raspberry Pi', 1, 89, '=B3*C3', '=IF(D3>100,"over budget","ok")'],
      ['Wires', 20, 0.4, '=B4*C4', '=IF(D4>100,"over budget","ok")'],
      ['Battery', 2, 24.9, '=B5*C5', '=IF(D5>100,"over budget","ok")'],
      ['', '', 'Total', '=SUM(D2:D5)', '=IF(D6<=Settings!B1,"✓ within budget","✗ over budget")'],
    ] });
    applyDocOp(d, { op: 'format', range: 'A1:E1', style: { b: true, fill: '#e8f0fe' } });
    applyDocOp(d, { op: 'format', range: 'C6:D6', style: { b: true } });
    applyDocOp(d, { op: 'freeze', rows: 1 });
    applyDocOp(d, { op: 'resize', cols: { A: 140, E: 150 } });
    applyDocOp(d, { op: 'addSheet', name: 'Settings' });
    applyDocOp(d, { op: 'set', sheet: 'Settings', cells: { A1: 'Budget', B1: '250' } });
    applyDocOp(d, { op: 'note', cell: 'E6', text: 'Compared against Settings!B1' });
    // Project: free-form sheet with a title and two small named tables in the middle
    applyDocOp(d, { op: 'addSheet', name: 'Project', index: 0 });
    applyDocOp(d, { op: 'set', sheet: 'Project', cells: {
      B2: 'Robot project', B3: 'Notes and tasks — tables live anywhere in the sheet; the agent reads them as records.',
      B5: 'Tasks', H5: 'Parts',
      B12: 'Open tasks', C12: '=COUNTIF(Tasks[Status],"open")', B13: 'Parts cost', C13: '=SUM(Parts[Price])',
    } });
    applyDocOp(d, { op: 'set', sheet: 'Project', range: 'B6', values: [
      ['Task', 'Status', 'Owner', 'Notes'],
      ['Build the chassis', 'done', 'Sam', 'Lego Technic'],
      ['Wire the servos', 'open', 'Alex', 'Need 4, check the voltage'],
      ['Speech recognition', 'open', 'Alex', 'Run Parakeet locally?'],
      ['Name the robot', 'open', 'Sam', ''],
    ] });
    applyDocOp(d, { op: 'set', sheet: 'Project', range: 'H6', values: [['Part', 'Price'], ['Servo', 12.5], ['Battery', 24.9], ['Pi', 89]] });
    applyDocOp(d, { op: 'table', name: 'Tasks', range: 'Project!B6:E10' });
    applyDocOp(d, { op: 'table', name: 'Parts', range: 'Project!H6:I9' });
    applyDocOp(d, { op: 'format', sheet: 'Project', range: 'B2', style: { b: true, fs: 16 } });
    applyDocOp(d, { op: 'format', sheet: 'Project', ranges: ['B5', 'H5'], style: { b: true, color: '#5f6368' } });
    applyDocOp(d, { op: 'format', sheet: 'Project', range: 'B3', style: { i: true, color: '#5f6368' } });
    applyDocOp(d, { op: 'resize', sheet: 'Project', cols: { A: 30, B: 150, C: 80, D: 80, E: 240, F: 90, G: 40 } });
    applyDocOp(d, { op: 'resize', sheet: 'Project', rows: { 2: 30 } });
    applyDocOp(d, { op: 'merge', sheet: 'Project', range: 'B3:I3' });
    applyDocOp(d, { op: 'borders', sheet: 'Project', range: 'B12:C13', type: 'outer', style: 'medium', color: '#188038' });
    applyDocOp(d, { op: 'borders', sheet: 'Project', range: 'B12:C12', type: 'bottom', style: 'dashed', color: '#188038' });
    // Dashboard: live KPIs + charts on a gridless sheet
    applyDocOp(d, { op: 'addSheet', name: 'Dashboard', index: 1 });
    applyDocOp(d, { op: 'set', sheet: 'Dashboard', cells: {
      B2: 'Robot project — status', B3: 'Updates live as the tables on the Project sheet change',
      B26: 'Source data (the charts read this):', B27: 'Status', C27: 'count', B28: 'open', C28: '=COUNTIF(Tasks[Status],B28)', B29: 'done', C29: '=COUNTIF(Tasks[Status],B29)',
    } });
    applyDocOp(d, { op: 'table', name: 'StatusMix', range: 'Dashboard!B27:C29' });
    applyDocOp(d, { op: 'format', sheet: 'Dashboard', range: 'B26', style: { color: '#9aa0a6', i: true } });
    applyDocOp(d, { op: 'format', sheet: 'Dashboard', range: 'B2', style: { fs: 32, b: true } });
    applyDocOp(d, { op: 'format', sheet: 'Dashboard', range: 'B3', style: { color: '#5f6368' } });
    applyDocOp(d, { op: 'resize', sheet: 'Dashboard', rows: { 2: 54 }, cols: { A: 24 } });
    applyDocOp(d, { op: 'view', sheet: 'Dashboard', grid: false });
    applyDocOp(d, { op: 'addChart', sheet: 'Dashboard', id: 'kpiOpen', type: 'kpi', value: 'Project!C12', title: 'Open tasks', at: 'B5', w: 220, h: 120 });
    applyDocOp(d, { op: 'addChart', sheet: 'Dashboard', id: 'kpiCost', type: 'kpi', value: 'Project!C13', title: 'Parts cost €', at: 'B5', dx: 236, w: 220, h: 120 });
    applyDocOp(d, { op: 'addChart', sheet: 'Dashboard', id: 'parts', type: 'column', table: 'Parts', x: 'Part', title: 'Part prices', at: 'B5', dy: 136, w: 456, h: 250 });
    applyDocOp(d, { op: 'addChart', sheet: 'Dashboard', id: 'status', type: 'pie', table: 'StatusMix', title: 'Task status', at: 'B5', dx: 472, w: 340, h: 386 });
    const notes = TYPES.text.create('Notes');
    this.state.docs.notes = { id: 'notes', ...notes, text: '# Notes\n\nA second canvas type. The agent can write here too:\nPOST /api/ops {"doc":"notes","ops":[{"op":"append","text":"..."}]}\n' };
    this.state.order.push('notes');
  }

  // ------------------------------------------------------------ persistence
  flush() {
    clearTimeout(this.saveTimer);
    const tmp = path.join(this.dir, 'state.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, path.join(this.dir, 'state.json'));
  }
  scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flush(), 250); }
  appendLog(e) {
    this.log.push(e);
    if (this.log.length > LOG_MEM * 1.2) this.log = this.log.slice(-LOG_MEM);
    fs.appendFileSync(path.join(this.dir, 'log.jsonl'), JSON.stringify(e) + '\n');
  }

  // ------------------------------------------------------------ live
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(evt) { for (const fn of this.subs) { try { fn(evt); } catch {} } }

  // ------------------------------------------------------------ docs
  doc(id) {
    const d = this.state.docs[id || this.state.order[0]];
    if (!d) throw httpErr(404, `No doc "${id}". Docs: ${this.state.order.join(', ')}`);
    return d;
  }
  docList() { return this.state.order.map((id) => ({ id, type: this.state.docs[id].type, title: this.state.docs[id].title })); }

  createDoc({ type, title, id, by = 'user' }) {
    const T = TYPES[type];
    if (!T) throw httpErr(400, `Unknown type "${type}". Types: ${Object.keys(TYPES).join(', ')}`);
    id = (id || (title || type).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || type).slice(0, 40);
    let base = id, i = 2;
    while (this.state.docs[id]) id = `${base}-${i++}`;
    this.state.docs[id] = { id, ...T.create(title) };
    this.state.order.push(id);
    return this.record({ by, doc: id, ops: [], changes: [{ k: 'doc', action: 'create', id, type }], docEvent: true });
  }
  deleteDoc(id, by = 'user') {
    this.doc(id);
    if (this.state.order.length <= 1) throw httpErr(400, 'Cannot delete the last doc');
    delete this.state.docs[id];
    this.state.order = this.state.order.filter((x) => x !== id);
    this.calc.delete(id);
    return this.record({ by, doc: id, ops: [], changes: [{ k: 'doc', action: 'delete', id }], docEvent: true });
  }
  renameDoc(id, title, by = 'user') {
    const d = this.doc(id);
    const old = d.title;
    d.title = String(title).slice(0, 80);
    return this.record({ by, doc: id, ops: [], changes: [{ k: 'doc', action: 'rename', id, old, new: d.title }], docEvent: true });
  }

  // ------------------------------------------------------------ ops
  /**
   * Apply a batch atomically.
   * expect: { "Sheet1!D5": "3" } -> 409 if current raw differs (optimistic concurrency for agents)
   */
  batch({ doc: docId, by = 'agent', clientId = null, ops, expect, label, who, color }) {
    const d = this.doc(docId);
    if (!Array.isArray(ops) || !ops.length) throw httpErr(400, 'ops must be a non-empty array');
    if (expect && d.type === 'sheet') {
      const conflicts = [];
      for (const [k, want] of Object.entries(expect)) {
        const [sn, a] = splitSheet(k);
        const sh = sn ? d.sheets.find((s) => s.name.toLowerCase() === sn.toLowerCase()) : d.sheets[0];
        const R = parseRange(a);
        if (!sh || !R) { conflicts.push({ cell: k, expected: want, actual: '(missing)' }); continue; }
        const cur = sh.cells[rangeToString(R)]?.v ?? '';
        if (String(want ?? '') !== cur) conflicts.push({ cell: k, expected: want, actual: cur });
      }
      if (conflicts.length) throw httpErr(409, 'Cells changed since you read them', { conflicts, version: this.state.version });
    }
    const done = [];
    const changes = [];
    try {
      for (const op of ops) {
        const res = applyDocOp(d, op);
        done.push(res.inverse);
        changes.push(...res.changes);
      }
    } catch (e) {
      for (const inv of done.reverse()) for (const op of inv) { try { applyDocOp(d, op); } catch {} }
      throw httpErr(400, e.message);
    }
    if (d.type === 'sheet' && d.sheets.some((sh) => sh.tables?.length)) {
      let n = 0;
      for (const c of changes) {
        if (c.k !== 'set' || n++ > 2000) continue;
        const t = TYPES.sheet.tableLabel(d, c.sheet, c.cell);
        if (t) c.t = t;
      }
    }
    const recalc = this.recalcDiff(d.id, changes);
    const inverse = done.reverse().flat();
    return this.record({ by, clientId, doc: d.id, ops, changes, recalc, label, inverse, who, color });
  }

  recalcDiff(docId, changes = []) {
    const d = this.state.docs[docId];
    const T = TYPES[d.type];
    if (!T.recalc) return [];
    const prev = this.calc.get(docId);
    const now = T.recalc(d);
    this.calc.set(docId, now);
    if (!prev) return [];
    for (const c of changes) relocate(prev, c); // compare moved formulas at their new address
    const direct = new Set(changes.filter((c) => c.k === 'set').map((c) => `${c.sheet}!${c.cell}`));
    const out = [];
    for (const [k, v] of now) {
      if (!prev.has(k) || direct.has(k)) continue;
      const o = prev.get(k);
      if (o !== v) out.push({ cell: k, old: o, new: v });
    }
    return out;
  }

  record({ by, clientId = null, doc, ops, changes, recalc = [], label, inverse, docEvent, who, color }) {
    const v = ++this.state.version;
    const entry = { v, ts: Date.now(), by, doc, ops, changes, recalc };
    if (label) entry.label = label;
    if (who) { entry.who = cleanName(who); if (color) entry.color = cleanColor(color); }
    this.appendLog(inverse ? { ...entry, inv: inverse } : docEvent ? { ...entry, docEvent: changes[0]?.action || true } : entry);   // inverses make time replay possible
    this.scheduleSave();
    this.emit({ type: docEvent ? 'docs' : 'batch', ...entry, clientId, touched: touched(changes), docs: docEvent ? this.docList() : undefined });
    return { ...entry, inverse };
  }

  // ------------------------------------------------------------ history
  changes({ since = 0, doc, exclude, by, limit = 200 }) {
    let list = this.log.filter((e) => e.v > since);
    const earliest = this.log.length ? this.log[0].v : this.state.version + 1;
    const truncated = since + 1 < earliest && this.state.version > 0 && since < earliest - 1;
    if (doc) list = list.filter((e) => e.doc === doc);
    if (exclude) { const ex = String(exclude).split(','); list = list.filter((e) => !ex.includes(e.by)); }   // e.g. agent,sim
    if (by) list = list.filter((e) => e.by === by);
    const more = list.length > limit;
    if (more) list = list.slice(0, limit);
    return { version: this.state.version, since, entries: list.map(({ inv, docEvent, ...e }) => e), more, truncated };
  }

  /** Every log entry still on disk (the in-memory log only keeps the newest LOG_MEM). */
  fullLog() {
    try { return fs.readFileSync(path.join(this.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return this.log; }
  }
  /**
   * Time replay: the doc as it was at `from`, rebuilt by undoing every later batch with its recorded inverse, plus
   * the batches between `from` and `to` to play forward. If history before some point can't be undone (the doc was
   * created then, or the log predates inverses), the replay starts there instead and says so.
   */
  replay({ doc: docId, from, to }) {
    const d = this.doc(docId);
    const now = Date.now();
    to = Math.min(to ?? now, now);
    if (!(from < to)) throw httpErr(400, 'replay: from must be before to');
    let log = this.log;
    if (log.length && log[0].ts > from) log = this.fullLog();
    const mine = log.filter((e) => e.doc === d.id);
    const state = clone(d);
    let start = from, note = null;
    for (let i = mine.length - 1; i >= 0; i--) {
      const e = mine[i];
      if (e.ts <= from) break;
      if (e.docEvent) {
        if (e.docEvent === 'create' || e.docEvent === true) { start = e.ts; note = `the workbook was created at ${new Date(e.ts).toISOString()}`; break; }
        continue;   // a rename: nothing in the content changed
      }
      if (!e.inv) { start = e.ts; note = `history before v${e.v + 1} has no undo record`; break; }
      try { for (const op of e.inv) applyDocOp(state, op); }
      catch (err) { throw httpErr(500, `replay: could not undo v${e.v}: ${err.message}`); }
    }
    const frames = mine.filter((e) => e.ts > start && e.ts <= to && !e.docEvent && e.ops.length)
      .map((e) => ({ v: e.v, ts: e.ts, by: e.by, who: e.who, color: e.color, label: e.label, ops: e.ops, touched: touched(e.changes).slice(0, 4), n: e.changes.length }));
    const first = mine.find((e) => e.ts > start);
    return { doc: d.id, from: start, to, requested: from, note, startVersion: first ? first.v - 1 : this.state.version, start: state, frames };
  }

  commit({ message, by = 'user' }) {
    const id = 'm' + (this.commits.length + 1);
    const c = { id, version: this.state.version, message: String(message || 'milestone').slice(0, 200), by, ts: Date.now() };
    this.flush();
    fs.writeFileSync(path.join(this.dir, 'commits', id + '.json'), JSON.stringify({ ...c, docs: this.state.docs, order: this.state.order }));
    this.commits.push(c);
    fs.writeFileSync(path.join(this.dir, 'commits.json'), JSON.stringify(this.commits, null, 1));
    this.emit({ type: 'commit', commit: c });
    return c;
  }

  loadCommit(id) {
    if (id === 'last' || id === 'latest') id = this.commits.at(-1)?.id;
    const c = this.commits.find((x) => x.id === id);
    if (!c) throw httpErr(404, `No milestone "${id}"`);
    return JSON.parse(fs.readFileSync(path.join(this.dir, 'commits', c.id + '.json'), 'utf8'));
  }

  /** Diff a milestone against now. */
  diff({ from, doc }) {
    const snap = this.loadCommit(from);
    const ids = doc ? [doc] : this.state.order;
    const out = [];
    for (const id of ids) {
      const cur = this.state.docs[id], old = snap.docs[id];
      if (!cur && !old) continue;
      if (!old) { out.push({ doc: id, changes: [{ k: 'doc', action: 'create', id }] }); continue; }
      if (!cur) { out.push({ doc: id, changes: [{ k: 'doc', action: 'delete', id }] }); continue; }
      // Move-aware: replay structural ops onto the snapshot so moved cells don't show as delete+add.
      const since = this.log.filter((e) => e.v > snap.version && e.doc === id);
      const covered = this.log.length && this.log[0].v <= snap.version + 1;
      let base = old;
      if (covered && !since.some((e) => e.ops.some((o) => o.op === '__restore'))) {
        base = clone(old);
        for (const e of since) for (const o of e.ops) if (STRUCTURAL.has(o.op)) { try { applyDocOp(base, o); } catch {} }
      }
      const ch = TYPES[cur.type].diff(base, cur);
      const structural = this.log.filter((e) => e.v > snap.version && e.doc === id)
        .flatMap((e) => e.changes.filter((c) => ['move', 'rows', 'cols', 'sheet'].includes(c.k)).map((c) => ({ ...c, v: e.v, by: e.by })));
      if (ch.length || structural.length) out.push({ doc: id, changes: ch, structural });
    }
    return { from: snap.id, fromVersion: snap.version, message: snap.message, version: this.state.version, docs: out };
  }

  restore({ commit, doc, by = 'user' }) {
    const snap = this.loadCommit(commit);
    const ids = doc ? [doc] : snap.order;
    const results = [];
    for (const id of ids) {
      const old = snap.docs[id];
      if (!old) continue;
      if (!this.state.docs[id]) {
        this.state.docs[id] = clone(old);
        this.state.order.push(id);
        results.push(this.record({ by, doc: id, ops: [], changes: [{ k: 'doc', action: 'create', id }], docEvent: true }));
        continue;
      }
      results.push(this.batch({ doc: id, by, ops: [{ op: '__restore', state: old }], label: `restore ${snap.id} "${snap.message}"` }));
    }
    return { restored: snap.id, version: this.state.version, entries: results.map((r) => r.v) };
  }
}

export function httpErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

/** Cells/ranges affected by changes (for UI flashes). */
function touched(changes) {
  const out = [];
  for (const c of changes) {
    if (c.k === 'set' || c.k === 'note') out.push({ sheet: c.sheet, range: c.cell });
    else if (c.k === 'move') out.push({ sheet: c.toSheet, range: c.to });
    else if (c.k === 'format') for (const r of c.ranges) if (r[0] !== '(') out.push({ sheet: c.sheet, range: r });
    if (out.length > 2000) break;
  }
  return out;
}
