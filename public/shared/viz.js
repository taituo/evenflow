// SVG visual packs — "spread-viz/1". Pure: validation, value → frame, frame → final SVG string.
// The spec for humans and models is VIZ_SPEC.md (also GET /api/viz/spec). Rendering in the DOM: canvases/sheet/viz-dom.js.
import { matches } from './cond.js';

export const SPEC = 'spread-viz/1';
export const KINDS = ['toggle', 'range', 'states', 'multi'];
export const LIMITS = { frame: 64 * 1024, pack: 256 * 1024, states: 12 };
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i;
const WHEN = ['<', '<=', '>', '>=', '=', '<>', 'between', 'contains', 'empty', 'notEmpty', 'any'];

/** Value produced by =VIZ("pack", value, [label]) — draws the pack in the cell. */
export class Viz {
  constructor(pack, value, label, min, max) { this.pack = pack; this.value = value; this.label = label ?? null; if (typeof min === 'number' && typeof max === 'number' && max > min) { this.min = min; this.max = max; } }
  toString() { return Array.isArray(this.value) ? this.value.map((x) => String(x ?? '')).join(' · ') : String(this.value ?? ''); }
}
export const isViz = (v) => v instanceof Viz;

// ------------------------------------------------------------------ validation (precise messages, so a model can fix its pack)
const BAD = [
  [/<script\b/i, 'no <script>'],
  [/<foreignObject\b/i, 'no <foreignObject>'],
  [/<(iframe|object|embed|image|audio|video|link|meta|base)\b/i, 'no <iframe>/<object>/<embed>/<image>/<audio>/<video>/<link>/<meta>'],
  [/\son[a-z]+\s*=/i, 'no event attributes (onload=, onclick=, …)'],
  [/javascript\s*:/i, 'no javascript: URLs'],
  [/@import/i, 'no @import in <style>'],
  [/url\(\s*['"]?(?!#)/i, 'url(...) may only point inside the SVG: url(#id)'],
  [/(?:xlink:)?href\s*=\s*['"](?!#)/i, 'href may only point inside the SVG: href="#id"'],
  [/<!ENTITY|<!DOCTYPE/i, 'no DOCTYPE / entities'],
];

function checkSvg(svg, where, errs) {
  if (typeof svg !== 'string' || !svg.trim()) { errs.push(`${where}: svg must be a non-empty string`); return; }
  if (svg.length > LIMITS.frame) errs.push(`${where}: svg is ${svg.length} bytes (max ${LIMITS.frame})`);
  const t = svg.trim();
  if (!/^<svg[\s>]/i.test(t) || !/<\/svg>\s*$/i.test(t)) errs.push(`${where}: must be exactly one <svg …>…</svg> element`);
  if (!/\sviewBox\s*=/.test(t.slice(0, t.indexOf('>') + 1))) errs.push(`${where}: the <svg> root needs a viewBox (e.g. viewBox="0 0 100 100")`);
  for (const [re, msg] of BAD) if (re.test(svg)) errs.push(`${where}: ${msg}`);
}

/** → { ok, errors: [...], warnings: [...], pack (normalized) } */
export function validatePack(p) {
  const errors = [], warnings = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: ['pack must be a JSON object'], warnings };
  if (p.spec !== SPEC) errors.push(`spec must be "${SPEC}"`);
  if (!ID.test(p.id || '')) errors.push('id must be 1–40 chars: a-z, 0-9, - (e.g. "battery")');
  if (!KINDS.includes(p.kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`);
  if (p.name != null && (typeof p.name !== 'string' || p.name.length > 60)) errors.push('name: a string, max 60 chars');
  if (JSON.stringify(p).length > LIMITS.pack) errors.push(`pack is too big (max ${LIMITS.pack} bytes)`);
  const out = { spec: SPEC, id: p.id, kind: p.kind, name: String(p.name || p.id || ''), description: String(p.description || '').slice(0, 300) };
  if (p.author) out.author = String(p.author).slice(0, 80);
  if (p.kind === 'multi') {
    // several values in one picture (a car's four tyres, a phase meter…): inputs [{id, label?, min?, max?}], one svg
    checkSvg(p.svg, 'svg', errors);
    out.svg = p.svg;
    if (!Array.isArray(p.inputs) || p.inputs.length < 2 || p.inputs.length > 12) errors.push('multi: inputs must be an array of 2–12 {id, label?, min?, max?}');
    else {
      const ids = new Set();
      out.inputs = p.inputs.map((x, i) => {
        const id = x?.id, min = x?.min ?? 0, max = x?.max ?? 100;
        if (!/^[a-z][a-z0-9]{0,15}$/.test(id || '')) errors.push(`inputs[${i}].id: 1–16 chars, a-z then a-z0-9 (it becomes --${id || 'id'} and data-${id || 'id'})`);
        else if (ids.has(id) || ['v', 'pct', 'level', 'state', 'value', 'label'].includes(id)) errors.push(`inputs[${i}].id "${id}" is used twice or reserved`);
        ids.add(id);
        if (x?.type === 'color') {
          // a color input: the value (a #hex) becomes --id directly, e.g. a team's livery
          if (x.value != null && !HEX.test(String(x.value))) errors.push(`inputs[${i}].value: a default color like "#e10600"`);
          return { id, type: 'color', label: String(x?.label ?? id).slice(0, 40), value: x.value || '#888888' };
        }
        if (x?.type != null && x.type !== 'number') errors.push(`inputs[${i}].type: "number" (default) or "color"`);
        if (typeof min !== 'number' || typeof max !== 'number' || !(max > min)) errors.push(`inputs[${i}]: min and max must be numbers with max > min`);
        return { id, label: String(x?.label ?? id ?? '').slice(0, 40), min, max };
      });
      if (typeof p.svg === 'string' && !out.inputs.some((x) => p.svg.includes('--' + x.id) || p.svg.includes('data-' + x.id) || p.svg.includes('{{' + x.id))) warnings.push('multi svg never uses an input (--id, [data-id], {{id}}) — it will look the same for every value');
    }
  }
  if (p.kind === 'range' || p.kind === 'toggle') {
    checkSvg(p.svg, 'svg', errors);
    out.svg = p.svg;
    if (p.states) warnings.push(`"states" is ignored for kind "${p.kind}"`);
  }
  if (p.kind === 'range') {
    const min = p.min ?? 0, max = p.max ?? 100;
    if (typeof min !== 'number' || typeof max !== 'number' || !(max > min)) errors.push('range: min and max must be numbers with max > min');
    out.min = min; out.max = max;
    if (typeof p.svg === 'string' && !/var\(--(v|pct)\)|data-level|\{\{(value|pct)\}\}/.test(p.svg)) warnings.push('range svg never uses --v, --pct, data-level or {{value}} — it will look the same at every value');
  }
  if (p.kind === 'toggle') {
    if (p.on != null) { const r = checkRule(p.on, 'on', errors); if (r) out.on = r; }
    if (typeof p.svg === 'string' && !/data-state|\[data-state/.test(p.svg) && !/\.on\b|\.off\b/.test(p.svg)) warnings.push('toggle svg never styles [data-state="on"] / [data-state="off"] — on and off will look the same');
  }
  if (p.kind === 'states') {
    if (!Array.isArray(p.states) || p.states.length < 2) errors.push('states: an array of 2–12 frames');
    if (Array.isArray(p.states)) {
      if (p.states.length > LIMITS.states) errors.push(`states: at most ${LIMITS.states} frames`);
      const ids = new Set();
      out.states = p.states.map((s, i) => {
        const where = `states[${i}]`;
        if (!s || typeof s !== 'object') { errors.push(`${where}: an object`); return null; }
        if (!ID.test(s.id || '')) errors.push(`${where}.id: 1–40 chars a-z 0-9 -`);
        else if (ids.has(s.id)) errors.push(`${where}.id "${s.id}" is used twice`);
        ids.add(s.id);
        checkSvg(s.svg, `${where}.svg`, errors);
        const r = checkRule(s, where, errors);
        return { id: s.id, label: String(s.label ?? s.id ?? '').slice(0, 40), ...(r || {}), svg: s.svg };
      });
      if (out.states.every((s) => s && s.when !== 'any')) warnings.push('no state has "when": "any" — values that match no rule show the first state');
    }
  }
  return { ok: !errors.length, errors, warnings, pack: errors.length ? null : out };
}
function checkRule(r, where, errors) {
  const when = r.when ?? 'any';
  if (!WHEN.includes(when)) { errors.push(`${where}.when must be one of ${WHEN.join(' ')}`); return null; }
  const o = { when };
  for (const k of ['value', 'value2']) if (r[k] !== undefined) {
    const list = Array.isArray(r[k]) ? r[k] : [r[k]];
    if (Array.isArray(r[k]) && (k !== 'value' || !['=', 'contains'].includes(when))) { errors.push(`${where}.${k}: a list of values only works with "=" or "contains"`); return null; }
    if (list.some((x) => typeof x === 'string' && x[0] === '=')) { errors.push(`${where}.${k}: formulas aren't allowed in packs`); return null; }
    if (list.some((x) => typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean')) { errors.push(`${where}.${k}: text, numbers or true/false`); return null; }
    o[k] = r[k];
  }
  if (!['any', 'empty', 'notEmpty'].includes(when) && o.value === undefined) errors.push(`${where}: "when": "${when}" needs a "value"`);
  if (when === 'between' && o.value2 === undefined) errors.push(`${where}: "between" needs "value2"`);
  return o;
}

// ------------------------------------------------------------------ value → what to show
/** A pack rule; "value" may be a list (any of them matches) for "=" and "contains". */
export const ruleMatches = (rule, v) => (Array.isArray(rule.value) ? rule.value.some((x) => matches(null, null, { ...rule, value: x }, v)) : matches(null, null, rule, v));
const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : v != null && String(v).trim() !== '' && !isNaN(+v) ? +v : null);
const truthy = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return /^(1|on|yes|true|ok|done|up|open|green|active|kyllä|päällä|valmis)$/i.test(String(v ?? '').trim());
};
const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(2))) : String(v ?? ''));

/** → { frame: svg string, state, v (0..1), pct, level (0..10), text } */
/** A multi pack's value: an array (a cell range), an object {id: v}, or text "95, 105, 97, 100". */
function multiValues(pack, value) {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? pack.inputs.map((x) => value[x.id]) : String(value ?? '').split(/[;,|·]/).map((x) => x.trim());
  return pack.inputs.map((x, i) => {
    const raw = list[i] ?? null;
    if (x.type === 'color') { const c = HEX.test(String(raw ?? '').trim()) ? String(raw).trim() : x.value; return { id: x.id, raw: c, text: c, color: c }; }
    const n = num(raw);
    const v = n == null ? 0 : Math.max(0, Math.min(1, (n - x.min) / (x.max - x.min)));
    return { id: x.id, raw, text: fmt(raw), v, pct: Math.round(v * 100), level: Math.round(v * 10) };
  });
}
export function resolve(pack, value, label, o = {}) {
  if (pack.kind === 'multi') {
    const vals = multiValues(pack, value), f = vals.find((x) => !x.color) || { v: 0, pct: 0, level: 0 };
    return { value, text: vals.map((x) => x.text).join(' · '), label: label ?? '', frame: pack.svg, state: 'v', v: f.v, pct: f.pct, level: f.level, vals };
  }
  const n = num(value);
  const base = { value, text: fmt(value), label: label ?? '' };
  if (pack.kind === 'range') {
    // the scale can be set where the pack is used (=VIZ("arc", A1, "°C", 0, 150)), so one gauge fits any quantity
    const [lo, hi] = typeof o.min === 'number' && typeof o.max === 'number' && o.max > o.min ? [o.min, o.max] : [pack.min, pack.max];
    const v = n == null ? 0 : Math.max(0, Math.min(1, (n - lo) / (hi - lo)));
    return { ...base, frame: pack.svg, state: 'v', v, pct: Math.round(v * 100), level: Math.round(v * 10) };
  }
  if (pack.kind === 'toggle') {
    const on = pack.on ? ruleMatches(pack.on, value) : truthy(value);
    return { ...base, frame: pack.svg, state: on ? 'on' : 'off', v: on ? 1 : 0, pct: on ? 100 : 0, level: on ? 10 : 0 };
  }
  const st = pack.states.find((s) => ruleMatches(s, value)) || pack.states[0];
  const i = pack.states.indexOf(st);
  return { ...base, frame: st.svg, state: st.id, label: label ?? st.label, v: pack.states.length > 1 ? i / (pack.states.length - 1) : 0, pct: 0, level: i };
}

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Fill the template: placeholders, and the state on the root as attributes + CSS variables. */
export const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9]*)(\.pct)?\s*\}\}/g;
/** Text for a {{placeholder}}: value, pct, label, state — and for multi packs {{id}} and {{id.pct}}. */
export function placeholder(r, k, pct) {
  const m = r.vals?.find((x) => x.id === k);
  if (m) return pct ? String(m.pct) : m.text;
  if (pct) return null;
  return k === 'pct' ? String(r.pct) : k === 'value' ? r.text : k === 'label' ? String(r.label ?? '') : k === 'state' ? r.state : null;
}
/** CSS variables and data attributes the root <svg> gets. */
export function rootVars(r) {
  const vars = [['--v', +r.v.toFixed(4)], ['--pct', r.pct], ['--level', r.level]];
  const attrs = [['data-state', r.state], ['data-level', r.level]];
  for (const x of r.vals || []) {
    if (x.color) { vars.push([`--${x.id}`, x.color]); continue; }
    vars.push([`--${x.id}`, +x.v.toFixed(4)], [`--${x.id}-pct`, x.pct]); attrs.push([`data-${x.id}`, x.level]);
  }
  return { vars, attrs };
}
export function fill(svg, r) {
  let s = svg.replace(PLACEHOLDER, (m, k, pct) => { const t = placeholder(r, k, !!pct); return t == null ? m : escXml(t); });
  const { vars, attrs } = rootVars(r);
  s = s.replace(/<svg\b([^>]*)>/i, (m, a) => {
    const clean = a.replace(/\sdata-[a-z0-9-]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
    const style = vars.map(([k, v]) => `${k}:${v}`).join(';');
    const merged = /\sstyle\s*=\s*"/i.test(clean) ? clean.replace(/\sstyle\s*=\s*"/i, ` style="${style};`) : `${clean} style="${style}"`;
    return `<svg${merged} ${attrs.map(([k, v]) => `${k}="${escXml(v)}"`).join(' ')}>`;
  });
  return s;
}
/** Final SVG string with explicit pixel size (for <img> / canvas). */
export function renderString(pack, value, label, w = 200, h = 200, o) {
  const r = resolve(pack, value, label, o);
  let s = fill(r.frame, r);
  s = s.replace(/<svg\b([^>]*)>/i, (m, attrs) => `<svg${attrs.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')} width="${w}" height="${h}"${/xmlns=/.test(attrs) ? '' : ' xmlns="http://www.w3.org/2000/svg"'}>`);
  return s;
}
