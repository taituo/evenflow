// Sheet canvas type: workbook state + operations. Pure, shared by server and browser.
// apply(state, op) mutates state and returns { inverse: op[], changes: record[] }.
import {
  addr, parseAddr, parseRange, rangeToString, inRange, splitSheet, nameToCol, colToName, sameName, norm, quoteSheet,
} from '../a1.js';
import { transformFormula, refBox, renameTableRefs, literal } from '../formula.js';
import { computeAll, Engine, fmtValue } from '../engine.js';

export const type = 'sheet';
const MAX_CELLS_PER_OP = 200000;

export function newSheet(name) {
  return { name, cells: {}, colW: {}, rowH: {}, freeze: { rows: 0, cols: 0 } };
}
export function create(title) {
  return { type, title: title || 'Workbook', sheets: [newSheet('Sheet1')] };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const fail = (m) => { throw new Error(m); };

export function findSheet(st, name) {
  if (name == null || name === '') return st.sheets[0];
  const s = st.sheets.find((x) => sameName(x.name, name));
  if (!s) fail(`No sheet "${name}". Sheets: ${st.sheets.map((x) => x.name).join(', ')}`);
  return s;
}

function normRaw(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function tidy(sh, a) {
  const c = sh.cells[a];
  if (c && (c.v === '' || c.v == null) && !c.s && !c.n) delete sh.cells[a];
}

/** "Sheet!A1:B2" or "A1:B2" with default sheet -> {sh, R} */
function target(st, str, defSheet) {
  const [sn, rs] = splitSheet(str);
  const sh = findSheet(st, sn ?? defSheet);
  const R = parseRange(rs);
  if (!R) fail(`Bad range "${str}"`);
  return { sh, R };
}

function usedExtent(sh) {
  let r = -1, c = -1;
  for (const a in sh.cells) { const p = parseAddr(a); if (p.r > r) r = p.r; if (p.c > c) c = p.c; }
  return { r, c };
}
export function usedRange(sh) {
  let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1;
  for (const a in sh.cells) {
    const p = parseAddr(a);
    r1 = Math.min(r1, p.r); c1 = Math.min(c1, p.c); r2 = Math.max(r2, p.r); c2 = Math.max(c2, p.c);
  }
  return r2 < 0 ? null : { c1, r1, c2, r2 };
}

// ------------------------------------------------------------------ ops
export function apply(st, op) {
  switch (op.op) {
    case 'set': return opSet(st, op);
    case 'format': return opFormat(st, op);
    case 'cellStyles': return opCellStyles(st, op);
    case 'note': return opNote(st, op);
    case 'move': return opMove(st, op);
    case 'insertRows': return opAxis(st, op, 'r', false);
    case 'deleteRows': return opAxis(st, op, 'r', true);
    case 'insertCols': return opAxis(st, op, 'c', false);
    case 'deleteCols': return opAxis(st, op, 'c', true);
    case 'resize': return opResize(st, op);
    case 'freeze': return opFreeze(st, op);
    case 'addSheet': return opAddSheet(st, op);
    case 'renameSheet': return opRenameSheet(st, op);
    case 'deleteSheet': return opDeleteSheet(st, op);
    case 'replaceAll': return opReplaceAll(st, op);
    case 'putCells': return opPutCells(st, op);
    case 'setTables': return opSetTables(st, op);
    case 'borders': return opBorders(st, op);
    case 'view': return opView(st, op);
    case 'liveLayout': return opLiveLayout(st, op);
    case 'panel': return opPanel(st, op);
    case 'removePanel': return opRemovePanel(st, op);
    case 'slide': return opSlide(st, op);
    case 'removeSlide': return opRemoveSlide(st, op);
    case 'addChart': return opAddChart(st, op);
    case 'updateChart': return opUpdateChart(st, op);
    case 'deleteChart': return opDeleteChart(st, op);
    case 'merge': return opMerge(st, op);
    case 'unmerge': return opUnmerge(st, op);
    case 'table': return opTable(st, op);
    case 'deleteTable': return opDeleteTable(st, op);
    case 'renameTable': return opRenameTable(st, op);
    case 'appendRows': return opAppendRows(st, op);
    case 'updateRows': return opUpdateRows(st, op);
    case 'removeRows': return opRemoveRows(st, op);
    case 'addColumn': return opAddColumn(st, op);
    default: fail(`Unknown sheet op "${op.op}"`);
  }
}

/**
 * set: { sheet?, cells: { "A1": "raw", "Other!B2": "=A1*2", "C3": null } }
 *   or { sheet?, range: "B2", values: [[...],[...]] }  (top-left anchored block)
 */
function opSet(st, op) {
  const entries = []; // [sheetName|null, "A1", value]
  if (op.cells) for (const [k, v] of Object.entries(op.cells)) { const [sn, a] = splitSheet(k); entries.push([sn, a, v]); }
  if (op.values) {
    const { sh, R } = target(st, op.range || 'A1', op.sheet);
    op.values.forEach((row, i) => (Array.isArray(row) ? row : [row]).forEach((v, j) => {
      entries.push([sh.name, addr(R.c1 + j, R.r1 + i), v]);
    }));
  }
  if (entries.length > MAX_CELLS_PER_OP) fail('Too many cells in one op');
  const inv = {}, changes = [];
  for (const [sn, a, v] of entries) {
    const sh = findSheet(st, sn ?? op.sheet);
    const p = parseAddr(a);
    if (!p) fail(`Bad cell "${a}"`);
    const A = addr(p.c, p.r);
    const old = sh.cells[A]?.v ?? '';
    const nv = normRaw(v);
    if (old === nv) continue;
    const invS = (inv[sh.name] ||= {});
    if (!(A in invS)) invS[A] = old === '' ? null : old;
    if (sh.cells[A]) sh.cells[A].v = nv; else if (nv !== '') sh.cells[A] = { v: nv };
    tidy(sh, A);
    changes.push({ k: 'set', sheet: sh.name, cell: A, old, new: nv });
  }
  return { inverse: Object.entries(inv).map(([sheet, cells]) => ({ op: 'set', sheet, cells })), changes };
}

const STYLE_KEYS = ['b', 'i', 'u', 's', 'fill', 'color', 'align', 'wrap', 'fs', 'valign', 'ff'];
/** format: { sheet?, range | ranges: [...], style: { b:true, fill:"#fff2cc", align:"center", color:null } } */
function opFormat(st, op) {
  const ranges = op.ranges || [op.range];
  const styles = {}, inv = [];
  let sheetName;
  for (const rs of ranges) {
    const { sh, R } = target(st, rs, op.sheet);
    sheetName = sh.name;
    const ext = usedExtent(sh);
    const r2 = R.r2 > 1e5 ? Math.max(ext.r, R.r1) : R.r2, c2 = R.c2 > 1e4 ? Math.max(ext.c, R.c1) : R.c2;
    if ((r2 - R.r1 + 1) * (c2 - R.c1 + 1) > MAX_CELLS_PER_OP) fail('Range too large to format');
    const old = {};
    for (let r = R.r1; r <= r2; r++) for (let c = R.c1; c <= c2; c++) {
      const A = addr(c, r);
      const cell = sh.cells[A] || (sh.cells[A] = { v: '' });
      old[A] = cell.s ? { ...cell.s } : null;
      const s = { ...(cell.s || {}) };
      for (const k of STYLE_KEYS) if (k in op.style) { if (op.style[k] == null || op.style[k] === false) delete s[k]; else s[k] = op.style[k]; }
      if (Object.keys(s).length) cell.s = s; else delete cell.s;
      tidy(sh, A);
    }
    inv.push({ op: 'cellStyles', sheet: sh.name, styles: old });
    styles[rangeToString(R)] = true;
  }
  return { inverse: inv.reverse(), changes: [{ k: 'format', sheet: sheetName, ranges: Object.keys(styles), style: op.style }] };
}

function opCellStyles(st, op) {
  const sh = findSheet(st, op.sheet);
  const old = {};
  for (const [A, s] of Object.entries(op.styles)) {
    old[A] = sh.cells[A]?.s ? { ...sh.cells[A].s } : null;
    const cell = sh.cells[A] || (sh.cells[A] = { v: '' });
    if (s) cell.s = { ...s }; else delete cell.s;
    tidy(sh, A);
  }
  return { inverse: [{ op: 'cellStyles', sheet: sh.name, styles: old }], changes: [{ k: 'format', sheet: sh.name, ranges: ['(restore)'], style: {} }] };
}

/** note: { sheet?, cell: "B2", text: "..." | null } */
function opNote(st, op) {
  const [sn, a] = splitSheet(op.cell);
  const sh = findSheet(st, sn ?? op.sheet);
  const p = parseAddr(a);
  if (!p) fail(`Bad cell "${op.cell}"`);
  const A = addr(p.c, p.r);
  const old = sh.cells[A]?.n ?? null;
  const nv = op.text ? String(op.text) : null;
  if (old === nv) return { inverse: [], changes: [] };
  const cell = sh.cells[A] || (sh.cells[A] = { v: '' });
  if (nv) cell.n = nv; else delete cell.n;
  tidy(sh, A);
  return {
    inverse: [{ op: 'note', sheet: sh.name, cell: A, text: old }],
    changes: [{ k: 'note', sheet: sh.name, cell: A, old: old ?? '', new: nv ?? '' }],
  };
}

const preCells = (st) => st.sheets.map((s) => ({ name: s.name, cells: clone(s.cells) }));
const preTables = (st) => ({
  op: 'setTables',
  tables: Object.fromEntries(st.sheets.map((s) => [s.name, s.tables ? clone(s.tables) : null])),
  merges: Object.fromEntries(st.sheets.map((s) => [s.name, s.merges ? [...s.merges] : null])),
  charts: Object.fromEntries(st.sheets.map((s) => [s.name, s.charts ? clone(s.charts) : null])),
});
const isFormula = (v) => typeof v === 'string' && v[0] === '=';
const intersects = (a, b) => a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2;

/**
 * Exact undo support for structural ops: after the reverse structural op has put cells back at their
 * pre-op addresses, these putCells restore removed cells and every formula whose text changed.
 * mapPos(sheet, A) -> [sheet, A] | null (removed). extra(sheet, A, text) -> force include.
 */
function buildRestore(st, pre, mapPos, extra, skipSheet) {
  const out = {};
  for (const ps of pre) {
    if (skipSheet && sameName(ps.name, skipSheet)) continue;
    for (const [A, cell] of Object.entries(ps.cells)) {
      const m = mapPos(ps.name, A);
      if (!m) { (out[ps.name] ||= {})[A] = cell; continue; }
      if (!isFormula(cell.v)) continue;
      const now = st.sheets.find((x) => sameName(x.name, m[0]))?.cells[m[1]];
      if (!now || now.v !== cell.v || (extra && extra(ps.name, A, cell.v))) (out[ps.name] ||= {})[A] = cell;
    }
  }
  return Object.entries(out).map(([sheet, cells]) => ({ op: 'putCells', sheet, cells }));
}

/** putCells: { sheet, cells: { A1: {v,s,n} | null } } — wholesale cell replace (used for exact undo). */
function opPutCells(st, op) {
  const sh = findSheet(st, op.sheet);
  const old = {}, changes = [];
  for (const [A, cell] of Object.entries(op.cells)) {
    const prev = sh.cells[A];
    old[A] = prev ? clone(prev) : null;
    if (cell) sh.cells[A] = clone(cell); else delete sh.cells[A];
    const o = prev?.v ?? '', w = cell?.v ?? '';
    if (o !== w) changes.push({ k: 'set', sheet: sh.name, cell: A, old: o, new: w });
  }
  return { inverse: [{ op: 'putCells', sheet: sh.name, cells: old }], changes };
}

/** Rewrite every formula in the workbook. fn(ref, resolvedSheetName, homeSheet, originSheetName) */
function rewriteAll(st, fn, originOf = () => null) {
  const rewritten = [];
  // named tables follow structural changes like range references do
  const moves = [];
  for (const sh of st.sheets) {
    if (!sh.tables) continue;
    for (const t of [...sh.tables]) {
      const R = parseRange(t.range);
      const ref = { sheet: null, a: { c: R.c1, r: R.r1, ac: false, ar: false }, b: { c: R.c2, r: R.r2, ac: false, ar: false } };
      const out = fn(ref, sh.name, sh);
      if (out === undefined) continue;
      if (out === null) { sh.tables.splice(sh.tables.indexOf(t), 1); continue; }
      t.range = rangeToString(refBox(out.ref));
      if (!sameName(out.sheet, sh.name)) moves.push([sh, t, out.sheet]);
    }
  }
  for (const sh of st.sheets) {
    if (!sh.merges) continue;
    sh.merges = sh.merges.map((m) => {
      const R = parseRange(m);
      const ref = { sheet: null, a: { c: R.c1, r: R.r1, ac: false, ar: false }, b: { c: R.c2, r: R.r2, ac: false, ar: false } };
      const out = fn(ref, sh.name, sh);
      if (out === undefined) return m;
      if (out === null) return null;
      const box = refBox(out.ref);
      if (!sameName(out.sheet, sh.name)) { const to = st.sheets.find((x) => sameName(x.name, out.sheet)); (to.merges ||= []).push(rangeToString(box)); return null; }
      return box.c1 === box.c2 && box.r1 === box.r2 ? null : rangeToString(box);
    }).filter(Boolean);
  }
  for (const sh of st.sheets) {
    for (const ch of sh.charts || []) {
      const tr = (str, isRange) => {
        if (!str) return str;
        const [sn, rs] = splitSheet(str);
        const R = parseRange(rs);
        if (!R) return str;
        const ref = { sheet: sn, a: { c: R.c1, r: R.r1, ac: false, ar: false }, b: { c: R.c2, r: R.r2, ac: false, ar: false } };
        const out = fn(ref, sn ?? sh.name, sh);
        if (!out) return str;
        const box = refBox(out.ref);
        if (!isRange && !sameName(out.sheet, sh.name)) return str;
        const prefix = !sameName(out.sheet, sh.name) || sn != null ? quoteSheet(out.sheet) + '!' : '';
        return prefix + rangeToString(isRange ? box : { c1: box.c1, r1: box.r1, c2: box.c1, r2: box.r1 });
      };
      ch.at = tr(ch.at, false);
      if (ch.range) ch.range = tr(ch.range, true);
      if (ch.value) ch.value = tr(ch.value, false);
    }
  }
  for (const [from, t, toName] of moves) {
    from.tables.splice(from.tables.indexOf(t), 1);
    const to = st.sheets.find((x) => sameName(x.name, toName));
    (to.tables ||= []).push(t);
  }
  for (const sh of st.sheets) {
    for (const [A, cell] of Object.entries(sh.cells)) {
      if (typeof cell.v !== 'string' || cell.v[0] !== '=') continue;
      const origin = originOf(sh, A) || sh.name;
      const nv = transformFormula(cell.v, (ref) => {
        const resolved = ref.sheet ?? origin;
        const out = fn(ref, resolved, sh);
        if (out === null) return null;
        const res = out === undefined ? { ref, sheet: resolved } : out;
        // decide prefix: explicit if target differs from home, or if it was explicit before
        const tgt = res.sheet;
        const r = { ...res.ref };
        r.sheet = !sameName(tgt, sh.name) || ref.sheet != null ? tgt : null;
        return r;
      });
      if (nv !== cell.v) { cell.v = nv; rewritten.push(`${sh.name}!${A}`); }
    }
  }
  return rewritten;
}

/** move: { sheet?, from: "C23:D32", to: "F23" | "Other!F23" } — cut & paste semantics, refs follow. */
function opMove(st, op) {
  const { sh: src, R } = target(st, op.from, op.sheet);
  const [tsn, ta] = splitSheet(op.to);
  const dst = findSheet(st, tsn ?? src.name);
  const T = parseRange(ta);
  if (!T) fail(`Bad target "${op.to}"`);
  const dr = T.r1 - R.r1, dc = T.c1 - R.c1;
  if (src === dst && dr === 0 && dc === 0) return { inverse: [], changes: [] };
  const D = { c1: R.c1 + dc, r1: R.r1 + dr, c2: R.c2 + dc, r2: R.r2 + dr };
  if (D.c1 < 0 || D.r1 < 0) fail('Move target out of bounds');
  const pre = preCells(st);
  const preT = preTables(st);
  const srcName = src.name, dstName = dst.name;

  const moving = [];
  for (const [A, cell] of Object.entries(src.cells)) {
    const p = parseAddr(A);
    if (inRange(R, p.c, p.r)) { moving.push([p, cell]); delete src.cells[A]; }
  }
  let overwritten = 0;
  for (const A of Object.keys(dst.cells)) {
    const p = parseAddr(A);
    if (inRange(D, p.c, p.r)) { delete dst.cells[A]; overwritten++; }
  }
  const movedKeys = new Set();
  for (const [p, cell] of moving) {
    const A = addr(p.c + dc, p.r + dr);
    dst.cells[A] = cell;
    movedKeys.add(A);
  }
  const rewritten = rewriteAll(st, (ref, rs) => {
    const box = refBox(ref);
    if (sameName(rs, src.name) && inRange(R, box.c1, box.r1) && inRange(R, box.c2, box.r2)) {
      const mv = (p) => ({ ...p, r: p.r + dr, c: p.c + dc });
      return { ref: { ...ref, a: mv(ref.a), b: ref.b ? mv(ref.b) : null }, sheet: dst.name };
    }
    if (!op.keepRefs && !ref.b && sameName(rs, dst.name) && inRange(D, ref.a.c, ref.a.r)) return null; // overwritten target
    return undefined;
  }, (sh, A) => (sh === dst && movedKeys.has(A) ? src.name : null))
    .filter((k) => !(sameName(k.split('!')[0], dst.name) && movedKeys.has(k.slice(k.lastIndexOf('!') + 1))));

  const mapPos = (sn, A) => {
    const p = parseAddr(A);
    if (sameName(sn, srcName) && inRange(R, p.c, p.r)) return [dstName, addr(p.c + dc, p.r + dr)];
    if (sameName(sn, dstName) && inRange(D, p.c, p.r)) return null;
    return [sn, A];
  };
  const touches = (sn, A, text) => {
    let hitRef = false;
    const origin = sn;
    transformFormula(text, (ref) => {
      const rs = ref.sheet ?? origin, box = refBox(ref);
      if ((sameName(rs, srcName) && intersects(box, R)) || (sameName(rs, dstName) && intersects(box, D))) hitRef = true;
      return undefined;
    });
    return hitRef;
  };
  const inverse = [
    { op: 'move', sheet: dstName, from: rangeToString(D), to: quoteSheet(srcName) + '!' + addr(R.c1, R.r1), keepRefs: true },
    ...buildRestore(st, pre, mapPos, touches),
    preT,
  ];
  return {
    inverse,
    changes: [{
      k: 'move', sheet: src.name, from: rangeToString(R), toSheet: dst.name, to: rangeToString(D),
      cells: moving.length, overwritten: Math.max(0, overwritten), rewritten,
    }],
  };
}

function shiftPos(v, at, n, del) {
  if (!del) return v >= at ? v + n : v;
  if (v >= at && v < at + n) return null;
  return v >= at + n ? v - n : v;
}

/** insertRows/deleteRows: { sheet?, at: 5 (1-based row), count }  insertCols/deleteCols: { at: "C" | 3 (1-based) } */
function opAxis(st, op, axis, del) {
  const sh = findSheet(st, op.sheet);
  const n = Math.max(1, op.count | 0 || 1);
  let at;
  if (axis === 'r') at = (+op.at) - 1;
  else at = typeof op.at === 'string' && /^[A-Za-z]+$/.test(op.at) ? nameToCol(op.at) : (+op.at) - 1;
  if (!(at >= 0)) fail('Bad "at"');
  const pre = preCells(st);
  const preT = preTables(st);
  let removed = 0;
  const cells = {};
  for (const [A, cell] of Object.entries(sh.cells)) {
    const p = parseAddr(A);
    const v = shiftPos(axis === 'r' ? p.r : p.c, at, n, del);
    if (v === null) { removed++; continue; }
    cells[axis === 'r' ? addr(p.c, v) : addr(v, p.r)] = cell;
  }
  sh.cells = cells;
  const sizes = axis === 'r' ? 'rowH' : 'colW';
  const presizes = { ...sh[sizes] };
  const ns = {};
  for (const [k, w] of Object.entries(sh[sizes])) { const v = shiftPos(+k, at, n, del); if (v !== null) ns[v] = w; }
  sh[sizes] = ns;

  const rewritten = rewriteAll(st, (ref, rs) => {
    if (!sameName(rs, sh.name)) return undefined;
    const key = axis;
    if (!ref.b) {
      const v = shiftPos(ref.a[key], at, n, del);
      if (v === null) return null;
      return { ref: { ...ref, a: { ...ref.a, [key]: v } }, sheet: rs };
    }
    const lo = Math.min(ref.a[key], ref.b[key]), hi = Math.max(ref.a[key], ref.b[key]);
    let nlo, nhi;
    if (!del) { nlo = lo >= at ? lo + n : lo; nhi = hi >= at ? hi + n : hi; }
    else {
      const end = at + n - 1;
      nlo = lo > end ? lo - n : lo >= at ? at : lo;
      nhi = hi > end ? hi - n : hi >= at ? at - 1 : hi;
      if (nhi < nlo) return null;
    }
    const aIsLo = ref.a[key] <= ref.b[key];
    return {
      ref: { ...ref, a: { ...ref.a, [key]: aIsLo ? nlo : nhi }, b: { ...ref.b, [key]: aIsLo ? nhi : nlo } },
      sheet: rs,
    };
  });
  const label = axis === 'r' ? `${at + 1}${n > 1 ? ':' + (at + n) : ''}` : `${colToName(at)}${n > 1 ? ':' + colToName(at + n - 1) : ''}`;
  const mapPos = (sn, A) => {
    if (!sameName(sn, sh.name)) return [sn, A];
    const p = parseAddr(A);
    const v = shiftPos(axis === 'r' ? p.r : p.c, at, n, del);
    return v === null ? null : [sn, axis === 'r' ? addr(p.c, v) : addr(v, p.r)];
  };
  const rev = { op: (del ? 'insert' : 'delete') + (axis === 'r' ? 'Rows' : 'Cols'), sheet: sh.name, at: axis === 'r' ? at + 1 : colToName(at), count: n };
  const inverse = [rev, ...buildRestore(st, pre, mapPos), preT];
  if (del) { // restore sizes of deleted rows/cols
    const restoreSizes = {};
    let any = false;
    for (let i = at; i < at + n; i++) { const w = presizes[i]; if (w != null) { restoreSizes[axis === 'r' ? i + 1 : colToName(i)] = w; any = true; } }
    if (any) inverse.push({ op: 'resize', sheet: sh.name, [axis === 'r' ? 'rows' : 'cols']: restoreSizes });
  }
  return {
    inverse,
    changes: [{ k: axis === 'r' ? 'rows' : 'cols', action: del ? 'delete' : 'insert', sheet: sh.name, at: label, count: n, removed, rewritten }],
  };
}

/** resize: { sheet?, cols: { "A": 140 }, rows: { "3": 40 } }  (null = default) */
function opResize(st, op) {
  const sh = findSheet(st, op.sheet);
  const inv = { op: 'resize', sheet: sh.name, cols: {}, rows: {} };
  for (const [k, w] of Object.entries(op.cols || {})) {
    const c = /^\d+$/.test(k) ? +k : nameToCol(k);
    inv.cols[c] = sh.colW[c] ?? null;
    if (w == null) delete sh.colW[c]; else sh.colW[c] = Math.max(16, Math.min(2000, +w));
  }
  for (const [k, h] of Object.entries(op.rows || {})) {
    const r = +k - 1;
    if (!(r >= 0)) fail(`Bad row "${k}"`);
    inv.rows[r + 1] = sh.rowH[r] ?? null;
    if (h == null) delete sh.rowH[r]; else sh.rowH[r] = Math.max(8, Math.min(1000, +h));
  }
  inv.cols = Object.fromEntries(Object.entries(inv.cols).map(([k, v]) => [String(k), v]));
  return { inverse: [inv], changes: [{ k: 'layout', sheet: sh.name, what: 'resize' }] };
}

function opFreeze(st, op) {
  const sh = findSheet(st, op.sheet);
  const old = { ...sh.freeze };
  sh.freeze = { rows: Math.max(0, op.rows | 0), cols: Math.max(0, op.cols | 0) };
  return { inverse: [{ op: 'freeze', sheet: sh.name, ...old }], changes: [{ k: 'layout', sheet: sh.name, what: `freeze ${sh.freeze.rows} rows, ${sh.freeze.cols} cols` }] };
}

function validName(st, name, except) {
  name = String(name || '').trim();
  if (!name || name.length > 60 || /[!'\[\]*?/\\:]/.test(name)) fail(`Bad sheet name "${name}"`);
  if (st.sheets.some((s) => s !== except && sameName(s.name, name))) fail(`Sheet "${name}" exists`);
  return name;
}

function opAddSheet(st, op) {
  let name = op.name;
  if (!name) { let i = st.sheets.length + 1; while (st.sheets.some((s) => sameName(s.name, 'Sheet' + i))) i++; name = 'Sheet' + i; }
  name = validName(st, name);
  const sh = op.data ? { ...newSheet(name), ...clone(op.data), name } : newSheet(name);
  const idx = op.index == null ? st.sheets.length : Math.max(0, Math.min(st.sheets.length, op.index));
  st.sheets.splice(idx, 0, sh);
  return { inverse: [{ op: 'deleteSheet', sheet: name }], changes: [{ k: 'sheet', action: 'add', name }] };
}

function opRenameSheet(st, op) {
  const sh = findSheet(st, op.sheet);
  const old = sh.name;
  const name = validName(st, op.name, sh);
  sh.name = name;
  rewriteAll(st, (ref, rs) => (sameName(rs, old) ? { ref, sheet: name } : undefined),
    (s) => (s === sh ? name : null));
  // Formulas on other sheets that referenced `old` explicitly now point to `name`.
  return { inverse: [{ op: 'renameSheet', sheet: name, name: old }], changes: [{ k: 'sheet', action: 'rename', name: old, to: name }] };
}

function opDeleteSheet(st, op) {
  if (st.sheets.length <= 1) fail('Cannot delete the last sheet');
  const sh = findSheet(st, op.sheet);
  const pre = preCells(st);
  const index = st.sheets.indexOf(sh);
  const { name, ...data } = clone(sh);
  st.sheets.splice(index, 1);
  rewriteAll(st, (ref, rs) => (sameName(rs, sh.name) ? null : undefined));
  const inverse = [{ op: 'addSheet', name, index, data }, ...buildRestore(st, pre, (sn, A) => [sn, A], null, name)];
  return { inverse, changes: [{ k: 'sheet', action: 'delete', name: sh.name }] };
}

function opReplaceAll(st, op) {
  const before = { sheets: st.sheets };
  const inverse = [{ op: 'replaceAll', sheets: clone(st.sheets) }];
  st.sheets = clone(op.sheets);
  return { inverse, changes: diff(before, st) };
}

// ------------------------------------------------------------------ borders & merges (Sheets-native)
const BORDER_STYLES = ['solid', 'medium', 'thick', 'dashed', 'dotted', 'double'];
/**
 * borders: { range|ranges, type: all|inner|horizontal|vertical|outer|left|top|right|bottom|clear,
 *            style?: solid|medium|thick|dashed|dotted|double, color?: "#000" }
 * Stored per cell as s.bd = { t, b, l, r } with values "style color". Shared edges are written on both cells.
 */
function opBorders(st, op) {
  const type = op.type || 'all';
  const style = op.style || 'solid';
  if (!BORDER_STYLES.includes(style)) fail(`Bad border style "${style}" (${BORDER_STYLES.join('|')})`);
  const val = `${style} ${op.color || '#000000'}`;
  const ranges = op.ranges || [op.range];
  const old = {};
  let sheetName;
  const edit = (sh, c, r, side, v) => {
    if (c < 0 || r < 0) return;
    const A = addr(c, r);
    if (!(A in old)) old[A] = sh.cells[A]?.s ? clone(sh.cells[A].s) : null;
    const cell = sh.cells[A] || (sh.cells[A] = { v: '' });
    const s = cell.s ? { ...cell.s } : {};
    const bd = { ...(s.bd || {}) };
    if (v) bd[side] = v; else delete bd[side];
    if (Object.keys(bd).length) s.bd = bd; else delete s.bd;
    if (Object.keys(s).length) cell.s = s; else delete cell.s;
    tidy(sh, A);
  };
  const OPP = { t: 'b', b: 't', l: 'r', r: 'l' };
  const D = { t: [0, -1], b: [0, 1], l: [-1, 0], r: [1, 0] };
  const set = (sh, c, r, side, v) => { edit(sh, c, r, side, v); edit(sh, c + D[side][0], r + D[side][1], OPP[side], v); };
  for (const rs of ranges) {
    const { sh, R: R0 } = target(st, rs, op.sheet);
    sheetName = sh.name;
    const ext = usedExtent(sh);
    const R = { ...R0, r2: R0.r2 > 1e5 ? Math.max(ext.r, R0.r1) : R0.r2, c2: R0.c2 > 1e4 ? Math.max(ext.c, R0.c1) : R0.c2 };
    if ((R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1) > 50000) fail('Range too large for borders');
    for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) {
      const top = r === R.r1, bot = r === R.r2, left = c === R.c1, right = c === R.c2;
      const want = {
        all: { t: 1, b: 1, l: 1, r: 1 },
        outer: { t: top, b: bot, l: left, r: right },
        inner: { b: !bot, r: !right },
        horizontal: { b: !bot },
        vertical: { r: !right },
        top: { t: top }, bottom: { b: bot }, left: { l: left }, right: { r: right },
        clear: { t: 1, b: 1, l: 1, r: 1 },
      }[type];
      if (!want) fail(`Bad border type "${type}"`);
      for (const side of ['t', 'b', 'l', 'r']) if (want[side]) set(sh, c, r, side, type === 'clear' ? null : val);
    }
  }
  return {
    inverse: [{ op: 'cellStyles', sheet: sheetName, styles: old }],
    changes: [{ k: 'format', sheet: sheetName, ranges: ranges.map((x) => splitSheet(x)[1]), style: { borders: type === 'clear' ? 'clear' : `${type} ${val}` } }],
  };
}

/** view: { sheet, grid?: bool } — sheet display options (hide gridlines for dashboards). */
function opView(st, op) {
  const sh = findSheet(st, op.sheet);
  const old = { ...(sh.view || {}) };
  const v = { ...(sh.view || {}) };
  if ('grid' in op) { if (op.grid === false) v.grid = false; else delete v.grid; }
  if ('theme' in op) { if (op.theme) v.theme = String(op.theme); else delete v.theme; }
  if ('font' in op) { if (op.font) v.font = String(op.font); else delete v.font; }
  if (Object.keys(v).length) sh.view = v; else delete sh.view;
  return {
    inverse: [{ op: 'view', sheet: sh.name, grid: old.grid !== false, theme: old.theme || null, font: old.font || null }],
    changes: [{ k: 'layout', sheet: sh.name, what: 'theme' in op ? `live theme ${v.theme || 'default'}` : 'font' in op ? `live font ${v.font || 'default'}` : `gridlines ${v.grid === false ? 'hidden' : 'shown'}` }],
  };
}

// ------------------------------------------------------------------ charts (floating, live)
export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'kpi'];
const CHART_KEYS = ['type', 'title', 'range', 'table', 'x', 'y', 'value', 'label', 'at', 'dx', 'dy', 'w', 'h', 'stacked', 'colors'];
export function allCharts(st) { const out = []; for (const sh of st.sheets) for (const ch of sh.charts || []) out.push({ sh, ch }); return out; }
function findChart(st, id) {
  const x = allCharts(st).find((x) => x.ch.id === id);
  if (!x) fail(`No chart "${id}". Charts: ${allCharts(st).map((x) => x.ch.id).join(', ') || '(none)'}`);
  return x;
}
function checkChart(ch) {
  if (!CHART_TYPES.includes(ch.type)) fail(`Bad chart type "${ch.type}" (${CHART_TYPES.join('|')})`);
  if (ch.type === 'kpi' ? !ch.value : !ch.range && !ch.table) fail(ch.type === 'kpi' ? 'kpi chart needs value (cell, e.g. "C12")' : 'chart needs range ("B6:C10") or table');
  if (!parseRange(splitSheet(ch.at)[1])) fail(`Bad anchor "${ch.at}"`);
}
/** addChart: { sheet?, type, range|table(+x,y[])|value(kpi), title?, at: "K2", w?, h? } */
function opAddChart(st, op) {
  const sh = findSheet(st, op.sheet);
  let id = op.id;
  if (!id) { let n = 1; while (allCharts(st).some((x) => x.ch.id === 'chart' + n)) n++; id = 'chart' + n; }
  else if (allCharts(st).some((x) => x.ch.id === id)) fail(`Chart "${id}" exists`);
  const ch = { id };
  for (const k of CHART_KEYS) if (op[k] !== undefined && op[k] !== null) ch[k] = clone(op[k]);
  if (typeof ch.range === 'string' && ch.range.startsWith('@')) { ch.table = ch.range.slice(1); delete ch.range; }
  ch.at ||= 'H2'; ch.w ||= ch.type === 'kpi' ? 220 : 440; ch.h ||= ch.type === 'kpi' ? 120 : 260; ch.dx ||= 0; ch.dy ||= 0;
  if (typeof ch.y === 'string') ch.y = ch.y.split(',').map((x) => x.trim());
  checkChart(ch);
  (sh.charts ||= []).push(ch);
  return { inverse: [{ op: 'deleteChart', id }], changes: [{ k: 'chart', action: 'add', id, sheet: sh.name, type: ch.type, source: ch.table ? '@' + ch.table : ch.range || ch.value, at: ch.at }] };
}
function opUpdateChart(st, op) {
  const { sh, ch } = findChart(st, op.id);
  const old = { op: 'updateChart', id: op.id };
  for (const k of CHART_KEYS) if (k in op) { old[k] = ch[k] === undefined ? null : clone(ch[k]); if (op[k] === null) delete ch[k]; else ch[k] = clone(op[k]); }
  if (typeof ch.range === 'string' && ch.range.startsWith('@')) { ch.table = ch.range.slice(1); delete ch.range; if (!('table' in old)) old.table = null; }
  if ('range' in op && op.range && !String(op.range).startsWith('@') && ch.table) { if (!('table' in old)) old.table = ch.table; delete ch.table; }
  checkChart(ch);
  const what = Object.keys(op).filter((k) => k !== 'op' && k !== 'id');
  const moved = what.every((k) => ['at', 'dx', 'dy', 'w', 'h'].includes(k));
  return { inverse: [old], changes: [{ k: 'chart', action: moved ? 'layout' : 'update', id: ch.id, sheet: sh.name, type: ch.type, fields: what }] };
}
function opDeleteChart(st, op) {
  const { sh, ch } = findChart(st, op.id);
  sh.charts.splice(sh.charts.indexOf(ch), 1);
  if (!sh.charts.length) delete sh.charts;
  return { inverse: [{ op: 'addChart', sheet: sh.name, ...clone(ch) }], changes: [{ k: 'chart', action: 'delete', id: ch.id, sheet: sh.name, type: ch.type }] };
}

/** Live data for a chart: { labels, series:[{name, values}] } or { kpi: {value, label} } */
export function chartData(st, sheetName, ch, en = new Engine(st)) {
  const sh = findSheet(st, sheetName);
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : typeof v === 'string' && v.trim() !== '' && !isNaN(+v.replace(',', '.')) ? +v.replace(',', '.') : null);
  if (ch.type === 'kpi') {
    const [sn, a] = splitSheet(ch.value);
    const s2 = findSheet(st, sn ?? sh.name);
    const p = parseAddr(a);
    const v = p ? en.value(s2, p.c, p.r) : null;
    return { kpi: { value: v, text: fmtValue(v), label: ch.label || ch.title || '' } };
  }
  let header = [], body = [];
  if (ch.table) {
    const x = findTable(st, ch.table);
    const cols = tableColumns(x.sh, x.R);
    const xi = ch.x ? colIndex(x.sh, x.R, ch.x) : 0;
    const rows = [];
    for (let r = x.R.r1 + 1; r <= x.R.r2; r++) { const row = []; for (let c = x.R.c1; c <= x.R.c2; c++) row.push(en.value(x.sh, c, r)); rows.push(row); }
    let yi = ch.y && ch.y.length ? ch.y.map((n) => colIndex(x.sh, x.R, n)) : cols.map((_, i) => i).filter((i) => i !== xi && rows.some((r) => num(r[i]) !== null));
    return { labels: rows.map((r) => fmtValue(r[xi])), series: yi.map((i) => ({ name: cols[i], values: rows.map((r) => num(r[i])) })) };
  }
  const [sn, rs] = splitSheet(ch.range);
  const s2 = findSheet(st, sn ?? sh.name);
  const R = parseRange(rs);
  const grid = [];
  for (let r = R.r1; r <= Math.min(R.r2, R.r1 + 2000); r++) { const row = []; for (let c = R.c1; c <= Math.min(R.c2, R.c1 + 50); c++) row.push(en.value(s2, c, r)); grid.push(row); }
  if (!grid.length) return { labels: [], series: [] };
  const wide = grid[0].length > 1;
  const hasHeader = grid.length > 1 && grid[0].slice(wide ? 1 : 0).some((v) => v !== null && num(v) === null);
  if (hasHeader) { header = grid[0]; body = grid.slice(1); } else body = grid;
  const labelCol = wide && body.some((r) => r[0] !== null && num(r[0]) === null);
  const first = labelCol ? 1 : 0;
  const labels = body.map((r, i) => (labelCol ? fmtValue(r[0]) : String(i + 1)));
  const series = [];
  for (let j = first; j < (body[0] || []).length; j++) series.push({ name: hasHeader ? fmtValue(header[j]) : `Series ${series.length + 1}`, values: body.map((r) => num(r[j])) });
  return { labels, series };
}

// ------------------------------------------------------------------ live (combined) layout — workbook level
// st.live = { order:[key], spans:{key:{span,h}}, hidden:[key], flow:'vertical'|'horizontal', reveal:bool,
//             slots:[{id, span, h, image?}], panels:[{id, title, text, value, label, image, span, h, by}] }
const LIVE_KEYS = ['order', 'spans', 'hidden', 'flow', 'reveal', 'slots', 'panels', 'slides', 'links'];
function setLive(st, patch) {
  const old = {};
  const L = { ...(st.live || {}) };
  for (const k of LIVE_KEYS) {
    if (!(k in patch)) continue;
    old[k] = L[k] === undefined ? null : clone(L[k]);
    if (patch[k] == null) delete L[k]; else L[k] = clone(patch[k]);
  }
  if (Object.keys(L).length) st.live = L; else delete st.live;
  return { op: 'liveLayout', ...old };
}
function opLiveLayout(st, op) {
  const inv = setLive(st, op);
  return { inverse: [inv], changes: [{ k: 'layout', sheet: '(live)', what: 'live layout: ' + LIVE_KEYS.filter((k) => k in op).join(', ') }] };
}
/** panel: { id, title?, text?, value?, label?, image?, span?, h? } — a card the agent drops into Live on the fly (upsert). */
function opPanel(st, op) {
  if (!op.id) fail('panel needs id');
  const panels = clone(st.live?.panels || []);
  const i = panels.findIndex((p) => p.id === op.id);
  const p = { ...(i >= 0 ? panels[i] : {}), id: String(op.id) };
  for (const k of ['title', 'text', 'value', 'label', 'image', 'span', 'h', 'by']) if (k in op) { if (op[k] == null) delete p[k]; else p[k] = op[k]; }
  if (i >= 0) panels[i] = p; else panels.push(p);
  const inv = setLive(st, { panels });
  return { inverse: [inv], changes: [{ k: 'panel', action: i >= 0 ? 'update' : 'add', id: p.id, title: p.title || '' }] };
}
function opRemovePanel(st, op) {
  const panels = (st.live?.panels || []).filter((p) => p.id !== op.id);
  if (panels.length === (st.live?.panels || []).length) return { inverse: [], changes: [] };
  const inv = setLive(st, { panels: panels.length ? panels : null });
  return { inverse: [inv], changes: [{ k: 'panel', action: 'remove', id: op.id }] };
}

/**
 * slide: { id, title?, text?, sheet?, mode?: 'sheet'|'auto', focus?, cards?: [key…], bg?: { theme? | image?, filter?: 'none'|'dither'|'halftone' },
 *          duration?: seconds, index?: position }  — upsert. Slides turn Live into a presentation engine.
 */
const SLIDE_KEYS = ['title', 'text', 'sheet', 'mode', 'focus', 'cards', 'bg', 'duration', 'align'];
function opSlide(st, op) {
  if (!op.id) fail('slide needs id');
  const slides = clone(st.live?.slides || []);
  const i = slides.findIndex((x) => x.id === op.id);
  const sl = { ...(i >= 0 ? slides[i] : {}), id: String(op.id) };
  for (const k of SLIDE_KEYS) if (k in op) { if (op[k] == null) delete sl[k]; else sl[k] = clone(op[k]); }
  if (i >= 0) slides.splice(i, 1);
  const at = op.index != null ? Math.max(0, Math.min(slides.length, op.index)) : i >= 0 ? i : slides.length;
  slides.splice(at, 0, sl);
  const inv = setLive(st, { slides });
  return { inverse: [inv], changes: [{ k: 'panel', action: i >= 0 ? 'update slide' : 'add slide', id: sl.id, title: sl.title || '' }] };
}
function opRemoveSlide(st, op) {
  const slides = (st.live?.slides || []).filter((x) => x.id !== op.id);
  if (slides.length === (st.live?.slides || []).length) return { inverse: [], changes: [] };
  const inv = setLive(st, { slides: slides.length ? slides : null });
  return { inverse: [inv], changes: [{ k: 'panel', action: 'remove slide', id: op.id }] };
}

export function mergeAt(sh, c, r) {
  for (const m of sh.merges || []) { const R = parseRange(m); if (inRange(R, c, r)) return R; }
  return null;
}

/** merge: { range, type: all|horizontal|vertical } — keeps the top-left value of each merged block (like Sheets). */
function opMerge(st, op) {
  const { sh, R } = target(st, op.range, op.sheet);
  const type = op.type || 'all';
  const blocks = [];
  if (type === 'all') blocks.push(R);
  else if (type === 'horizontal') for (let r = R.r1; r <= R.r2; r++) blocks.push({ c1: R.c1, c2: R.c2, r1: r, r2: r });
  else if (type === 'vertical') for (let c = R.c1; c <= R.c2; c++) blocks.push({ c1: c, c2: c, r1: R.r1, r2: R.r2 });
  else fail(`Bad merge type "${type}"`);
  const good = blocks.filter((b) => b.c1 !== b.c2 || b.r1 !== b.r2);
  if (!good.length) fail('Select more than one cell to merge');
  if (good.some((b) => (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1) > 20000)) fail('Merge range too large');
  for (const x of tables(st)) if (x.sh === sh && intersects(x.R, R)) fail(`Cannot merge inside table "${x.t.name}"`);
  const inv = [preTables(st)];
  const restore = {}, cleared = [];
  for (const b of good) for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) {
    if (r === b.r1 && c === b.c1) continue;
    const A = addr(c, r);
    const cell = sh.cells[A];
    if (cell && cell.v !== '') { restore[A] = clone(cell); cleared.push(A); cell.v = ''; tidy(sh, A); }
  }
  if (cleared.length) inv.push({ op: 'putCells', sheet: sh.name, cells: restore });
  sh.merges = (sh.merges || []).filter((m) => !good.some((b) => intersects(parseRange(m), b)));
  sh.merges.push(...good.map(rangeToString));
  return {
    inverse: inv.reverse(),
    changes: [
      { k: 'merge', action: 'merge', sheet: sh.name, ranges: good.map(rangeToString) },
      ...cleared.map((A) => ({ k: 'set', sheet: sh.name, cell: A, old: restore[A].v, new: '' })),
    ],
  };
}
function opUnmerge(st, op) {
  const { sh, R } = target(st, op.range, op.sheet);
  const inv = preTables(st);
  const removed = (sh.merges || []).filter((m) => intersects(parseRange(m), R));
  if (!removed.length) return { inverse: [], changes: [] };
  sh.merges = sh.merges.filter((m) => !removed.includes(m));
  if (!sh.merges.length) delete sh.merges;
  return { inverse: [inv], changes: [{ k: 'merge', action: 'unmerge', sheet: sh.name, ranges: removed }] };
}

