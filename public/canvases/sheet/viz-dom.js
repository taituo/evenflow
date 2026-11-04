// SVG packs in the browser: a strict sanitizer, shadow-DOM mounting (pack styles can't leak into the page),
// cross-fading states, and cached <img> renderings for the canvas grid.
import { resolve, renderString, PLACEHOLDER, placeholder, rootVars } from '../../shared/viz.js';

// ------------------------------------------------------------------ registry (filled by app.js from /api/viz)
const packs = new Map();
const listeners = new Set();
export function setPacks(list) { packs.clear(); for (const p of list) packs.set(p.id, p); imgCache.clear(); listeners.forEach((f) => f()); }
export const getPack = (id) => packs.get(String(id || '').toLowerCase()) || null;
export const allPacks = () => [...packs.values()];
export const onPacks = (f) => { listeners.add(f); return () => listeners.delete(f); };

// ------------------------------------------------------------------ sanitizer: allowlist, never trust a pack
const EL = new Set(('svg g defs symbol use title desc path rect circle ellipse line polyline polygon text tspan textPath '
  + 'linearGradient radialGradient stop clipPath mask pattern marker filter style '
  + 'feGaussianBlur feOffset feMerge feMergeNode feColorMatrix feBlend feFlood feComposite feDropShadow feMorphology feTurbulence feDisplacementMap '
  + 'animate animateTransform animateMotion set mpath').split(' '));
const ATTR = new Set(('id class style viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry d points '
  + 'fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity stroke-miterlimit '
  + 'opacity transform transform-origin font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing '
  + 'offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy patternUnits patternContentUnits patternTransform '
  + 'clip-path clip-rule mask filter filterUnits primitiveUnits in in2 result stdDeviation dx dy mode operator k1 k2 k3 k4 values type '
  + 'flood-color flood-opacity radius baseFrequency numOctaves seed scale xChannelSelector yChannelSelector '
  + 'attributeName attributeType from to by dur begin end repeatCount repeatDur fill-mode calcMode keyTimes keySplines keyPoints additive accumulate rotate path '
  + 'pathLength visibility display vector-effect shape-rendering paint-order href xlink:href markerWidth markerHeight refX refY orient markerUnits '
  + 'textLength lengthAdjust startOffset role aria-label data-state data-level').split(' '));
