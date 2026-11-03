// Conditional formatting ("traffic lights"). Pure; shared by grid, Live, server.
// sheet.conds = [{ id, range, rules: [{ when, value?, value2?, light?, style? }] }]
//   when: < <= > >= = <> between contains empty notEmpty any
//   value/value2: number, text, or "=formula" (evaluated in the sheet, e.g. "=Settings!B1")
//   light: green | amber | red | blue | gray   (or style: { fill, color, b })
// First cond (in list order) whose range contains the cell and has a matching rule wins.
import { parseRange, inRange } from './a1.js';
import { isErr } from './formula.js';

export const LIGHTS = {
  green: { fill: '#ceead6', color: '#0d652d', dot: '#34a853' },
  amber: { fill: '#feefc3', color: '#7a4f01', dot: '#f9ab00' },
  red: { fill: '#fad2cf', color: '#a50e0e', dot: '#ea4335' },
  blue: { fill: '#d2e3fc', color: '#174ea6', dot: '#4285f4' },
  gray: { fill: '#e8eaed', color: '#3c4043', dot: '#9aa0a6' },
};
LIGHTS.yellow = LIGHTS.amber;
export const WHEN = ['<', '<=', '>', '>=', '=', '<>', 'between', 'contains', 'empty', 'notEmpty', 'any'];

const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : v != null && v !== '' && !isNaN(+v) ? +v : null);

function operand(en, sh, x) {
  if (typeof x === 'string' && x[0] === '=') {
    try { return en.scalar(en.ev(en.compile(x), sh)); } catch { return null; }
  }
  return x;
}

export function matches(en, sh, rule, v) {
  const empty = v == null || v === '';
  switch (rule.when) {
    case 'any': return true;
    case 'empty': return empty;
    case 'notEmpty': return !empty;
  }
  if (empty || isErr(v)) return false;
  const a = operand(en, sh, rule.value);
  if (rule.when === 'contains') return String(v).toLowerCase().includes(String(a ?? '').toLowerCase());
  const nv = num(v), na = num(a);
  if (rule.when === 'between') {
    const nb = num(operand(en, sh, rule.value2));
    if (nv == null || na == null || nb == null) return false;
    return nv >= Math.min(na, nb) && nv <= Math.max(na, nb);
  }
  if (nv != null && na != null) {
    switch (rule.when) {
      case '<': return nv < na; case '<=': return nv <= na; case '>': return nv > na; case '>=': return nv >= na;
      case '=': return nv === na; case '<>': return nv !== na;
    }
  }
  if (na != null && nv == null && rule.when !== '=' && rule.when !== '<>') return false;   // "> 100" never lights text
  const sv = String(v).toLowerCase(), sa = String(a ?? '').toLowerCase();
  switch (rule.when) {
    case '=': return sv === sa; case '<>': return sv !== sa;
    case '<': return sv < sa; case '<=': return sv <= sa; case '>': return sv > sa; case '>=': return sv >= sa;
  }
  return false;
}

/** Resolved style for a rule: { fill, color, b, dot, light } */
export function ruleStyle(rule) {
  const L = LIGHTS[rule.light];
  return { ...(L ? { fill: L.fill, color: L.color, dot: L.dot, light: rule.light === 'yellow' ? 'amber' : rule.light } : {}), ...(rule.style || {}) };
}

/** Style override for a cell, or null. v = the cell's computed value. */
export function condStyle(en, sh, c, r, v) {
  if (!sh.conds?.length) return null;
  for (const cd of sh.conds) {
    const R = parseRange(cd.range);
    if (!R || !inRange(R, c, r)) continue;
    for (const rule of cd.rules || []) if (matches(en, sh, rule, v)) return ruleStyle(rule);
  }
  return null;
}

/** Parse CLI shorthand: "<100:green" ">=200:red" "between 100 200:amber" "=done:green" "contains late:red" "empty:gray" */
export function parseRule(s) {
  const i = s.lastIndexOf(':');
  if (i < 0) throw new Error(`Rule "${s}" needs ":color"`);
  const cond = s.slice(0, i).trim(), light = s.slice(i + 1).trim();
  const style = light.startsWith('#') ? { fill: light } : null;
  if (!style && !LIGHTS[light]) throw new Error(`Unknown color "${light}" (green amber red blue gray, or #hex)`);
  const out = style ? { style } : { light };
  let m;
  if ((m = /^between\s+(\S+)\s+(\S+)$/i.exec(cond))) return { when: 'between', value: lit(m[1]), value2: lit(m[2]), ...out };
  if ((m = /^contains\s+(.+)$/i.exec(cond))) return { when: 'contains', value: m[1], ...out };
  const k = cond.toLowerCase();
  if (k === 'empty' || k === 'notempty' || k === 'any') return { when: k === 'notempty' ? 'notEmpty' : k, ...out };
  if ((m = /^(<=|>=|<>|<|>|=)\s*(.+)$/.exec(cond))) return { when: m[1], value: lit(m[2]), ...out };
  throw new Error(`Can't read rule "${s}"`);
}
const lit = (x) => (x[0] === '=' ? x : !isNaN(+x) && x.trim() !== '' ? +x : x);

export function describeRule(r) {
  const what = r.light || (r.style?.fill ?? 'style');
  if (r.when === 'between') return `between ${r.value} and ${r.value2} → ${what}`;
  if (['empty', 'notEmpty', 'any'].includes(r.when)) return `${r.when} → ${what}`;
  return `${r.when} ${r.value} → ${what}`;
}