// ------------------------------------------------------------------ named tables
// A table is a named rectangle inside a sheet: first row = column headers, rest = records.
// Many tables per sheet. Ranges follow moves / row & column inserts like references do.

export function tables(st) {
  const out = [];
  for (const sh of st.sheets) for (const t of sh.tables || []) out.push({ sh, t, R: parseRange(t.range) });
  return out;
}
export function findTable(st, name) {
  const x = tables(st).find((x) => sameName(x.t.name, name));
  if (!x) fail(`No table "${name}". Tables: ${tables(st).map((x) => x.t.name).join(', ') || '(none)'}`);
  return x;
}
export function tableAt(st, sheetName, c, r) {
  const sh = st.sheets.find((s) => sameName(s.name, sheetName));
  for (const t of sh?.tables || []) { const R = parseRange(t.range); if (inRange(R, c, r)) return { sh, t, R }; }
  return null;
}
export function tableColumns(sh, R) {
  const cols = [];
  for (let c = R.c1; c <= R.c2; c++) cols.push(String(sh.cells[addr(c, R.r1)]?.v ?? '').trim() || colToName(c));
  return cols;
}
function colIndex(sh, R, name) {
  const cols = tableColumns(sh, R);
  let i = cols.findIndex((x) => sameName(x, name));
  if (i < 0 && /^[A-Za-z]{1,3}$/.test(name)) { const c = nameToCol(name); if (c >= R.c1 && c <= R.c2) i = c - R.c1; }
  if (i < 0) fail(`Table has no column "${name}". Columns: ${cols.join(', ')}`);
  return i;
}
function validTableName(st, name, except) {
  name = String(name || '').trim();
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || /^[A-Za-z]{1,3}\d+$/.test(name) || /^(true|false)$/i.test(name)) fail(`Bad table name "${name}" (letters, digits, _; no spaces)`);
  if (tables(st).some((x) => x.t !== except && sameName(x.t.name, name))) fail(`Table "${name}" exists`);
  return name;
}
const key = (sh, R, r) => String(sh.cells[addr(R.c1, r)]?.v ?? '').trim();

