// Lazy, memoized workbook evaluator. Shared by server (change tracking) and browser (rendering).
import { addr, parseAddr, sameName } from './a1.js';
import { parse, literal, FErr, isErr, E } from './formula.js';
import { Viz } from './viz.js';
export { Viz, isViz } from './viz.js';

const err = (c) => new FErr(c);
const isRange = (v) => v && v.__range;

/** Value produced by =IMAGE(url): renders as a picture in the cell. */
export class Img {
  constructor(url, mode) { this.url = url; this.mode = mode || 1; }
  toString() { return this.url; }
}
export const isImg = (v) => v instanceof Img;

export function fmtValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Img) return `[image ${v.url}]`;
  if (v instanceof Viz) return fmtValue(v.value);
  if (isErr(v)) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '#NUM!';
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    return String(parseFloat(v.toPrecision(12)));
  }
  return String(v);
}

function num(v) {
  if (isErr(v)) throw v;
  if (v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const t = String(v).trim().replace(',', '.');
  if (t !== '' && !isNaN(+t)) return +t;
  throw err(E.VALUE);
}
function str(v) {
  if (isErr(v)) throw v;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return fmtValue(v);
  return String(v);
}
function bool(v) {
  if (isErr(v)) throw v;
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  const u = String(v).toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE' || u === '') return false;
  throw err(E.VALUE);
}
function cmp(a, b) {
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const rank = (x) => (typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === 'string') { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a < b ? -1 : a > b ? 1 : 0;
}

function criteria(c) {
  if (typeof c === 'number' || typeof c === 'boolean') return (v) => v === c || (typeof v === 'string' && cmp(literal(v), c) === 0);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(str(c));
  const op = m[1] || '=';
  const rhsLit = literal(m[2]);
  const rhs = rhsLit === null ? '' : rhsLit;
  let re = null;
  if (typeof rhs === 'string' && /[*?]/.test(rhs)) {
    re = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  }
  return (v) => {
    if (isErr(v)) return false;
    if (re && (op === '=' || op === '<>')) { const r = re.test(str(v)); return op === '=' ? r : !r; }
    if (rhs === '' && op === '=') return v === null || v === '';
    if (rhs === '' && op === '<>') return !(v === null || v === '');
    if (typeof rhs === 'number' && typeof v !== 'number') return op === '<>';
    const d = cmp(v, rhs);
    return { '=': d === 0, '<>': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[op];
  };
}

export class Engine {
  constructor(wb) { this.wb = wb; this.memo = new Map(); this.busy = new Set(); this.asts = new Map(); this.ext = new Map(); }
  invalidate() { this.memo.clear(); this.ext.clear(); }

  sheet(name) { return this.wb.sheets.find((s) => sameName(s.name, name)); }

  extent(sh) {
    let e = this.ext.get(sh);
    if (!e) {
      e = { r: -1, c: -1 };
      for (const a in sh.cells) { const p = parseAddr(a); if (p.r > e.r) e.r = p.r; if (p.c > e.c) e.c = p.c; }
      this.ext.set(sh, e);
    }
    return e;
  }

  compile(src) {
    let a = this.asts.get(src);
    if (!a) {
      try { a = parse(src.slice(1)); } catch (e) { a = { k: 'err', v: E.PARSE }; }
      if (this.asts.size > 20000) this.asts.clear();
      this.asts.set(src, a);
    }
    return a;
  }

  /** Value of a cell (number|string|boolean|null|FErr). */
  value(sheetName, c, r) {
    const sh = typeof sheetName === 'string' ? this.sheet(sheetName) : sheetName;
    if (!sh) return err(E.REF);
    const cell = sh.cells[addr(c, r)];
    if (!cell || cell.v === '' || cell.v == null) return null;
    if (cell.v[0] !== '=') return literal(cell.v);
    const key = sh.name + '!' + c + ',' + r;
    if (this.memo.has(key)) return this.memo.get(key);
    if (this.busy.has(key)) return err(E.CYCLE);
    this.busy.add(key);
    let v;
    try {
      v = this.ev(this.compile(cell.v), sh);
      if (isRange(v)) v = this.scalar(v);
      if (typeof v === 'number' && !isFinite(v)) v = err(E.NUM);
    } catch (e) {
      v = isErr(e) ? e : err(E.PARSE);
    } finally {
      this.busy.delete(key);
    }
    this.memo.set(key, v);
    return v;
  }

  scalar(v) {
    if (!isRange(v)) return v;
    return this.value(v.sh, v.c1, v.r1);
  }

  /** Range -> 2D array of values, clamped to used extent. */
  grid(rg) {
    const e = this.extent(rg.sh);
    const r2 = Math.min(rg.r2, Math.max(e.r, rg.r1)), c2 = Math.min(rg.c2, Math.max(e.c, rg.c1));
    const out = [];
    for (let r = rg.r1; r <= r2; r++) {
      const row = [];
      for (let c = rg.c1; c <= c2; c++) row.push(this.value(rg.sh, c, r));
      out.push(row);
    }
    return out;
  }
  flat(rg) { return this.grid(rg).flat(); }

  ev(n, sh) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': return err(n.v);
      case 'name': return err(E.NAME);
      case 'empty': return null;
      case 'ref': {
        const target = n.ref.sheet != null ? this.sheet(n.ref.sheet) : sh;
        if (!target) return err(E.REF);
        if (!n.ref.b) return this.value(target, n.ref.a.c, n.ref.a.r);
        const a = n.ref.a, b = n.ref.b;
        return {
          __range: true, sh: target,
          c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r),
        };
      }
      case 'tref': {
        // Table[Column] -> data cells of that column; Table[] / Table[#All] -> whole data body
        for (const s2 of this.wb.sheets) for (const t of s2.tables || []) {
          if (t.name.toLowerCase() !== n.table.toLowerCase()) continue;
          const m = /^([A-Za-z]{1,3})(\d+):([A-Za-z]{1,3})(\d+)$/.exec(t.range) || /^([A-Za-z]{1,3})(\d+)$/.exec(t.range);
          const a = parseAddr(m[1] + m[2]), b = m[3] ? parseAddr(m[3] + m[4]) : a;
          if (!n.col || n.col.toLowerCase() === '#all' || n.col.toLowerCase() === '#data') {
            return { __range: true, sh: s2, c1: a.c, r1: a.r + (n.col.toLowerCase() === '#all' ? 0 : 1), c2: b.c, r2: Math.max(b.r, a.r + 1) };
          }
          for (let c = a.c; c <= b.c; c++) {
            const h = String(s2.cells[addr(c, a.r)]?.v ?? '').trim();
            if (h.toLowerCase() === n.col.toLowerCase()) return { __range: true, sh: s2, c1: c, r1: a.r + 1, c2: c, r2: Math.max(b.r, a.r + 1) };
          }
          return err(E.REF);
        }
        return err(E.REF);
      }
      case 'neg': return -num(this.scalar(this.ev(n.e, sh)));
      case 'pos': return this.scalar(this.ev(n.e, sh));
      case 'pct': return num(this.scalar(this.ev(n.e, sh))) / 100;
      case 'bin': {
        const l = this.scalar(this.ev(n.l, sh));
        const r = this.scalar(this.ev(n.r, sh));
        if (isErr(l)) return l;
        if (isErr(r)) return r;
        switch (n.op) {
          case '+': return num(l) + num(r);
          case '-': return num(l) - num(r);
          case '*': return num(l) * num(r);
          case '/': { const d = num(r); if (d === 0) return err(E.DIV0); return num(l) / d; }
          case '^': return Math.pow(num(l), num(r));
          case '&': return str(l) + str(r);
          case '=': return cmp(l, r) === 0;
          case '<>': return cmp(l, r) !== 0;
          case '<': return cmp(l, r) < 0;
          case '>': return cmp(l, r) > 0;
          case '<=': return cmp(l, r) <= 0;
          case '>=': return cmp(l, r) >= 0;
        }
        return err(E.PARSE);
      }
      case 'call': {
        const f = FN[n.name];
        if (!f) return err(E.NAME);
        try {
          return f(this, n.args, sh);
        } catch (e) {
          if (isErr(e)) return e;
          throw e;
        }
      }
    }
    return err(E.PARSE);
  }

  // helpers for functions
  arg(a, sh) { return this.scalar(this.ev(a, sh)); }
  /** Numbers from args. Ranges: only numeric cells. Direct args: coerced. Errors propagate. */
  nums(args, sh) {
    const out = [];
    for (const a of args) {
      const v = this.ev(a, sh);
      if (isRange(v)) {
        for (const x of this.flat(v)) { if (isErr(x)) throw x; if (typeof x === 'number') out.push(x); }
      } else if (v !== null) out.push(num(v));
    }
    return out;
  }
  vals(args, sh) {
    const out = [];
    for (const a of args) {
      const v = this.ev(a, sh);
      if (isRange(v)) out.push(...this.flat(v)); else out.push(v);
    }
    return out;
  }
  rangeArg(a, sh) {
    const v = this.ev(a, sh);
    if (isRange(v)) return v;
    throw err(E.VALUE);
  }
}

