// Live mode: the current sheet as a full-screen, real-time, presentation-grade surface.
// Background: Paper Shaders (WebGL mesh gradient). Foreground: frosted-glass cards rendered from the
// sheet's own layout — charts in white, KPIs, named tables (values editable, structure locked), titles.
import * as PS from '../../vendor/paper-shaders/index.js';
import { FONTS } from '../../shared/fonts.js';
import { sampleBackground, findRelations, drawRelations, flip, backSide } from './live-extras.js';
import { drawChart } from './charts.js';
import { tables as allTables, chartData, mergeAt, tableColumns, usedRange } from '../../shared/types/sheet.js';
import { Engine, fmtValue, isImg } from '../../shared/engine.js';
import { addr, parseAddr, parseRange, splitSheet, sameName } from '../../shared/a1.js';
import { isErr } from '../../shared/formula.js';
import { condStyle } from '../../shared/cond.js';
import { FX, fxText, textOf, vaporRowsOut, vaporRowsIn } from './fx.js';
import { renderViz, getPack } from './viz-dom.js';
import { isViz } from '../../shared/engine.js';

// Background themes. Each one is a Paper Shaders fragment shader + its parameters.
export const PRESETS = {
  aurora: { shader: 'mesh', colors: ['#0b1026', '#3b1c74', '#0aa5d8', '#ff4f9a'], distortion: 0.85, swirl: 0.4, speed: 0.35 },
  nebula: { shader: 'mesh', colors: ['#e0eaff', '#241d9a', '#f75092', '#9f50d3'], distortion: 0.8, swirl: 0.1, speed: 0.5 },
  ocean: { shader: 'mesh', colors: ['#04293a', '#0a6c8a', '#00c6d7', '#7ef0c9'], distortion: 0.9, swirl: 0.3, speed: 0.3 },
  ember: { shader: 'mesh', colors: ['#1a0b0b', '#7a1f1f', '#ff6a3d', '#ffc56e'], distortion: 0.7, swirl: 0.5, speed: 0.4 },
  forest: { shader: 'mesh', colors: ['#071a12', '#145a3a', '#4fb286', '#d8f3a6'], distortion: 0.8, swirl: 0.25, speed: 0.25 },
  ink: { shader: 'mesh', colors: ['#1d1d1f', '#000000', '#3a3a40', '#6b6b75'], distortion: 1, swirl: 0.2, speed: 0.4 },
  grain: { shader: 'grain', colorBack: '#07020f', colors: ['#7300ff', '#eba8ff', '#00bfff', '#2a00ff'], softness: 0.5, intensity: 0.5, noise: 0.25, shape: 'corners', speed: 0.5 },
  neuro: { shader: 'neuro', colorFront: '#ffffff', colorMid: '#47a6ff', colorBack: '#020814', brightness: 0.05, contrast: 0.3, speed: 0.5 },
  warp: { shader: 'warp', colors: ['#121212', '#9470ff', '#121212', '#8838ff'], proportion: 0.45, softness: 1, distortion: 0.25, swirl: 0.8, swirlIterations: 10, shapeScale: 0.1, shape: 'checks', speed: 0.4 },
  smoke: { shader: 'smoke', colorBack: '#05060f', colors: ['#7fd1ff', '#ffffff'], noiseScale: 3, noiseIterations: 8, radius: 0.25, thickness: 0.65, innerShape: 0.7, scale: 0.9, speed: 0.4 },
  rays: { shader: 'rays', colorBack: '#000000', colorBloom: '#2a3cff', colors: ['#a600ff6e', '#6200fff0', '#ffffff', '#33fff5'], density: 0.3, spotty: 0.3, midIntensity: 0.4, midSize: 0.2, intensity: 0.8, bloom: 0.4, offsetY: -0.55, speed: 0.5 },
  swirl: { shader: 'swirl', colorBack: '#1a0000', colors: ['#ffd1d1', '#ff8a8a', '#660000'], bandCount: 4, twist: 0.1, center: 0.2, proportion: 0.5, softness: 0, noiseFrequency: 0.4, noise: 0.2, speed: 0.25 },
  blobs: { shader: 'metaballs', colorBack: '#05000c', colors: ['#6e33cc', '#ff5500', '#ffc105', '#ffc800', '#f585ff'], count: 10, size: 0.83, speed: 0.5 },
};
const C = (x) => PS.getShaderColorFromString(x);
const sizing = (p, fit) => ({
  u_fit: PS.ShaderFitOptions[fit], u_rotation: 0, u_scale: p.scale ?? 1, u_offsetX: p.offsetX ?? 0, u_offsetY: p.offsetY ?? 0,
  u_originX: 0.5, u_originY: 0.5, u_worldWidth: 0, u_worldHeight: 0,
});
const SHADERS = {
  mesh: (p) => [PS.meshGradientFragmentShader, { u_colors: p.colors.map(C), u_colorsCount: p.colors.length, u_distortion: p.distortion, u_swirl: p.swirl, u_grainMixer: 0, u_grainOverlay: 0.06, ...sizing(p, 'cover') }],
  grain: (p) => [PS.grainGradientFragmentShader, { u_colorBack: C(p.colorBack), u_colors: p.colors.map(C), u_colorsCount: p.colors.length, u_softness: p.softness, u_intensity: p.intensity, u_noise: p.noise, u_shape: PS.GrainGradientShapes[p.shape], u_noiseTexture: PS.getShaderNoiseTexture(), ...sizing(p, 'cover') }],
  neuro: (p) => [PS.neuroNoiseFragmentShader, { u_colorFront: C(p.colorFront), u_colorMid: C(p.colorMid), u_colorBack: C(p.colorBack), u_brightness: p.brightness, u_contrast: p.contrast, ...sizing(p, 'none') }],
  warp: (p) => [PS.warpFragmentShader, { u_colors: p.colors.map(C), u_colorsCount: p.colors.length, u_proportion: p.proportion, u_softness: p.softness, u_distortion: p.distortion, u_swirl: p.swirl, u_swirlIterations: p.swirlIterations, u_shapeScale: p.shapeScale, u_shape: PS.WarpPatterns[p.shape], u_noiseTexture: PS.getShaderNoiseTexture(), ...sizing(p, 'none') }],
  smoke: (p) => [PS.smokeRingFragmentShader, { u_colorBack: C(p.colorBack), u_colors: p.colors.map(C), u_colorsCount: p.colors.length, u_noiseScale: p.noiseScale, u_thickness: p.thickness, u_radius: p.radius, u_innerShape: p.innerShape, u_noiseIterations: p.noiseIterations, u_noiseTexture: PS.getShaderNoiseTexture(), ...sizing(p, 'cover') }],
  rays: (p) => [PS.godRaysFragmentShader, { u_colorBloom: C(p.colorBloom), u_colorBack: C(p.colorBack), u_colors: p.colors.map(C), u_colorsCount: p.colors.length, u_density: p.density, u_spotty: p.spotty, u_midIntensity: p.midIntensity, u_midSize: p.midSize, u_intensity: p.intensity, u_bloom: p.bloom, u_noiseTexture: PS.getShaderNoiseTexture(), ...sizing(p, 'cover') }],
  swirl: (p) => [PS.swirlFragmentShader, { u_colorBack: C(p.colorBack), u_colors: p.colors.map(C), u_colorsCount: p.colors.length, u_bandCount: p.bandCount, u_twist: p.twist, u_center: p.center, u_proportion: p.proportion, u_softness: p.softness, u_noiseFrequency: p.noiseFrequency, u_noise: p.noise, ...sizing(p, 'cover') }],
  metaballs: (p) => [PS.metaballsFragmentShader, { u_colorBack: C(p.colorBack), u_colors: p.colors.map(C), u_colorsCount: p.colors.length, u_size: p.size, u_count: p.count, u_noiseTexture: PS.getShaderNoiseTexture(), ...sizing(p, 'cover') }],
};
const swatch = (p) => { const c = p.colors || [p.colorBack, p.colorMid, p.colorFront]; return `conic-gradient(${[...c, c[0]].join(', ')})`; };

const DEF_W = 100, DEF_H = 21;
const ease = (t) => 1 - Math.pow(1 - t, 3);