function opSetTables(st, op) {
  const inv = preTables(st);
  for (const [name, list] of Object.entries(op.tables || {})) {
    const sh = st.sheets.find((s) => sameName(s.name, name));
    if (!sh) continue;
    if (list) sh.tables = clone(list); else delete sh.tables;
  }
  for (const [name, list] of Object.entries(op.charts || {})) {
    const sh = st.sheets.find((s) => sameName(s.name, name));
    if (!sh) continue;
    if (list) sh.charts = clone(list); else delete sh.charts;
  }
  for (const [name, list] of Object.entries(op.merges || {})) {
    const sh = st.sheets.find((s) => sameName(s.name, name));
    if (!sh) continue;
    if (list) sh.merges = [...list]; else delete sh.merges;
  }
  return { inverse: [inv], changes: [] };
}

/** table: { name, range: "B4:E9" | "Sheet!B4:E9", sheet? } — create or redefine */
function opTable(st, op) {
  const { sh, R } = target(st, op.range, op.sheet);
  const existing = tables(st).find((x) => sameName(x.t.name, op.name));
  const name = validTableName(st, op.name, existing?.t);
  for (const x of tables(st)) if (x.t !== existing?.t && x.sh === sh && intersects(x.R, R)) fail(`Overlaps table "${x.t.name}"`);
  for (const m of sh.merges || []) if (intersects(parseRange(m), R)) fail(`Unmerge ${m} before making a table there`);
  const inv = preTables(st);
  const def = { name, range: rangeToString(R) };
  if (existing && existing.sh === sh) sh.tables[sh.tables.indexOf(existing.t)] = def;
  else {
    if (existing) existing.sh.tables.splice(existing.sh.tables.indexOf(existing.t), 1);
    (sh.tables ||= []).push(def);
  }
  const cols = tableColumns(sh, R);
  return {
    inverse: [inv],
    changes: [{ k: 'table', action: existing ? 'resize' : 'create', name, sheet: sh.name, range: rangeToString(R), columns: cols }],
  };
}
function opDeleteTable(st, op) {
  const x = findTable(st, op.name);
  const inv = preTables(st);
  x.sh.tables.splice(x.sh.tables.indexOf(x.t), 1);
  return { inverse: [inv], changes: [{ k: 'table', action: 'delete', name: x.t.name, sheet: x.sh.name, range: x.t.range }] };
}
function opRenameTable(st, op) {
  const x = findTable(st, op.name);
  const old = x.t.name;
  x.t.name = validTableName(st, op.newName, x.t);
  for (const sh of st.sheets) for (const cell of Object.values(sh.cells)) if (isFormula(cell.v)) cell.v = renameTableRefs(cell.v, old, x.t.name);
  for (const { ch } of allCharts(st)) if (ch.table && sameName(ch.table, old)) ch.table = x.t.name;
  return { inverse: [{ op: 'renameTable', name: x.t.name, newName: old }], changes: [{ k: 'table', action: 'rename', name: old, to: x.t.name, sheet: x.sh.name }] };
}

