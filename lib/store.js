// Workspace store: docs, versioned op log, milestones (commits), live subscribers.
import fs from 'node:fs';
import path from 'node:path';
import { TYPES, applyDocOp } from '../public/shared/types/index.js';
import { parseRange, splitSheet, rangeToString } from '../public/shared/a1.js';
import { relocate } from './format.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const LOG_MEM = 5000;
const STRUCTURAL = new Set(['move', 'insertRows', 'deleteRows', 'insertCols', 'deleteCols', 'renameSheet', 'addSheet', 'deleteSheet']);

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.subs = new Set();
    this.selection = null;
    this.calc = new Map(); // docId -> Map(cell -> display) for recalc diffs
    this.saveTimer = null;
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
  batch({ doc: docId, by = 'agent', clientId = null, ops, expect, label }) {
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
    return this.record({ by, clientId, doc: d.id, ops, changes, recalc, label, inverse });
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

  record({ by, clientId = null, doc, ops, changes, recalc = [], label, inverse, docEvent }) {
    const v = ++this.state.version;
    const entry = { v, ts: Date.now(), by, doc, ops, changes, recalc };
    if (label) entry.label = label;
    this.appendLog(entry);
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
    if (exclude) list = list.filter((e) => e.by !== exclude);
    if (by) list = list.filter((e) => e.by === by);
    const more = list.length > limit;
    if (more) list = list.slice(0, limit);
    return { version: this.state.version, since, entries: list, more, truncated };
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