const need = (args, min, max = min) => { if (args.length < min || args.length > max) throw err(E.NA); };
const round = (x, d, mode) => {
  const f = Math.pow(10, d);
  const v = x * f;
  const r = mode === 'up' ? Math.sign(v) * Math.ceil(Math.abs(v) - 1e-9)
    : mode === 'down' ? Math.trunc(v + Math.sign(v) * 1e-9)
      : Math.sign(v) * Math.round(Math.abs(v) + 1e-9);
  return r / f;
};

function ifAgg(en, args, sh, kind) {
  need(args, 2, 3);
  const rg = en.rangeArg(args[0], sh);
  const test = criteria(en.arg(args[1], sh));
  const crit = en.grid(rg);
  const sumRg = args[2] ? en.rangeArg(args[2], sh) : rg;
  let n = 0, s = 0;
  crit.forEach((row, i) => row.forEach((v, j) => {
    if (!test(v)) return;
    n++;
    const x = en.value(sumRg.sh, sumRg.c1 + j, sumRg.r1 + i);
    if (typeof x === 'number') s += x;
  }));
  if (kind === 'count') return n;
  if (kind === 'sum') return s;
  return n ? s / n : err(E.DIV0);
}

export const FN = {
  SUM: (en, a, sh) => en.nums(a, sh).reduce((x, y) => x + y, 0),
  AVERAGE: (en, a, sh) => { const n = en.nums(a, sh); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : err(E.DIV0); },
  MIN: (en, a, sh) => { const n = en.nums(a, sh); return n.length ? Math.min(...n) : 0; },
  MAX: (en, a, sh) => { const n = en.nums(a, sh); return n.length ? Math.max(...n) : 0; },
  COUNT: (en, a, sh) => en.vals(a, sh).filter((v) => typeof v === 'number').length,
  COUNTA: (en, a, sh) => en.vals(a, sh).filter((v) => v !== null && v !== '').length,
  COUNTBLANK: (en, a, sh) => en.vals(a, sh).filter((v) => v === null || v === '').length,
  PRODUCT: (en, a, sh) => en.nums(a, sh).reduce((x, y) => x * y, 1),
  SUMIF: (en, a, sh) => ifAgg(en, a, sh, 'sum'),
  COUNTIF: (en, a, sh) => ifAgg(en, a, sh, 'count'),
  AVERAGEIF: (en, a, sh) => ifAgg(en, a, sh, 'avg'),
  IF: (en, a, sh) => { need(a, 2, 3); return bool(en.arg(a[0], sh)) ? en.arg(a[1], sh) : a[2] ? en.arg(a[2], sh) : false; },
  IFS: (en, a, sh) => { for (let i = 0; i + 1 < a.length; i += 2) if (bool(en.arg(a[i], sh))) return en.arg(a[i + 1], sh); return err(E.NA); },
  IFERROR: (en, a, sh) => {
    need(a, 1, 2);
    let v;
    try { v = en.arg(a[0], sh); } catch (e) { if (!isErr(e)) throw e; v = e; }
    return isErr(v) ? (a[1] ? en.arg(a[1], sh) : '') : v;
  },
  AND: (en, a, sh) => en.vals(a, sh).filter((v) => v !== null).every((v) => bool(v)),
  OR: (en, a, sh) => en.vals(a, sh).filter((v) => v !== null).some((v) => bool(v)),
  NOT: (en, a, sh) => { need(a, 1); return !bool(en.arg(a[0], sh)); },
  XOR: (en, a, sh) => en.vals(a, sh).filter((v) => v !== null && bool(v)).length % 2 === 1,
  ISBLANK: (en, a, sh) => { need(a, 1); const v = en.arg(a[0], sh); return v === null; },
  ISNUMBER: (en, a, sh) => typeof en.arg(a[0], sh) === 'number',
  ISTEXT: (en, a, sh) => typeof en.arg(a[0], sh) === 'string',
  ISERROR: (en, a, sh) => { try { return isErr(en.arg(a[0], sh)); } catch (e) { if (isErr(e)) return true; throw e; } },
  ROUND: (en, a, sh) => { need(a, 1, 2); return round(num(en.arg(a[0], sh)), a[1] ? num(en.arg(a[1], sh)) : 0); },
  ROUNDUP: (en, a, sh) => { need(a, 1, 2); return round(num(en.arg(a[0], sh)), a[1] ? num(en.arg(a[1], sh)) : 0, 'up'); },
  ROUNDDOWN: (en, a, sh) => { need(a, 1, 2); return round(num(en.arg(a[0], sh)), a[1] ? num(en.arg(a[1], sh)) : 0, 'down'); },
  INT: (en, a, sh) => Math.floor(num(en.arg(a[0], sh))),
  ABS: (en, a, sh) => Math.abs(num(en.arg(a[0], sh))),
  SQRT: (en, a, sh) => { const x = num(en.arg(a[0], sh)); return x < 0 ? err(E.NUM) : Math.sqrt(x); },
  POWER: (en, a, sh) => Math.pow(num(en.arg(a[0], sh)), num(en.arg(a[1], sh))),
  MOD: (en, a, sh) => { const x = num(en.arg(a[0], sh)), d = num(en.arg(a[1], sh)); if (d === 0) return err(E.DIV0); return x - d * Math.floor(x / d); },
  LEN: (en, a, sh) => str(en.arg(a[0], sh)).length,
  UPPER: (en, a, sh) => str(en.arg(a[0], sh)).toUpperCase(),
  LOWER: (en, a, sh) => str(en.arg(a[0], sh)).toLowerCase(),
  TRIM: (en, a, sh) => str(en.arg(a[0], sh)).trim().replace(/\s+/g, ' '),
  LEFT: (en, a, sh) => str(en.arg(a[0], sh)).slice(0, a[1] ? num(en.arg(a[1], sh)) : 1),
  RIGHT: (en, a, sh) => { const s = str(en.arg(a[0], sh)); const n = a[1] ? num(en.arg(a[1], sh)) : 1; return n ? s.slice(-n) : ''; },
  MID: (en, a, sh) => { const s = str(en.arg(a[0], sh)); const st = num(en.arg(a[1], sh)) - 1; return s.slice(st, st + num(en.arg(a[2], sh))); },
  EXACT: (en, a, sh) => str(en.arg(a[0], sh)) === str(en.arg(a[1], sh)),
  CONCAT: (en, a, sh) => en.vals(a, sh).map(str).join(''),
  CONCATENATE: (en, a, sh) => en.vals(a, sh).map(str).join(''),
  TEXTJOIN: (en, a, sh) => {
    const d = str(en.arg(a[0], sh)), skip = bool(en.arg(a[1], sh));
    return en.vals(a.slice(2), sh).filter((v) => !(skip && (v === null || v === ''))).map(str).join(d);
  },
  VLOOKUP: (en, a, sh) => {
    need(a, 3, 4);
    const key = en.arg(a[0], sh), rg = en.rangeArg(a[1], sh), idx = num(en.arg(a[2], sh));
    const sorted = a[3] ? bool(en.arg(a[3], sh)) : true;
    if (idx < 1 || idx > rg.c2 - rg.c1 + 1) return err(E.REF);
    const g = en.grid(rg);
    let hit = -1;
    for (let i = 0; i < g.length; i++) {
      const d = cmp(g[i][0], key);
      if (!sorted) { if (d === 0) { hit = i; break; } } else if (d <= 0) hit = i; else break;
    }
    if (hit < 0) return err(E.NA);
    return en.value(rg.sh, rg.c1 + idx - 1, rg.r1 + hit);
  },
  MATCH: (en, a, sh) => {
    need(a, 2, 3);
    const key = en.arg(a[0], sh), list = en.flat(en.rangeArg(a[1], sh));
    const type = a[2] ? num(en.arg(a[2], sh)) : 1;
    if (type === 0) { const i = list.findIndex((v) => cmp(v, key) === 0); return i < 0 ? err(E.NA) : i + 1; }
    let hit = -1;
    for (let i = 0; i < list.length; i++) { const d = cmp(list[i], key); if (type > 0 ? d <= 0 : d >= 0) hit = i; else break; }
    return hit < 0 ? err(E.NA) : hit + 1;
  },
  INDEX: (en, a, sh) => {
    need(a, 2, 3);
    const rg = en.rangeArg(a[0], sh);
    let r = num(en.arg(a[1], sh)), c = a[2] ? num(en.arg(a[2], sh)) : 1;
    if (rg.r1 === rg.r2 && !a[2]) { c = r; r = 1; }
    if (r < 1 || c < 1 || r > rg.r2 - rg.r1 + 1 || c > rg.c2 - rg.c1 + 1) return err(E.REF);
    return en.value(rg.sh, rg.c1 + c - 1, rg.r1 + r - 1);
  },
  ROWS: (en, a, sh) => { const rg = en.rangeArg(a[0], sh); return rg.r2 - rg.r1 + 1; },
  COLUMNS: (en, a, sh) => { const rg = en.rangeArg(a[0], sh); return rg.c2 - rg.c1 + 1; },
  NA: () => err(E.NA),
  PI: () => Math.PI,
  IMAGE: (en, a, sh) => { need(a, 1, 2); const u = str(en.arg(a[0], sh)).trim(); if (!u) return err(E.VALUE); return new Img(u, a[1] ? num(en.arg(a[1], sh)) : 1); },
  VIZ: (en, a, sh) => {
    need(a, 2, 3);
    const p = str(en.arg(a[0], sh)).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(p)) return err(E.VALUE);
    const v = en.arg(a[1], sh);
    if (isErr(v)) return v;
    return new Viz(p, v, a[2] ? str(en.arg(a[2], sh)) : null);
  },
  HYPERLINK: (en, a, sh) => (a[1] ? en.arg(a[1], sh) : en.arg(a[0], sh)),
};

/** Evaluate all formula cells -> Map("Sheet!A1" -> display string). */
export function computeAll(wb) {
  const en = new Engine(wb);
  const out = new Map();
  for (const sh of wb.sheets) {
    for (const a in sh.cells) {
      const v = sh.cells[a].v;
      if (typeof v === 'string' && v[0] === '=') {
        const p = parseAddr(a);
        out.set(sh.name + '!' + a, fmtValue(en.value(sh, p.c, p.r)));
      }
    }
  }
  return out;
}