/** Merge several apply() results run in sequence. */
function chain(st, ops) {
  const inverse = [], changes = [];
  for (const o of ops) {
    const r = apply(st, typeof o === 'function' ? o() : o);
    inverse.unshift(...r.inverse);
    changes.push(...r.changes);
  }
  return { inverse, changes };
}
function rowValues(sh, R, row) {
  const cols = tableColumns(sh, R);
  if (Array.isArray(row)) return row.slice(0, cols.length);
  const out = new Array(cols.length).fill(undefined);
  for (const [k, v] of Object.entries(row)) out[colIndex(sh, R, k)] = v;
  return out;
}

/** appendRows: { table, rows: [ {Col: v, ...} | [v1, v2, ...] ] } — adds records below, expanding the table. */
function opAppendRows(st, op) {
  const x = findTable(st, op.table);
  const rows = op.rows || (op.row ? [op.row] : []);
  if (!rows.length) fail('appendRows needs rows');
  const n = rows.length, sheet = x.sh.name, name = x.t.name;
  let blocked = false;
  for (let r = x.R.r2 + 1; r <= x.R.r2 + n; r++) for (let c = x.R.c1; c <= x.R.c2; c++) if (x.sh.cells[addr(c, r)]?.v) blocked = true;
  const R0 = x.R;
  const steps = [];
  if (blocked) steps.push({ op: 'insertRows', sheet, at: R0.r2 + 2, count: n });
  steps.push(() => {
    const cells = {};
    rows.forEach((row, i) => rowValues(x.sh, R0, row).forEach((v, j) => { if (v !== undefined) cells[addr(R0.c1 + j, R0.r2 + 1 + i)] = v; }));
    return { op: 'set', sheet, cells };
  });
  steps.push(() => ({ op: 'table', name, range: `${quoteSheet(sheet)}!${rangeToString({ ...R0, r2: R0.r2 + n })}` }));
  return chain(st, steps);
}

