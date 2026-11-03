// SVG visual packs — "spread-viz/1". Pure: validation, value → frame, frame → final SVG string.
// The spec for humans and models is VIZ_SPEC.md (also GET /api/viz/spec). Rendering in the DOM: canvases/sheet/viz-dom.js.
import { matches } from './cond.js';

export const SPEC = 'spread-viz/1';
export const KINDS = ['toggle', 'range', 'states'];
export const LIMITS = { frame: 64 * 1024, pack: 256 * 1024, states: 12 };
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const WHEN = ['<', '<=', '>', '>=', '=', '<>', 'between', 'contains', 'empty', 'notEmpty', 'any'];

/** Value produced by =VIZ("pack", value, [label]) — draws the pack in the cell. */
export class Viz {
  constructor(pack, value, label) { this.pack = pack; this.value = value; this.label = label ?? null; }
  toString() { return String(this.value ?? ''); }
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
export function resolve(pack, value, label) {
  const n = num(value);
  const base = { value, text: fmt(value), label: label ?? '' };
  if (pack.kind === 'range') {
    const v = n == null ? 0 : Math.max(0, Math.min(1, (n - pack.min) / (pack.max - pack.min)));
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
export function fill(svg, r) {
  let s = svg.replace(/\{\{\s*(value|pct|label|state)\s*\}\}/g, (_, k) => escXml(k === 'pct' ? r.pct : k === 'value' ? r.text : k === 'label' ? r.label : r.state));
  s = s.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
    const clean = attrs.replace(/\s(data-state|data-level)\s*=\s*("[^"]*"|'[^']*')/gi, '');
    const style = `--v:${+r.v.toFixed(4)};--pct:${r.pct};--level:${r.level}`;
    const merged = /\sstyle\s*=\s*"/i.test(clean) ? clean.replace(/\sstyle\s*=\s*"/i, ` style="${style};`) : `${clean} style="${style}"`;
    return `<svg${merged} data-state="${escXml(r.state)}" data-level="${r.level}">`;
  });
  return s;
}
/** Final SVG string with explicit pixel size (for <img> / canvas). */
export function renderString(pack, value, label, w = 200, h = 200) {
  const r = resolve(pack, value, label);
  let s = fill(r.frame, r);
  s = s.replace(/<svg\b([^>]*)>/i, (m, attrs) => `<svg${attrs.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')} width="${w}" height="${h}"${/xmlns=/.test(attrs) ? '' : ' xmlns="http://www.w3.org/2000/svg"'}>`);
  return s;
}
