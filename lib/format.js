// Compact, token-cheap text renderings for agents.
import { parseAddr, parseRange, rangeToString, addr } from '../public/shared/a1.js';

const q = (v, max = 160) => {
  if (v === '' || v == null) return '∅';
  const s = String(v).replace(/\n/g, '⏎');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
const full = (v) => q(v, 4000);
const time = (ts) => new Date(ts).toTimeString().slice(0, 8);

function bbox(cells) {
  let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1;
  for (const a of cells) {
    const p = parseAddr(a);
    if (!p) continue;
    r1 = Math.min(r1, p.r); c1 = Math.min(c1, p.c); r2 = Math.max(r2, p.r); c2 = Math.max(c2, p.c);
  }
  return r2 < 0 ? '' : rangeToString({ r1, c1, r2, c2 });
}

export function formatChangeList(changes, recalc = [], indent = '  ') {
  const lines = [];
  const sets = changes.filter((c) => c.k === 'set');
  const SET_MAX = 15;
  if (sets.length > SET_MAX) {
    const bySheet = {};
    for (const c of sets) (bySheet[c.sheet] ||= []).push(c.cell);
    for (const [sh, cells] of Object.entries(bySheet)) lines.push(`${indent}set ${cells.length} cells in ${sh}!${bbox(cells)}`);
    for (const c of sets.slice(0, 6)) lines.push(`${indent}  ${c.sheet}!${c.cell}: ${q(c.old)} → ${q(c.new)}${c.t ? `   ⟨${c.t}⟩` : ''}`);
    lines.push(`${indent}  … ${sets.length - 6} more (format=json or /api/read for details)`);
  }
  for (const c of changes) {
    switch (c.k) {
      case 'set': if (sets.length <= SET_MAX) lines.push(`${indent}${c.sheet}!${c.cell}: ${q(c.old)} → ${q(c.new)}${c.t ? `   ⟨${c.t}⟩` : ''}`); break;
      case 'table': lines.push(`${indent}TABLE ${c.action} ${c.name}${c.to ? ` → ${c.to}` : ''}${c.range ? ` ${c.sheet}!${c.range}` : ''}${c.columns ? ` [${c.columns.join(' | ')}]` : ''}`); break;
      case 'move': {
        const to = c.toSheet && c.toSheet !== c.sheet ? `${c.toSheet}!${c.to}` : c.to;
        let l = `${indent}MOVE ${c.sheet}!${c.from} → ${to} (${c.cells} cells`;
        if (c.overwritten) l += `, overwrote ${c.overwritten}`;
        if (c.rewritten?.length) l += `; refs updated in ${c.rewritten.slice(0, 8).join(', ')}${c.rewritten.length > 8 ? ` +${c.rewritten.length - 8}` : ''}`;
        lines.push(l + ')');
        break;
      }
      case 'rows': case 'cols': {
        let l = `${indent}${c.action.toUpperCase()} ${c.k} ${c.at} in ${c.sheet}`;
        if (c.removed) l += ` (${c.removed} cells removed)`;
        if (c.rewritten?.length) l += `; refs updated in ${c.rewritten.length} formulas`;
        lines.push(l);
        break;
      }
      case 'format': lines.push(`${indent}format ${c.sheet}!${c.ranges.join(',')} ${JSON.stringify(c.style)}`); break;
      case 'chart': lines.push(`${indent}CHART ${c.action} ${c.id}${c.type ? ` (${c.type})` : ''}${c.source ? ` ${c.sheet}!${c.source}` : ''}${c.at ? ` @${c.at}` : ''}${c.fields ? ` [${c.fields.join(',')}]` : ''}`); break;
      case 'panel': lines.push(`${indent}PANEL ${c.action} ${c.id}${c.title ? ` "${c.title}"` : ''}${c.keys ? ` [${c.keys.join(',')}]` : ''}${c.new != null ? `: ${q(c.new)}` : ''}`); break;
      case 'merge': lines.push(`${indent}${c.action.toUpperCase()} ${c.sheet}!${c.ranges.join(',')}`); break;
      case 'note': lines.push(`${indent}note ${c.sheet}!${c.cell}: ${q(c.old)} → ${q(c.new)}`); break;
      case 'sheet': lines.push(`${indent}sheet ${c.action} "${c.name}"${c.to ? ` → "${c.to}"` : ''}`); break;
      case 'layout': lines.push(c.sheet ? `${indent}layout ${c.sheet}: ${c.what}` : `${indent}LAYOUT ${c.action} ${c.name}`); break;
      case 'doc': lines.push(`${indent}doc ${c.action} ${c.id}${c.type ? ` (${c.type})` : ''}${c.new ? ` "${c.new}"` : ''}`); break;
      case 'agent': lines.push(`${indent}AGENT ${c.action} ${c.id}${c.name ? ` "${c.name}"` : ''}${c.keys ? ` [${c.keys.join(',')}]` : ''}`); break;
      case 'config': lines.push(`${indent}studio settings ${JSON.stringify(c.set)}`); break;
      case 'root': lines.push(`${indent}studio root ${q(c.old)} → ${q(c.new)}`); break;
      case 'text': lines.push(`${indent}L${c.line}: ${c.old == null ? '+' : q(c.old)} → ${c.new == null ? '(deleted)' : q(c.new)}`); break;
    }
  }
  if (recalc.length) {
    const shown = recalc.slice(0, 12).map((r) => `${r.cell} ${q(r.old)}→${q(r.new)}`);
    lines.push(`${indent}calc: ${shown.join(' · ')}${recalc.length > 12 ? ` · +${recalc.length - 12} more` : ''}`);
  }
  return lines;
}

export function formatEntries(res) {
  const out = [];
  if (res.truncated) out.push(`(history before v${res.since} truncated in memory — use /api/diff?from=<milestone> or /api/read)`);
  if (!res.entries.length) out.push(`no changes since v${res.since} (now v${res.version})`);
  for (const e of res.entries) {
    out.push(`v${e.v} ${e.by}${e.who ? ` (${e.who})` : ''} ${time(e.ts)} [${e.doc}]${e.label ? ' — ' + e.label : ''}`);
    out.push(...formatChangeList(e.changes, e.recalc));
  }
  if (res.more) out.push(`… more entries; continue with since=${res.entries.at(-1).v}`);
  out.push(`cursor: ${res.entries.length ? res.entries.at(-1).v : res.version}`);
  return out.join('\n');
}

/** Net effect since a version: per cell first-old → last-new; structural events in order. */
export function relocate(map, c) {
  if (c.k !== 'move' && c.k !== 'rows' && c.k !== 'cols') return;
  const moved = new Map();
  for (const [k, val] of map) {
    const i = k.lastIndexOf('!');
    const sh = k.slice(0, i), p = parseAddr(k.slice(i + 1));
    let nk = k;
    if (c.k === 'move' && sh === c.sheet) {
      const R = parseRange(c.from), D = parseRange(c.to);
      if (p.c >= R.c1 && p.c <= R.c2 && p.r >= R.r1 && p.r <= R.r2) nk = `${c.toSheet}!${addr(p.c + D.c1 - R.c1, p.r + D.r1 - R.r1)}`;
    } else if ((c.k === 'rows' || c.k === 'cols') && sh === c.sheet) {
      const R = c.k === 'rows' ? parseRange(c.at.includes(':') ? c.at : c.at + ':' + c.at) : parseRange(c.at.includes(':') ? c.at : c.at + ':' + c.at);
      const at = c.k === 'rows' ? R.r1 : R.c1, n = c.count, v = c.k === 'rows' ? p.r : p.c;
      let nv = v;
      if (c.action === 'insert') nv = v >= at ? v + n : v;
      else if (v >= at && v < at + n) nv = null; else if (v >= at + n) nv = v - n;
      nk = nv === null ? null : `${sh}!${c.k === 'rows' ? addr(p.c, nv) : addr(nv, p.r)}`;
    }
    if (nk) moved.set(nk, val);
  }
  map.clear();
  for (const [k, v] of moved) map.set(k, v);
}

export function netChanges(res) {
  const cells = new Map(), calc = new Map(), other = [];
  for (const e of res.entries) {
    for (const c of e.changes) {
      relocate(cells, c);
      relocate(calc, c);
      if (c.k === 'set') {
        const k = `${c.sheet}!${c.cell}`;
        const prev = cells.get(k);
        cells.set(k, { old: prev ? prev.old : c.old, new: c.new, by: new Set([...(prev?.by || []), e.by]) });
      } else other.push({ ...c, v: e.v, by: e.by });
    }
    for (const r of e.recalc || []) {
      const prev = calc.get(r.cell);
      calc.set(r.cell, { old: prev ? prev.old : r.old, new: r.new });
    }
  }
  const out = [`net changes v${res.since} → v${res.version}`];
  for (const o of other) out.push(...formatChangeList([o], [], `  v${o.v} ${o.by} `));
  for (const [k, c] of cells) if (c.old !== c.new) out.push(`  ${k}: ${q(c.old)} → ${q(c.new)}  (${[...c.by].join(',')})`);
  const cl = [...calc].filter(([, c]) => c.old !== c.new);
  if (cl.length) out.push(`  calc: ${cl.slice(0, 20).map(([k, c]) => `${k} ${q(c.old)}→${q(c.new)}`).join(' · ')}${cl.length > 20 ? ` +${cl.length - 20}` : ''}`);
  out.push(`cursor: ${res.version}`);
  return out.join('\n');
}

export function formatRead(r) {
  if (r.studio) return JSON.stringify(r.studio, null, 1);
  if (r.lines) return r.lines.map((l) => `${String(l.n).padStart(4)}| ${l.t}`).join('\n');
  if (r.table) {
    const out = [`table ${r.table} = ${r.sheet}!${r.range} · ${r.rows.length} rows${r.truncated ? ' (TRUNCATED)' : ''}`, `columns: ${r.columns.join(' | ')}`];
    for (const row of r.rows) {
      const parts = row.values.map((v, i) => {
        if (v.raw === '' && !v.note) return null;
        let s = `${r.columns[i]}: ${full(v.raw)}`;
        if (v.value !== undefined) s += ` ⇒ ${full(v.value)}`;
        if (v.note) s += ` [note: ${full(v.note)}]`;
        return s;
      }).filter(Boolean);
      out.push(`[${row.r}] ${parts.join(' · ') || '(empty)'}`);
    }
    out.push('(row numbers in [] are sheet rows; column letters via header order)');
    return out.join('\n');
  }
  const out = [`${r.sheet}!${r.range ?? '(empty)'}  — ${r.cells.length} non-empty cells${r.truncated ? ' (TRUNCATED, narrow the range)' : ''}`];
  let row = -1, line = [];
  const push = () => { if (line.length) out.push(line.join(' | ')); line = []; };
  for (const c of r.cells) {
    if (c.r !== row) { push(); row = c.r; }
    let s = `${c.merged || c.a} ${full(c.raw)}`;
    if (c.value !== undefined) s += ` ⇒ ${full(c.value)}`;
    if (c.note) s += ` [note: ${full(c.note)}]`;
    line.push(s);
  }
  push();
  return out.join('\n');
}

export function formatDiff(d) {
  const out = [`diff ${d.from} (v${d.fromVersion} "${d.message}") → now v${d.version}`];
  if (!d.docs.length) out.push('  no differences');
  for (const x of d.docs) {
    out.push(`[${x.doc}]`);
    for (const s of x.structural || []) out.push(...formatChangeList([s], [], `  v${s.v} ${s.by} `));
    out.push(...formatChangeList(x.changes));
  }
  return out.join('\n');
}

export function formatHistory(list, title) {
  if (!list.length) return `${title}: no recorded changes (in the in-memory log)`;
  const out = [title];
  for (const h of list) {
    const who = h.by + (h.who ? ` (${h.who})` : '');
    const when = new Date(h.ts).toISOString().replace('T', ' ').slice(0, 16);
    if (h.moved) out.push(`  v${h.v} ${when} ${who}: ${h.away ? 'contents cut away: ' : 'moved '}${h.moved}`);
    else if (h.table) out.push(`  v${h.v} ${when} ${who}: table ${h.table}`);
    else out.push(`  v${h.v} ${when} ${who}: ${h.at} ${q(h.old)} → ${q(h.new)}${h.t ? `   ⟨${h.t}⟩` : ''}`);
  }
  return out.join('\n');
}