function matchRows(sh, R, op) {
  const out = [];
  if (op.rows) { for (const i of [].concat(op.rows)) { const r = R.r1 + (+i); if (r > R.r1 && r <= R.r2) out.push(r); } return out; }
  if (op.key != null) { for (let r = R.r1 + 1; r <= R.r2; r++) if (sameName(key(sh, R, r), String(op.key).trim())) out.push(r); return out; }
  const m = Object.entries(op.match || op.where || {}).map(([k, v]) => [colIndex(sh, R, k), v]);
  if (!m.length) fail('Specify rows (1-based record numbers), key (first column value) or match {Column: value}');
  for (let r = R.r1 + 1; r <= R.r2; r++) {
    if (m.every(([i, v]) => {
      const raw = String(sh.cells[addr(R.c1 + i, r)]?.v ?? '').trim();
      const lv = literal(raw), want = typeof v === 'string' ? literal(v.trim()) : v;
      return typeof lv === 'string' || typeof want === 'string' ? sameName(String(lv ?? ''), String(want ?? '')) : lv === want;
    })) out.push(r);
  }
  return out;
}

/** updateRows: { table, key: "Servot" | match: {Col: v} | rows: [1,3], set: {Col: newValue} } */
function opUpdateRows(st, op) {
  const x = findTable(st, op.table);
  const rows = matchRows(x.sh, x.R, op);
  if (!rows.length) fail(`No matching rows in ${x.t.name}`);
  const cells = {};
  for (const r of rows) for (const [k, v] of Object.entries(op.set || {})) cells[addr(x.R.c1 + colIndex(x.sh, x.R, k), r)] = v;
  return apply(st, { op: 'set', sheet: x.sh.name, cells });
}