const SAFE_URL = /^\s*#[\w.-]+\s*$/;
function cleanCss(css) {
  return String(css).replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(/gi, '(').replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none')
    .replace(/behavior\s*:/gi, 'x:').replace(/-moz-binding/gi, 'x');
}
/** → a safe <svg> element (or null), parsed from untrusted text. */
export function sanitizeSvg(text) {
  // packs often omit xmlns (fine in HTML, not in an XML parse): add it, or every element would be dropped
  const src = String(text).replace(/<svg\b(?![^>]*\sxmlns=)/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'svg' || doc.querySelector('parsererror')) return null;
  const walk = (el) => {
    for (const ch of [...el.children]) {
      if (!EL.has(ch.localName) || ch.namespaceURI !== 'http://www.w3.org/2000/svg') { ch.remove(); continue; }
      walk(ch);
    }
    for (const a of [...el.attributes]) {
      const n = a.name, v = a.value;
      if (!ATTR.has(n) || /^on/i.test(n)) { el.removeAttribute(n); continue; }
      if ((n === 'href' || n === 'xlink:href') && !SAFE_URL.test(v)) { el.removeAttribute(n); continue; }
      if (/javascript:|data:|vbscript:/i.test(v)) { el.removeAttribute(n); continue; }
      if (/url\(/i.test(v) && !/^\s*url\(\s*['"]?#[\w.-]+['"]?\s*\)\s*$/i.test(v) && n !== 'style') { el.removeAttribute(n); continue; }
      if (n === 'style') el.setAttribute('style', cleanCss(v));
      // SMIL may not animate links or event handlers into existence
      if (n === 'attributeName' && /^(href|xlink:href|on)/i.test(v)) { el.remove(); return; }
    }
    if (el.localName === 'style') el.textContent = cleanCss(el.textContent);
  };
  walk(root);
  for (const a of [...root.attributes]) if (!ATTR.has(a.name) && a.name !== 'xmlns' && a.name !== 'xmlns:xlink' && !/^data-[a-z0-9-]{1,30}$/.test(a.name)) root.removeAttribute(a.name);
  return document.importNode(root, true);
}

// ------------------------------------------------------------------ live mounting: one shadow root per visual
const HOST_CSS = `:host{display:block;position:relative;width:100%;height:100%;contain:content}
.f{position:absolute;inset:0;transition:opacity .45s ease,filter .45s ease}
.f>svg{width:100%;height:100%;display:block;overflow:visible}
.f.off{opacity:0;filter:blur(4px);pointer-events:none}
svg *{transition:fill .5s ease,stroke .5s ease,opacity .5s ease,transform .7s cubic-bezier(.2,.8,.2,1),stroke-dashoffset .7s cubic-bezier(.2,.8,.2,1)}`;

/** Show `value` with pack `packId` inside host. Re-calls update in place: range/toggle values glide (CSS transitions), states cross-fade. */
export function renderViz(host, packId, value, label, o = {}) {
  const pack = getPack(packId);
  let root = host.shadowRoot;
  if (!root) { root = host.attachShadow({ mode: 'open' }); root.innerHTML = `<style>${HOST_CSS}</style>`; }
  if (!pack) {
    if (host.__vizKey !== 'missing:' + packId) { root.innerHTML = `<style>${HOST_CSS}</style><div class="f" style="display:grid;place-items:center;font:12px system-ui;opacity:.7">no pack “${String(packId).replace(/[<>&]/g, '')}”</div>`; host.__vizKey = 'missing:' + packId; }
    return;
  }
  const r = resolve(pack, value, label, o);
  const key = `${pack.id}@${pack.rev || 0}`;
  if (host.__vizKey !== key) { root.innerHTML = `<style>${HOST_CSS}</style>`; host.__vizKey = key; host.__frames = new Map(); }
  const frames = host.__frames;
  const fkey = pack.kind === 'states' ? r.state : '_';
  let f = frames.get(fkey);
  if (!f) {
    // sanitize the raw template; text nodes that carry {{placeholders}} are remembered and filled on every update,
    // so a changing value only touches text and CSS variables (smooth transitions, no re-mount)
    const svg = sanitizeSvg(r.frame);
    if (!svg) return;
    f = document.createElement('div');
    f.className = 'f off';
    f.append(svg);
    f.__tpl = [];
    const tw = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if (/\{\{\s*[a-z][a-z0-9]*(\.pct)?\s*\}\}/.test(n.nodeValue)) f.__tpl.push([n, n.nodeValue]);
    root.append(f);
    frames.set(fkey, f);
    requestAnimationFrame(() => f.classList.remove('off'));
  }
  const svg = f.firstElementChild;
  const { vars, attrs } = rootVars(r);
  for (const [k, v] of vars) svg.style.setProperty(k, v);
  for (const [k, v] of attrs) svg.setAttribute(k, v);
  for (const [node, tpl] of f.__tpl) node.nodeValue = tpl.replace(PLACEHOLDER, (m, k, pct) => placeholder(r, k, !!pct) ?? m);
  for (const [k, other] of frames) other.classList.toggle('off', k !== fkey);
  host.dataset.state = r.state;
}

// ------------------------------------------------------------------ canvas: cached images of the final SVG
const imgCache = new Map();
/** Image (or null while loading) of pack at value; onload called once when it becomes ready. */
export function vizImage(packId, value, label, w, h, onload, o = {}) {
  const pack = getPack(packId);
  if (!pack) return null;
  const W = Math.max(16, Math.round(w)), H = Math.max(16, Math.round(h));
  const k = `${pack.id}|${pack.rev || 0}|${String(value)}|${label ?? ''}|${o.min ?? ''}-${o.max ?? ''}|${W}x${H}`;
  let e = imgCache.get(k);
  if (!e) {
    if (imgCache.size > 600) imgCache.clear();
    const url = vizDataUrl(pack, value, label, W, H, o);
    e = { img: new Image(), ok: false };
    if (url) {
      e.img.onload = () => { e.ok = true; onload?.(); };
      e.img.src = url;
    }
    imgCache.set(k, e);
  }
  return e.ok ? e.img : null;
}

/** data: URL of the sanitized, filled SVG — for <img> previews and the canvas. */
export function vizDataUrl(pack, value, label, w = 120, h = 120, o) {
  const el = sanitizeSvg(renderString(pack, value, label, w, h, o));
  if (!el) return null;
  el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(el));
}
/** A value that shows each pack at its best in a preview. */
export function sampleValues(pack) {
  if (pack.kind === 'range') return [pack.min + (pack.max - pack.min) * 0.72];
  if (pack.kind === 'multi') return [pack.inputs.map((x, i) => x.min + (x.max - x.min) * [0.3, 0.55, 0.75, 0.9, 0.45, 0.65][i % 6])];
  if (pack.kind === 'toggle') return [1, 0];
  return pack.states.map((s) => (s.when === 'any' ? '?' : Array.isArray(s.value) ? s.value[0] : s.value ?? ''));
}