export function openLive(ctx, doc, startSheet, { submit, onClose, mode: startMode, focus: startFocus, kiosk, slide: startSlide }) {
  let sheetName = startSheet;
  const sh = () => doc.sheets.find((s) => sameName(s.name, sheetName)) || doc.sheets[0];
  const root = document.createElement('div');
  root.className = 'lv';
  root.innerHTML = `
    <div class="lv-bg"></div>
    <div class="lv-bgimg"><img alt="" draggable="false"></div>
    <div class="lv-scroll"><div class="lv-slidetext"></div><div class="lv-stage"></div></div>
    <div class="lv-slides"></div>
    <div class="lv-progress"><i></i></div>
    <div class="lv-dots"></div>
    <div class="lv-bar">
      <div class="lv-page" data-page="1">
        <div class="lv-modes"><button class="lv-btn" data-m="sheet" title="Each sheet with its own layout">Sheet</button><button class="lv-btn" data-m="auto" title="All tables, charts and KPIs from every sheet, auto-composed">✦ Combined</button></div>
        <div class="lv-sep"></div>
        <div class="lv-sheets"></div>
        <div class="lv-sep"></div>
        <button class="lv-btn" data-a="slides" title="Slides: turn views into a presentation">▤ Slides</button>
        <button class="lv-btn lv-more" data-a="page2" title="Look &amp; layout: theme, cards, table lines, effects, font…">◐ Look ›</button>
        <button class="lv-btn" data-a="fs" title="Fullscreen">⛶</button>
        <button class="lv-btn" data-a="exit" title="Back to edit mode (Esc)">✎ Edit</button>
      </div>
      <div class="lv-page" data-page="2">
        <button class="lv-btn lv-more" data-a="page1" title="Back">‹</button>
        <div class="lv-themes"></div>
        <div class="lv-sep"></div>
        <button class="lv-btn" data-a="cards" title="Cards: frosted glass · outline · clear (content floats on the background)">▢ Glass</button>
        <button class="lv-btn" data-a="lines" title="Table lines: rows · grid · none">☰ Rows</button>
        <button class="lv-btn" data-a="fx" title="Change effect: what a value does when the data changes (morph · scramble · vapor · glow · none)">⟡ Morph</button>
        <button class="lv-btn" data-a="font" title="Typeface for this sheet in Live">Aa</button>
        <div class="lv-sep"></div>
        <button class="lv-btn" data-a="flow" title="Scroll direction (combined)">↕</button>
        <button class="lv-btn" data-a="reveal" title="Reveal cards as they scroll into view">✨</button>
        <button class="lv-btn" data-a="links" title="Show relations between tables (and which table feeds which chart)">⛓</button>
        <button class="lv-btn" data-a="space" title="Add an empty space (e.g. for a logo) — drag it anywhere">＋ Space</button>
      </div>
    </div>
    <div class="lv-live"><span class="lv-people"></span><i></i>LIVE</div>`;
  document.body.append(root);
  const $ = (s) => root.querySelector(s);
  const stage = $('.lv-stage'), scroller = $('.lv-scroll'), bar = $('.lv-bar');

  // ------------------------------------------------------------- shader background
  let mount = null, mountedShader = null;
  let slide = null;           // the slide being shown (null = free browsing)
  const themeName = () => (PRESETS[slide?.bg?.theme] ? slide.bg.theme : PRESETS[sh().view?.theme] ? sh().view.theme : 'aurora');
  // Adaptive quality: without a GPU (VMs, remote desktops, cheap TV sticks) a full-resolution animated shader can
  // starve the page of frames, and then input and transitions stall too. Measure, and step down: fewer pixels
  // (gradients upscale invisibly), and as a last resort a still frame.
  const QUALITY = [1920 * 1080 * 2, 1920 * 1080 / 2, 960 * 540 / 2, 480 * 270];
  const gov = { level: 0, frozen: false, slow: 0, n: 0, t0: performance.now(), raf: 0 };
  // ?quality=half|low|minimal|still starts lower — for a weak wall screen you already know about
  { const qq = new URLSearchParams(location.search).get('quality'); const i = ['full', 'half', 'low', 'minimal'].indexOf(qq); if (i > 0) gov.level = i; if (qq === 'still') { gov.level = 3; gov.frozen = true; root.classList.add('lv-static'); } }
  const govTick = (now) => {
    gov.n++;
    if (now - gov.t0 >= 1500) {
      const fps = (gov.n * 1000) / (now - gov.t0);
      gov.slow = fps < 24 && !document.hidden ? gov.slow + 1 : 0;
      if (gov.slow >= 2 && mount) {
        gov.slow = 0;
        if (gov.level < QUALITY.length - 1) { gov.level++; try { mount.setMaxPixelCount(QUALITY[gov.level]); } catch {} }
        else if (!gov.frozen) { gov.frozen = true; try { mount.setSpeed(0); } catch {} root.classList.add('lv-static'); }
        reportState();
      }
      gov.n = 0; gov.t0 = now;
    }
    gov.raf = requestAnimationFrame(govTick);
  };
  gov.raf = requestAnimationFrame(govTick);
  function mountShader(id, frag, uni, speed) {
    const sp = gov.frozen ? 0 : speed;
    if (mount && mountedShader === id) { mount.setUniforms(uni); mount.setSpeed(sp); return; }
    try { mount?.dispose(); } catch { /* remount */ }
    $('.lv-bg').innerHTML = '';
    // preserveDrawingBuffer lets adaptive ink read the background behind each card
    mount = new PS.ShaderMount($('.lv-bg'), frag, uni, { preserveDrawingBuffer: true, premultipliedAlpha: false }, sp, 0, 1, QUALITY[gov.level]);
    mountedShader = id;
  }
  function applyTheme() {
    const img = slide?.bg?.image;
    const filter = slide?.bg?.filter || 'none';
    const bgimg = $('.lv-bgimg'), im = bgimg.querySelector('img');
    root.classList.toggle('lv-has-bgimg', !!img && filter === 'none');
    if (img && filter === 'none') {
      // plain bitmap / animated GIF / animated SVG: the browser animates them natively
      if (im.getAttribute('src') !== img) im.src = img;
      try { mount?.dispose(); } catch {}
      mount = null; mountedShader = null; $('.lv-bg').innerHTML = '';   // nothing renders behind a plain image
    } else if (img) {
      let pic = new Image();
      pic.crossOrigin = 'anonymous';
      pic.src = img;
      const tint = PRESETS[themeName()];
      const front = tint.colors?.[tint.colors.length - 1] || '#ffffff', back = tint.colorBack || tint.colors?.[0] || '#000000';
      const sizingU = { u_fit: PS.ShaderFitOptions.cover, u_rotation: 0, u_scale: 1, u_offsetX: 0, u_offsetY: 0, u_originX: 0.5, u_originY: 0.5, u_worldWidth: 0, u_worldHeight: 0 };
      const ready = () => {
        try {
          if (filter === 'halftone') mountShader('halftone:' + img, PS.halftoneDotsFragmentShader, { u_image: pic, u_colorFront: C(front), u_colorBack: C(back), u_size: 0.5, u_radius: 1.25, u_contrast: 0.4, u_originalColors: true, u_inverted: false, u_grainMixer: 0.2, u_grainOverlay: 0.2, u_grainSize: 0.5, u_grid: PS.HalftoneDotsGrids.hex, u_type: PS.HalftoneDotsTypes.gooey, ...sizingU }, 0);
          else mountShader('dither:' + img, PS.imageDitheringFragmentShader, { u_image: pic, u_colorFront: C(front), u_colorBack: C(back), u_colorHighlight: C('#ffffff'), u_type: 4, u_pxSize: 2, u_colorSteps: 2, u_originalColors: true, u_inverted: false, ...sizingU }, 0);
        } catch { root.classList.add('lv-has-bgimg'); im.src = img; }
      };
      // SVGs (and anything without intrinsic pixels) are rasterized first: the shader needs a bitmap texture
      const rasterize = () => {
        if (pic.naturalWidth && !/\.svg(\?|$)|svg\+xml/i.test(img)) return ready();
        const cv = document.createElement('canvas');
        cv.width = 1600; cv.height = 900;
        const g = cv.getContext('2d');
        const k = pic.naturalWidth ? Math.max(1600 / pic.naturalWidth, 900 / pic.naturalHeight) : 1;
        const w = pic.naturalWidth ? pic.naturalWidth * k : 1600, h = pic.naturalHeight ? pic.naturalHeight * k : 900;
        try { g.drawImage(pic, (1600 - w) / 2, (900 - h) / 2, w, h); } catch {}
        const r = new Image();
        r.onload = () => { pic = r; ready(); };
        r.src = cv.toDataURL('image/png');
      };
      if (pic.complete) rasterize(); else pic.onload = rasterize;
    }
    if (!img || filter !== 'none') {
      if (!img) {
        const p = PRESETS[themeName()];
        const [frag, uni] = SHADERS[p.shader](p);
        try { mountShader(p.shader, frag, uni, p.speed); } catch (e) { $('.lv-bg').style.background = swatch(p); }
      }
    }
    root.querySelectorAll('.lv-dot').forEach((d) => d.classList.toggle('on', d.dataset.t === themeName()));
    root.style.fontFamily = FONTS[sh().view?.font]?.stack || FONTS.display.stack;
    const fb = root.querySelector('[data-a=font]');
    if (fb) fb.textContent = 'Aa ' + (FONTS[sh().view?.font] ? FONTS[sh().view.font].label : FONTS.display.label);
  }

  // ------------------------------------------------------------- layout model from the sheet
  function geometry(s) {
    const cx = (c) => { let x = 0; for (let i = 0; i < c; i++) x += s.colW[i] ?? DEF_W; return x; };
    const ry = (r) => { let y = 0; for (let i = 0; i < r; i++) y += s.rowH[i] ?? DEF_H; return y; };
    const rect = (R) => { const x = cx(R.c1), y = ry(R.r1); return { x, y, w: cx(R.c2 + 1) - x, h: ry(R.r2 + 1) - y }; };
    return { cx, ry, rect };
  }
  function model(name = sheetName) {
    const s = doc.sheets.find((x) => sameName(x.name, name)) || doc.sheets[0];
    const en = new Engine(doc), G = geometry(s), K = s.name + '::';
    const items = [];
    const tabs = allTables(doc).filter((x) => x.sh === s);
    const charts = (s.charts || []).map((ch) => {
      const p = parseAddr(splitSheet(ch.at)[1]) || { c: 0, r: 0 };
      return { ch, r: { x: G.cx(p.c) + (ch.dx || 0), y: G.ry(p.r) + (ch.dy || 0), w: ch.w, h: ch.h } };
    });
    const under = (r) => charts.some(({ r: c }) => r.x < c.x + c.w && c.x < r.x + r.w && r.y < c.y + c.h && c.y < r.y + r.h);
    for (const { ch, r } of charts) {
      let data;
      try { data = chartData(doc, s.name, ch, en); } catch { data = { labels: [], series: [] }; }
      let light = null;
      if (ch.type === 'kpi' && ch.value) {
        const [vs, va] = splitSheet(ch.value);
        const vsh = vs ? doc.sheets.find((x) => sameName(x.name, vs)) : s, vp = parseAddr(va);
        if (vsh && vp) light = condStyle(en, vsh, vp.c, vp.r, en.value(vsh, vp.c, vp.r))?.dot;
      }
      items.push({ key: K + 'chart:' + ch.id, sheet: s.name, kind: ch.type === 'kpi' ? 'kpi' : ch.type === 'viz' ? 'viz' : 'chart', ch, data, r, light });
    }
    for (const x of tabs) {
      const r = G.rect(x.R);
      if (under(r)) continue;
      const cols = tableColumns(x.sh, x.R);
      const rows = [];
      for (let rr = x.R.r1 + 1; rr <= x.R.r2; rr++) {
        const row = [];
        for (let c = x.R.c1; c <= x.R.c2; c++) {
          const A = addr(c, rr), cell = s.cells[A];
          const v = en.value(s, c, rr);
          row.push({ A, raw: cell?.v ?? '', text: fmtValue(v), num: typeof v === 'number', formula: typeof cell?.v === 'string' && cell.v[0] === '=', err: isErr(v), light: condStyle(en, s, c, rr, v)?.dot, viz: isViz(v) ? { pack: v.pack, value: v.value, label: v.label } : null });
        }
        rows.push(row);
      }
      const above = x.R.r1 > 0 && [x.R.c1, x.R.c1 + 1].some((c) => String(s.cells[addr(c, x.R.r1 - 1)]?.v ?? '').trim());
      items.push({ key: K + 'table:' + x.t.name, sheet: s.name, kind: 'table', name: x.t.name, label: !above, cols, rows, r: { ...r, h: Math.max(r.h, 60) } });
    }
    const inTable = (c, r) => tabs.some((x) => c >= x.R.c1 && c <= x.R.c2 && r >= x.R.r1 && r <= x.R.r2);
    for (const A of Object.keys(s.cells)) {
      const cell = s.cells[A];
      if (cell.v === '' || cell.v == null) continue;
      const p = parseAddr(A);
      if (inTable(p.c, p.r)) continue;
      const M = mergeAt(s, p.c, p.r);
      if (M && (M.c1 !== p.c || M.r1 !== p.r)) continue;
      const r = G.rect(M || { c1: p.c, r1: p.r, c2: p.c, r2: p.r });
      if (under(r)) continue;
      const v = en.value(s, p.c, p.r);
      const st = cell.s || {};
      if (isImg(v)) items.push({ key: K + 'img:' + A, sheet: s.name, kind: 'img', url: v.url, r });
      else items.push({ key: K + 'text:' + A, sheet: s.name, kind: 'text', A, raw: cell.v, text: fmtValue(v), st, num: typeof v === 'number', formula: cell.v[0] === '=', merged: !!M, r, light: condStyle(en, s, p.c, p.r, v)?.dot });
    }
    return items;
  }

  // ------------------------------------------------------------- combined mode: all sheets, auto-composed
  let mode = 'sheet';
  try { mode = localStorage.getItem('spread.liveMode') === 'auto' ? 'auto' : 'sheet'; } catch {}
  const excluded = new Set();
  const ORDER = { panel: -1, kpi: 0, viz: 0.5, stat: 1, chart: 2, table: 3, img: 4, slot: 5 };
  function autoItems() {
    const out = [];
    for (const s of doc.sheets) {
      if (excluded.has(s.name)) continue;
      const items = model(s.name);
      // a sheet with plain data but no named table: show its used range as an implicit table
      if (!items.some((it) => it.kind === 'table' || it.kind === 'chart' || it.kind === 'kpi')) {
        const U = usedRange(s);
        if (U && U.r2 > U.r1 && U.c2 > U.c1 && (U.r2 - U.r1 + 1) * (U.c2 - U.c1 + 1) <= 4000) {
          const en = new Engine(doc);
          const cols = [];
          for (let c = U.c1; c <= U.c2; c++) cols.push(fmtValue(en.value(s, c, U.r1)) || ' ');
          const rows = [];
          for (let r = U.r1 + 1; r <= U.r2; r++) {
            const row = [];
            for (let c = U.c1; c <= U.c2; c++) {
              const A = addr(c, r), cell = s.cells[A], v = en.value(s, c, r);
              row.push({ A, raw: cell?.v ?? '', text: fmtValue(v), num: typeof v === 'number', formula: typeof cell?.v === 'string' && cell.v[0] === '=', err: isErr(v), light: condStyle(en, s, c, r, v)?.dot, viz: isViz(v) ? { pack: v.pack, value: v.value, label: v.label } : null });
            }
            rows.push(row);
          }
          out.push({ key: s.name + '::range', kind: 'table', sheet: s.name, name: s.name, label: true, cols, rows, r: { x: 0, y: 0, w: 400, h: 200 } });
          continue;
        }
      }
      const rows = new Map();
      for (const it of items) {
        if (it.kind !== 'text') { out.push(it); continue; }
        const r = parseAddr(it.A).r;
        if (!rows.has(r)) rows.set(r, []);
        rows.get(r).push(it);
      }
      // "label | value" rows become stat cards
      for (const list of rows.values()) {
        list.sort((a, b) => parseAddr(a.A).c - parseAddr(b.A).c);
        if (list.length === 2 && !list[0].num && list[1].num) {
          out.push({ key: s.name + '::stat:' + list[1].A, kind: 'stat', sheet: s.name, label: list[0].text, value: list[1], r: list[1].r });
        }
      }
    }
    // the same number under the same label (e.g. a KPI and the cell it reads) is shown once
    const seenStat = new Set();
    out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    const uniq = out.filter((it) => {
      if (it.kind !== 'kpi' && it.kind !== 'stat') return true;
      const label = (it.kind === 'kpi' ? it.ch.title || it.data.kpi.label : it.label).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const val = it.kind === 'kpi' ? it.data.kpi.value : it.value.text;
      const k = label + '=' + (typeof val === 'number' ? +val.toFixed(6) : String(val).replace(',', '.'));
      if (seenStat.has(k)) return false;
      seenStat.add(k);
      return true;
    });
    uniq.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    const L = doc.live || {};
    const panels = (L.panels || []).map((p) => ({ key: 'live::panel:' + p.id, kind: 'panel', sheet: 'live', p }));
    const slots = (L.slots || []).map((sl) => ({ key: 'live::slot:' + sl.id, kind: 'slot', sheet: 'live', sl }));
    let all = [...panels, ...uniq, ...slots].filter((it) => !(L.hidden || []).includes(it.key));
    if (Array.isArray(slide?.cards)) {
      const want = slide.cards.map((k) => String(k).toLowerCase());
      const match = (it, w) => { const k = it.key.toLowerCase(), tail = k.split('::')[1] || ''; return k === w || tail === w || tail.slice(tail.indexOf(':') + 1) === w; };
      all = [...new Set(want.map((w) => all.find((it) => match(it, w))).filter(Boolean))];
      return all;
    }
    if (!L.order?.length) return all;
    const idx = new Map(L.order.map((k, i) => [k, i]));
    const fresh = all.filter((it) => !idx.has(it.key) && it.kind === 'panel');       // new agent panels show up on top
    const known = all.filter((it) => idx.has(it.key)).sort((a, b) => idx.get(a.key) - idx.get(b.key));
    const rest = all.filter((it) => !idx.has(it.key) && it.kind !== 'panel');
    return [...fresh, ...known, ...rest];
  }
  function styleFor(key) {
    const L = doc.live || {}, all = L.styles || {};
    const k = key.toLowerCase(), tail = k.split('::')[1] || '';
    const hit = Object.entries(all).find(([q]) => { const w = q.toLowerCase(); return w === k || w === tail || w === tail.slice(tail.indexOf(':') + 1); })?.[1] || {};
    return { card: hit.card || L.cards || 'glass', lines: hit.lines || L.lines || 'rows' };
  }
  function spanOf(it, cols) {
    const o = doc.live?.spans?.[it.key];
    const n = o?.span || (it.kind === 'table' ? (it.cols.length >= 6 ? 3 : it.cols.length >= 4 ? 2 : 1)
      : it.kind === 'chart' ? (it.ch.type !== 'pie' && it.ch.w >= 520 ? 2 : 1)
        : it.kind === 'panel' || it.kind === 'slot' ? (it.p || it.sl).span || 1 : 1);
    const min = ['kpi', 'viz', 'stat', 'slot', 'img', 'panel'].includes(it.kind) ? 0.5 : 1;
    return Math.max(min, Math.min(n, cols));
  }
  const FIXED_H = { kpi: 150, viz: 230, stat: 118, chart: 300, img: 260, slot: 180 };
  const heightOf = (it) => doc.live?.spans?.[it.key]?.h || (it.kind === 'panel' ? it.p.h : it.kind === 'slot' ? it.sl.h : 0) || FIXED_H[it.kind] || 0;

  // ------------------------------------------------------------- rendering (keyed)
  const nodes = new Map();       // key -> { el, item, tween }
  let scale = 1, bx = 0, by = 0, offX = 0;
  const PAD = 56;

  function layoutScale(items) {
    if (!items.length) return;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const it of items) {
      const w = it.kind === 'text' && !it.merged && !it.st.wrap ? Math.max(it.r.w, textWidth(it) + 8) : it.r.w;
      x1 = Math.min(x1, it.r.x); y1 = Math.min(y1, it.r.y); x2 = Math.max(x2, it.r.x + w); y2 = Math.max(y2, it.r.y + it.r.h);
    }
    const W = scroller.clientWidth - PAD * 2;
    scale = Math.max(0.5, Math.min(1.9, W / (x2 - x1)));
    bx = x1; by = y1;
    offX = PAD + Math.max(0, (W - (x2 - x1) * scale) / 2);
    stage.style.height = (y2 - y1) * scale + PAD * 2 + 80 + 'px';
  }
  const meas = document.createElement('canvas').getContext('2d');
  function textWidth(it) { meas.font = `${it.st.b ? 600 : 400} ${it.st.fs || 13}px system-ui`; return meas.measureText(it.text).width; }
  function place(el, r, autoH) {
    el.style.left = offX + (r.x - bx) * scale + 'px';
    el.style.top = PAD + (r.y - by) * scale + 'px';
    el.style.width = r.w * scale + 'px';
    if (!autoH) el.style.height = r.h * scale + 'px';
  }

  let vtSeq = 0;
  function fxKind() { return FX.includes(doc.live?.fx) ? doc.live.fx : 'morph'; }
  /** Traffic light on a card: a glowing dot and a colored edge; color changes cross-fade. */
  function setLight(el, color) {
    el.classList.toggle('lv-lit', !!color);
    if (color) el.style.setProperty('--light', color); else el.style.removeProperty('--light');
  }
  // ------------------------------------------------------------- flip: the sheet behind a card
  function fillBack(n, back, withHistory) {
    const keep = back.querySelector('.lv-back-hist')?.innerHTML || '';
    back.innerHTML = backSide(n.item, { doc });
    back.querySelector('.lv-back-hist').innerHTML = keep;
    if (!withHistory) return;
    const it = n.item;
    const q = it.kind === 'table' && !it.key.endsWith('::range') ? `table=${encodeURIComponent(it.name)}`
      : it.kind === 'kpi' || it.kind === 'viz' ? `cell=${encodeURIComponent(it.ch.value.includes('!') ? it.ch.value : it.sheet + '!' + it.ch.value)}`
        : it.kind === 'stat' ? `cell=${encodeURIComponent(it.sheet + '!' + it.value.A)}` : null;
    if (!q) return;
    fetch(`/api/history?${q}&format=json`).then((r) => r.json()).then((list) => {
      const el = back.querySelector('.lv-back-hist');
      if (!el || !list.length) return;
      el.innerHTML = '<div class="lv-back-sub">recent changes</div>' + list.slice(0, 8).map((x) => `<div><span>${new Date(x.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${escH(x.who || x.by)}</span> ${escH(x.at || '')} ${x.moved ? (x.away ? 'cut away ' : 'moved ') + escH(x.moved) : x.table ? 'table ' + escH(x.table) : `${escH(x.old || '∅')} → <b>${escH(x.new || '∅')}</b>`}</div>`).join('');
    }).catch(() => {});
  }
  const escH = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ------------------------------------------------------------- adaptive ink: dark text on light backgrounds, per card
  function adaptInk() {
    // One decision for the whole screen (consistent look), with per-card exceptions only where the background behind
    // a card is clearly on the other side (a bright patch on a dark image, or the reverse).
    const lum = sampleBackground(root);
    const whole = lum(root);
    if (whole == null) return;
    const bright = root.classList.contains('lv-bright') ? whole > 0.5 : whole > 0.56;   // hysteresis
    root.classList.toggle('lv-bright', bright);
    const decide = (el) => {
      const L = lum(el);
      if (L == null) return bright;
      const was = el.classList.contains('lv-ink-dark');
      if (bright) return !(L < (was ? 0.3 : 0.26));
      return L > (was ? 0.66 : 0.72);
    };
    for (const n of nodes.values()) {
      const dark = decide(n.el);
      if (dark !== n.el.classList.contains('lv-ink-dark')) {
        n.el.classList.toggle('lv-ink-dark', dark);
        if (n.item.kind === 'chart') paintChart(n, n.item);
      }
    }
    const t = $('.lv-slidetext');
    if (t.childElementCount) {
      // judge the text by where its glyphs are, not by the full-width block
      const box = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
      const tw = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
      const rg = document.createRange();
      for (let nd = tw.nextNode(); nd; nd = tw.nextNode()) {
        if (!nd.nodeValue.trim()) continue;
        rg.selectNodeContents(nd);
        const q = rg.getBoundingClientRect();
        box.l = Math.min(box.l, q.left); box.t = Math.min(box.t, q.top); box.r = Math.max(box.r, q.right); box.b = Math.max(box.b, q.bottom);
      }
      const glyphs = { getBoundingClientRect: () => ({ left: box.l, top: box.t, right: box.r, bottom: box.b }) };
      const L = box.r > box.l ? lum(glyphs) : null, was = t.classList.contains('lv-ink-dark');
      t.classList.toggle('lv-ink-dark', L == null ? bright : bright ? !(L < (was ? 0.3 : 0.26)) : L > (was ? 0.66 : 0.72));
    }
  }
  const inkTimer = setInterval(() => { if (!document.hidden) adaptInk(); }, 1500);
  const beat = setInterval(() => reportState(), 30000);   // keeps this screen listed for remotes

  // ------------------------------------------------------------- slides: views become a presentation
  let playing = false, slideIdx = -1, slideTimer = null;
  const slides = () => doc.live?.slides || [];
  function renderSlideText() {
    const t = $('.lv-slidetext');
    const has = slide && (slide.title || slide.text);
    const solo = has && Array.isArray(slide.cards) && slide.cards.length === 0;
    root.classList.toggle('lv-slide-solo', !!solo);
    stage.classList.toggle('lv-titled', !!has && !solo);
    if (!has) { t.innerHTML = ''; return; }
    const html = `${slide.title ? `<h1>${escH(slide.title)}</h1>` : ''}${slide.text ? `<div class="lv-md">${mdLite(slide.text)}</div>` : ''}`;
    if (t.dataset.html !== html) { t.innerHTML = html; t.dataset.html = html; t.classList.remove('lv-reveal'); void t.offsetWidth; t.classList.add('lv-reveal'); }
  }
  function showSlide(i, quiet) {
    const list = slides();
    if (!list.length) return;
    slideIdx = (i + list.length) % list.length;
    const sl = list[slideIdx];
    const apply = () => { try { applySlide(); } catch (e) { console.error('slide', e); } };
    const applySlide = () => {
      slide = sl;
      if (sl.sheet && doc.sheets.some((x) => sameName(x.name, sl.sheet))) sheetName = doc.sheets.find((x) => sameName(x.name, sl.sheet)).name;
      mode = sl.mode === 'sheet' ? 'sheet' : sl.mode === 'auto' ? 'auto' : mode;
      revealed.clear();
      applyTheme();
      render();
      scroller.scrollTo(0, 0);
      setFocus(sl.focus || null, true);
      renderDots();
      renderSlidePanel();
    };
    if (quiet) apply(); else transition(apply);
    clearTimeout(slideTimer);
    const bar = $('.lv-progress i');
    bar.getAnimations?.().forEach((a) => a.cancel());
    if (playing && sl.duration > 0) {
      bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: sl.duration * 1000, easing: 'linear', fill: 'forwards' });
      slideTimer = setTimeout(() => next(1), sl.duration * 1000);
    }
  }
  function next(d) { if (slides().length) showSlide(slideIdx + d); }

  // ------------------------------------------------------------- remote control: step through slides, or through cards
  let cTimer = null;
  function cardStep(d) {
    const keys = [...stage.children].map((x) => x.dataset?.key).filter((k) => k && nodes.has(k) && !k.includes('::text:') && !k.startsWith('live::slot'));
    if (!keys.length) return;
    const i = keys.indexOf(focusKey);
    setFocus(keys[i < 0 ? (d > 0 ? 0 : keys.length - 1) : (i + d + keys.length) % keys.length]);
  }
  function startCarousel() {
    stopCarousel();
    cardStep(1);
    cTimer = setInterval(() => { if (!document.hidden) cardStep(1); }, (doc.live?.carousel || 7) * 1000);
    root.classList.add('lv-carousel');
    reportState();
  }
  function stopCarousel() { if (cTimer) { clearInterval(cTimer); cTimer = null; root.classList.remove('lv-carousel'); } }
  function remoteAction(a) {
    const hasSlides = slides().length > 0;
    switch (a) {
      case 'next': case 'prev': {
        const d = a === 'next' ? 1 : -1;
        if (hasSlides) { if (slideIdx < 0) { playing = false; showSlide(d > 0 ? 0 : slides().length - 1); } else showSlide(slideIdx + d); }
        else if (cTimer) { clearInterval(cTimer); cardStep(d); cTimer = setInterval(() => { if (!document.hidden) cardStep(1); }, (doc.live?.carousel || 7) * 1000); }
        else cardStep(d);
        break;
      }
      case 'toggle': return remoteAction(playing || cTimer ? 'pause' : 'play');   // the screen knows its own state: no race
      case 'play': if (hasSlides) play(slideIdx >= 0 ? slideIdx : 0); else startCarousel(); break;
      case 'pause': stopCarousel(); if (playing) stopPlaying(); break;
      case 'unfocus': stopCarousel(); if (playing || slide) leaveSlide(); setFocus(null); break;
    }
    reportState();
  }
  function play(from = 0) {
    if (!slides().length) return;
    playing = true;
    root.classList.add('lv-playing');
    showSlide(from);
  }
  function stopPlaying() {
    playing = false;
    clearTimeout(slideTimer);
    root.classList.remove('lv-playing');
    $('.lv-progress i').getAnimations?.().forEach((a) => a.cancel());
    renderDots();
  }
  function leaveSlide() { stopPlaying(); slide = null; slideIdx = -1; applyTheme(); render(); renderSlidePanel(); }
  function renderDots() {
    const d = $('.lv-dots');
    d.innerHTML = playing ? slides().map((_, i) => `<i class="${i === slideIdx ? 'on' : ''}"></i>`).join('') + `<span>${slideIdx + 1} / ${slides().length}</span>` : '';
  }
  function captureView() {
    let n = slides().length + 1;
    while (slides().some((x) => x.id === 's' + n)) n++;
    const f = focusKey ? nodes.get(focusKey)?.item : null;
    const title = f ? (f.ch?.title || f.name || f.label || '') : mode === 'auto' ? 'Overview' : sh().name;
    return { op: 'slide', id: 's' + n, title, sheet: sh().name, mode, focus: focusKey ? focusKey.split('::')[1] : null, duration: 8 };
  }
  function renderSlidePanel() {
    const p = $('.lv-slides');
    if (!root.classList.contains('lv-slides-open')) return;
    const list = slides();
    p.innerHTML = `<div class="lv-sl-head"><b>Slides</b><span>${list.length}</span>
        <button class="lv-btn" data-s="add" title="Add the current view as a slide">＋ This view</button>
        <button class="lv-btn" data-s="text" title="A slide with just a title and text">＋ Text</button>
        <button class="lv-btn on" data-s="play">▶ Play</button><button class="lv-btn" data-s="close" title="Close">✕</button></div>
      <div class="lv-sl-list">${list.map((x, i) => `
        <div class="lv-sl ${i === slideIdx ? 'on' : ''}" data-id="${escH(x.id)}" data-i="${i}">
          <div class="lv-sl-n">${i + 1}</div>
          <div class="lv-sl-body">
            <div class="lv-sl-title" contenteditable="plaintext-only" data-k="title" spellcheck="false">${escH(x.title || '')}</div>
            <div class="lv-sl-text" contenteditable="plaintext-only" data-k="text" spellcheck="false">${escH(x.text || '')}</div>
            <div class="lv-sl-meta">${escH(x.sheet || '')} · ${x.mode === 'auto' ? 'combined' : 'sheet'}${x.focus ? ' · ' + escH(x.focus) : ''}${Array.isArray(x.cards) ? ` · ${x.cards.length} cards` : ''}</div>
            <div class="lv-sl-bg">
              <input data-k="image" placeholder="background image / GIF / SVG url — or drop a file" value="${escH(x.bg?.image || '')}">
              <select data-k="filter">${['none', 'dither', 'halftone'].map((f) => `<option ${(x.bg?.filter || 'none') === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
              <input data-k="duration" type="number" min="0" step="1" value="${x.duration ?? 8}" title="seconds (0 = manual)">s
            </div>
          </div>
          <div class="lv-sl-tools"><button data-s="go" title="Show">▸</button><button data-s="up" title="Move up">↑</button><button data-s="down" title="Move down">↓</button><button data-s="del" title="Delete">✕</button></div>
        </div>`).join('') || '<div class="lv-sl-empty">Arrange a view (sheet, combined, focus…), then “＋ This view”. Slides can have a title, text and a background image, GIF or SVG.</div>'}</div>`;
  }
  $('.lv-slides').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    const row = b.closest('.lv-sl'), id = row?.dataset.id, i = row ? +row.dataset.i : -1;
    switch (b.dataset.s) {
      case 'add': submit([captureView()]); break;
      case 'text': { const o = captureView(); submit([{ ...o, title: 'Title', text: 'Write something **bold**\n- and a bullet', cards: [], mode: 'auto', focus: null }]); break; }
      case 'play': play(0); root.classList.remove('lv-slides-open'); break;
      case 'close': root.classList.remove('lv-slides-open'); return;
      case 'go': showSlide(i); break;
      case 'up': if (i > 0) submit([{ op: 'slide', id, index: i - 1 }]); break;
      case 'down': submit([{ op: 'slide', id, index: i + 1 }]); break;
      case 'del': submit([{ op: 'removeSlide', id }]); if (slideIdx === i) leaveSlide(); break;
    }
    renderSlidePanel();
  });
  $('.lv-slides').addEventListener('focusout', (e) => {
    const k = e.target.dataset?.k, row = e.target.closest('.lv-sl');
    if (!k || !row || (k !== 'title' && k !== 'text')) return;
    const sl = slides().find((x) => x.id === row.dataset.id);
    const v = e.target.textContent;
    if (sl && (sl[k] || '') !== v) { submit([{ op: 'slide', id: sl.id, [k]: v || null }]); if (slide?.id === sl.id) { slide = slides().find((x) => x.id === sl.id); renderSlideText(); } }
  });
  $('.lv-slides').addEventListener('change', (e) => {
    const k = e.target.dataset?.k, row = e.target.closest('.lv-sl');
    if (!row || !['image', 'filter', 'duration'].includes(k)) return;
    const sl = slides().find((x) => x.id === row.dataset.id);
    if (!sl) return;
    const bg = { ...(sl.bg || {}) };
    if (k === 'image') { if (e.target.value.trim()) bg.image = e.target.value.trim(); else delete bg.image; }
    if (k === 'filter') { if (e.target.value === 'none') delete bg.filter; else bg.filter = e.target.value; }
    submit([k === 'duration' ? { op: 'slide', id: sl.id, duration: +e.target.value || 0 } : { op: 'slide', id: sl.id, bg: Object.keys(bg).length ? bg : null }]);
    if (slide?.id === sl.id) showSlide(slideIdx, true);
  });
  $('.lv-slides').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && e.target.dataset?.k === 'title') { e.preventDefault(); e.target.blur(); } });
  $('.lv-slides').addEventListener('dragover', (e) => { if (e.target.closest('.lv-sl')) e.preventDefault(); });
  $('.lv-slides').addEventListener('drop', async (e) => {
    const row = e.target.closest('.lv-sl');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (!row || !f) return;
    e.preventDefault();
    const { url } = await (await fetch('/api/assets', { method: 'POST', headers: { 'content-type': f.type }, body: f })).json();
    const sl = slides().find((x) => x.id === row.dataset.id);
    submit([{ op: 'slide', id: sl.id, bg: { ...(sl.bg || {}), image: url } }]);
    renderSlidePanel();
    if (slide?.id === sl.id) showSlide(slideIdx, true);
  });

  // ------------------------------------------------------------- people in Live
  function showPeople(list) {
    const el = $('.lv-people');
    el.innerHTML = (list || []).filter((p) => !p.me).slice(0, 8).map((p) => `<b style="background:${escH(p.color || '#888')}" title="${escH(p.name)}${p.live ? ' — in Live' : ''}">${escH((p.name || '?').slice(0, 1).toUpperCase())}</b>`).join('');
  }
  // ------------------------------------------------------------- reveal cards as they scroll into view
  const revealed = new Set();
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      io.unobserve(el);
      revealed.add(el.dataset.key);
      el.classList.remove('lv-hidden');
      el.classList.add('lv-reveal');
      el.addEventListener('animationend', () => el.classList.remove('lv-reveal'), { once: true });
    }
  }, { root: scroller, threshold: 0.12 }) : null;
  function observeReveal() {
    const on = doc.live?.reveal !== false && io && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const n of nodes.values()) {
      if (!on || revealed.has(n.item.key)) { n.el.classList.remove('lv-hidden'); continue; }
      const r = n.el.getBoundingClientRect(), v = scroller.getBoundingClientRect();
      const inView = r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;
      if (inView) { revealed.add(n.item.key); continue; }   // already on screen: no reveal
      n.el.classList.add('lv-hidden');
      io.observe(n.el);
    }
  }

  // ------------------------------------------------------------- tell the server what the user sees (the agent can read it)
  let stateTimer = null;
  function reportState(closing) {
    clearTimeout(stateTimer);
    const send = () => {
      const v = scroller.getBoundingClientRect();
      const cards = [...nodes.values()].map((n) => {
        const r = n.el.getBoundingClientRect(), it = n.item;
        const summary = it.kind === 'viz' ? `${it.ch.pack}: ${it.data.viz.text}` : it.kind === 'kpi' ? `= ${it.data.kpi.text}`
          : it.kind === 'stat' ? `${it.label} = ${it.value.text}`
            : it.kind === 'chart' ? `${it.ch.type}: ${it.data.labels.slice(0, 6).map((l, i) => `${l} ${it.data.series.map((s2) => s2.values[i] ?? '∅').join('/')}`).join(', ')}`
              : it.kind === 'table' ? `${it.rows.length} rows [${it.cols.join(' | ')}]`
                : it.kind === 'panel' ? (it.p.text || '').slice(0, 80).replace(/\n/g, ' ')
                  : it.kind === 'slot' ? (it.sl.image ? 'image ' + it.sl.image : 'empty space')
                    : it.kind === 'text' ? it.text.slice(0, 60) : '';
        const title = it.kind === 'chart' || it.kind === 'kpi' || it.kind === 'viz' ? it.ch.title : it.kind === 'table' ? it.name : it.kind === 'panel' ? it.p.title : it.kind === 'stat' ? it.label : '';
        return {
          key: it.key, kind: it.kind, title, summary,
          x: Math.round(r.left - v.left + scroller.scrollLeft), y: Math.round(r.top - v.top + scroller.scrollTop), w: Math.round(r.width), h: Math.round(r.height),
          visible: r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right && !n.el.classList.contains('lv-hidden'),
        };
      });
      const body = closing ? { open: false, screen: ctx.screen?.id } : {
        screen: ctx.screen?.id, name: ctx.screen?.name, playing: playing || !!cTimer, slides: slides().length,
        open: true, mode, sheet: sh().name, focus: focusKey, flow: doc.live?.flow || 'vertical', quality: gov.frozen ? 'still' : ['full', 'half', 'low', 'minimal'][gov.level], slide: playing ? slideIdx + 1 : null,
        vw: Math.round(v.width), vh: Math.round(v.height), scroll: [scroller.scrollLeft, scroller.scrollTop], cards,
      };
      ctx.livePresence?.(closing ? null : { mode, sheet: sh().name, focus: focusKey, slide: playing ? slideIdx + 1 : null });
      fetch('/api/live-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    };
    if (closing) send(); else stateTimer = setTimeout(send, 400);
  }
  scroller.addEventListener('scroll', () => reportState(), { passive: true });
  // horizontal flow: the mouse wheel scrolls sideways
  scroller.addEventListener('wheel', (e) => {
    if (!root.classList.contains('lv-h') || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    scroller.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // ------------------------------------------------------------- drag to rearrange / resize (mouse, pen and touch)
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || focusKey) return;
    const rs = e.target.closest('.lv-rs');
    const card = e.target.closest('.lv-card');
    if (!card || e.target.closest('[contenteditable="plaintext-only"], .lv-zoom, button, a')) return;
    const n = nodes.get(card.dataset.key);
    if (!n) return;
    if (mode === 'sheet' && n.item.kind !== 'chart' && n.item.kind !== 'kpi') return;   // sheet layout: only charts float
    drag = { n, el: card, kind: rs ? 'resize' : 'move', x0: e.clientX, y0: e.clientY, r0: card.getBoundingClientRect(), id: e.pointerId, touch: e.pointerType === 'touch', active: false, timer: null };
    if (drag.touch) drag.timer = setTimeout(activate, 320);   // long-press on touch, so normal scrolling still works
  });
  function activate() {
    if (!drag || drag.active) return;
    drag.active = true;
    try { drag.el.setPointerCapture(drag.id); } catch {}
    drag.el.classList.add(drag.kind === 'move' ? 'lv-dragging' : 'lv-resizing');
    root.classList.add('lv-arranging');
    if (navigator.vibrate && drag.touch) navigator.vibrate(12);
  }
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (drag.touch) { if (Math.hypot(dx, dy) > 10) { clearTimeout(drag.timer); drag = null; } return; }
      if (Math.hypot(dx, dy) < 6) return;
      activate();
    }
    e.preventDefault();
    if (drag.kind === 'move') {
      drag.dx = dx; drag.dy = dy;
      drag.el.style.translate = `${dx}px ${dy}px`;
      stage.querySelectorAll('.lv-drop-before, .lv-drop-after').forEach((x) => x.classList.remove('lv-drop-before', 'lv-drop-after'));
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains('lv-card') && x !== drag.el);
      drag.target = null;
      if (under && mode === 'auto') {
        const ur = under.getBoundingClientRect();
        const after = root.classList.contains('lv-h') ? e.clientY > ur.top + ur.height / 2 : e.clientX > ur.left + ur.width / 2;
        under.classList.add(after ? 'lv-drop-after' : 'lv-drop-before');
        drag.target = { key: under.dataset.key, after };
      }
    } else {
      drag.w = Math.max(96, drag.r0.width + dx);
      drag.h = Math.max(72, drag.r0.height + dy);
      drag.el.style.width = drag.w + 'px';
      drag.el.style.height = drag.h + 'px';
    }
  });
  stage.addEventListener('touchmove', (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    clearTimeout(drag.timer);
    const d = drag;
    drag = null;
    root.classList.remove('lv-arranging');
    stage.querySelectorAll('.lv-drop-before, .lv-drop-after').forEach((x) => x.classList.remove('lv-drop-before', 'lv-drop-after'));
    if (!d.active) return;
    d.el.classList.remove('lv-dragging', 'lv-resizing');
    d.el.style.translate = '';
    const key = d.n.item.key;
    if (d.kind === 'move' && mode === 'auto') {
      if (!d.target) return render();
      const keys = [...stage.children].map((x) => x.dataset.key).filter((k) => k && k !== key && !k.includes('::text:'));
      let i = keys.indexOf(d.target.key);
      if (d.target.after) i++;
      keys.splice(i, 0, key);
      transition(() => { submit([{ op: 'liveLayout', order: keys }]); });
    } else if (d.kind === 'move') {
      // sheet layout: a floating chart gets a new anchor cell
      const ch = d.n.item.ch, G = geometry(sh());
      const left = parseFloat(d.el.style.left) + (d.dx || 0), top = parseFloat(d.el.style.top) + (d.dy || 0);
      const sxp = Math.max(0, (left - offX) / scale + bx), syp = Math.max(0, (top - PAD) / scale + by);
      let c = 0; while (G.cx(c + 1) <= sxp && c < 500) c++;
      let r = 0; while (G.ry(r + 1) <= syp && r < 5000) r++;
      submit([{ op: 'updateChart', id: ch.id, at: addr(c, r), dx: Math.round(sxp - G.cx(c)), dy: Math.round(syp - G.ry(r)) }]);
    } else if (mode === 'auto') {
      const hflow = root.classList.contains('lv-h');
      const units = hflow ? 6 : Math.max(1, getComputedStyle(stage).gridTemplateColumns.split(' ').length);
      const gap = parseFloat(getComputedStyle(stage).columnGap) || 18;
      const uw = hflow ? 161 : parseFloat(getComputedStyle(stage).gridTemplateColumns) || 160;
      const min = ['kpi', 'viz', 'stat', 'slot', 'img', 'panel'].includes(d.n.item.kind) ? 1 : 2;
      const span = Math.max(min, Math.min(units, Math.round((d.w + gap) / (uw + gap)))) / 2;
      const spans = { ...(doc.live?.spans || {}), [key]: { span, ...(d.n.item.kind !== 'table' ? { h: Math.round(d.h) } : {}) } };
      transition(() => { submit([{ op: 'liveLayout', spans }]); });
    } else if (d.n.item.kind === 'chart' || d.n.item.kind === 'kpi') {
      submit([{ op: 'updateChart', id: d.n.item.ch.id, w: Math.round(d.w / scale), h: Math.round(d.h / scale) }]);
    } else render();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------- focus mode: one view, full screen, still live
  let focusKey = null;
  function resolveKey(ref) {
    if (!ref) return null;
    if (nodes.has(ref)) return ref;
    const r = String(ref).toLowerCase();
    for (const k of nodes.keys()) {
      const tail = k.split('::')[1].toLowerCase();               // chart:status | table:tasks | stat:C12 | text:B2
      if (tail === r || tail.split(':')[1] === r) return k;
    }
    return null;
  }
  function setFocus(ref, quiet) {
    const key = resolveKey(ref);
    const apply = () => {
      focusKey = key;
      root.classList.toggle('lv-focusing', !!key);
      for (const n of nodes.values()) n.el.classList.toggle('lv-focus', n.item.key === key);
      for (const n of nodes.values()) if (n.item.kind === 'chart') paintChart(n, n.item);
      for (const n of nodes.values()) if (n.item.kind === 'kpi') update(n, n.item);
      syncUrl();
    };
    if (quiet) apply(); else transition(apply);
  }
  function syncUrl() {
    try {
      const u = new URL(location.href);
      u.searchParams.set('live', sh().name);
      u.searchParams.set('mode', mode);
      if (focusKey) u.searchParams.set('focus', focusKey.split('::')[1]); else u.searchParams.delete('focus');
      history.replaceState(null, '', u);
    } catch {}
  }
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('[contenteditable="plaintext-only"]')) return;
    const slot = e.target.closest('.lv-slot');
    if (slot) { const id = slot.dataset.key.split(':').pop(); return transition(() => submit([{ op: 'liveLayout', slots: (doc.live?.slots || []).filter((x) => x.id !== id) }])); }
    const card = e.target.closest('.lv-card');
    if (card) setFocus(focusKey === card.dataset.key ? null : card.dataset.key);
  });
  stage.addEventListener('click', (e) => {
    const fb = e.target.closest('.lv-flip');
    if (fb) {
      e.stopPropagation();
      const n = nodes.get(fb.parentElement.dataset.key);
      if (n) flip(n.el, (back) => fillBack(n, back, true));
      return;
    }
    if (playing && !e.target.closest('.lv-card, [contenteditable]')) { next(1); return; }
    const b = e.target.closest('.lv-zoom');
    if (b) { e.stopPropagation(); const k = b.parentElement.dataset.key; setFocus(focusKey === k ? null : k); }
  });
  function render() {
    renderSlideText();   // first: it decides whether the stage is visible at all (measurements need it)
    const auto = mode === 'auto';
    const items = auto ? autoItems() : model();
    const hflow = auto && doc.live?.flow === 'horizontal';
    stage.classList.toggle('lv-grid', auto && !hflow);
    stage.classList.toggle('lv-hflow', hflow);
    root.classList.toggle('lv-auto', auto);
    root.classList.toggle('lv-h', hflow);
    if (auto) { scale = 1; stage.style.height = ''; } else layoutScale(items);
    const seen = new Set();
    // the grid has half-width units: a normal card spans two, a small KPI can be a single square unit
    const units = hflow ? 6 : auto ? Math.max(1, getComputedStyle(stage).gridTemplateColumns.split(' ').length) : 2;
    const cols = Math.max(1, Math.floor(units / 2));
    const unitW = auto && !hflow ? parseFloat(getComputedStyle(stage).gridTemplateColumns) || 160 : 160;
    for (const it of items) {
      seen.add(it.key);
      let n = nodes.get(it.key);
      if (!n) {
        n = { el: create(it), item: null, tween: null };
        n.el.style.viewTransitionName = 'lv' + ++vtSeq;
        nodes.set(it.key, n);
        stage.append(n.el);
        n.el.classList.add('lv-in');
        n.el.addEventListener('animationend', () => n.el.classList.remove('lv-in'), { once: true });
      }
      if (auto) {
        stage.append(n.el); // DOM order = visual order in the grid
        n.el.style.left = n.el.style.top = n.el.style.width = '';
        const span = spanOf(it, cols), small = span < 1;
        const hh = small && !doc.live?.spans?.[it.key]?.h ? Math.round(hflow ? 161 : unitW) : heightOf(it);
        if (hflow) { n.el.style.gridColumn = ''; n.el.style.gridRowEnd = ''; n.el.style.width = Math.round(span * 340 + (span - 1) * 18) + 'px'; }
        else n.el.style.gridColumn = `span ${Math.max(1, Math.min(units, Math.round(span * 2)))}`;
        n.el.classList.toggle('lv-small', small);
        n.el.style.height = hh && it.kind !== 'table' ? hh + 'px' : 'auto';
        n.el.dataset.span = span;
        n.el.dataset.tag = doc.sheets.length > 1 ? it.sheet : '';
      } else { n.el.style.gridColumn = ''; n.el.style.gridRowEnd = ''; n.el.dataset.tag = ''; }
      // card look: per-card override (agent-controlled) › workbook default › glass
      const st = styleFor(it.key);
      n.el.dataset.card = st.card;
      if (it.kind === 'table') n.el.dataset.lines = st.lines; else delete n.el.dataset.lines;
      update(n, it);
      n.item = it;
    }
    for (const [k, n] of nodes) if (!seen.has(k)) { n.el.remove(); nodes.delete(k); }
    if (auto && !hflow) masonry(items); else if (!auto) reflow(items);
    observeReveal();
    renderSlideText();
    if (auto && doc.live?.links !== false && !Array.isArray(slide?.cards)) drawRelations(stage, findRelations(items), nodes);
    else stage.querySelector(':scope > svg.lv-links')?.remove();
    for (const n of nodes.values()) { const b = n.el.querySelector(':scope > .lv-back'); if (b) fillBack(n, b, false); }
    requestAnimationFrame(adaptInk);
    reportState();
    if (focusKey && !nodes.has(focusKey)) setFocus(null, true);
    for (const n of nodes.values()) n.el.classList.toggle('lv-focus', n.item.key === focusKey);
    for (const n of nodes.values()) if (n.item.kind === 'chart') paintChart(n, n.item);
    renderBar();
    tick();
  }
  /** Masonry: each card spans as many 4px grid rows as its height needs; `dense` fills the holes. */
  function masonry(items) {
    for (const it of items) {
      const el = nodes.get(it.key).el;
      el.style.gridRowEnd = `span ${Math.ceil((el.offsetHeight + 18) / 4)}`;
    }
  }
  /** Switch layouts with a View Transition so cards morph to their new places. */
  // While a view transition runs, the browser routes all input to its overlay. On a starved device one can hang
  // around after its animations end, swallowing clicks — so slow devices skip transitions, and none may outlive 1.5 s.
  let vtNow = null;
  function transition(fn) {
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches && gov.level < 2 && !gov.frozen) {
      const vt = document.startViewTransition(fn);
      vtNow = vt;
      for (const pr of [vt.ready, vt.finished, vt.updateCallbackDone]) pr?.catch(() => {});   // overlapping transitions just skip
      const guard = setTimeout(() => { try { vt.skipTransition(); } catch {} }, 1500);
      vt.finished.finally(() => { clearTimeout(guard); if (vtNow === vt) vtNow = null; }).catch(() => {});
    } else fn();
  }

  /** Tables take their natural height; everything below them (overlapping horizontally) moves down. */
  function reflow(items) {
    const shifts = [];
    for (const it of items) {
      if (it.kind !== 'table') continue;
      const el = nodes.get(it.key).el;
      el.style.height = 'auto';
      const natural = el.offsetHeight / scale;
      const extra = natural - it.r.h;
      if (extra > 1) shifts.push({ x1: it.r.x, x2: it.r.x + it.r.w, bottom: it.r.y + it.r.h, extra });
    }
    if (!shifts.length) return;
    let maxBottom = 0;
    for (const it of items) {
      let dy = 0;
      for (const sft of shifts) {
        const w = it.kind === 'text' ? Math.max(it.r.w, 200) : it.r.w;
        if (it.r.y >= sft.bottom - 1 && it.r.x < sft.x2 && sft.x1 < it.r.x + w) dy = Math.max(dy, sft.extra);
      }
      if (dy) place(nodes.get(it.key).el, { ...it.r, y: it.r.y + dy }, it.kind === 'table');
      maxBottom = Math.max(maxBottom, (it.r.y + dy - by) * scale + nodes.get(it.key).el.offsetHeight);
    }
    stage.style.height = Math.max(parseFloat(stage.style.height) || 0, maxBottom + PAD * 2 + 80) + 'px';
  }

  function create(it) {
    const el = document.createElement('div');
    el.dataset.key = it.key;
    if (it.kind !== 'text' && it.kind !== 'slot') queueMicrotask(() => { const z = document.createElement('button'); z.className = 'lv-zoom'; z.title = 'Focus (double-click)'; z.textContent = '⤢'; el.append(z); });
    if (it.kind !== 'text') queueMicrotask(() => { const h = document.createElement('div'); h.className = 'lv-rs'; h.title = 'Drag to resize'; el.append(h); });
    if (it.kind !== 'text' && it.kind !== 'slot' && it.kind !== 'img') queueMicrotask(() => { const f = document.createElement('button'); f.className = 'lv-flip'; f.title = 'Flip to the sheet side'; f.textContent = '⟲'; el.append(f); });
    if (it.kind === 'panel') {
      el.className = 'lv-card lv-panel';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-pv"></div><div class="lv-md"></div><img class="lv-pimg" alt="" draggable="false">';
      return el;
    }
    if (it.kind === 'slot') {
      el.className = 'lv-card lv-slot';
          el.innerHTML = '<img alt="" draggable="false"><span>space · drop an image</span>';
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', async (e) => {
        const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
        if (!f) return;
        e.preventDefault();
        const { url } = await (await fetch('/api/assets', { method: 'POST', headers: { 'content-type': f.type }, body: f })).json();
        const slots = (doc.live?.slots || []).map((x) => (x.id === it.sl.id ? { ...x, image: url } : x));
        submit([{ op: 'liveLayout', slots }]);
      });
      return el;
    }
    if (it.kind === 'chart') {
      el.className = 'lv-card lv-chart';
      el.innerHTML = '<div class="lv-title"></div><canvas></canvas>';
    } else if (it.kind === 'viz') {
      el.className = 'lv-card lv-vizcard';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-vizhost"></div><div class="lv-vizcap"></div>';
    } else if (it.kind === 'kpi') {
      el.className = 'lv-card lv-kpi';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-kpis"><div class="lv-num"></div><div class="lv-kv2"><div class="lv-sub2"></div><div class="lv-num2"></div></div></div>';
    } else if (it.kind === 'table') {
      el.className = 'lv-card lv-table';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-tw"><table><thead></thead><tbody></tbody></table></div>';
      el.addEventListener('focusout', (e) => commitCell(e.target));
      el.addEventListener('keydown', (e) => cellKey(e));
    } else if (it.kind === 'stat') {
      el.className = 'lv-card lv-stat';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-statv"></div>';
      el.addEventListener('focusout', (e) => commitCell(e.target));
      el.addEventListener('keydown', (e) => cellKey(e));
    } else if (it.kind === 'img') {
      el.className = 'lv-card lv-imgcard';
      el.innerHTML = '<img alt="" draggable="false">';
    } else {
      el.className = 'lv-text';
      el.addEventListener('focusout', (e) => commitCell(e.target));
      el.addEventListener('keydown', (e) => cellKey(e));
    }
    return el;
  }

  function update(n, it) {
    const el = n.el;
    el.dataset.sheet = it.sheet;
    if (it.kind === 'panel') {
      const p = it.p;
      el.querySelector('.lv-label').textContent = p.title || '';
      const pv = el.querySelector('.lv-pv');
      pv.textContent = p.value != null ? String(p.value) + (p.label ? ' ' + p.label : '') : '';
      pv.style.display = p.value != null ? '' : 'none';
      const md = mdLite(p.text || '');
      if (el.querySelector('.lv-md').innerHTML !== md) { el.querySelector('.lv-md').innerHTML = md; if (n.item) pulse(el); }
      const img = el.querySelector('.lv-pimg');
      img.style.display = p.image ? '' : 'none';
      if (p.image && img.getAttribute('src') !== p.image) img.src = p.image;
      return;
    }
    if (it.kind === 'slot') {
      const img = el.querySelector('img');
      img.style.display = it.sl.image ? '' : 'none';
      el.classList.toggle('has-img', !!it.sl.image);
      if (it.sl.image && img.getAttribute('src') !== it.sl.image) img.src = it.sl.image;
      return;
    }
    if (mode === 'sheet') place(el, it.r);
    if (it.kind === 'stat') {
      el.querySelector('.lv-label').textContent = it.label;
      const v = el.querySelector('.lv-statv');
      v.dataset.a = it.value.A; v.dataset.raw = it.value.raw; v.dataset.sheet = it.sheet;
      v.contentEditable = it.value.formula ? 'false' : 'plaintext-only';
      if (v !== document.activeElement && textOf(v) !== it.value.text) { if (n.item) fxText(v, it.value.text, fxKind()); else v.textContent = it.value.text; }
      setLight(el, it.value.light);
      return;
    }
    if (it.kind === 'chart') {
      el.querySelector('.lv-title').textContent = it.ch.title || '';
      const prev = n.item?.data;
      if (prev && sameShape(prev, it.data) && changed(prev, it.data)) n.tween = { from: n.tween ? current(n) : prev, to: it.data, t0: performance.now() };
      else if (!prev) n.tween = { from: zeroed(it.data), to: it.data, t0: performance.now() };
      else if (!sameShape(prev, it.data)) n.tween = null;
      n.data = it.data;
      if (mode === 'sheet') paintChart(n, it);
    } else if (it.kind === 'viz') {
      const d = it.data.viz;
      el.querySelector('.lv-label').textContent = it.ch.title || '';
      const host = el.querySelector('.lv-vizhost');
      const before = host.dataset.state;
      renderViz(host, d.pack, d.value, d.label);
      const pack = getPack(d.pack);
      const cap = pack?.kind === 'states' ? (pack.states.find((x) => x.id === host.dataset.state)?.label || '') : '';
      el.querySelector('.lv-vizcap').textContent = cap;
      if (n.item && before && before !== host.dataset.state) pulse(el);
      setLight(el, it.light);
    } else if (it.kind === 'kpi') {
      el.querySelector('.lv-label').textContent = it.ch.title || it.data.kpi.label || '';
      const v = it.data.kpi.value;
      const pv = n.item?.data.kpi.value;
      const kind = fxKind();
      const counting = kind === 'morph' || !n.item;
      n.kpi = { to: v, text: it.data.kpi.text, from: counting ? (typeof pv === 'number' ? (n.kpi?.cur ?? pv) : typeof v === 'number' ? 0 : v) : v, t0: performance.now() };
      if (n.item && pv !== v) {
        const num = el.querySelector('.lv-num');
        if (counting) { num.classList.remove('fx-glow'); void num.offsetWidth; num.classList.add('fx-glow'); setTimeout(() => num.classList.remove('fx-glow'), 1300); }
        else fxText(num, typeof v === 'number' ? fmtNum(v, v) : it.data.kpi.text || '—', kind);
      }
      // size: CSS container units fit the number to the card (any size down to a small square); --len is its width in characters
      const k2 = it.data.kpi2;
      const shown = typeof v === 'number' ? fmtNum(v, v) : it.data.kpi.text || '—';
      el.style.setProperty('--len', Math.max(1.2, [...shown].length * (k2 ? 1.7 : 1)));
      el.classList.toggle('lv-dual', !!k2);
      if (k2) {
        el.querySelector('.lv-sub2').textContent = k2.label || '';
        const n2 = el.querySelector('.lv-num2'), t2 = typeof k2.value === 'number' ? fmtNum(k2.value, k2.value) : k2.text || '—';
        el.style.setProperty('--len2', Math.max(1.2, [...t2].length));
        if (textOf(n2) !== t2) { if (n.item?.data.kpi2) fxText(n2, t2, kind); else n2.textContent = t2; }
      }
      setLight(el, it.light);
    } else if (it.kind === 'table') {
      const lab = el.querySelector('.lv-label');
      lab.textContent = it.name;
      lab.style.display = it.label || mode === 'auto' ? '' : 'none';
      const thead = el.querySelector('thead'), tbody = el.querySelector('tbody');
      const fsz = mode === 'auto' ? 14 : Math.max(11, Math.min(17, 12 * scale));
      el.style.fontSize = fsz + 'px';
      // the cells' addresses are part of the shape: a table that moved (or had a column inserted before it) rebuilds
      const sig = it.cols.join('\u0001') + '|' + it.rows.length + '|' + (it.rows[0]?.[0]?.A || '') + ':' + (it.rows.at(-1)?.at(-1)?.A || '');
      const rowKey = (row, i) => (row[0]?.text || '') + '\u0001' + (row[0]?.text ? '' : i);
      if (n.sig !== sig && !el.contains(document.activeElement)) {
        const had = n.sig != null;
        const oldKeys = [...tbody.rows].map((tr) => tr.dataset.k);
        const newKeys = new Set(it.rows.map(rowKey));
        const gone = had && fxKind() !== 'none' ? [...tbody.rows].filter((tr) => !newKeys.has(tr.dataset.k)) : [];
        if (gone.length && !n.leaving && !n.vaporDone) {
          // removed records evaporate first; the table re-forms when they're gone
          n.leaving = true;
          vaporRowsOut(gone, () => { n.leaving = false; n.vaporDone = true; n.sig = null; render(); });   // then re-form, whatever else changed meanwhile
          return;
        }
        if (n.leaving) return;
        thead.innerHTML = '<tr>' + it.cols.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr>';
        tbody.innerHTML = it.rows.map((row, i) => `<tr data-k="${esc(rowKey(row, i))}">` + row.map((c) => `<td data-a="${c.A}"></td>`).join('') + '</tr>').join('');
        n.sig = sig;
        n.vaporDone = false;
        if (had && fxKind() !== 'none') vaporRowsIn([...tbody.rows].filter((tr) => !oldKeys.includes(tr.dataset.k)));
      }
      for (const row of it.rows) for (const c of row) {
        const td = tbody.querySelector(`td[data-a="${c.A}"]`);
        if (!td || td === document.activeElement) continue;
        if (c.viz) {
          // a =VIZ() cell: the pack's picture, updating in place (values glide, states cross-fade)
          let host = td.querySelector(':scope > .lv-vizcell');
          if (!host) { td.textContent = ''; host = document.createElement('span'); host.className = 'lv-vizcell'; td.append(host); }
          renderViz(host, c.viz.pack, c.viz.value, c.viz.label);
          td.title = `${c.viz.pack}: ${c.text}`;
          td.contentEditable = 'false';
          td.dataset.init = 1;
          continue;
        }
        if (td.querySelector(':scope > .lv-vizcell')) td.textContent = '';
        if (textOf(td) !== c.text) { if (td.dataset.init) fxText(td, c.text, fxKind()); else td.textContent = c.text; }
        td.dataset.init = 1;
        td.dataset.raw = c.raw;
        td.classList.toggle('num', !!c.num); td.classList.toggle('err', !!c.err); td.classList.toggle('lit', !!c.light);
        if (c.light) td.style.setProperty('--light', c.light); else td.style.removeProperty('--light');
        td.contentEditable = c.formula ? 'false' : 'plaintext-only';
        td.title = c.formula ? c.raw : '';
      }
    } else if (it.kind === 'img') {
      const img = el.querySelector('img');
      if (img.getAttribute('src') !== it.url) img.src = it.url;
    } else {
      const st = it.st;
      const fs = (st.fs || 13) * scale;
      el.style.fontSize = fs + 'px';
      el.style.fontWeight = st.b || (st.fs || 13) >= 20 ? 650 : 400;
      el.style.fontStyle = st.i ? 'italic' : '';
      el.style.fontFamily = st.ff && FONTS[st.ff] ? FONTS[st.ff].stack : '';
      el.style.textAlign = st.align || (it.num ? 'right' : 'left');
      el.style.whiteSpace = st.wrap || it.merged ? 'pre-wrap' : 'pre';
      el.style.opacity = (st.fs || 13) >= 16 || st.b ? 1 : 0.78;
      el.style.letterSpacing = (st.fs || 13) >= 24 ? '-0.025em' : '';
      el.style.lineHeight = Math.max(fs * 1.25, Math.min(it.r.h * scale, fs * 1.6)) + 'px';
      el.style.width = (st.wrap || it.merged || it.num ? it.r.w * scale : Math.max(it.r.w * scale, (textWidth(it) + 8) * scale)) + 'px';
      el.dataset.a = it.A;
      el.dataset.raw = it.raw;
      el.contentEditable = it.formula ? 'false' : 'plaintext-only';
      if (el !== document.activeElement && textOf(el) !== it.text) { if (n.item) fxText(el, it.text, fxKind()); else el.textContent = it.text; }
      setLight(el, it.light);
    }
  }

  // ------------------------------------------------------------- charts: tweened canvas paint
  const sameShape = (a, b) => a.labels?.length === b.labels?.length && a.series?.length === b.series?.length;
  const changed = (a, b) => a.series.some((s, i) => s.values.some((v, j) => v !== b.series[i].values[j]));
  const zeroed = (d) => ({ ...d, series: d.series.map((s) => ({ ...s, values: s.values.map((v) => (v === null ? null : 0)) })) });
  function current(n) {
    const t = n.tween;
    const k = ease(Math.min(1, (performance.now() - t.t0) / 900));
    return { ...t.to, series: t.to.series.map((s, i) => ({ ...s, values: s.values.map((v, j) => { const f = t.from.series[i]?.values[j]; return v === null || f == null ? v : f + (v - f) * k; }) })) };
  }
  function paintChart(n, it) {
    const cv = n.el.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    const card = n.el, title = card.querySelector('.lv-title');
    const w = Math.max(40, card.clientWidth - 24), h = Math.max(40, card.clientHeight - 28 - (title.offsetHeight || 0) - 6);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const data = n.tween ? current(n) : n.data;
    const zz = it.key === focusKey ? Math.min(2.6, Math.max(1, h / 260)) : Math.min(1.6, scale * 1.05);
    n.inkDark = n.el.classList.contains('lv-ink-dark');
    drawChart(g, { x: 0, y: 0, w, h }, { ...it.ch, title: '' }, data, zz, false, n.inkDark ? 'glassDark' : 'glass');
  }
  let raf = 0;
  function tick() {
    cancelAnimationFrame(raf);
    let busy = false;
    const now = performance.now();
    for (const n of nodes.values()) {
      if (n.item?.kind === 'chart' && n.tween) {
        paintChart(n, n.item);
        if (now - n.tween.t0 < 900) busy = true; else n.tween = null;
      }
      if (n.item?.kind === 'kpi' && n.kpi) {
        const k = n.kpi, num = n.el.querySelector('.lv-num');
        const t = Math.min(1, (now - k.t0) / 900);
        if (typeof k.to === 'number' && typeof k.from === 'number' && t < 1) {
          k.cur = k.from + (k.to - k.from) * ease(t);
          num.textContent = fmtNum(k.cur, k.to);
          busy = true;
        } else {
          k.cur = k.to;
          const fin = typeof k.to === 'number' ? fmtNum(k.to, k.to) : k.text || '—';
          if (!num.__fx && num.textContent !== fin) num.textContent = fin;
        }
      }
    }
    if (busy) raf = requestAnimationFrame(tick);
  }
  const decimals = (v) => { const s = String(+v.toFixed(6)); return s.includes('.') ? Math.min(2, s.split('.')[1].length) : 0; };
  const fmtNum = (v, target) => v.toLocaleString(undefined, { minimumFractionDigits: decimals(target), maximumFractionDigits: decimals(target) });

  /** Tiny, safe markdown: **bold**, *italic*, `code`, - bullets, line breaks. */
  function mdLite(t) {
    const e = esc(t);
    const inline = (x) => x.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>');
    const out = [];
    let list = false;
    for (const line of e.split('\n')) {
      const m = /^\s*[-•]\s+(.*)$/.exec(line);
      if (m) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if (list) { out.push('</ul>'); list = false; }
      out.push(line.trim() ? `<p>${inline(line)}</p>` : '');
    }
    if (list) out.push('</ul>');
    return out.join('');
  }
  function pulse(el) { el.classList.remove('lv-pulse'); void el.offsetWidth; el.classList.add('lv-pulse'); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ------------------------------------------------------------- editing values (structure is locked)
  function commitCell(el) {
    const A = el?.dataset?.a;
    if (!A || el.contentEditable === 'false') return;
    const text = el.textContent.replace(/\n+$/, '');
    if (text === (el.dataset.raw ?? '')) return;
    submit([{ op: 'set', sheet: el.dataset.sheet || el.closest('[data-sheet]')?.dataset.sheet || sh().name, cells: { [A]: text === '' ? null : text } }]);
  }
  function cellKey(e) {
    const el = e.target;
    if (!el.dataset?.a) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.textContent = el.dataset.raw ?? ''; el.blur(); }
  }

  // ------------------------------------------------------------- control bar
  function renderBar() {
    const sheets = $('.lv-sheets');
    const names = doc.sheets.map((s) => s.name).join('|');
    const sig = names + '|' + sh().name + '|' + mode + '|' + [...excluded].join(',');
    if (sheets.dataset.sig !== sig) {
      sheets.innerHTML = '';
      for (const s of doc.sheets) {
        const b = document.createElement('button');
        const on = mode === 'auto' ? !excluded.has(s.name) : s === sh();
        b.className = 'lv-btn' + (on ? ' on' : '') + (mode === 'auto' ? ' chip' : '');
        b.textContent = s.name;
        b.title = mode === 'auto' ? 'Include / exclude this sheet' : 'Show this sheet';
        b.onclick = () => transition(() => {
          if (mode === 'auto') { if (excluded.has(s.name)) excluded.delete(s.name); else excluded.add(s.name); }
          else { sheetName = s.name; applyTheme(); scroller.scrollTop = 0; }
          render();
        });
        sheets.append(b);
      }
      sheets.dataset.sig = sig;
    }
    root.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    const fl = root.querySelector('[data-a=flow]');
    fl.textContent = doc.live?.flow === 'horizontal' ? '↔' : '↕';
    fl.style.display = root.querySelector('[data-a=space]').style.display = mode === 'auto' ? '' : 'none';
    root.querySelector('[data-a=reveal]').classList.toggle('on', doc.live?.reveal !== false);
    root.querySelector('[data-a=links]').classList.toggle('on', doc.live?.links !== false);
    syncFx();
    syncStyleButtons();
    root.querySelector('[data-a=links]').style.display = mode === 'auto' ? '' : 'none';
    renderSlidePanel();
    const th = $('.lv-themes');
    if (!th.childElementCount) {
      for (const [k, p] of Object.entries(PRESETS)) {
        const d = document.createElement('button');
        d.className = 'lv-dot'; d.dataset.t = k; d.title = k;
        d.style.background = swatch(p);
        d.onclick = () => {
          if (!th.classList.contains('open')) { th.classList.add('open'); return; }   // collapsed: the current swatch opens the row
          th.classList.remove('open');
          if (k !== themeName()) { submit([{ op: 'view', sheet: sh().name, theme: k }]); applyTheme(); }
        };
        th.append(d);
      }
      applyTheme();
    }
  }
  // touching the bar (modes, sheets, themes…) leaves the slide and returns to free browsing
  root.querySelector('.lv-bar').addEventListener('click', (e) => {
    if (!slide || !e.target.closest('button') || e.target.closest('[data-a=slides], [data-a=exit]')) return;
    stopPlaying(); slide = null; slideIdx = -1; applyTheme(); render(); renderSlidePanel();
  }, true);
  root.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
    if (mode === b.dataset.m) return;
    transition(() => { mode = b.dataset.m; try { localStorage.setItem('spread.liveMode', mode); } catch {} render(); scroller.scrollTop = 0; });
  }));
  // Cross-highlight: hovering a value lights up the same value in every other card -> tables connect visually.
  const norm = (t) => t.trim().toLowerCase();
  stage.addEventListener('mouseover', (e) => {
    const t = e.target.closest('td, .lv-text, .lv-statv');
    const key = t ? norm(t.textContent) : '';
    stage.querySelectorAll('.lv-link').forEach((x) => x.classList.remove('lv-link'));
    stage.querySelectorAll('.lv-linked').forEach((x) => x.classList.remove('lv-linked'));
    if (!key || key.length < 2 || !isNaN(+key.replace(',', '.'))) { stage.classList.remove('lv-linking'); return; }
    let hits = 0;
    stage.querySelectorAll('td, .lv-text, .lv-statv').forEach((x) => { if (norm(x.textContent) === key) { x.classList.add('lv-link'); x.closest('.lv-card, .lv-text')?.classList.add('lv-linked'); hits++; } });
    stage.classList.toggle('lv-linking', hits > 1);
  });
  stage.addEventListener('mouseleave', () => { stage.classList.remove('lv-linking'); stage.querySelectorAll('.lv-link, .lv-linked').forEach((x) => x.classList.remove('lv-link', 'lv-linked')); });
  root.querySelector('[data-a=font]').onclick = () => {
    const keys = Object.keys(FONTS);
    const cur = FONTS[sh().view?.font] ? sh().view.font : 'display';
    submit([{ op: 'view', sheet: sh().name, font: keys[(keys.indexOf(cur) + 1) % keys.length] }]);
    applyTheme();
    render();
  };
  root.querySelector('[data-a=flow]').onclick = () => transition(() => { submit([{ op: 'liveLayout', flow: doc.live?.flow === 'horizontal' ? null : 'horizontal' }]); scroller.scrollTo(0, 0); });
  root.querySelector('[data-a=reveal]').onclick = () => { submit([{ op: 'liveLayout', reveal: doc.live?.reveal === false ? null : false }]); revealed.clear(); render(); };
  root.querySelector('[data-a=space]').onclick = () => {
    let i = 1;
    while ((doc.live?.slots || []).some((x) => x.id === 'space' + i)) i++;
    transition(() => submit([{ op: 'liveLayout', slots: [...(doc.live?.slots || []), { id: 'space' + i, span: 1, h: 180 }] }]));
  };
  // two pages: everyday navigation, and "Look" (theme, cards, lines, effects…)
  const setPage = (n) => { root.dataset.barpage = n; try { localStorage.setItem('spread.livePage', n); } catch {} };
  root.querySelector('[data-a=page2]').onclick = () => setPage(2);
  root.querySelector('[data-a=page1]').onclick = () => setPage(1);
  try { root.dataset.barpage = localStorage.getItem('spread.livePage') === '2' ? 2 : 1; } catch { root.dataset.barpage = 1; }
  const CARD = ['glass', 'outline', 'clear'], LINES = ['rows', 'grid', 'none'];
  const CARD_LABEL = { glass: '▢ Glass', outline: '▭ Outline', clear: '◌ Clear' }, LINE_LABEL = { rows: '☰ Rows', grid: '▦ Grid', none: '⋯ No lines' };
  root.querySelector('[data-a=cards]').onclick = () => {
    const nx = CARD[(CARD.indexOf(doc.live?.cards || 'glass') + 1) % CARD.length];
    submit([{ op: 'liveLayout', cards: nx === 'glass' ? null : nx }]); render();
  };
  root.querySelector('[data-a=lines]').onclick = () => {
    const nx = LINES[(LINES.indexOf(doc.live?.lines || 'rows') + 1) % LINES.length];
    submit([{ op: 'liveLayout', lines: nx === 'rows' ? null : nx }]); render();
  };
  function syncStyleButtons() {
    root.querySelector('[data-a=cards]').textContent = CARD_LABEL[doc.live?.cards || 'glass'];
    root.querySelector('[data-a=lines]').textContent = LINE_LABEL[doc.live?.lines || 'rows'];
  }
  root.querySelector('[data-a=fx]').onclick = () => {
    const next = FX[(FX.indexOf(fxKind()) + 1) % FX.length];
    submit([{ op: 'liveLayout', fx: next === 'morph' ? null : next }]);
    syncFx();
    // preview: the KPIs and stats on screen show the new effect once
    for (const n of nodes.values()) {
      const t = n.el.querySelector('.lv-num, .lv-statv');
      if (t && !t.__fx && next !== 'none') { const real = t.textContent; t.textContent = real.replace(/\d/g, '0'); fxText(t, real, next); }
    }
  };
  function syncFx() { root.querySelector('[data-a=fx]').textContent = '⟡ ' + fxKind()[0].toUpperCase() + fxKind().slice(1); }
  syncFx();
  root.querySelector('[data-a=links]').onclick = () => { submit([{ op: 'liveLayout', links: doc.live?.links === false ? null : false }]); render(); };
  root.querySelector('[data-a=slides]').onclick = () => { root.classList.toggle('lv-slides-open'); renderSlidePanel(); };
  root.querySelector('[data-a=exit]').onclick = close;
  root.querySelector('[data-a=fs]').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.());
  let idle;
  // the bar fades out when the pointer rests — but never while it is being used
  // (pointer position is tracked by hand: :hover isn't recomputed when the bar regains pointer-events)
  let lastPt = null;
  const overBar = () => { if (!lastPt) return false; const r = bar.getBoundingClientRect(); return lastPt.x >= r.left - 8 && lastPt.x <= r.right + 8 && lastPt.y >= r.top - 8 && lastPt.y <= r.bottom + 8; };
  const sleepBar = () => {
    if ((lastPt?.mouse && overBar()) || bar.matches(':focus-within') || root.classList.contains('lv-slides-open')) { idle = setTimeout(sleepBar, 1200); return; }
    root.classList.add('lv-idle');
  };
  const wake = (e) => {
    if (e?.clientX != null) lastPt = { x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse' };
    root.classList.remove('lv-idle'); clearTimeout(idle); idle = setTimeout(sleepBar, 2600);
  };
  for (const ev of ['pointermove', 'pointerdown', 'wheel']) root.addEventListener(ev, wake, { passive: true });
  wake();
  const onKey = (e) => {
    const ae = document.activeElement;
    const typing = root.contains(ae) && (ae.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(ae.tagName));
    if (playing && !typing) {
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(1); return; }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); next(-1); return; }
    }
    if (e.key !== 'Escape' || typing) return;
    e.preventDefault();
    if (playing || slide) leaveSlide();
    else if (focusKey) setFocus(null);
    else close();
  };
  document.addEventListener('keydown', onKey, true);
  const onResize = () => render();
  addEventListener('resize', onResize);

  function close() {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(gov.raf);
    clearTimeout(idle);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', onResize);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try { const u = new URL(location.href); ['live', 'mode', 'focus', 'kiosk', 'slides'].forEach((k) => u.searchParams.delete(k)); history.replaceState(null, '', u); } catch {}
    try { mount?.dispose(); } catch {}
    reportState(true);
    io?.disconnect();
    clearInterval(inkTimer);
    clearInterval(beat);
    stopCarousel();
    clearTimeout(slideTimer);
    root.classList.add('lv-out');
    setTimeout(() => root.remove(), 260);
    onClose?.(sheetName);
  }

  if (startMode) mode = startMode === 'auto' ? 'auto' : 'sheet';
  else if (innerWidth < 700) mode = 'auto';      // phones: composed layout reads better than a scaled sheet
  if (kiosk) root.classList.add('lv-kiosk');
  render();
  if (startFocus) setFocus(startFocus, true);
  if (startSlide) play(Math.max(0, startSlide - 1));
  syncUrl();
  return {
    update: () => render(),
    close,
    get sheet() { return sheetName; },
    /** Remote control (agent / URL): { sheet?, mode?, focus? } */
    people: showPeople,
    present(o) {
      if (o.action) return remoteAction(o.action);
      if (o.theme && PRESETS[o.theme]) { submit([{ op: 'view', sheet: sh().name, theme: o.theme }]); applyTheme(); }
      if (o.slide) { stopCarousel(); play(Math.max(0, (+o.slide || 1) - 1)); return; }
      stopCarousel();
      if (playing || slide) { stopPlaying(); slide = null; }
      transition(() => {
        if (o.mode) mode = o.mode === 'auto' ? 'auto' : 'sheet';
        if (o.sheet && doc.sheets.some((s) => sameName(s.name, o.sheet))) { sheetName = doc.sheets.find((s) => sameName(s.name, o.sheet)).name; applyTheme(); }
        render();
        setFocus(o.focus || null, true);
      });
    },
  };
}