/** removeRows: { table, key | match | rows } — removes records, table-local (cells beside the table stay). */
function opRemoveRows(st, op) {
  const x = findTable(st, op.table);
  const rows = matchRows(x.sh, x.R, op).sort((a, b) => b - a);
  if (!rows.length) fail(`No matching rows in ${x.t.name}`);
  const sheet = x.sh.name, name = x.t.name, R0 = { ...x.R };
  const steps = [];
  let bottom = R0.r2;
  for (const r of rows) {
    if (r < bottom) steps.push({ op: 'move', sheet, from: rangeToString({ c1: R0.c1, c2: R0.c2, r1: r + 1, r2: bottom }), to: addr(R0.c1, r) });
    else {
      const cells = {};
      for (let c = R0.c1; c <= R0.c2; c++) cells[addr(c, r)] = null;
      steps.push({ op: 'set', sheet, cells });
    }
    bottom--;
  }
  steps.push({ op: 'table', name, range: `${quoteSheet(sheet)}!${rangeToString({ ...R0, r2: Math.max(R0.r1, bottom) })}` });
  return chain(st, steps);
}

/** addColumn: { table, name, values?: [..] } — new column at the right edge. */
function opAddColumn(st, op) {
  const x = findTable(st, op.table);
  const sheet = x.sh.name, name = x.t.name, R0 = { ...x.R }, c = R0.c2 + 1;
  let blocked = false;
  for (let r = R0.r1; r <= R0.r2; r++) if (x.sh.cells[addr(c, r)]?.v) blocked = true;
  const steps = [];
  if (blocked) steps.push({ op: 'insertCols', sheet, at: colToName(c), count: 1 });
  const cells = { [addr(c, R0.r1)]: op.name };
  (op.values || []).forEach((v, i) => { if (R0.r1 + 1 + i <= R0.r2) cells[addr(c, R0.r1 + 1 + i)] = v; });
  steps.push({ op: 'set', sheet, cells });
  const hs = x.sh.cells[addr(R0.c2, R0.r1)]?.s;
  if (hs) steps.push({ op: 'cellStyles', sheet, styles: { [addr(c, R0.r1)]: hs } });
  steps.push({ op: 'table', name, range: `${quoteSheet(sheet)}!${rangeToString({ ...R0, c2: c })}` });
  return chain(st, steps);
}

/** Human/agent label for a cell inside a table: Tasks[Wire the servos].Status */
export function tableLabel(st, sheetName, A) {
  const p = parseAddr(A);
  const x = p && tableAt(st, sheetName, p.c, p.r);
  if (!x) return null;
  const col = tableColumns(x.sh, x.R)[p.c - x.R.c1];
  if (p.r === x.R.r1) return `${x.t.name} header`;
  const k = key(x.sh, x.R, p.r);
  return `${x.t.name}[${k || '#' + (p.r - x.R.r1)}].${col}`;
}

/** Records view of a table for agents. */
export function readTable(st, name, { limit = 400 } = {}) {
  const x = findTable(st, name);
  const en = new Engine(st);
  const cols = tableColumns(x.sh, x.R);
  const rows = [];
  let truncated = false;
  for (let r = x.R.r1 + 1; r <= x.R.r2; r++) {
    if (rows.length >= limit) { truncated = true; break; }
    const values = [];
    for (let c = x.R.c1; c <= x.R.c2; c++) {
      const cell = x.sh.cells[addr(c, r)];
      const raw = cell?.v ?? '';
      const o = { raw };
      if (isFormula(raw)) o.value = fmtValue(en.value(x.sh, c, r));
      if (cell?.n) o.note = cell.n;
      values.push(o);
    }
    rows.push({ r: r + 1, values });
  }
  return { table: x.t.name, sheet: x.sh.name, range: x.t.range, columns: cols, rows, truncated };
}

// ------------------------------------------------------------------ diff / recalc / read
/** Cell-value diff between two workbook states (by sheet name + address). */
export function diff(a, b) {
  const out = [];
  const names = new Set([...a.sheets.map((s) => s.name), ...b.sheets.map((s) => s.name)]);
  for (const n of names) {
    const sa = a.sheets.find((s) => s.name === n), sb = b.sheets.find((s) => s.name === n);
    if (!sa) { out.push({ k: 'sheet', action: 'add', name: n }); }
    if (!sb) { out.push({ k: 'sheet', action: 'delete', name: n }); continue; }
    const ca = sa ? sa.cells : {}, cb = sb.cells;
    const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
    for (const A of keys) {
      const o = ca[A]?.v ?? '', w = cb[A]?.v ?? '';
      if (o !== w) out.push({ k: 'set', sheet: n, cell: A, old: o, new: w });
    }
  }
  return out;
}

export function recalc(st) { return computeAll(st); }

export function describe(st) {
  return st.sheets.map((s) => {
    const u = usedRange(s);
    const n = Object.keys(s.cells).length;
    const f = Object.values(s.cells).filter((c) => typeof c.v === 'string' && c.v[0] === '=').length;
    return {
      name: s.name, used: u ? rangeToString(u) : null, cells: n, formulas: f, freeze: s.freeze,
      merges: s.merges || [],
      charts: (s.charts || []).map((c) => ({ id: c.id, type: c.type, title: c.title, source: c.table ? '@' + c.table : c.range || c.value, at: c.at })),
      tables: (s.tables || []).map((t) => { const R = parseRange(t.range); return { name: t.name, range: t.range, rows: R.r2 - R.r1, columns: tableColumns(s, R) }; }),
    };
  });
}

/** Read a range for agents. Returns rows of {a, raw, value, note?}. Empty cells skipped. */
export function read(st, rangeStr, { limit = 400 } = {}) {
  const tn = String(rangeStr || '').replace(/^@/, '');
  if (tn && !tn.includes('!') && tables(st).some((x) => sameName(x.t.name, tn))) return readTable(st, tn, { limit });
  const [sn, rs] = splitSheet(rangeStr || '');
  const sh = findSheet(st, sn ?? (rs && !/\d|:/.test(rs) ? rs : null));
  let R = rs && /\d|:/.test(rs) ? parseRange(rs) : usedRange(sh);
  if (!R) return { sheet: sh.name, range: null, cells: [], truncated: false };
  const ext = usedExtent(sh);
  R = norm({ ...R, r2: Math.min(R.r2, Math.max(ext.r, R.r1)), c2: Math.min(R.c2, Math.max(ext.c, R.c1)) });
  const en = new Engine(st);
  const cells = [];
  let truncated = false;
  const keys = Object.keys(sh.cells).map((A) => [A, parseAddr(A)]).filter(([, p]) => inRange(R, p.c, p.r))
    .sort((x, y) => x[1].r - y[1].r || x[1].c - y[1].c);
  for (const [A, p] of keys) {
    const cell = sh.cells[A];
    if ((cell.v === '' || cell.v == null) && !cell.n) continue;
    if (cells.length >= limit) { truncated = true; break; }
    const isF = typeof cell.v === 'string' && cell.v[0] === '=';
    const o = { a: A, r: p.r + 1, raw: cell.v ?? '' };
    const M = mergeAt(sh, p.c, p.r);
    if (M) o.merged = rangeToString(M);
    if (isF) o.value = fmtValue(en.value(sh, p.c, p.r));
    if (cell.n) o.note = cell.n;
    cells.push(o);
  }
  return { sheet: sh.name, range: rangeToString(R), cells, truncated };
}

/** Find cells whose raw or value contains q (case-insensitive). */
export function find(st, q, limit = 100) {
  q = String(q).toLowerCase();
  const en = new Engine(st);
  const out = [];
  for (const sh of st.sheets) for (const [A, cell] of Object.entries(sh.cells)) {
    const p = parseAddr(A);
    const raw = String(cell.v ?? '');
    const val = raw[0] === '=' ? fmtValue(en.value(sh, p.c, p.r)) : raw;
    if (raw.toLowerCase().includes(q) || val.toLowerCase().includes(q) || (cell.n || '').toLowerCase().includes(q)) {
      out.push({ at: `${sh.name}!${A}`, raw, value: val });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
