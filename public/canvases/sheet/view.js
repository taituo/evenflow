// Spreadsheet canvas view. Canvas-rendered, virtualized grid with Sheets-style interactions.
import { addr, parseAddr, colToName, parseRange, rangeToString, splitSheet, quoteSheet, sameName, norm, inRange } from '../../shared/a1.js';
import { Engine, fmtValue, isImg, isViz } from '../../shared/engine.js';
import { vizImage, allPacks, onPacks, getPack, vizDataUrl } from './viz-dom.js';
import { setRedraw } from './charts.js';
import { shiftFormula, refSpans, autoClose, literal, isErr, refBox } from '../../shared/formula.js';
import { tableAt, tables as allTables, mergeAt, chartData, CHART_TYPES, tableColumns, mapData, MAP_BASES } from '../../shared/types/sheet.js';
import { drawChart } from './charts.js';
import { openLive } from './live.js';
import { condStyle, LIGHTS, parseRule, describeRule } from '../../shared/cond.js';
import { FONTS, fontStack } from '../../shared/fonts.js';
import { sheetBlocks, toMarkdown, toHtml } from '../../shared/export.js';

const DEF_W = 100, DEF_H = 21, HDR_W = 46, HDR_H = 24, FONT = 13;
const MAXR = 999999, MAXC = 18277;
const C = {
  grid: '#e2e3e3', hdrBg: '#f8f9fa', hdrLine: '#c4c7c5', hdrText: '#444746', hdrSel: '#d3e3fd', hdrSelText: '#0b57d0',
  hdrFull: '#0b57d0', sel: '#1a73e8', selFill: 'rgba(14,101,235,0.10)', agent: '#9334e6', diff: 'rgba(251,188,4,0.30)',
  freeze: '#c4c7c5', text: '#202124',
};
const REF_COLORS = ['#1a73e8', '#e8710a', '#9334e6', '#188038', '#d93025', '#12b5cb', '#e52592', '#795548'];
const PALETTE = ['#000000', '#5f6368', '#d93025', '#e8710a', '#f9ab00', '#188038', '#1a73e8', '#9334e6', '#ffffff',
  '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#d9d2e9', '#ead1dc', '#efefef'];

const TEMPLATE = `
<div class="sv">
  <div class="sv-fbar">
    <input class="sv-name" spellcheck="false" title="Name box: type C23 or C23:D32 or Sheet!A1 and press Enter">
    <div class="sv-fx-ico">fx</div>
    <input class="sv-fx" spellcheck="false" autocomplete="off">
  </div>
  <div class="sv-diffbar"><span class="sv-difftext"></span><button class="sv-diffclose">Close</button></div>
  <div class="sv-grid">
    <canvas class="sv-canvas"></canvas>
    <div class="sv-scroll"><div class="sv-spacer"></div></div>
    <textarea class="sv-editor idle" spellcheck="false" autocomplete="off" wrap="off"></textarea>
    <div class="sv-tip" hidden></div>
  </div>
  <div class="sv-bottom">
    <button class="tb sv-addsheet" title="Add sheet">+</button>
    <div class="sv-tabs"></div>
    <div class="sv-stats"></div>
  </div>
</div>`;

const rgba = (hex, a) => { const h = String(hex).replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

export function mount(root, ctx) {
  root.innerHTML = TEMPLATE;
  const $ = (s) => root.querySelector(s);
  const canvas = $('.sv-canvas'), scroller = $('.sv-scroll'), spacer = $('.sv-spacer'), ed = $('.sv-editor');
  const nameBox = $('.sv-name'), fx = $('.sv-fx'), tabsEl = $('.sv-tabs'), statsEl = $('.sv-stats'), tip = $('.sv-tip');
  const gridEl = $('.sv-grid'), diffBar = $('.sv-diffbar');
  const g = canvas.getContext('2d');

  const doc = ctx.doc;
  let engine = new Engine(doc);
  let sheetName = doc.sheets[0].name;
  const perSheet = new Map();
  let z = 1;
  let sel = freshSel();
  let edit = null;            // { sheet, c, r, mode: 'enter'|'edit', orig, input, pointRef }
  let rowsExt = 0, colsExt = 0, colPre = new Float64Array(1), rowPre = new Float64Array(1);
  let undoStack = [], redoStack = [];
  let clip = null;            // { sheet, R, cut, text, cells }
  let flashes = [];           // { sheet, R, t0, color? }
  let others = [];            // other people in this workbook: { name, color, sheet, ranges, active }
  let agentBox = null;        // { sheet, R, label, t0 }
  const agentSheets = new Set();
  let diffCells = null;       // Map sheet -> Set(addr)
  let drag = null;
  let preview = null;         // { kind:'col'|'row', i, size }
  let dpr = 1, W = 0, H = 0, raf = 0, animating = false;
  let tabStartCol = null;
  let selChart = null;        // id of selected chart

  function freshSel() { return { ranges: [{ c1: 0, r1: 0, c2: 0, r2: 0 }], active: { c: 0, r: 0 }, anchor: { c: 0, r: 0 }, cursor: { c: 0, r: 0 } }; }
  const sh = () => doc.sheets.find((s) => sameName(s.name, sheetName)) || doc.sheets[0];
  const lastR = () => sel.ranges[sel.ranges.length - 1];

  // ================================================================ geometry
  const cw = (c) => (preview && preview.kind === 'col' && preview.i === c ? preview.size : sh().colW[c] ?? DEF_W);
  const rh = (r) => (preview && preview.kind === 'row' && preview.i === r ? preview.size : sh().rowH[r] ?? DEF_H);
  function rebuild() {
    const s = sh();
    const ext = engine.extent(s);
    rowsExt = Math.max(rowsExt, 1000, ext.r + 100, sel.cursor.r + 50);
    colsExt = Math.max(colsExt, 26, ext.c + 6, sel.cursor.c + 6);
    colPre = new Float64Array(colsExt + 1);
    for (let c = 0; c < colsExt; c++) colPre[c + 1] = colPre[c] + cw(c);
    rowPre = new Float64Array(rowsExt + 1);
    for (let r = 0; r < rowsExt; r++) rowPre[r + 1] = rowPre[r] + rh(r);
    spacer.style.width = Math.ceil(hw() + colPre[colsExt] * z) + 'px';
    spacer.style.height = Math.ceil(hh() + rowPre[rowsExt] * z) + 'px';
  }
  const colX = (c) => (c <= colsExt ? colPre[c] : colPre[colsExt] + (c - colsExt) * DEF_W);
  const rowY = (r) => (r <= rowsExt ? rowPre[r] : rowPre[rowsExt] + (r - rowsExt) * DEF_H);
  function bs(pre, n, v) {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pre[m] <= v) lo = m; else hi = m - 1; }
    return Math.max(0, Math.min(lo, n - 1));
  }
  const colAt = (u) => bs(colPre, colsExt, u);
  const rowAt = (u) => bs(rowPre, rowsExt, u);
  const hz = () => Math.max(0.75, Math.min(1.6, z));
  const hw = () => HDR_W * hz(), hh = () => HDR_H * hz();
  const fz = () => sh().freeze || { rows: 0, cols: 0 };
  const frozenW = () => colX(fz().cols) * z;
  const frozenH = () => rowY(fz().rows) * z;
  const sx = (c) => hw() + colX(c) * z - (c < fz().cols ? 0 : scroller.scrollLeft);
  const sy = (r) => hh() + rowY(r) * z - (r < fz().rows ? 0 : scroller.scrollTop);
  function hit(x, y) {
    let c, r;
    if (x < hw()) c = -1; else c = colAt(x < hw() + frozenW() ? (x - hw()) / z : (x - hw() + scroller.scrollLeft) / z);
    if (y < hh()) r = -1; else r = rowAt(y < hh() + frozenH() ? (y - hh()) / z : (y - hh() + scroller.scrollTop) / z);
    return { c, r };
  }
  function visCols() {
    const f = fz().cols;
    return [Math.max(f, colAt((scroller.scrollLeft + frozenW()) / z)), colAt((scroller.scrollLeft + W - hw()) / z)];
  }
  function visRows() {
    const f = fz().rows;
    return [Math.max(f, rowAt((scroller.scrollTop + frozenH()) / z)), rowAt((scroller.scrollTop + H - hh()) / z)];
  }
  const clampR = (R) => ({ c1: R.c1, r1: R.r1, c2: Math.min(R.c2, colsExt - 1), r2: Math.min(R.r2, rowsExt - 1) });
  function rectOf(R) {
    R = clampR(R);
    const x = sx(R.c1), y = sy(R.r1);
    return { x, y, w: sx(R.c2) + cw(R.c2) * z - x, h: sy(R.r2) + rh(R.r2) * z - y };
  }
  const px = (v) => (Math.round(v * dpr) + 0.5) / dpr;

  // ================================================================ rendering
  function requestDraw() { if (!raf) raf = requestAnimationFrame(draw); }
  setRedraw(requestDraw);
  const offPacks = onPacks(() => { live?.update(); requestDraw(); });

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = gridEl.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    W = scroller.clientWidth; H = scroller.clientHeight;
    requestDraw();
  }

  function draw() {
    raf = 0;
    const now = performance.now();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    const f = fz(), X0 = hw(), Y0 = hh(), XF = X0 + frozenW(), YF = Y0 + frozenH();
    const [ca, cb] = visCols(), [ra, rb] = visRows();
    drawCells(ra, rb, ca, cb, XF, YF, W, H);
    if (f.rows) drawCells(0, f.rows - 1, ca, cb, XF, Y0, W, YF);
    if (f.cols) drawCells(ra, rb, 0, f.cols - 1, X0, YF, XF, H);
    if (f.rows && f.cols) drawCells(0, f.rows - 1, 0, f.cols - 1, X0, Y0, XF, YF);
    drawOverlays(now);
    drawCharts();
    drawHeaders(ca, cb, ra, rb);
    g.fillStyle = C.freeze;
    if (f.cols) g.fillRect(XF - 1, 0, 3, H);
    if (f.rows) g.fillRect(0, YF - 1, W, 3);
    placeEditor();
    animating = flashes.length > 0 || (agentBox && now - agentBox.t0 < 10000) || !!clip;
    if (animating) setTimeout(requestDraw, 50);
  }

  function hasContent(s, c, r) { const cell = s.cells[addr(c, r)]; return cell && cell.v !== '' && cell.v != null; }

  function drawCells(r0, r1, c0, c1, x0, y0, x1, y1) {
    if (r1 < r0 || c1 < c0) return;
    const s = sh();
    g.save();
    g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
    // gridlines
    if (s.view?.grid !== false) {
      g.strokeStyle = C.grid; g.lineWidth = 1 / dpr; g.beginPath();
      for (let c = c0; c <= c1 + 1; c++) { const x = px(sx(c) - 1 / dpr); g.moveTo(x, y0); g.lineTo(x, y1); }
      for (let r = r0; r <= r1 + 1; r++) { const y = px(sy(r) - 1 / dpr); g.moveTo(x0, y); g.lineTo(x1, y); }
      g.stroke();
    }
    const ctx2 = {
      s, dset: diffCells?.get(s.name), font: '',
      tabs: (s.tables || []).map((t) => parseRange(t.range)),
    };
    const merges = (s.merges || []).map((m) => parseRange(m));
    const mergeOf = (c, r) => { for (const M of merges) if (inRange(M, c, r)) return M; return null; };
    const visM = merges.filter((M) => M.r2 >= r0 && M.r1 <= r1 && M.c2 >= c0 && M.c1 <= c1);
    g.fillStyle = '#fff';
    for (const M of visM) { const m = rectOf(M); g.fillRect(m.x, m.y, m.w - 1, m.h - 1); } // hide inner gridlines
    g.textBaseline = 'alphabetic';
    for (let r = r0; r <= r1; r++) {
      const y = sy(r), h = rh(r) * z;
      for (let c = c0; c <= c1; c++) {
        if (merges.length && mergeOf(c, r)) continue;
        drawCell(ctx2, c, r, sx(c), y, cw(c) * z, h);
      }
    }
    for (const M of visM) { const m = rectOf(M); drawCell(ctx2, M.c1, M.r1, m.x, m.y, m.w, m.h, true); }
    // borders (on top of fills)
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const bd = s.cells[addr(c, r)]?.s?.bd;
      if (!bd) continue;
      const M = merges.length ? mergeOf(c, r) : null;
      const x = sx(c) - 1 / dpr, y = sy(r) - 1 / dpr, w = cw(c) * z, h = rh(r) * z;
      if (bd.t && (!M || r === M.r1)) edge(x, y, x + w, y, bd.t);
      if (bd.b && (!M || r === M.r2)) edge(x, y + h, x + w, y + h, bd.b);
      if (bd.l && (!M || c === M.c1)) edge(x, y, x, y + h, bd.l);
      if (bd.r && (!M || c === M.c2)) edge(x + w, y, x + w, y + h, bd.r);
    }
    g.restore();
  }

  function edge(xa, ya, xb, yb, spec) {
    const [style, color] = spec.split(' ');
    const lw = { solid: 1, dashed: 1, dotted: 1, double: 1, medium: 2, thick: 3 }[style] || 1;
    g.strokeStyle = color || '#000';
    g.lineWidth = lw;
    g.setLineDash(style === 'dashed' ? [4, 3] : style === 'dotted' ? [1, 2] : []);
    const snap = (v) => (lw % 2 ? Math.round(v * dpr) / dpr + 0.5 / dpr : Math.round(v));
    const horiz = ya === yb;
    const line = (off) => {
      g.beginPath();
      if (horiz) { g.moveTo(xa - (lw > 1 ? lw / 2 : 0), snap(ya) + off); g.lineTo(xb + (lw > 1 ? lw / 2 : 0), snap(yb) + off); }
      else { g.moveTo(snap(xa) + off, ya - (lw > 1 ? lw / 2 : 0)); g.lineTo(snap(xb) + off, yb + (lw > 1 ? lw / 2 : 0)); }
      g.stroke();
    };
    if (style === 'double') { line(-1); line(1); } else line(0);
    g.setLineDash([]);
  }

  function drawCell(k, c, r, x, y, w, h, merged) {
    const s = k.s;
    const A = addr(c, r);
    const cell = s.cells[A];
    let T = null;
    for (const R of k.tabs) if (c >= R.c1 && c <= R.c2 && r >= R.r1 && r <= R.r2) { T = R; break; }
    if (T && !cell?.s?.fill) {
      if (r === T.r1) { g.fillStyle = '#c2d7f5'; g.fillRect(x - 1, y - 1, w + 1, h + 1); }
      else if ((r - T.r1) % 2 === 0) { g.fillStyle = '#f1f5fc'; g.fillRect(x, y, w - 1, h - 1); }
    }
    if (k.dset && k.dset.has(A)) { g.fillStyle = C.diff; g.fillRect(x, y, w - 1, h - 1); }
    const has = cell && cell.v !== '' && cell.v != null;
    const v0 = has ? engine.value(s, c, r) : null;
    const cs = s.conds && !(T && r === T.r1) ? condStyle(engine, s, c, r, v0) : null;   // traffic lights (not on table headers)
    if (!cell && !cs) return;
    const st = { ...(T && r === T.r1 ? { b: true } : {}), ...(cell?.s || {}), ...(cs ? Object.fromEntries(Object.entries(cs).filter(([q]) => q !== 'dot' && q !== 'light')) : {}) };
    if (st.fill) { g.fillStyle = st.fill; g.fillRect(x - 1, y - 1, w + 1, h + 1); }
    if (cs?.dot) { g.fillStyle = cs.dot; g.fillRect(x - 1, y, Math.max(2, 3 * z), h - 1); }   // a light bar on the left edge
    if (!cell) return;
    if (cell.n) { g.fillStyle = '#e8710a'; g.beginPath(); g.moveTo(x + w - 7 * z, y); g.lineTo(x + w - 1, y); g.lineTo(x + w - 1, y + 6 * z); g.fill(); }
    if (!has) return;
    const v = v0;
    if (isImg(v)) { drawImg(v, x, y, w, h); return; }
    if (isViz(v)) { drawVizCell(v, x, y, w, h); return; }
    const t = fmtValue(v);
    if (!t) return;
    const fsz = (st.fs || FONT) * z;
    const font = `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${fsz}px ${fontStack(st.ff)}`;
    if (font !== k.font) { g.font = font; k.font = font; }
    const err = isErr(v);
    const align = st.align || (typeof v === 'number' ? 'right' : typeof v === 'boolean' || err ? 'center' : 'left');
    const pad = 3 * z;
    if (st.wrap || t.includes('\n')) { drawLines(t, st, x, y, w, h, align, err); k.font = ''; return; }
    const tw = g.measureText(t).width;
    let clipW = w, needClip = tw > w - 2 * pad;
    if (needClip && !merged && align === 'left' && typeof v !== 'number') {
      let cc = c + 1, extra = 0;
      while (tw > w + extra - 2 * pad && cc < c + 30 && !hasContent(s, cc, r) && !s.cells[addr(cc, r)]?.s?.fill && !mergeAt(s, cc, r)) { extra += cw(cc) * z; cc++; }
      if (extra) { g.fillStyle = '#fff'; g.fillRect(x + w - 1, y, extra, h - 1); }
      clipW = w + extra;
      needClip = tw > clipW - 2 * pad;
    }
    g.fillStyle = err ? '#c5221f' : st.color || C.text;
    g.textAlign = align;
    const tx = align === 'left' ? x + pad : align === 'right' ? x + w - pad - 1 : x + w / 2;
    const ty = st.valign === 'top' ? y + fsz + 3 * z : st.valign === 'middle' ? y + h / 2 + fsz * 0.36 : y + h - Math.max(5 * z, fsz * 0.3);
    if (needClip) { g.save(); g.beginPath(); g.rect(x, y, clipW - 1, h); g.clip(); }
    g.fillText(t, tx, ty);
    if (st.u || st.s) {
      const lx = align === 'left' ? tx : align === 'right' ? tx - tw : tx - tw / 2;
      g.fillRect(lx, st.u ? ty + 2 * z : ty - 4 * z, Math.min(tw, clipW), Math.max(1, z));
    }
    if (needClip) g.restore();
    if (err) { g.fillStyle = '#d93025'; g.beginPath(); g.moveTo(x + w - 7 * z, y); g.lineTo(x + w - 1, y); g.lineTo(x + w - 1, y + 6 * z); g.fill(); }
  }

  const imgCache = new Map();
  function drawVizCell(v, x, y, w, h) {
    // the pack's picture fills the cell height; text cells beside it stay readable
    const s = Math.max(8, Math.min(w, h) - 4);
    const img = getPack(v.pack) ? vizImage(v.pack, v.value, v.label, s * dpr, s * dpr, requestDraw) : null;
    if (img) {
      const pr = img.naturalWidth / img.naturalHeight || 1;
      const dw = Math.min(w - 4, s * pr), dh = dw / pr;
      g.drawImage(img, x + 2, y + (h - dh) / 2, dw, dh);
    } else if (!getPack(v.pack)) {
      g.fillStyle = '#d93025'; g.font = `${11 * z}px system-ui`; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(`no pack ${v.pack}`, x + 4, y + h / 2); g.textBaseline = 'alphabetic';
    }
  }
  function drawImg(v, x, y, w, h) {
    let e = imgCache.get(v.url);
    if (!e) {
      e = { img: new Image(), ok: false, bad: false };
      e.img.onload = () => { e.ok = true; requestDraw(); };
      e.img.onerror = () => { e.bad = true; requestDraw(); };
      e.img.src = v.url;
      imgCache.set(v.url, e);
    }
    if (!e.ok) { g.fillStyle = e.bad ? '#d93025' : '#9aa0a6'; g.font = `${11 * z}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e.bad ? 'image error' : '…', x + w / 2, y + h / 2); g.textBaseline = 'alphabetic'; return; }
    const iw = e.img.naturalWidth, ih = e.img.naturalHeight, bw = w - 4, bh = h - 4;
    let dw = bw, dh = bh;
    if (v.mode !== 2) { const k = Math.min(bw / iw, bh / ih); dw = iw * k; dh = ih * k; }  // 1 = fit (default), 2 = stretch
    g.save(); g.beginPath(); g.rect(x, y, w - 1, h - 1); g.clip();
    g.drawImage(e.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    g.restore();
  }
  async function uploadImage(file, c, r) {
    if (!file || !/^image\//.test(file.type)) return false;
    try {
      const res = await fetch('/api/assets', { method: 'POST', headers: { 'content-type': file.type }, body: file });
      const { url } = await res.json();
      const s = sh();
      const ops = [{ op: 'set', sheet: s.name, cells: { [addr(c, r)]: `=IMAGE("${url}")` } }];
      if ((s.rowH[r] ?? DEF_H) < 80) ops.push({ op: 'resize', sheet: s.name, rows: { [r + 1]: 120 } });
      if ((s.colW[c] ?? DEF_W) < 140) ops.push({ op: 'resize', sheet: s.name, cols: { [colToName(c)]: 180 } });
      submit(ops);
    } catch (e) { ctx.toast('Upload failed: ' + e.message, true); }
    return true;
  }

  function wrapLines(t, width, wrap) {
    const out = [];
    for (const para of t.split('\n')) {
      if (!wrap) { out.push(para); continue; }
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const tryL = line + word;
        if (line && g.measureText(tryL).width > width) { out.push(line.trimEnd()); line = word.trimStart(); }
        else line = tryL;
      }
      out.push(line);
    }
    return out;
  }
  function drawLines(t, st, x, y, w, h, align, err) {
    const pad = 3 * z, lh = (st.fs || FONT) * z * 1.3;
    const lines = wrapLines(t, w - 2 * pad, !!st.wrap);
    g.save(); g.beginPath(); g.rect(x, y, w - 1, h - 1); g.clip();
    g.fillStyle = err ? '#c5221f' : st.color || C.text;
    g.textAlign = align;
    const tx = align === 'left' ? x + pad : align === 'right' ? x + w - pad - 1 : x + w / 2;
    lines.forEach((l, i) => g.fillText(l, tx, y + pad + lh * (i + 1) - lh * 0.25));
    g.restore();
  }
  function cellLines(s, c, r) {
    const cell = s.cells[addr(c, r)];
    if (!cell || cell.v === '') return 1;
    const st = cell.s || {};
    g.font = `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${st.fs || FONT}px ${fontStack(st.ff)}`;
    return wrapLines(fmtValue(engine.value(s, c, r)), cw(c) - 6, !!st.wrap).length * ((st.fs || FONT) / FONT);
  }

  /** Clip to the pane(s) a range lives in so scrolled overlays don't paint over frozen panes. */
  function paneClip(R) {
    const f = fz();
    const x = R.c1 < f.cols ? hw() : hw() + frozenW();
    const y = R.r1 < f.rows ? hh() : hh() + frozenH();
    g.save(); g.beginPath(); g.rect(x, y, W - x, H - y); g.clip();
  }

  function strokeRange(R, color, width, dash) {
    const r = rectOf(R);
    paneClip(R);
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash || []);
    g.strokeRect(r.x - 1 + width / 2 - 0.5, r.y - 1 + width / 2 - 0.5, r.w - width + 1, r.h - width + 1);
    g.setLineDash([]);
    g.restore();
    return r;
  }

  function drawOverlays(now) {
    const s = sh();
    // agent flashes
    flashes = flashes.filter((f) => now - f.t0 < 1600);
    for (const f of flashes) {
      if (!sameName(f.sheet, s.name)) continue;
      const r = rectOf(f.R);
      paneClip(f.R);
      g.fillStyle = f.color ? rgba(f.color, 0.32 * (1 - (now - f.t0) / 1600)) : `rgba(147,52,230,${0.32 * (1 - (now - f.t0) / 1600)})`;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.restore();
    }
    // other people: their selection (tinted) and active cell with a name tag
    for (const p of others) {
      if (!p.sheet || !sameName(p.sheet, s.name)) continue;
      for (const rs of p.ranges || []) {
        const R = parseRange(rs);
        if (!R || (R.c1 === R.c2 && R.r1 === R.r2)) continue;
        const r = rectOf(R);
        paneClip(R);
        g.fillStyle = rgba(p.color || '#888', 0.08);
        g.fillRect(r.x, r.y, r.w, r.h);
        g.restore();
        strokeRange(R, rgba(p.color || '#888', 0.55), 1);
      }
      const A = p.active && parseRange(p.active);
      if (!A) continue;
      const r = strokeRange(A, p.color || '#888', 2);
      g.font = `600 ${10}px system-ui, sans-serif`;
      const tw = g.measureText(p.name).width + 8;
      g.fillStyle = p.color || '#888';
      const ty = A.r1 === 0 ? r.y + r.h : r.y - 14;   // first row: tag below the cell
      const tx = Math.max(r.x, r.x + r.w - tw);         // narrow cell: tag starts at the cell, not off its left edge
      g.fillRect(tx, ty, tw, 14);
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(p.name, tx + 4, ty + 7);
      g.textBaseline = 'alphabetic';
    }
    if (agentBox && now - agentBox.t0 < 10000 && sameName(agentBox.sheet, s.name)) {
      const r = strokeRange(agentBox.R, C.agent, 2, [5, 3]);
      const label = agentBox.label || 'agent';
      g.font = `600 ${11}px system-ui, sans-serif`;
      const tw = g.measureText(label).width + 10;
      g.fillStyle = C.agent;
      g.fillRect(r.x - 1, r.y - 17, tw, 16);
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(label, r.x + 4, r.y - 9);
      g.textBaseline = 'alphabetic';
    }
    // copy/cut marching ants
    if (clip && sameName(clip.sheet, s.name)) {
      const r = rectOf(clip.R);
      paneClip(clip.R);
      g.strokeStyle = C.sel; g.lineWidth = 2; g.setLineDash([6, 4]); g.lineDashOffset = -(now / 40) % 10;
      g.strokeRect(r.x, r.y, r.w - 1, r.h - 1);
      g.setLineDash([]); g.lineDashOffset = 0;
      g.restore();
    }
    // named tables: border + name chip at top-right
    for (const t of s.tables || []) {
      const R = parseRange(t.range);
      strokeRange(R, '#6f9be0', 1);
      const c = chipRect(t);
      paneClip(R);
      g.font = c.font;
      g.fillStyle = hoverChip === t.name ? '#0842a0' : '#0b57d0';
      g.beginPath(); g.roundRect ? g.roundRect(c.x, c.y, c.w, c.h, [4, 4, 0, 0]) : g.rect(c.x, c.y, c.w, c.h); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(c.label, c.x + 5, c.y + c.h / 2 + 0.5);
      g.textBaseline = 'alphabetic';
      g.restore();
      // + row / + column handles on the table you're in
      if (!edit && inRange(R, sel.active.c, sel.active.r)) {
        for (const h of plusHandles(t)) {
          g.fillStyle = hoverPlus === h.key ? '#0b57d0' : '#fff';
          g.strokeStyle = '#0b57d0'; g.lineWidth = 1.2;
          g.beginPath(); g.arc(h.x, h.y, h.r, 0, Math.PI * 2); g.fill(); g.stroke();
          g.strokeStyle = hoverPlus === h.key ? '#fff' : '#0b57d0'; g.lineWidth = 1.6;
          g.beginPath(); g.moveTo(h.x - h.r * 0.5, h.y); g.lineTo(h.x + h.r * 0.5, h.y); g.moveTo(h.x, h.y - h.r * 0.5); g.lineTo(h.x, h.y + h.r * 0.5); g.stroke();
        }
      }
    }
    // formula reference highlights while editing
    if (edit && edit.input.value[0] === '=') {
      refSpans(edit.input.value).forEach((sp, i) => {
        const target = sp.ref.sheet ?? edit.sheet;
        if (!sameName(target, s.name)) return;
        const R = refBox(sp.ref);
        const col = REF_COLORS[i % REF_COLORS.length];
        const r = rectOf(R);
        paneClip(R);
        g.fillStyle = col + '22'; g.fillRect(r.x, r.y, r.w - 1, r.h - 1);
        g.strokeStyle = col; g.lineWidth = 2; g.setLineDash(edit.pointRef && sp.end === edit.pointRef.end ? [4, 3] : []);
        g.strokeRect(r.x, r.y, r.w - 1, r.h - 1);
        g.setLineDash([]);
        g.restore();
      });
    }
    // selection
    const pointing = edit && !sameName(edit.sheet, s.name);
    if (!pointing) {
      sel.ranges.forEach((R, i) => {
        const AR = activeRect();
        const single = (R.c1 === R.c2 && R.r1 === R.r2) || (R.c1 === AR.c1 && R.c2 === AR.c2 && R.r1 === AR.r1 && R.r2 === AR.r2);
        if (single && sel.ranges.length === 1) return;
        const r = rectOf(R);
        paneClip(R);
        g.fillStyle = C.selFill;
        g.beginPath(); g.rect(r.x, r.y, r.w - 1, r.h - 1);
        if (i === sel.ranges.length - 1) { const a = rectOf(activeRect()); g.rect(a.x, a.y, a.w - 1, a.h - 1); }
        g.fill('evenodd');
        g.restore();
        strokeRange(R, C.sel, 1);
      });
      strokeRange(activeRect(), C.sel, 2);
      if (!edit && sel.ranges.length === 1) {
        const r = rectOf(lastR());
        paneClip(lastR());
        g.fillStyle = '#fff'; g.fillRect(r.x + r.w - 5, r.y + r.h - 5, 8, 8);
        g.fillStyle = C.sel; g.fillRect(r.x + r.w - 4, r.y + r.h - 4, 6, 6);
        g.restore();
      }
    }
    // drag ghosts
    if (drag && drag.type === 'move' && (drag.dr || drag.dc)) {
      const R = drag.src;
      strokeRange({ c1: R.c1 + drag.dc, r1: R.r1 + drag.dr, c2: R.c2 + drag.dc, r2: R.r2 + drag.dr }, '#5f6368', 2, [4, 3]);
    }
    if (drag && drag.type === 'fill' && drag.tgt) strokeRange(drag.tgt, '#5f6368', 1, [4, 3]);
  }

  function chartRect(ch) {
    const p = parseAddr(splitSheet(ch.at)[1]) || { c: 0, r: 0 };
    return { x: sx(p.c) + (ch.dx || 0) * z, y: sy(p.r) + (ch.dy || 0) * z, w: ch.w * z, h: ch.h * z, p };
  }
  function drawCharts() {
    for (const ch of sh().charts || []) {
      let r = chartRect(ch);
      if (drag && drag.type === 'chart' && drag.id === ch.id && drag.cur) r = { ...r, ...drag.cur };
      if (r.x > W || r.y > H || r.x + r.w < 0 || r.y + r.h < 0) continue;
      let data;
      try { data = chartData(doc, sh().name, ch, engine); } catch { data = { labels: [], series: [] }; }
      paneClip({ c1: r.p.c, r1: r.p.r });
      drawChart(g, r, ch, data, z, selChart === ch.id);
      g.restore();
    }
  }
  // ---------------------------------------------------------------- table chips (drag to move) and + handles
  let hoverChip = null, hoverPlus = null;
  function chipRect(t) {
    const R = parseRange(t.range), r = rectOf(R);
    const font = `600 ${Math.max(10, 11 * hz())}px system-ui, sans-serif`;
    g.font = font;
    const label = '▦ ' + t.name;
    const w = g.measureText(label).width + 10, h = Math.max(14, 15 * hz());
    return { x: r.x + r.w - w - 1, y: r.y - h, w, h, font, label, R };
  }
  function plusHandles(t) {
    const r = rectOf(parseRange(t.range)), rad = Math.max(7, 8 * hz());
    return [
      { key: t.name + ':row', kind: 'row', t, x: r.x + rad + 2, y: r.y + r.h + rad + 3, r: rad },
      { key: t.name + ':col', kind: 'col', t, x: r.x + r.w + rad + 3, y: r.y + rad + 2, r: rad },
    ];
  }
  function hitChip(x, y) {
    for (const t of sh().tables || []) { const c = chipRect(t); if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return t; }
    return null;
  }
  function hitPlus(x, y) {
    if (edit) return null;
    for (const t of sh().tables || []) {
      if (!inRange(parseRange(t.range), sel.active.c, sel.active.r)) continue;
      for (const h of plusHandles(t)) if (Math.hypot(x - h.x, y - h.y) <= h.r + 3) return h;
    }
    return null;
  }
  function addTableRow(t) {
    const R = parseRange(t.range);
    submit([{ op: 'appendRows', sheet: sh().name, table: t.name, rows: [[]] }]);
    setActive({ c: R.c1, r: R.r2 + 1 });
    ensureVisible(R.c1, R.r2 + 1);
  }
  function addTableCol(t) {
    const R = parseRange(t.range), s = sh();
    const names = new Set(tableColumns(s, R).map((x) => String(x).toLowerCase()));
    let i = R.c2 - R.c1 + 2; while (names.has(('column ' + i))) i++;
    submit([{ op: 'addColumn', sheet: s.name, table: t.name, name: 'Column ' + i }]);
    setActive({ c: R.c2 + 1, r: R.r1 });
    ensureVisible(R.c2 + 1, R.r1);
    startEdit('edit');   // name it right away: the default name is selected, typing replaces it
    ed.setSelectionRange(0, ed.value.length);
  }
  /** Move a whole table (cells, formats, its rules) — within the sheet or to another one. */
  function moveTable(t, toSheet, at) {
    const R = parseRange(t.range);
    const dest = at || addr(R.c1, R.r1);
    submit([{ op: 'move', sheet: sh().name, from: t.range, to: (toSheet && !sameName(toSheet, sh().name) ? quoteSheet(toSheet) + '!' : '') + dest }]);
    if (toSheet && !sameName(toSheet, sh().name)) {
      switchSheet(doc.sheets.find((x) => sameName(x.name, toSheet)).name);
      const p = parseAddr(dest);
      setActive(p); ensureVisible(p.c, p.r);
      ctx.toast(`Moved table ${t.name} to ${toSheet}`);
    }
  }

  function hitChart(x, y) {
    const list = sh().charts || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = chartRect(list[i]);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { ch: list[i], r, handle: x > r.x + r.w - 12 && y > r.y + r.h - 12 };
    }
    return null;
  }
  function mapEditor(ch, anchor) {
    ctx.popover(anchor, (p, close) => {
      p.style.width = '320px';
      const row = (label, el) => { const l = document.createElement('label'); l.style.cssText = 'display:flex;gap:6px;align-items:center;width:100%'; const t = document.createElement('span'); t.textContent = label; t.style.cssText = 'width:64px;color:#5f6368;font-size:12px'; l.append(t, el); el.style.flex = '1'; p.append(l); return el; };
      const title = row('Title', Object.assign(document.createElement('input'), { value: ch.title || '' }));
      const layers = row('Layers', Object.assign(document.createElement('input'), { value: ch.layers.map((L) => L.table + (L.route ? ' +route' : '') + (L.color ? ' color=' + L.color : '')).join(', '), placeholder: 'Places +route, Robots color=Status' }));
      const base = document.createElement('select');
      for (const b of MAP_BASES) base.add(new Option(b === 'none' ? 'none (points float)' : b, b, false, b === (ch.basemap || 'dark')));
      row('Map', base);
      const follow = row('Follow', Object.assign(document.createElement('input'), { value: ch.follow || '', placeholder: 'a point label (camera follows it)' }));
      const hint = document.createElement('div'); hint.style.cssText = 'font-size:11px;color:#5f6368'; hint.textContent = 'Columns lat/lon (or one "coords" column) are found by name. The full map is in ▶ Live.';
      const save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save';
      const fit = document.createElement('button'); fit.className = 'btn2'; fit.textContent = 'Fit to points';
      const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete'; del.style.background = '#c5221f';
      save.onclick = () => {
        const L = layers.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
          const [table, ...more] = x.split(/\s+/);
          const o = { table: table.replace(/^@/, '') };
          for (const m of more) { if (m === '+route') o.route = true; else if (m.includes('=')) { const [k, v] = m.split('='); o[k] = v; } }
          const old = ch.layers.find((y) => y.table.toLowerCase() === o.table.toLowerCase());
          return { ...(old || {}), ...o, ...(more.includes('+route') ? {} : { route: undefined }) };
        }).map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
        if (submit([{ op: 'updateChart', id: ch.id, title: title.value || null, layers: L, basemap: base.value === 'dark' ? null : base.value, follow: follow.value.trim() || null }])) close();
        ed.focus();
      };
      fit.onclick = () => { close(); submit([{ op: 'updateChart', id: ch.id, view: null, follow: null }]); ed.focus(); };
      del.onclick = () => { close(); submit([{ op: 'deleteChart', id: ch.id }]); selChart = null; ed.focus(); };
      p.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
      p.append(hint, save, fit, del);
      setTimeout(() => title.focus());
    });
  }
  /** A map of a table, when it has coordinates. */
  function insertMap(tab) {
    let n = 1;
    while (doc.sheets.some((s2) => (s2.charts || []).some((c) => c.id === 'map' + n))) n++;
    const o = { op: 'addChart', id: 'map' + n, sheet: sh().name, type: 'map', title: tab.t.name, layers: [{ table: tab.t.name }], at: addr(tab.R.c2 + 2, tab.R.r1) };
    if (submit([o])) { selChart = o.id; requestDraw(); }
  }
  const hasCoords = (tab) => { try { return !mapData(doc, { layers: [{ table: tab.t.name }] }, engine).layers[0].error; } catch { return false; } };
  function chartEditor(ch, anchor) {
    if (ch.type === 'map') return mapEditor(ch, anchor);
    ctx.popover(anchor, (p, close) => {
      p.style.width = '300px';
      const row = (label, el) => { const l = document.createElement('label'); l.style.cssText = 'display:flex;gap:6px;align-items:center;width:100%'; const t = document.createElement('span'); t.textContent = label; t.style.cssText = 'width:64px;color:#5f6368;font-size:12px'; l.append(t, el); el.style.flex = '1'; p.append(l); return el; };
      const type = document.createElement('select');
      for (const t of CHART_TYPES) if (t !== 'map' && (t !== 'viz' || ch.type === 'viz')) type.add(new Option(t, t, false, t === ch.type));
      row('Type', type);
      const title = row('Title', Object.assign(document.createElement('input'), { value: ch.title || '' }));
      const src = row('Data', Object.assign(document.createElement('input'), { value: ch.type === 'kpi' ? ch.value || '' : ch.table ? '@' + ch.table : ch.range || '', placeholder: 'B6:C10 · @Table · C12 (kpi)' }));
      const xi = row('X col', Object.assign(document.createElement('input'), { value: ch.x || '', placeholder: 'table: label column' }));
      const yi = row('Y cols', Object.assign(document.createElement('input'), { value: (ch.y || []).join(', '), placeholder: 'table: value columns' }));
      const save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save';
      const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete'; del.style.background = '#c5221f';
      save.onclick = () => {
        close();
        const t = type.value, v = src.value.trim();
        const o = { op: 'updateChart', id: ch.id, type: t, title: title.value || null };
        if (t === 'kpi') o.value = v; else if (v.startsWith('@')) { o.range = v; o.x = xi.value.trim() || null; o.y = yi.value.trim() ? yi.value.split(',').map((x) => x.trim()) : null; } else o.range = v;
        if (t === 'kpi' && ch.type !== 'kpi') { o.w = 220; o.h = 120; }
        if (t !== 'kpi' && ch.type === 'kpi') { o.w = 440; o.h = 260; }
        submit([o]);
        ed.focus();
      };
      del.onclick = () => { close(); submit([{ op: 'deleteChart', id: ch.id }]); selChart = null; ed.focus(); };
      p.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
      p.append(save, del);
      setTimeout(() => title.focus());
    });
  }
  function insertChart(anchorEl) {
    const R = clampFull(lastR());
    const tab = tableAt(doc, sh().name, sel.active.c, sel.active.r);
    const single = R.c1 === R.c2 && R.r1 === R.r2;
    const o = { op: 'addChart', sheet: sh().name, type: 'column', at: addr((tab && single ? tab.R.c2 : R.c2) + 2, tab && single ? tab.R.r1 : R.r1) };
    if (tab && single) o.table = tab.t.name;
    else if (single) { o.type = 'kpi'; o.value = addr(R.c1, R.r1); o.at = addr(R.c1 + 2, R.r1); }
    else o.range = rangeToString(R);
    let n = 1;
    while (doc.sheets.some((s2) => (s2.charts || []).some((c) => c.id === 'chart' + n))) n++;
    o.id = 'chart' + n;
    if (submit([o])) {
      selChart = o.id;
      const ch = sh().charts.find((c) => c.id === o.id);
      const r = chartRect(ch), b = scroller.getBoundingClientRect();
      requestDraw();
      chartEditor(ch, { left: b.left + r.x, bottom: b.top + r.y + 24 });
    }
  }

  function drawHeaders(ca, cb, ra, rb) {
    const f = fz(), X0 = hw(), Y0 = hh(), XF = X0 + frozenW(), YF = Y0 + frozenH();
    const pointing = edit && !sameName(edit.sheet, sheetName);
    const selC = new Map(), selR = new Map();
    if (!pointing) for (const R of sel.ranges) {
      const fullC = R.r1 === 0 && R.r2 >= MAXR - 1, fullR = R.c1 === 0 && R.c2 >= MAXC - 1;
      for (let c = Math.max(R.c1, 0); c <= Math.min(R.c2, colsExt - 1); c++) selC.set(c, selC.get(c) || fullC);
      for (let r = Math.max(R.r1, 0); r <= Math.min(R.r2, rowsExt - 1); r++) selR.set(r, selR.get(r) || fullR);
    }
    g.font = `${11 * hz()}px Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // column header strip
    g.fillStyle = C.hdrBg; g.fillRect(0, 0, W, Y0);
    const colPass = (a, b, clipX0, clipX1) => {
      if (b < a) return;
      g.save(); g.beginPath(); g.rect(clipX0, 0, clipX1 - clipX0, Y0); g.clip();
      for (let c = a; c <= b; c++) {
        const x = sx(c), w = cw(c) * z;
        if (selC.has(c)) { g.fillStyle = selC.get(c) ? C.hdrFull : C.hdrSel; g.fillRect(x, 0, w, Y0); }
        g.fillStyle = selC.get(c) ? '#fff' : selC.has(c) ? C.hdrSelText : C.hdrText;
        g.fillText(colToName(c), x + w / 2, Y0 / 2 + 1);
        g.fillStyle = C.hdrLine; g.fillRect(x + w - 1, 0, 1 / dpr * 1, Y0);
      }
      g.restore();
    };
    colPass(ca, cb, XF, W);
    if (f.cols) colPass(0, f.cols - 1, X0, XF);
    // row header strip
    g.fillStyle = C.hdrBg; g.fillRect(0, Y0, X0, H - Y0);
    const rowPass = (a, b, clipY0, clipY1) => {
      if (b < a) return;
      g.save(); g.beginPath(); g.rect(0, clipY0, X0, clipY1 - clipY0); g.clip();
      for (let r = a; r <= b; r++) {
        const y = sy(r), h = rh(r) * z;
        if (selR.has(r)) { g.fillStyle = selR.get(r) ? C.hdrFull : C.hdrSel; g.fillRect(0, y, X0, h); }
        g.fillStyle = selR.get(r) ? '#fff' : selR.has(r) ? C.hdrSelText : C.hdrText;
        g.fillText(String(r + 1), X0 / 2, y + h / 2 + 1);
        g.fillStyle = C.hdrLine; g.fillRect(0, y + h - 1, X0, 1 / dpr);
      }
      g.restore();
    };
    rowPass(ra, rb, YF, H);
    if (f.rows) rowPass(0, f.rows - 1, Y0, YF);
    // borders + corner
    g.fillStyle = C.hdrLine;
    g.fillRect(0, Y0 - 1, W, 1); g.fillRect(X0 - 1, 0, 1, H);
    g.fillStyle = C.hdrBg; g.fillRect(0, 0, X0 - 1, Y0 - 1);
    g.textBaseline = 'alphabetic';
  }

  // ================================================================ editor
  function placeEditor() {
    const showHere = edit && sameName(edit.sheet, sheetName) && edit.input === ed || (edit && sameName(edit.sheet, sheetName) && edit.input === fx);
    if (!showHere) {
      ed.className = 'sv-editor idle';
      const x = sx(sel.active.c), y = sy(sel.active.r);
      ed.style.left = Math.max(0, Math.min(W - 2, x)) + 'px';
      ed.style.top = Math.max(0, Math.min(H - 2, y)) + 'px';
      return;
    }
    const EM = mergeR(edit.c, edit.r);
    const er = EM ? rectOf(EM) : null;
    const x = sx(edit.c), y = sy(edit.r), w = er ? er.w : cw(edit.c) * z, h = er ? er.h : rh(edit.r) * z;
    const est = sh().cells[addr(edit.c, edit.r)]?.s || {};
    const efs = (est.fs || FONT) * z;
    const font = `${efs}px ${fontStack(est.ff)}`;
    g.font = font;
    const lines = ed.value.split('\n');
    const tw = Math.max(...lines.map((l) => g.measureText(l + 'MM').width));
    const lh = efs * 1.3;
    ed.className = 'sv-editor';
    ed.style.font = font;
    ed.style.left = x - 2 + 'px';
    ed.style.top = y - 2 + 'px';
    ed.style.width = Math.min(Math.max(w + 3, tw + 8 * z), Math.max(w + 3, W - x)) + 'px';
    ed.style.height = Math.max(h + 3, lines.length * lh + 8) + 'px';
    ed.style.lineHeight = lines.length > 1 ? lh + 'px' : h - 3 + 'px';
    ed.style.padding = `0 ${3 * z - 1}px`;
  }

  function startEdit(mode, initial, input = ed) {
    const s = sh();
    const { c, r } = sel.active;
    const orig = s.cells[addr(c, r)]?.v ?? '';
    edit = { sheet: s.name, c, r, mode, orig, input, pointRef: null };
    const text = initial !== undefined ? initial : orig;
    if (ed.value !== text) ed.value = text;
    if (fx.value !== text) fx.value = text;
    if (input === ed) { ed.focus(); const n = ed.value.length; ed.setSelectionRange(n, n); }
    requestDraw();
  }

  function commitEdit(moveDr = 0, moveDc = 0) {
    if (!edit) return;
    const e = edit;
    let v = e.input.value;
    if (v[0] === '=') v = autoClose(v);
    edit = null;
    ed.value = '';
    if (!sameName(sheetName, e.sheet)) switchSheet(e.sheet, true);
    if (v !== e.orig) {
      const ops = [{ op: 'set', sheet: e.sheet, cells: { [addr(e.c, e.r)]: v === '' ? null : v } }];
      if (v !== '' && !tableAt(doc, e.sheet, e.c, e.r)) {
        for (const t of sh().tables || []) {
          const R = parseRange(t.range);
          const below = e.r === R.r2 + 1 && e.c >= R.c1 && e.c <= R.c2;
          const right = e.c === R.c2 + 1 && e.r === R.r1;
          if (below || right) {
            const N = below ? { ...R, r2: R.r2 + 1 } : { ...R, c2: R.c2 + 1 };
            ops.push({ op: 'table', name: t.name, range: quoteSheet(e.sheet) + '!' + rangeToString(N) });
            break;
          }
        }
      }
      submit(ops);
    }
    ed.focus();
    if (moveDr || moveDc) moveActive(moveDc, moveDr, false, false);
    syncBars();
    requestDraw();
  }

  function cancelEdit() {
    if (!edit) return;
    const e = edit;
    edit = null;
    ed.value = '';
    if (!sameName(sheetName, e.sheet)) switchSheet(e.sheet, true);
    ed.focus();
    syncBars();
    requestDraw();
  }

  const isFormulaEdit = () => edit && edit.input.value[0] === '=';
  function pointable() {
    if (!isFormulaEdit()) return false;
    const inp = edit.input, t = inp.value, pos = inp.selectionStart;
    if (inp.selectionStart !== inp.selectionEnd) return false;
    if (edit.pointRef && pos === edit.pointRef.end) return true;
    return /[=(,;+\-*/^&<>:]$/.test(t.slice(0, pos).replace(/\s+$/, ''));
  }
  function setPointRef(anchor, cur) {
    const inp = edit.input, t = inp.value, pr = edit.pointRef;
    const start = pr ? pr.start : inp.selectionStart, end = pr ? pr.end : inp.selectionStart;
    let txt = rangeToString(norm({ c1: anchor.c, r1: anchor.r, c2: cur.c, r2: cur.r }));
    if (!sameName(sheetName, edit.sheet)) txt = quoteSheet(sh().name) + '!' + txt;
    inp.value = t.slice(0, start) + txt + t.slice(end);
    const ne = start + txt.length;
    inp.setSelectionRange(ne, ne);
    edit.pointRef = { start, end: ne, anchor, cell: cur };
    (inp === ed ? fx : ed).value = inp.value;
    ensureVisible(cur.c, cur.r);
    requestDraw();
  }

  // ================================================================ selection & navigation
  const mergeR = (c, r) => mergeAt(sh(), c, r);
  /** Grow a range until it fully contains every merge it touches (like Sheets). */
  function expandMerges(R) {
    const ms = (sh().merges || []).map((m) => parseRange(m));
    if (!ms.length) return R;
    for (let changed = true, guard = 0; changed && guard < 50; guard++) {
      changed = false;
      for (const M of ms) {
        if (M.c1 <= R.c2 && R.c1 <= M.c2 && M.r1 <= R.r2 && R.r1 <= M.r2 && !(R.c1 <= M.c1 && R.c2 >= M.c2 && R.r1 <= M.r1 && R.r2 >= M.r2)) {
          R = { c1: Math.min(R.c1, M.c1), r1: Math.min(R.r1, M.r1), c2: Math.max(R.c2, M.c2), r2: Math.max(R.r2, M.r2) };
          changed = true;
        }
      }
    }
    return R;
  }
  const activeRect = () => { const M = mergeR(sel.active.c, sel.active.r); return M || { c1: sel.active.c, r1: sel.active.r, c2: sel.active.c, r2: sel.active.r }; };
  function setActive(p, keepTab) {
    const M = mergeR(p.c, p.r);
    if (M) p = { c: M.c1, r: M.r1 };
    sel = { ranges: [M || { c1: p.c, r1: p.r, c2: p.c, r2: p.r }], active: { ...p }, anchor: { ...p }, cursor: { ...p } };
    if (!keepTab) tabStartCol = null;
    afterSelect();
  }
  function extendTo(p) {
    sel.cursor = { ...p };
    sel.ranges[sel.ranges.length - 1] = expandMerges(norm({ c1: sel.anchor.c, r1: sel.anchor.r, c2: p.c, r2: p.r }));
    afterSelect();
  }
  function afterSelect() {
    syncBars();
    renderToolbarState();
    reportSel();
    requestDraw();
  }
  function reportSel() {
    ctx.reportSelection({ sheet: sh().name, ranges: sel.ranges.map((R) => rangeToString(clampFull(R))), active: addr(sel.active.c, sel.active.r) });
  }
  function clampFull(R) {
    const e = engine.extent(sh());
    return { c1: R.c1, r1: R.r1, c2: R.c2 >= MAXC - 1 ? Math.max(e.c, R.c1) : R.c2, r2: R.r2 >= MAXR - 1 ? Math.max(e.r, R.r1) : R.r2 };
  }

  function syncBars() {
    const R = lastR();
    const AR = activeRect();
    const single = sel.ranges.length === 1 && ((R.c1 === R.c2 && R.r1 === R.r2) || (R.c1 === AR.c1 && R.c2 === AR.c2 && R.r1 === AR.r1 && R.r2 === AR.r2));
    if (document.activeElement !== nameBox) nameBox.value = single ? addr(sel.active.c, sel.active.r) : rangeToString(clampFull(R));
    if (!edit) fx.value = sh().cells[addr(sel.active.c, sel.active.r)]?.v ?? '';
    updateStats();
  }

  function updateStats() {
    let sum = 0, n = 0, cnt = 0, seen = 0;
    const s = sh();
    for (const R0 of sel.ranges) {
      const R = clampFull(R0);
      if ((R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1) > 50000) continue;
      for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) {
        seen++;
        if (!s.cells[addr(c, r)]) continue;
        const v = engine.value(s, c, r);
        if (v !== null && v !== '') cnt++;
        if (typeof v === 'number') { sum += v; n++; }
      }
    }
    statsEl.textContent = seen > 1 && cnt ? (n ? `Sum ${fmtValue(sum)}   Avg ${fmtValue(sum / n)}   ` : '') + `Count ${cnt}` : '';
  }

  function ensureVisible(c, r) {
    if (r >= rowsExt - 20 || c >= colsExt - 3) rebuild();
    const f = fz();
    if (c >= f.cols) {
      const left = hw() + frozenW(), x = sx(c), w = cw(c) * z;
      if (x < left) scroller.scrollLeft -= left - x;
      else if (x + w > W) scroller.scrollLeft += x + w - W;
    }
    if (r >= f.rows) {
      const top = hh() + frozenH(), y = sy(r), h = rh(r) * z;
      if (y < top) scroller.scrollTop -= top - y;
      else if (y + h > H) scroller.scrollTop += y + h - H;
    }
  }

  function jump(p, dc, dr) {
    const s = sh(), e = engine.extent(s);
    const maxC = Math.max(e.c, colsExt - 1), maxR = Math.max(e.r, rowsExt - 1);
    const ok = (c, r) => c >= 0 && r >= 0 && c <= maxC && r <= maxR;
    let c = p.c, r = p.r;
    const filled = (c2, r2) => hasContent(s, c2, r2);
    if (!ok(c + dc, r + dr)) return p;
    if (filled(c, r) && filled(c + dc, r + dr)) {
      while (ok(c + dc, r + dr) && filled(c + dc, r + dr)) { c += dc; r += dr; }
      return { c, r };
    }
    c += dc; r += dr;
    while (ok(c, r) && !filled(c, r) && (dr ? r <= e.r + 1 && r >= 0 : c <= e.c + 1 && c >= 0)) {
      if (ok(c + dc, r + dr)) { c += dc; r += dr; } else break;
    }
    if (!ok(c, r) || !filled(c, r)) return { c: dc > 0 ? Math.min(maxC, Math.max(c, p.c)) : dc < 0 ? 0 : p.c, r: dr > 0 ? Math.min(maxR, Math.max(r, p.r)) : dr < 0 ? 0 : p.r };
    return { c, r };
  }

  function moveActive(dc, dr, extend, toEdge) {
    let from = extend ? sel.cursor : sel.active;
    const M = !extend && mergeR(from.c, from.r);
    if (M) from = { c: dc > 0 ? M.c2 : M.c1, r: dr > 0 ? M.r2 : M.r1 };
    const t = toEdge ? jump(from, dc, dr) : { c: Math.max(0, from.c + dc), r: Math.max(0, from.r + dr) };
    if (extend) extendTo(t); else setActive(t, true);
    ensureVisible(t.c, t.r);
  }

  function gotoRef(text) {
    const tb = allTables(doc).find((x) => sameName(x.t.name, text.replace(/^@/, '')));
    if (tb) text = quoteSheet(tb.sh.name) + '!' + tb.t.range;
    const [sn, rs] = splitSheet(text);
    if (sn) { const s = doc.sheets.find((x) => sameName(x.name, sn)); if (!s) return ctx.toast(`No sheet ${sn}`, true); switchSheet(s.name); }
    const R = parseRange(rs, MAXR, MAXC);
    if (!R) return ctx.toast(`Not a cell or range: ${text}`, true);
    sel = { ranges: [R], active: { c: R.c1, r: R.r1 }, anchor: { c: R.c1, r: R.r1 }, cursor: { c: R.c2, r: R.r2 } };
    rebuild();
    ensureVisible(R.c1, R.r1);
    afterSelect();
  }

  // ================================================================ ops
  function submit(ops, undoable = true) {
    const inv = ctx.submit(ops);
    if (inv === null) { refresh(); return false; }
    if (undoable && inv.length) { undoStack.push(inv); if (undoStack.length > 300) undoStack.shift(); redoStack = []; }
    refresh();
    return true;
  }
  function undo() { const inv = undoStack.pop(); if (!inv) return; const re = ctx.submit(inv); if (re) redoStack.push(re); refresh(); }
  function redo() { const ops = redoStack.pop(); if (!ops) return; const inv = ctx.submit(ops); if (inv) undoStack.push(inv); refresh(); }

  let live = null;
  function startLive(opts = {}) {
    if (edit) commitEdit();
    if (live) return live.present(opts);
    live = openLive(ctx, doc, opts.sheet && doc.sheets.some((x) => sameName(x.name, opts.sheet)) ? doc.sheets.find((x) => sameName(x.name, opts.sheet)).name : sh().name, {
      ...opts,
      submit: (ops) => submit(ops),
      onClose: (name) => { live = null; if (!sameName(name, sheetName)) switchSheet(name); ed.focus(); requestDraw(); },
    });
    live?.people?.(others);
    if (opts.replay && live) live.present({ replay: opts.replay });
  }
  function refresh() {
    live?.update();
    engine.invalidate();
    if (!doc.sheets.find((s) => sameName(s.name, sheetName))) sheetName = doc.sheets[0].name;
    rebuild();
    renderTabs();
    syncBars();
    requestDraw();
  }

  function eachCellIn(R, fn) {
    const s = sh();
    R = clampFull(R);
    const area = (R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1);
    if (area > Object.keys(s.cells).length) {
      for (const A in s.cells) { const p = parseAddr(A); if (inRange(R, p.c, p.r)) fn(A, s.cells[A], p); }
    } else {
      for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) { const A = addr(c, r); if (s.cells[A]) fn(A, s.cells[A], { c, r }); }
    }
  }

  function clearSelection() {
    const cells = {};
    for (const R of sel.ranges) eachCellIn(R, (A, cell) => { if (cell.v !== '') cells[A] = null; });
    if (Object.keys(cells).length) submit([{ op: 'set', sheet: sh().name, cells }]);
  }

  function toggleStyle(k, value) {
    const cur = sh().cells[addr(sel.active.c, sel.active.r)]?.s?.[k];
    const nv = value !== undefined ? value : !cur;
    const ranges = sel.ranges.map((R) => rangeToString(clampFull(R)));
    submit([{ op: 'format', sheet: sh().name, ranges, style: { [k]: nv || null } }]);
    renderToolbarState();
  }

  // ---------------- clipboard
  function copySel(cut) {
    const R = clampFull(lastR());
    const s = sh();
    const cells = [], rows = [];
    for (let r = R.r1; r <= R.r2; r++) {
      const row = [], trow = [];
      for (let c = R.c1; c <= R.c2; c++) {
        const cell = s.cells[addr(c, r)];
        row.push(cell ? { v: cell.v, s: cell.s } : null);
        let t = cell ? fmtValue(engine.value(s, c, r)) : '';
        if (/[\t\n"]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
        trow.push(t);
      }
      cells.push(row); rows.push(trow.join('\t'));
    }
    clip = { sheet: s.name, R, cut, text: rows.join('\n'), cells };
    requestDraw();
    return clip.text;
  }

  function parseTSV(t) {
    t = t.replace(/\r\n?/g, '\n');
    if (t.endsWith('\n')) t = t.slice(0, -1);
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"' && cur === '') q = true;
      else if (ch === '\t') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    row.push(cur); rows.push(row);
    return rows;
  }

  function paste(text) {
    const s = sh();
    const D = lastR();
    if (clip && text.replace(/\r/g, '') === clip.text.replace(/\r/g, '')) {
      const R = clip.R, h = R.r2 - R.r1 + 1, w = R.c2 - R.c1 + 1;
      if (clip.cut) {
        const src = clip; clip = null;
        submit([{ op: 'move', sheet: src.sheet, from: rangeToString(R), to: quoteSheet(s.name) + '!' + addr(D.c1, D.r1) }]);
        sel = { ranges: [{ c1: D.c1, r1: D.r1, c2: D.c1 + w - 1, r2: D.r1 + h - 1 }], active: { c: D.c1, r: D.r1 }, anchor: { c: D.c1, r: D.r1 }, cursor: { c: D.c1, r: D.r1 } };
        afterSelect();
        return;
      }
      const dh = D.r2 - D.r1 + 1, dw = D.c2 - D.c1 + 1;
      const th = dh % h === 0 && dh > h ? dh : h, tw = dw % w === 0 && dw > w ? dw : w;
      const cells = {}, styles = {};
      for (let i = 0; i < th; i++) for (let j = 0; j < tw; j++) {
        const src = clip.cells[i % h][j % w];
        const A = addr(D.c1 + j, D.r1 + i);
        let v = src ? src.v : null;
        if (typeof v === 'string' && v[0] === '=') v = shiftFormula(v, D.r1 + i - (R.r1 + (i % h)), D.c1 + j - (R.c1 + (j % w)));
        cells[A] = v === '' ? null : v;
        styles[A] = src?.s || null;
      }
      submit([{ op: 'set', sheet: s.name, cells }, { op: 'cellStyles', sheet: s.name, styles }]);
      selectBlock(D.c1, D.r1, tw, th);
      return;
    }
    const rows = parseTSV(text);
    submit([{ op: 'set', sheet: s.name, range: addr(D.c1, D.r1), values: rows.map((r) => r.map((v) => (v === '' ? null : v))) }]);
    selectBlock(D.c1, D.r1, Math.max(...rows.map((r) => r.length)), rows.length);
  }
  function selectBlock(c, r, w, h) {
    sel = { ranges: [{ c1: c, r1: r, c2: c + w - 1, r2: r + h - 1 }], active: { c, r }, anchor: { c, r }, cursor: { c: c + w - 1, r: r + h - 1 } };
    afterSelect();
  }

  // ---------------- fill
  function fill(src, tgt) {
    const s = sh();
    const cells = {}, styles = {};
    const vertical = tgt.c1 === src.c1 && tgt.c2 === src.c2;
    const len = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1;
    const lanes = vertical ? [src.c1, src.c2] : [src.r1, src.r2];
    for (let lane = lanes[0]; lane <= lanes[1]; lane++) {
      const seq = [];
      for (let k = 0; k < len; k++) {
        const c = vertical ? lane : src.c1 + k, r = vertical ? src.r1 + k : lane;
        seq.push({ c, r, cell: s.cells[addr(c, r)] });
      }
      const nums = seq.map((x) => (x.cell && x.cell.v[0] !== '=' ? literal(x.cell.v) : null));
      let step = null;
      if (len >= 2 && nums.every((x) => typeof x === 'number')) {
        const d = nums[1] - nums[0];
        if (nums.every((x, i) => i === 0 || Math.abs(x - nums[i - 1] - d) < 1e-9)) step = d;
      }
      const from = vertical ? tgt.r1 : tgt.c1, to = vertical ? tgt.r2 : tgt.c2;
      const base = vertical ? src.r1 : src.c1;
      for (let p = from; p <= to; p++) {
        const off = p - base;
        const k = ((off % len) + len) % len;
        const srcCell = seq[k];
        const c = vertical ? lane : p, r = vertical ? p : lane;
        const A = addr(c, r);
        let v;
        if (step !== null) v = String(parseFloat((nums[0] + step * off).toPrecision(15)));
        else {
          v = srcCell.cell ? srcCell.cell.v : null;
          if (typeof v === 'string' && v[0] === '=') v = shiftFormula(v, r - srcCell.r, c - srcCell.c);
        }
        cells[A] = v === '' ? null : v;
        styles[A] = srcCell.cell?.s || null;
      }
    }
    submit([{ op: 'set', sheet: s.name, cells }, { op: 'cellStyles', sheet: s.name, styles }]);
  }
  function fillDownRight(down) {
    const R = clampFull(lastR());
    if (down) {
      if (R.r1 === R.r2) { if (R.r1 === 0) return; fill({ ...R, r1: R.r1 - 1, r2: R.r1 - 1 }, R); }
      else fill({ ...R, r2: R.r1 }, { ...R, r1: R.r1 + 1 });
    } else {
      if (R.c1 === R.c2) { if (R.c1 === 0) return; fill({ ...R, c1: R.c1 - 1, c2: R.c1 - 1 }, R); }
      else fill({ ...R, c2: R.c1 }, { ...R, c1: R.c1 + 1 });
    }
  }

  // ---------------- rows / cols
  function rowOps(kind) {
    const R = clampFull(lastR()), s = sh().name;
    const n = R.r2 - R.r1 + 1, m = R.c2 - R.c1 + 1;
    const ops = {
      rowAbove: { op: 'insertRows', sheet: s, at: R.r1 + 1, count: n },
      rowBelow: { op: 'insertRows', sheet: s, at: R.r2 + 2, count: n },
      rowDel: { op: 'deleteRows', sheet: s, at: R.r1 + 1, count: n },
      colLeft: { op: 'insertCols', sheet: s, at: colToName(R.c1), count: m },
      colRight: { op: 'insertCols', sheet: s, at: colToName(R.c2 + 1), count: m },
      colDel: { op: 'deleteCols', sheet: s, at: colToName(R.c1), count: m },
    }[kind];
    submit([ops]);
  }

  function autofit(c) {
    const s = sh();
    g.font = `${FONT}px Arial, Helvetica, sans-serif`;
    let w = 30;
    for (const A in s.cells) {
      const p = parseAddr(A);
      if (p.c !== c) continue;
      const st = s.cells[A].s || {};
      g.font = `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${st.fs || FONT}px ${fontStack(st.ff)}`;
      w = Math.max(w, g.measureText(fmtValue(engine.value(s, p.c, p.r))).width + 12);
    }
    submit([{ op: 'resize', sheet: s.name, cols: { [colToName(c)]: Math.ceil(Math.min(w, 600)) } }]);
  }

  // ================================================================ sheet tabs
  function switchSheet(name, keepEdit) {
    if (sameName(name, sheetName)) return;
    if (edit && !keepEdit && !isFormulaEdit()) commitEdit();
    perSheet.set(sheetName, { sel, left: scroller.scrollLeft, top: scroller.scrollTop });
    sheetName = name;
    agentSheets.delete(name.toLowerCase());
    const st = perSheet.get(name);
    sel = st ? st.sel : freshSel();
    rowsExt = 0; colsExt = 0;
    rebuild();
    scroller.scrollLeft = st ? st.left : 0;
    scroller.scrollTop = st ? st.top : 0;
    renderTabs();
    afterSelect();
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const s of doc.sheets) {
      const b = document.createElement('button');
      b.className = 'sv-tab' + (sameName(s.name, sheetName) ? ' on' : '');
      b.dataset.sheet = s.name;
      b.textContent = s.name;
      if (agentSheets.has(s.name.toLowerCase())) b.insertAdjacentHTML('beforeend', '<span class="dot" title="agent changed this sheet"></span>');
      for (const p of others.filter((x) => x.sheet && sameName(x.sheet, s.name)).slice(0, 4)) b.insertAdjacentHTML('beforeend', `<span class="pdot" style="background:${/^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : '#888'}" title="${String(p.name).replace(/[<>"&]/g, '')} is here"></span>`);
      b.onmousedown = (e) => { if (!b.isContentEditable) e.preventDefault(); };
      b.onclick = () => { if (!b.isContentEditable) switchSheet(s.name, isFormulaEdit()); };
      b.ondblclick = () => renameTab(b, s);
      b.oncontextmenu = (e) => {
        e.preventDefault();
        ctx.menu(e.clientX, e.clientY - 80, [
          { label: 'Rename', action: () => renameTab(b, s) },
          { label: 'Delete', disabled: doc.sheets.length < 2, action: () => submit([{ op: 'deleteSheet', sheet: s.name }]) },
          { label: 'Copy reference', action: () => navigator.clipboard?.writeText(quoteSheet(s.name) + '!A1') },
          '-',
          { label: '📄 Generate document → new Notes canvas', action: () => exportToNotes(s.name) },
          { label: '⬇ Download HTML report (charts as images)', action: () => downloadHtml(s.name) },
          { label: '⬇ Download Markdown', action: () => download(`${s.name}.md`, toMarkdown(sheetBlocks(doc, s.name)), 'text/markdown') },
        ]);
      };
      tabsEl.append(b);
    }
  }
  function renameTab(b, s) {
    b.contentEditable = 'true';
    b.textContent = s.name;
    b.focus();
    document.getSelection().selectAllChildren(b);
    const done = (ok) => {
      b.onblur = null; b.onkeydown = null;
      b.removeAttribute('contenteditable');
      const n = b.textContent.trim();
      if (ok && n && n !== s.name) { const old = s.name; if (submit([{ op: 'renameSheet', sheet: old, name: n }]) && sameName(sheetName, old)) sheetName = n; refresh(); }
      else renderTabs();
      ed.focus();
    };
    b.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); e.stopPropagation(); };
    b.onblur = () => done(true);
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function downloadHtml(name) {
    const b = sheetBlocks(doc, name);
    const imgs = {};
    const s2 = doc.sheets.find((x) => x.name === name);
    for (const ch of s2.charts || []) {
      if (ch.type === 'kpi') continue;
      const cv = document.createElement('canvas');
      cv.width = ch.w * 2; cv.height = ch.h * 2;
      const g2 = cv.getContext('2d'); g2.scale(2, 2);
      try { drawChart(g2, { x: 0, y: 0, w: ch.w, h: ch.h }, ch, chartData(doc, name, ch, engine), 1, false); imgs[ch.id] = { src: cv.toDataURL('image/png'), w: ch.w }; } catch {}
    }
    // inline uploaded images so the file stands alone
    for (const bl of b.blocks) if (bl.t === 'img' && bl.url.startsWith('/assets/')) {
      try { const r = await fetch(bl.url); const blob = await r.blob(); bl.url = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); }); } catch {}
    }
    download(`${name}.html`, toHtml(b, imgs), 'text/html');
  }
  async function exportToNotes(name) {
    const md = toMarkdown(sheetBlocks(doc, name));
    const r = await ctx.post('/api/docs', { type: 'text', title: `${name} – report`, by: 'user' });
    await ctx.post('/api/ops', { doc: r.id, by: 'user', ops: [{ op: 'setText', text: md }] });
    ctx.toast(`Document "${name} – report" created`);
    location.hash = r.id;
  }
  $('.sv-addsheet').onmousedown = (e) => e.preventDefault();
  $('.sv-addsheet').onclick = () => {
    let i = doc.sheets.length + 1;
    while (doc.sheets.some((s) => sameName(s.name, 'Sheet' + i))) i++;
    if (submit([{ op: 'addSheet', name: 'Sheet' + i }])) switchSheet('Sheet' + i);
  };

  // ================================================================ toolbar
  const tb = document.createElement('div');
  tb.style.display = 'contents';
  tb.innerHTML = `
    <button class="tb" data-a="undo" title="Undo (Ctrl+Z)">↶</button>
    <button class="tb" data-a="redo" title="Redo (Ctrl+Y)">↷</button>
    <span class="tbp tbp1">
    <select class="tb" data-a="zoom" title="Zoom (Ctrl+wheel / pinch)">${[50, 75, 90, 100, 125, 150, 200, 300].map((p) => `<option value="${p}">${p}%</option>`).join('')}</select>
    <div class="sep"></div>
    <select class="tb" data-a="ff" title="Font">${Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('')}</select>
    <select class="tb" data-a="fs" title="Font size">${[9, 10, 11, 13, 16, 20, 24, 32, 40, 56, 72].map((p) => `<option value="${p}">${p}</option>`).join('')}</select>
    <button class="tb" data-a="b" title="Bold (Ctrl+B)"><b>B</b></button>
    <button class="tb" data-a="i" title="Italic (Ctrl+I)"><i>I</i></button>
    <button class="tb" data-a="color" title="Text color"><span class="stack"><span>A</span><span class="swatch" style="background:#000"></span></span></button>
    <button class="tb" data-a="fill" title="Fill color"><span class="stack"><span>◧</span><span class="swatch" style="background:#fff2cc"></span></span></button>
    <div class="sep"></div>
    <button class="tb" data-a="table" title="Make a named table from the selection">▦</button>
    <button class="tb" data-a="chart" title="Insert chart from selection (or table / KPI from one cell)">📊</button>
    <button class="tb" data-a="visuals" title="SVG visuals: show a value as a lamp, gauge, battery, status icon… (or install a pack)">🎨</button>
    <button class="tb" data-a="traffic" title="Traffic lights: color cells by their value (conditional formatting)">🚦</button>
    </span>
    <span class="tbp tbp2">
    <button class="tb" data-a="s" title="Strikethrough"><s>S</s></button>
    <button class="tb" data-a="left" title="Align left">⫷</button>
    <button class="tb" data-a="center" title="Align center">≡</button>
    <button class="tb" data-a="right" title="Align right">⫸</button>
    <button class="tb" data-a="wrap" title="Wrap text (Alt+Enter = new line in cell)">↵</button>
    <div class="sep"></div>
    <button class="tb" data-a="borders" title="Borders">⊞</button>
    <button class="tb" data-a="merge" title="Merge cells">⧉</button>
    <div class="sep"></div>
    <button class="tb" data-a="freeze" title="Freeze rows/cols up to the active cell">❄</button>
    <button class="tb" data-a="grid" title="Show / hide gridlines (dashboard look)">#</button>
    <button class="tb" data-a="sum" title="Insert =SUM of selection below">Σ</button>
    </span>
    <button class="tb more" data-a="more" title="More tools: alignment, wrap, borders, merge, freeze, gridlines, Σ">⋯</button>
    <div class="sep"></div>
    <button class="tb live" data-a="live" title="Live mode: full-screen real-time view (Esc = back to edit)">▶ Live</button>`;
  ctx.toolbar.append(tb);
  try { ctx.toolbar.dataset.page = localStorage.getItem('spread.tbPage') === '2' ? '2' : '1'; } catch { ctx.toolbar.dataset.page = '1'; }
  tb.querySelector('[data-a=more]').textContent = ctx.toolbar.dataset.page === '2' ? '‹' : '⋯';
  const zoomSel = tb.querySelector('[data-a=zoom]');
  zoomSel.value = '100';
  zoomSel.onchange = () => { setZoom(+zoomSel.value / 100); ed.focus(); };
  const ffSel = tb.querySelector('[data-a=ff]');
  ffSel.value = 'sans';
  ffSel.onchange = () => { toggleStyle('ff', ffSel.value === 'sans' ? null : ffSel.value); ed.focus(); };
  const fsSel = tb.querySelector('[data-a=fs]');
  fsSel.value = String(FONT);
  fsSel.onchange = () => { setFontSize(+fsSel.value); ed.focus(); };
  function setFontSize(fs) {
    const s = sh();
    const ranges = sel.ranges.map((R) => clampFull(R));
    const ops = [{ op: 'format', sheet: s.name, ranges: ranges.map(rangeToString), style: { fs: fs === FONT ? null : fs } }];
    // grow rows so the text fits (Sheets auto-fits row height)
    const rows = {};
    for (const R of ranges) for (let r = R.r1; r <= Math.min(R.r2, R.r1 + 500); r++) {
      let max = fs;
      for (const A in s.cells) { const p = parseAddr(A); if (p.r === r && !(p.c >= R.c1 && p.c <= R.c2)) max = Math.max(max, s.cells[A].s?.fs || FONT); }
      const need = Math.round(max * 1.45 + 6);
      if (need > (s.rowH[r] ?? DEF_H)) rows[r + 1] = need;
    }
    if (Object.keys(rows).length) ops.push({ op: 'resize', sheet: s.name, rows });
    submit(ops);
  }
  tb.querySelectorAll('button').forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => toolbarAction(b.dataset.a, b);
  });
  function toolbarAction(a, btn) {
    switch (a) {
      case 'undo': return undo();
      case 'redo': return redo();
      case 'b': case 'i': case 's': return toggleStyle(a);
      case 'left': case 'center': case 'right': return toggleStyle('align', sh().cells[addr(sel.active.c, sel.active.r)]?.s?.align === a ? null : a);
      case 'color': case 'fill': return colorPicker(btn, a);
      case 'freeze': return freezeMenu(btn.getBoundingClientRect());
      case 'wrap': return toggleStyle('wrap');
      case 'chart': return insertChart(btn);
      case 'live': return startLive();
      case 'grid': return submit([{ op: 'view', sheet: sh().name, grid: sh().view?.grid === false }]);
      case 'borders': return bordersPopover(btn);
      case 'merge': return mergeMenu(btn.getBoundingClientRect());
      case 'table': return createTable(btn);
      case 'sum': return autoSum();
      case 'traffic': return trafficEditor(btn.getBoundingClientRect());
      case 'visuals': return visualsPopover(btn.getBoundingClientRect());
      case 'more': {
        // two pages of tools: everyday first, the rest one click away (remembered)
        const two = ctx.toolbar.dataset.page !== '2';
        ctx.toolbar.dataset.page = two ? '2' : '1';
        btn.textContent = two ? '‹' : '⋯';
        try { localStorage.setItem('spread.tbPage', ctx.toolbar.dataset.page); } catch {}
        return;
      }
    }
  }

  // ---------------------------------------------------------------- SVG visuals (spread-viz packs)
  function visualsPopover(anchor) {
    const R = clampFull(lastR()), s = sh();
    const A = addr(sel.active.c, sel.active.r);
    const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const previews = (p) => {
      if (p.kind === 'states') return p.states.map((st) => `<img alt="" title="${esc(st.label || st.id)}" src="${vizDataUrl({ ...p, states: [st] }, '?', null, 64, 64)}">`).join('');
      if (p.kind === 'toggle') return [1, 0].map((v) => `<img alt="" src="${vizDataUrl(p, v, null, 64, 64)}">`).join('');
      return [0.15, 0.55, 0.9].map((k) => `<img alt="" src="${vizDataUrl(p, p.min + (p.max - p.min) * k, null, 64, 64)}">`).join('');
    };
    ctx.popover(anchor, (pop, close) => {
      pop.classList.add('vizpop');
      const listHtml = () => allPacks().map((p) => `<div class="vp-pack" data-id="${esc(p.id)}">
            <div class="vp-prev">${previews(p)}</div>
            <div class="vp-meta"><b>${esc(p.name)}</b> <small>${esc(p.kind)}${p.builtin ? '' : ' · custom'}</small><div>${esc(p.description || '')}</div></div>
            <div class="vp-act"><button class="btn2" data-x="card" title="A visual card showing ${esc(A)}">Card</button><button class="btn2" data-x="cells" title="=VIZ() next to each selected cell">In cells</button>${p.builtin ? '' : '<button class="btn2" data-x="del" title="Delete this pack">✕</button>'}</div>
          </div>`).join('');
      pop.innerHTML = `<div class="vp-h">🎨 Visuals <span>value from <code>${esc(s.name)}!${rangeToString(R)}</code></span></div>
          <div class="vp-list">${listHtml()}</div>
          <details class="vp-install"><summary>Install a pack (JSON from any model)</summary>
            <p>Packs follow <a href="/api/viz/spec" target="_blank" rel="noopener">spread-viz/1</a>. <button class="btn2" data-x="prompt">Copy a prompt for a model</button></p>
            <textarea rows="6" placeholder='{"spec":"spread-viz/1","id":"…","kind":"states", …}'></textarea>
            <div class="vp-msg"></div>
            <button class="btn" data-x="install">Validate &amp; install</button>
          </details>`;
      // packs arriving (installed here, by an agent, or by another user) refresh the list, not the installer
      const draw = () => { pop.querySelector('.vp-list').innerHTML = listHtml(); };
      const off = onPacks(draw);
      const obs = new MutationObserver(() => { if (!pop.isConnected) { off(); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
      pop.addEventListener('keydown', (e) => e.stopPropagation());
      pop.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-x]');
        if (!b) return;
        const id = b.closest('[data-id]')?.dataset.id;
        const msg = pop.querySelector('.vp-msg');
        switch (b.dataset.x) {
          case 'card': {
            let n = 1; while (doc.sheets.some((x) => (x.charts || []).some((c) => c.id === 'viz' + n))) n++;
            const title = String(s.cells[addr(Math.max(0, sel.active.c - 1), sel.active.r)]?.v ?? '').slice(0, 40);
            close();
            submit([{ op: 'addChart', id: 'viz' + n, sheet: s.name, type: 'viz', pack: id, value: A, title: title && title[0] !== '=' ? title : getPack(id)?.name, at: addr(R.c2 + 2, R.r1) }]);
            selChart = 'viz' + n; requestDraw();
            return;
          }
          case 'cells': {
            // =VIZ("pack", ref) for every selected cell, in the first free column to the right
            let col = R.c2 + 1;
            const free = (c) => { for (let r = R.r1; r <= R.r2; r++) if (s.cells[addr(c, r)]?.v) return false; return true; };
            while (!free(col) && col < R.c2 + 30) col++;
            const cells = {};
            for (let r = R.r1; r <= Math.min(R.r2, R.r1 + 2000); r++) for (let c = R.c1; c <= R.c1; c++) cells[addr(col, r)] = `=VIZ("${id}",${addr(c, r)})`;
            close();
            submit([{ op: 'set', sheet: s.name, cells }]);
            setActive({ c: col, r: R.r1 });
            return;
          }
          case 'del': if (confirmDel(id)) { const r = await fetch('/api/viz?by=user&id=' + encodeURIComponent(id), { method: 'DELETE' }); if (!r.ok) ctx.toast((await r.json()).error, true); } return;
          case 'prompt': {
            const spec = await (await fetch('/api/viz/spec')).text();
            const text = `Make an SVG visual pack for my spreadsheet dashboard.\nIt should show: <describe it — e.g. "a water tank 0–100 %" or "5 moods from great to awful">.\nReply with only the JSON, following this spec exactly:\n\n${spec}`;
            try { await navigator.clipboard.writeText(text); ctx.toast('Prompt copied — paste it into any model, then paste its JSON here'); } catch { ctx.toast('Could not copy', true); }
            return;
          }
          case 'install': {
            let pack;
            try { pack = JSON.parse(pop.querySelector('textarea').value.trim().replace(/^```(json)?|```$/g, '')); } catch (er) { msg.innerHTML = `<b class="bad">Not JSON:</b> ${esc(er.message)}`; return; }
            const r = await fetch('/api/viz?by=user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) });
            const j = await r.json();
            if (!r.ok) { msg.innerHTML = `<b class="bad">Not installed</b><ul>${(j.errors || [j.error]).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`; return; }
            msg.innerHTML = `<b class="good">Installed “${esc(j.id)}”</b>${j.warnings?.length ? `<ul>${j.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
            pop.querySelector('textarea').value = '';
            return;
          }
        }
      });
    });
  }
  const confirmDel = (id) => window.confirm?.(`Delete visual pack “${id}”? Cells and cards using it will show “no pack”.`);

  // ---------------------------------------------------------------- traffic lights editor
  const WHEN_LABEL = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '=': '=', '<>': '≠', between: 'between', contains: 'contains', empty: 'is empty', notEmpty: 'not empty', any: 'anything' };
  function trafficEditor(anchor) {
    const s = sh();
    const R = clampFull(lastR());
    const here = (s.conds || []).find((cd) => { const C2 = parseRange(cd.range); return C2.c1 <= R.c2 && R.c1 <= C2.c2 && C2.r1 <= R.r2 && R.r1 <= C2.r2; });
    const range = here ? here.range : rangeToString(R);
    // presets guess from the data: numbers → thresholds, words → status lights
    const vals = [];
    const PR = parseRange(range);
    for (let r = PR.r1; r <= Math.min(PR.r2, PR.r1 + 200); r++) for (let c = PR.c1; c <= PR.c2; c++) { const v = engine.value(s, c, r); if (v != null && v !== '') vals.push(v); }
    const nums = vals.filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const words = [...new Set(vals.filter((v) => typeof v === 'string').map((v) => v.toLowerCase()))].slice(0, 8);
    const q = (f) => nums.length ? +nums[Math.floor((nums.length - 1) * f)].toPrecision(3) : 0;
    let rules = here ? JSON.parse(JSON.stringify(here.rules)) : nums.length >= words.length
      ? [{ when: '<', value: q(0.34), light: 'green' }, { when: 'between', value: q(0.34), value2: q(0.67), light: 'amber' }, { when: '>', value: q(0.67), light: 'red' }]
      : words.map((w) => ({ when: '=', value: w, light: /done|ok|yes|valmis|green|✓/.test(w) ? 'green' : /late|over|fail|no|red|✗|blocked/.test(w) ? 'red' : /open|wip|todo|amber|pending/.test(w) ? 'amber' : 'gray' }));
    ctx.popover(anchor.left != null ? anchor : { left: anchor.x, bottom: anchor.y }, (p, close) => {
      p.classList.add('trafficpop');
      const draw = () => {
        p.innerHTML = `<div class="tp-h">🚦 Traffic lights <code>${range}</code>${here ? ` <span>${here.id}</span>` : ''}</div>
          <div class="tp-rules">${rules.map((r, i) => `<div class="tp-r" data-i="${i}">
            <select data-k="when">${Object.entries(WHEN_LABEL).map(([k, l]) => `<option value="${k}" ${r.when === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <input data-k="value" value="${r.value ?? ''}" placeholder="value or =Sheet!B1" ${['empty', 'notEmpty', 'any'].includes(r.when) ? 'hidden' : ''}>
            <input data-k="value2" value="${r.value2 ?? ''}" placeholder="and" ${r.when === 'between' ? '' : 'hidden'}>
            <span class="tp-lights">${['green', 'amber', 'red', 'blue', 'gray'].map((l) => `<i data-l="${l}" class="${r.light === l ? 'on' : ''}" style="background:${LIGHTS[l].dot}" title="${l}"></i>`).join('')}</span>
            <button data-x="del" title="Remove rule">✕</button></div>`).join('')}</div>
          <div class="tp-foot"><button class="btn2" data-x="add">＋ Rule</button>${here ? '<button class="btn2" data-x="remove">Remove all</button>' : ''}<span style="flex:1"></span><button class="btn" data-x="save">Apply</button></div>
          <div class="tp-hint">First matching rule wins. Values can be formulas, e.g. <code>=Settings!B1</code>. Lights follow the cells when rows, columns or tables move.</div>`;
      };
      const lit = (x) => (x === '' ? '' : x[0] === '=' ? x : !isNaN(+x) ? +x : x);
      p.addEventListener('input', (e) => { const row = e.target.closest('.tp-r'); if (row) { rules[+row.dataset.i][e.target.dataset.k] = e.target.dataset.k === 'when' ? e.target.value : lit(e.target.value); if (e.target.dataset.k === 'when') draw(); } });
      p.addEventListener('change', (e) => { const row = e.target.closest('.tp-r'); if (row && e.target.dataset.k === 'when') { rules[+row.dataset.i].when = e.target.value; draw(); } });
      p.addEventListener('click', (e) => {
        const l = e.target.closest('[data-l]'), x = e.target.closest('[data-x]'), row = e.target.closest('.tp-r');
        if (l && row) { rules[+row.dataset.i].light = l.dataset.l; delete rules[+row.dataset.i].style; draw(); return; }
        if (!x) return;
        if (x.dataset.x === 'del') { rules.splice(+row.dataset.i, 1); draw(); }
        if (x.dataset.x === 'add') { rules.push({ when: '>', value: 0, light: 'red' }); draw(); }
        if (x.dataset.x === 'remove') { close(); submit([{ op: 'removeCond', sheet: s.name, id: here.id }]); ed.focus(); }
        if (x.dataset.x === 'save') {
          const clean = rules.filter((r) => r.light || r.style).map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== '' && !(k === 'value2' && r.when !== 'between') && !(k === 'value' && ['empty', 'notEmpty', 'any'].includes(r.when)))));
          close();
          if (!clean.length) { if (here) submit([{ op: 'removeCond', sheet: s.name, id: here.id }]); }
          else submit([{ op: 'cond', sheet: s.name, range, rules: clean, ...(here ? { id: here.id } : {}) }]);
          ed.focus();
        }
      });
      p.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); p.querySelector('[data-x=save]').click(); } });
      draw();
    });
  }
  function colorPicker(btn, key) {
    ctx.popover(btn, (p, close) => {
      p.style.width = '232px';
      const none = document.createElement('div');
      none.className = 'sw none'; none.title = 'None';
      none.onclick = () => { close(); toggleStyle(key, null); };
      p.append(none);
      for (const col of PALETTE) {
        const d = document.createElement('div');
        d.className = 'sw'; d.style.background = col; d.title = col;
        d.onmousedown = (e) => e.preventDefault();
        d.onclick = () => { close(); toggleStyle(key, col); btn.querySelector('.swatch').style.background = col; };
        p.append(d);
      }
    });
  }
  let borderStyle = 'solid', borderColor = '#000000';
  function bordersPopover(btn) {
    ctx.popover(btn, (p, close) => {
      p.style.width = '252px';
      const types = [['all', '⊞ All'], ['inner', '╋ Inner'], ['horizontal', '━ Horiz'], ['vertical', '┃ Vert'], ['outer', '□ Outer'],
        ['left', '▏Left'], ['top', '▔ Top'], ['right', '▕ Right'], ['bottom', '▁ Bottom'], ['clear', '✕ Clear']];
      for (const [t, label] of types) {
        const b = document.createElement('button');
        b.className = 'tb'; b.textContent = label; b.style.width = '76px'; b.style.justifyContent = 'flex-start';
        b.onmousedown = (e) => e.preventDefault();
        b.onclick = () => {
          close();
          submit([{ op: 'borders', sheet: sh().name, ranges: sel.ranges.map((R) => rangeToString(clampFull(R))), type: t, style: borderStyle, color: borderColor }]);
        };
        p.append(b);
      }
      const styleSel = document.createElement('select');
      styleSel.className = 'tb';
      for (const st of ['solid', 'medium', 'thick', 'dashed', 'dotted', 'double']) styleSel.add(new Option(st, st, false, st === borderStyle));
      styleSel.onchange = () => { borderStyle = styleSel.value; };
      p.append(styleSel);
      for (const col of ['#000000', '#5f6368', '#d93025', '#e8710a', '#188038', '#1a73e8', '#9334e6']) {
        const d = document.createElement('div');
        d.className = 'sw'; d.style.background = col; d.title = col;
        if (col === borderColor) d.style.outline = '2px solid #0b57d0';
        d.onmousedown = (e) => e.preventDefault();
        d.onclick = () => { borderColor = col; p.querySelectorAll('.sw').forEach((x) => (x.style.outline = '')); d.style.outline = '2px solid #0b57d0'; };
        p.append(d);
      }
    });
  }
  function mergeMenu(r) {
    const R = clampFull(lastR());
    const multi = R.c1 !== R.c2 || R.r1 !== R.r2;
    const isMerged = (sh().merges || []).some((m) => { const M = parseRange(m); return M.c1 <= R.c2 && R.c1 <= M.c2 && M.r1 <= R.r2 && R.r1 <= M.r2; });
    const go = (type) => submit([{ op: 'merge', sheet: sh().name, range: rangeToString(R), type }]);
    ctx.menu(r.left, r.bottom + 4, [
      { label: 'Merge all', disabled: !multi, action: () => go('all') },
      { label: 'Merge horizontally', disabled: R.c1 === R.c2, action: () => go('horizontal') },
      { label: 'Merge vertically', disabled: R.r1 === R.r2, action: () => go('vertical') },
      { label: 'Unmerge', disabled: !isMerged, action: () => submit([{ op: 'unmerge', sheet: sh().name, range: rangeToString(R) }]) },
    ]);
  }
  function freezeMenu(r) {
    const a = sel.active;
    ctx.menu(r.left, r.bottom + 4, [
      { label: 'No rows', action: () => submit([{ op: 'freeze', sheet: sh().name, rows: 0, cols: fz().cols }]) },
      { label: '1 row', action: () => submit([{ op: 'freeze', sheet: sh().name, rows: 1, cols: fz().cols }]) },
      { label: `Up to row ${a.r + 1}`, action: () => submit([{ op: 'freeze', sheet: sh().name, rows: a.r + 1, cols: fz().cols }]) },
      '-',
      { label: 'No columns', action: () => submit([{ op: 'freeze', sheet: sh().name, rows: fz().rows, cols: 0 }]) },
      { label: '1 column', action: () => submit([{ op: 'freeze', sheet: sh().name, rows: fz().rows, cols: 1 }]) },
      { label: `Up to column ${colToName(a.c)}`, action: () => submit([{ op: 'freeze', sheet: sh().name, rows: fz().rows, cols: a.c + 1 }]) },
    ]);
  }
  function autoSum() {
    const R = clampFull(lastR());
    const target = { c: R.c1, r: R.r2 + 1 };
    if (R.c1 === R.c2 && R.r1 === R.r2) {
      // single cell: sum the numbers above it
      let r = R.r1 - 1;
      while (r >= 0 && typeof engine.value(sh(), R.c1, r) === 'number') r--;
      if (r === R.r1 - 1) return startEdit('enter', '=SUM()');
      submit([{ op: 'set', sheet: sh().name, cells: { [addr(R.c1, R.r1)]: `=SUM(${addr(R.c1, r + 1)}:${addr(R.c1, R.r1 - 1)})` } }]);
      return;
    }
    const cells = {};
    for (let c = R.c1; c <= R.c2; c++) cells[addr(c, target.r)] = `=SUM(${addr(c, R.r1)}:${addr(c, R.r2)})`;
    submit([{ op: 'set', sheet: sh().name, cells }]);
  }
  function renderToolbarState() {
    const st = sh().cells[addr(sel.active.c, sel.active.r)]?.s || {};
    for (const k of ['b', 'i', 's', 'wrap']) tb.querySelector(`[data-a=${k}]`).classList.toggle('on', !!st[k]);
    for (const k of ['left', 'center', 'right']) tb.querySelector(`[data-a=${k}]`).classList.toggle('on', st.align === k);
    tb.querySelector('[data-a=grid]').classList.toggle('on', sh().view?.grid === false);
    const fsSel2 = tb.querySelector('[data-a=fs]');
    if (fsSel2 && document.activeElement !== fsSel2) fsSel2.value = String(st.fs || FONT);
    const ffSel2 = tb.querySelector('[data-a=ff]');
    if (ffSel2 && document.activeElement !== ffSel2) ffSel2.value = st.ff && FONTS[st.ff] ? st.ff : 'sans';
  }

  function setZoom(nz, ax = hw() + 1, ay = hh() + 1) {
    nz = Math.max(0.3, Math.min(4, nz));
    if (Math.abs(nz - z) < 1e-3) return;
    const wx = (ax - hw() + scroller.scrollLeft) / z, wy = (ay - hh() + scroller.scrollTop) / z;
    z = nz;
    rebuild();
    scroller.scrollLeft = wx * z - (ax - hw());
    scroller.scrollTop = wy * z - (ay - hh());
    const pct = Math.round(z * 100);
    if (![...zoomSel.options].some((o) => +o.value === pct)) {
      [...zoomSel.options].filter((o) => o.dataset.custom).forEach((o) => o.remove());
      const o = new Option(pct + '%', pct); o.dataset.custom = 1; zoomSel.add(o);
    }
    zoomSel.value = String(pct);
    requestDraw();
  }

  // ================================================================ keyboard
  ed.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (edit) return editKey(e);
    navKey(e);
  });
  document.addEventListener('keydown', docKey, true);
  function docKey(e) {
    if (live) return;
    if (document.activeElement === document.body && !e.defaultPrevented && root.isConnected) {
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { ed.focus(); return; }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Delete', 'Backspace', 'F2'].includes(e.key) || e.ctrlKey || e.metaKey) {
        ed.focus();
        if (edit) editKey(e); else navKey(e);
      }
    }
  }

  function navKey(e) {
    const mod = e.ctrlKey || e.metaKey, k = e.key;
    if (selChart) {
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); submit([{ op: 'deleteChart', id: selChart }]); selChart = null; return; }
      if (k === 'Escape') { selChart = null; requestDraw(); return; }
      if (k === 'Enter') { e.preventDefault(); const ch = (sh().charts || []).find((c) => c.id === selChart); if (ch) { const r = chartRect(ch), b = scroller.getBoundingClientRect(); chartEditor(ch, { left: b.left + r.x, bottom: b.top + r.y + 30 }); } return; }
      selChart = null; requestDraw();
    }
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[k]) { e.preventDefault(); return moveActive(...arrows[k], e.shiftKey, mod); }
    if (mod) {
      const lk = k.toLowerCase();
      const map = {
        z: () => (e.shiftKey ? redo() : undo()), y: redo, b: () => toggleStyle('b'), i: () => toggleStyle('i'), u: () => toggleStyle('u'),
        a: () => { sel = { ranges: [{ c1: 0, r1: 0, c2: MAXC, r2: MAXR }], active: { ...sel.active }, anchor: { c: 0, r: 0 }, cursor: { c: MAXC, r: MAXR } }; afterSelect(); },
        d: () => fillDownRight(true), r: () => fillDownRight(false),
        '=': () => setZoom(z * 1.1), '+': () => setZoom(z * 1.1), '-': () => setZoom(z / 1.1), 0: () => setZoom(1),
        home: () => { setActive({ c: 0, r: 0 }); ensureVisible(0, 0); },
        end: () => { const x = engine.extent(sh()); setActive({ c: Math.max(0, x.c), r: Math.max(0, x.r) }); ensureVisible(x.c, x.r); },
      };
      if (map[lk]) { e.preventDefault(); map[lk](); }
      return; // c/x/v handled by clipboard events
    }
    switch (k) {
      case 'Tab': {
        e.preventDefault();
        if (tabStartCol === null) tabStartCol = sel.active.c;
        const t = { c: Math.max(0, sel.active.c + (e.shiftKey ? -1 : 1)), r: sel.active.r };
        setActive(t, true); ensureVisible(t.c, t.r);
        return;
      }
      case 'Enter': {
        e.preventDefault();
        if (e.shiftKey) return moveActive(0, -1, false, false);
        if (tabStartCol !== null) { const t = { c: tabStartCol, r: sel.active.r + 1 }; tabStartCol = null; setActive(t); ensureVisible(t.c, t.r); return; }
        return startEdit('edit');
      }
      case 'F2': e.preventDefault(); return startEdit('edit');
      case 'Delete': case 'Backspace': e.preventDefault(); return clearSelection();
      case 'Escape': if (clip) { clip = null; requestDraw(); } return;
      case 'PageDown': case 'PageUp': {
        e.preventDefault();
        const n = Math.max(1, Math.floor((H - hh() - frozenH()) / (DEF_H * z)) - 1);
        return moveActive(0, k === 'PageDown' ? n : -n, e.shiftKey, false);
      }
      case 'Home': e.preventDefault(); setActive({ c: 0, r: sel.active.r }); ensureVisible(0, sel.active.r); return;
    }
  }

  function editKey(e) {
    const k = e.key;
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (k === 'Enter' && !e.altKey) {
      e.preventDefault();
      const back = tabStartCol !== null ? tabStartCol - edit.c : 0;
      commitEdit(e.shiftKey ? -1 : 1, 0);
      if (back && !e.shiftKey) { setActive({ c: tabStartCol, r: sel.active.r }); ensureVisible(sel.active.c, sel.active.r); }
      tabStartCol = null;
      return;
    }
    if (k === 'Enter' && e.altKey) {
      e.preventDefault();
      const i = edit.input, p = i.selectionStart;
      if (i === ed) { i.value = i.value.slice(0, p) + '\n' + i.value.slice(i.selectionEnd); i.setSelectionRange(p + 1, p + 1); fx.value = i.value; }
      return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      if (tabStartCol === null) tabStartCol = edit.c;
      commitEdit(0, e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'Escape') { e.preventDefault(); return cancelEdit(); }
    if (k === 'F2') { e.preventDefault(); edit.mode = edit.mode === 'edit' ? 'enter' : 'edit'; return; }
    if (arrows[k] && edit.mode === 'enter') {
      e.preventDefault();
      const [dc, dr] = arrows[k];
      if (pointable()) {
        const base = edit.pointRef ? edit.pointRef.cell : { c: edit.c, r: edit.r };
        const cur = { c: Math.max(0, base.c + dc), r: Math.max(0, base.r + dr) };
        setPointRef(e.shiftKey ? (edit.pointRef?.anchor ?? base) : cur, cur);
        return;
      }
      commitEdit(dr, dc);
    }
  }

  ed.addEventListener('input', () => {
    if (!edit) { if (ed.value.trim()) startEdit('enter', ed.value); else ed.value = ''; return; }
    edit.pointRef = null;
    fx.value = ed.value;
    requestDraw();
  });
  ed.addEventListener('compositionstart', () => { if (!edit) startEdit('enter', ''); });

  // formula bar
  fx.addEventListener('focus', () => { if (!edit) startEdit('edit', undefined, fx); else edit.input = fx; });
  fx.addEventListener('input', () => { if (!edit) startEdit('edit', fx.value, fx); edit.pointRef = null; ed.value = fx.value; requestDraw(); });
  fx.addEventListener('keydown', (e) => {
    if (!edit) return;
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(1, 0); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'Tab') { e.preventDefault(); commitEdit(0, 1); }
  });

  // name box
  nameBox.addEventListener('focus', () => { if (edit) commitEdit(); nameBox.select(); });
  nameBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoRef(nameBox.value.trim()); ed.focus(); }
    if (e.key === 'Escape') { syncBars(); ed.focus(); }
  });

  // clipboard (only when not editing; editor handles its own text otherwise)
  ed.addEventListener('copy', (e) => { if (edit) return; e.preventDefault(); e.clipboardData.setData('text/plain', copySel(false)); });
  ed.addEventListener('cut', (e) => { if (edit) return; e.preventDefault(); e.clipboardData.setData('text/plain', copySel(true)); });
  ed.addEventListener('paste', (e) => {
    if (edit) return;
    e.preventDefault();
    const f = [...(e.clipboardData.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) return uploadImage(f, sel.active.c, sel.active.r);
    paste(e.clipboardData.getData('text/plain'));
  });
  scroller.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  scroller.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    e.preventDefault();
    const { x, y } = local(e);
    const p = hit(x, y);
    if (p.c >= 0 && p.r >= 0) { setActive(p); uploadImage(f, p.c, p.r); }
  });

  // ================================================================ mouse
  const local = (e) => { const r = scroller.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function colEdge(x) {
    const { c } = hit(x, 0);
    if (c < 0) return -1;
    const right = sx(c) + cw(c) * z;
    if (Math.abs(x - right) <= 4) return c;
    if (Math.abs(x - sx(c)) <= 4 && c > 0) return c - 1;
    return -1;
  }
  function rowEdge(y) {
    const { r } = hit(0, y);
    if (r < 0) return -1;
    const bottom = sy(r) + rh(r) * z;
    if (Math.abs(y - bottom) <= 3) return r;
    if (Math.abs(y - sy(r)) <= 3 && r > 0) return r - 1;
    return -1;
  }
  function nearFillHandle(x, y) {
    if (sel.ranges.length !== 1 || edit) return false;
    const r = rectOf(lastR());
    return Math.abs(x - (r.x + r.w - 1)) <= 5 && Math.abs(y - (r.y + r.h - 1)) <= 5;
  }
  function nearBorder(x, y) {
    if (sel.ranges.length !== 1 || edit) return false;
    const R = lastR();
    if (R.r2 >= MAXR - 1 || R.c2 >= MAXC - 1) return false;
    const r = rectOf(R);
    const inX = x >= r.x - 4 && x <= r.x + r.w + 3, inY = y >= r.y - 4 && y <= r.y + r.h + 3;
    const onV = inY && (Math.abs(x - r.x) <= 3 || Math.abs(x - (r.x + r.w)) <= 3);
    const onH = inX && (Math.abs(y - r.y) <= 3 || Math.abs(y - (r.y + r.h)) <= 3);
    return onV || onH;
  }

  scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    if (x >= scroller.clientWidth || y >= scroller.clientHeight) return; // scrollbars
    const p = hit(x, y);
    e.preventDefault();
    tip.hidden = true;
    const hp = x > hw() && y > hh() ? hitPlus(x, y) : null;
    if (hp) { if (hp.kind === 'row') addTableRow(hp.t); else addTableCol(hp.t); return; }
    const chip = x > hw() && y > hh() && !(edit && pointable()) ? hitChip(x, y) : null;
    if (chip) {
      if (edit) commitEdit();
      const R = parseRange(chip.range);
      sel = { ranges: [{ ...R }], active: { c: R.c1, r: R.r1 }, anchor: { c: R.c1, r: R.r1 }, cursor: { c: R.c2, r: R.r2 } };
      afterSelect();
      drag = { type: 'move', src: { ...R }, start: p.c >= 0 && p.r >= 0 ? { c: Math.min(R.c2, Math.max(R.c1, p.c)), r: R.r1 } : { c: R.c1, r: R.r1 }, dr: 0, dc: 0, table: chip };
      document.body.classList.add('sv-moving-table');
      return listen();
    }
    const hc = x > hw() && y > hh() ? hitChart(x, y) : null;
    if (hc && !(edit && pointable())) {
      if (edit) commitEdit();
      selChart = hc.ch.id;
      ed.focus();
      drag = { type: 'chart', id: hc.ch.id, mode: hc.handle ? 'resize' : 'move', x0: x, y0: y, r0: hc.r, cur: null };
      requestDraw();
      return listen();
    }
    if (selChart) { selChart = null; requestDraw(); }
    if (p.r === -1 && p.c >= 0) { const ce = colEdge(x); if (ce >= 0) { drag = { type: 'colsize', i: ce, x0: x, s0: cw(ce) }; return listen(); } }
    if (p.c === -1 && p.r >= 0) { const re = rowEdge(y); if (re >= 0) { drag = { type: 'rowsize', i: re, y0: y, s0: rh(re) }; return listen(); } }
    if (edit && pointable() && p.c >= 0 && p.r >= 0) {
      if (e.shiftKey && edit.pointRef) setPointRef(edit.pointRef.anchor, p);
      else { edit.pointRef = edit.pointRef && edit.input.selectionStart === edit.pointRef.end ? edit.pointRef : null; setPointRef(p, p); }
      drag = { type: 'point' };
      return listen();
    }
    if (edit) commitEdit();
    if (document.activeElement !== ed) ed.focus();
    const add = e.ctrlKey || e.metaKey;
    if (p.c === -1 && p.r === -1) { sel = { ranges: [{ c1: 0, r1: 0, c2: MAXC, r2: MAXR }], active: { c: 0, r: 0 }, anchor: { c: 0, r: 0 }, cursor: { c: MAXC, r: MAXR } }; afterSelect(); return; }
    if (p.r === -1) {
      const R = { c1: p.c, r1: 0, c2: p.c, r2: MAXR };
      if (e.shiftKey) { sel.ranges[sel.ranges.length - 1] = norm({ c1: sel.anchor.c, r1: 0, c2: p.c, r2: MAXR }); }
      else { const a = { c: p.c, r: Math.max(fz().rows ? 0 : 0, 0) }; sel = add ? { ...sel, ranges: [...sel.ranges, R], active: a, anchor: a, cursor: a } : { ranges: [R], active: a, anchor: a, cursor: a }; }
      afterSelect();
      drag = { type: 'colsel' };
      return listen();
    }
    if (p.c === -1) {
      const R = { c1: 0, r1: p.r, c2: MAXC, r2: p.r };
      if (e.shiftKey) { sel.ranges[sel.ranges.length - 1] = norm({ c1: 0, r1: sel.anchor.r, c2: MAXC, r2: p.r }); }
      else { const a = { c: 0, r: p.r }; sel = add ? { ...sel, ranges: [...sel.ranges, R], active: a, anchor: a, cursor: a } : { ranges: [R], active: a, anchor: a, cursor: a }; }
      afterSelect();
      drag = { type: 'rowsel' };
      return listen();
    }
    if (nearFillHandle(x, y)) { drag = { type: 'fill', src: clampFull(lastR()), tgt: null }; return listen(); }
    if (nearBorder(x, y)) { drag = { type: 'move', src: { ...lastR() }, start: p, dr: 0, dc: 0 }; return listen(); }
    if (e.shiftKey) extendTo(p);
    else if (add) { sel = { ranges: [...sel.ranges, { c1: p.c, r1: p.r, c2: p.c, r2: p.r }], active: p, anchor: p, cursor: p }; afterSelect(); }
    else setActive(p);
    drag = { type: 'sel' };
    listen();
  });

  let lastMouse = null, autoTimer = null;
  function listen() {
    addEventListener('mousemove', onDragMove);
    addEventListener('mouseup', onDragUp, { once: true });
  }
  function onDragMove(e) {
    lastMouse = e;
    if (drag?.type === 'move') {
      document.body.classList.add('sv-moving');
      const tab = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.sv-tab');
      tabsEl.querySelectorAll('.sv-tab').forEach((x) => x.classList.toggle('drop', x === tab && !x.classList.contains('on')));
    }
    dragAt(e);
    const { x, y } = local(e);
    const out = x < hw() || y < hh() || x > W || y > H;
    if (out && !autoTimer && ['sel', 'fill', 'move', 'point', 'colsel', 'rowsel'].includes(drag?.type)) {
      autoTimer = setInterval(() => {
        if (!drag || !lastMouse) return;
        const q = local(lastMouse);
        const sp = 18 * z;
        if (q.x > W) scroller.scrollLeft += sp; else if (q.x < hw()) scroller.scrollLeft -= sp;
        if (q.y > H) scroller.scrollTop += sp; else if (q.y < hh()) scroller.scrollTop -= sp;
        dragAt(lastMouse);
      }, 40);
    } else if (!out && autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  }
  function dragAt(e) {
    if (!drag) return;
    const { x, y } = local(e);
    const cx = Math.max(hw() + 1, Math.min(W - 1, x)), cy = Math.max(hh() + 1, Math.min(H - 1, y));
    const p = hit(cx, cy);
    switch (drag.type) {
      case 'sel': extendTo(p); break;
      case 'colsel': sel.ranges[sel.ranges.length - 1] = norm({ c1: sel.anchor.c, r1: 0, c2: hit(cx, 0).c, r2: MAXR }); afterSelect(); break;
      case 'rowsel': sel.ranges[sel.ranges.length - 1] = norm({ c1: 0, r1: sel.anchor.r, c2: MAXC, r2: hit(0, cy).r }); afterSelect(); break;
      case 'point': setPointRef(edit.pointRef.anchor, p); break;
      case 'move': drag.dr = Math.max(-drag.src.r1, p.r - drag.start.r); drag.dc = Math.max(-drag.src.c1, p.c - drag.start.c); requestDraw(); break;
      case 'fill': {
        const S = drag.src;
        const down = p.r - S.r2, up = S.r1 - p.r, right = p.c - S.c2, left = S.c1 - p.c;
        const m = Math.max(down, up, right, left);
        drag.tgt = m <= 0 ? null
          : m === down ? { c1: S.c1, c2: S.c2, r1: S.r2 + 1, r2: p.r }
            : m === up ? { c1: S.c1, c2: S.c2, r1: p.r, r2: S.r1 - 1 }
              : m === right ? { r1: S.r1, r2: S.r2, c1: S.c2 + 1, c2: p.c }
                : { r1: S.r1, r2: S.r2, c1: p.c, c2: S.c1 - 1 };
        requestDraw();
        break;
      }
      case 'chart': {
        const dx = x - drag.x0, dy = y - drag.y0;
        drag.cur = drag.mode === 'move' ? { x: drag.r0.x + dx, y: drag.r0.y + dy } : { w: Math.max(120 * z, drag.r0.w + dx), h: Math.max(70 * z, drag.r0.h + dy) };
        requestDraw();
        break;
      }
      case 'colsize': preview = { kind: 'col', i: drag.i, size: Math.max(16, Math.round(drag.s0 + (x - drag.x0) / z)) }; rebuild(); requestDraw(); break;
      case 'rowsize': preview = { kind: 'row', i: drag.i, size: Math.max(10, Math.round(drag.s0 + (y - drag.y0) / z)) }; rebuild(); requestDraw(); break;
    }
  }
  function onDragUp() {
    removeEventListener('mousemove', onDragMove);
    document.body.classList.remove('sv-moving-table', 'sv-moving');
    tabsEl.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
    clearInterval(autoTimer); autoTimer = null;
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.type === 'chart' && d.cur) {
      if (d.mode === 'move') {
        const cx = Math.max(hw() + 1, d.cur.x), cy = Math.max(hh() + 1, d.cur.y);
        const p = hit(cx, cy);
        submit([{ op: 'updateChart', id: d.id, at: addr(Math.max(0, p.c), Math.max(0, p.r)), dx: Math.round((cx - sx(p.c)) / z), dy: Math.round((cy - sy(p.r)) / z) }]);
      } else submit([{ op: 'updateChart', id: d.id, w: Math.round(d.cur.w / z), h: Math.round(d.cur.h / z) }]);
    } else if (d.type === 'move' && lastMouse && document.elementFromPoint(lastMouse.clientX, lastMouse.clientY)?.closest('.sv-tab')) {
      // dropped on a sheet tab: the block (or table) moves to that sheet, same place
      const tab = document.elementFromPoint(lastMouse.clientX, lastMouse.clientY).closest('.sv-tab');
      const dest = tab.dataset.sheet;
      if (dest && !sameName(dest, sh().name)) {
        const destSheet = doc.sheets.find((x) => sameName(x.name, dest));
        const at = freeSpot(destSheet, d.src);   // never on top of what's already there
        if (d.table) moveTable(d.table, dest, at);
        else { submit([{ op: 'move', sheet: sh().name, from: rangeToString(d.src), to: quoteSheet(dest) + '!' + at }]); switchSheet(destSheet.name); }
      }
    } else if (d.type === 'move' && (d.dr || d.dc)) {
      const R = d.src;
      const to = { c1: R.c1 + d.dc, r1: R.r1 + d.dr, c2: R.c2 + d.dc, r2: R.r2 + d.dr };
      submit([{ op: 'move', sheet: sh().name, from: rangeToString(R), to: addr(to.c1, to.r1) }]);
      sel = { ranges: [to], active: { c: to.c1, r: to.r1 }, anchor: { c: to.c1, r: to.r1 }, cursor: { c: to.c2, r: to.r2 } };
      afterSelect();
    } else if (d.type === 'fill' && d.tgt) {
      fill(d.src, d.tgt);
      const U = norm({ c1: Math.min(d.src.c1, d.tgt.c1), r1: Math.min(d.src.r1, d.tgt.r1), c2: Math.max(d.src.c2, d.tgt.c2), r2: Math.max(d.src.r2, d.tgt.r2) });
      sel.ranges = [U]; afterSelect();
    } else if ((d.type === 'colsize' || d.type === 'rowsize') && preview) {
      const p = preview; preview = null;
      const R = lastR();
      const multi = d.type === 'colsize' ? R.r2 >= MAXR - 1 && d.i >= R.c1 && d.i <= R.c2 : R.c2 >= MAXC - 1 && d.i >= R.r1 && d.i <= R.r2;
      const idx = multi ? (d.type === 'colsize' ? [R.c1, R.c2] : [R.r1, R.r2]) : [d.i, d.i];
      const map = {};
      for (let i = idx[0]; i <= Math.min(idx[1], idx[0] + 500); i++) map[d.type === 'colsize' ? colToName(i) : i + 1] = p.size;
      submit([{ op: 'resize', sheet: sh().name, ...(d.type === 'colsize' ? { cols: map } : { rows: map }) }]);
    }
    requestDraw();
  }

  scroller.addEventListener('dblclick', (e) => {
    const { x, y } = local(e);
    const hc = hitChart(x, y);
    if (hc) return chartEditor(hc.ch, { left: e.clientX, bottom: e.clientY });
    const p = hit(x, y);
    if (p.r === -1 && p.c >= 0) { const ce = colEdge(x); if (ce >= 0) autofit(ce); return; }
    if (p.c === -1 && p.r >= 0) { const re = rowEdge(y); if (re >= 0) autofitRow(re); return; }
    if (p.c >= 0 && p.r >= 0 && !edit) startEdit('edit');
  });

  let tipTimer = null;
  scroller.addEventListener('mousemove', (e) => {
    if (drag) return;
    const { x, y } = local(e);
    const p = hit(x, y);
    let cur = 'default';
    const hpv = x > hw() && y > hh() ? hitPlus(x, y) : null, chv = x > hw() && y > hh() && !hpv ? hitChip(x, y) : null;
    const hk = hpv?.key || null, ck = chv?.name || null;
    if (hk !== hoverPlus || ck !== hoverChip) { hoverPlus = hk; hoverChip = ck; requestDraw(); }
    const hcv = x > hw() && y > hh() && !hpv && !chv ? hitChart(x, y) : null;
    if (hpv) { cur = 'pointer'; scroller.title = hpv.kind === 'row' ? `Add a row to ${hpv.t.name}` : `Add a column to ${hpv.t.name}`; }
    else if (chv) { cur = 'grab'; scroller.title = `Drag to move table ${chv.name} — drop on a sheet tab to move it there`; }
    else scroller.title = '';
    if (hpv || chv) { /* cursor set above */ }
    else if (hcv) cur = hcv.handle ? 'nwse-resize' : 'move';
    else if (p.r === -1 && p.c >= 0 && colEdge(x) >= 0) cur = 'col-resize';
    else if (p.c === -1 && p.r >= 0 && rowEdge(y) >= 0) cur = 'row-resize';
    else if (nearFillHandle(x, y)) cur = 'crosshair';
    else if (nearBorder(x, y)) cur = 'grab';
    else if (edit && pointable() && p.c >= 0 && p.r >= 0) cur = 'cell';
    scroller.style.cursor = cur;
    clearTimeout(tipTimer);
    const note = p.c >= 0 && p.r >= 0 ? sh().cells[addr(p.c, p.r)]?.n : null;
    if (!note) { tip.hidden = true; return; }
    tipTimer = setTimeout(() => {
      tip.textContent = note;
      tip.style.left = sx(p.c) + cw(p.c) * z + 4 + 'px';
      tip.style.top = sy(p.r) + 'px';
      tip.hidden = false;
    }, 250);
  });
  scroller.addEventListener('mouseleave', () => { tip.hidden = true; clearTimeout(tipTimer); });

  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const { x, y } = local(e);
    setZoom(z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), x, y);
  }, { passive: false });

  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + H * 2 > spacer.offsetHeight) { rowsExt += 1000; rebuild(); }
    if (scroller.scrollLeft + W * 2 > spacer.offsetWidth) { colsExt += 26; rebuild(); }
    tip.hidden = true;
    requestDraw();
  }, { passive: true });

  scroller.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { x, y } = local(e);
    const hcm = hitChart(x, y);
    if (hcm) {
      selChart = hcm.ch.id; requestDraw();
      return ctx.menu(e.clientX, e.clientY, [
        { label: 'Edit chart…', action: () => chartEditor(hcm.ch, { left: e.clientX, bottom: e.clientY }) },
        ...CHART_TYPES.filter((t) => !['kpi', 'viz', 'map'].includes(t) && t !== hcm.ch.type && !['kpi', 'viz', 'map'].includes(hcm.ch.type)).map((t) => ({ label: `→ ${t}`, action: () => submit([{ op: 'updateChart', id: hcm.ch.id, type: t }]) })),
        '-',
        { label: 'Delete chart', action: () => { submit([{ op: 'deleteChart', id: hcm.ch.id }]); selChart = null; } },
      ]);
    }
    const p = hit(x, y);
    if (edit) commitEdit();
    if (p.c >= 0 && p.r >= 0 && !sel.ranges.some((R) => inRange(R, p.c, p.r))) setActive(p);
    const R = clampFull(lastR());
    const nR = R.r2 - R.r1 + 1, nC = R.c2 - R.c1 + 1;
    const rows = nR > 1 ? `${nR} rows` : 'row', cols = nC > 1 ? `${nC} columns` : 'column';
    const A = addr(sel.active.c, sel.active.r);
    const hasNote = !!sh().cells[A]?.n;
    const tab = tableAt(doc, sh().name, sel.active.c, sel.active.r);
    const tableItems = tab ? [
      { label: `▦ ${tab.t.name}: add row`, action: () => { submit([{ op: 'appendRows', table: tab.t.name, rows: [[]] }]); setActive({ c: tab.R.c1, r: tab.R.r2 + 1 }); ensureVisible(tab.R.c1, tab.R.r2 + 1); } },
      { label: `▦ ${tab.t.name}: add column…`, action: () => askName(e, 'Column name', 'New', (n) => submit([{ op: 'addColumn', table: tab.t.name, name: n }])) },
      { label: `▦ ${tab.t.name}: rename table…`, action: () => askName(e, 'Table name', tab.t.name, (n) => submit([{ op: 'renameTable', name: tab.t.name, newName: n }])) },
      { label: `▦ ${tab.t.name}: delete record${nR > 1 ? 's' : ''}`, disabled: R.r1 <= tab.R.r1, action: () => submit([{ op: 'removeRows', table: tab.t.name, rows: Array.from({ length: nR }, (_, i) => R.r1 + i - tab.R.r1) }]) },
      { label: `▦ ${tab.t.name}: remove table (keep data)`, action: () => submit([{ op: 'deleteTable', name: tab.t.name }]) },
      ...doc.sheets.filter((x) => !sameName(x.name, sh().name)).slice(0, 6).map((x) => ({ label: `▦ ${tab.t.name}: move to sheet ${x.name}`, action: () => moveTable(tab.t, x.name, freeSpot(x, parseRange(tab.t.range))) })),
      '-',
    ] : [{ label: '▦ Create table from selection…', action: () => createTable(e) }, '-'];
    if (tab && hasCoords(tab)) tableItems.unshift({ label: `🗺 Map of ${tab.t.name}`, action: () => insertMap(tab) });
    tableItems.unshift({ label: '📊 Insert chart', action: () => insertChart() });
    ed.focus();
    ctx.menu(e.clientX, e.clientY, [
      ...tableItems,
      { label: 'Cut', kbd: 'Ctrl+X', action: () => { const t = copySel(true); navigator.clipboard?.writeText(t).catch(() => {}); } },
      { label: 'Copy', kbd: 'Ctrl+C', action: () => { const t = copySel(false); navigator.clipboard?.writeText(t).catch(() => {}); } },
      { label: 'Paste', kbd: 'Ctrl+V', action: async () => { try { paste(await navigator.clipboard.readText()); } catch { ctx.toast('Use Ctrl+V to paste', true); } } },
      '-',
      { label: `Insert ${rows} above`, action: () => rowOps('rowAbove') },
      { label: `Insert ${rows} below`, action: () => rowOps('rowBelow') },
      { label: `Insert ${cols} left`, action: () => rowOps('colLeft') },
      { label: `Insert ${cols} right`, action: () => rowOps('colRight') },
      '-',
      { label: `Delete ${rows} ${R.r1 + 1}${nR > 1 ? '–' + (R.r2 + 1) : ''}`, action: () => rowOps('rowDel') },
      { label: `Delete ${cols} ${colToName(R.c1)}${nC > 1 ? '–' + colToName(R.c2) : ''}`, action: () => rowOps('colDel') },
      { label: 'Clear contents', kbd: 'Del', action: clearSelection },
      '-',
      { label: hasNote ? 'Edit note' : 'Insert note', action: () => noteEditor(A) },
      { label: '🚦 Traffic lights…', action: () => trafficEditor({ left: e.clientX, bottom: e.clientY }) },
      { label: `🕘 History of ${A}`, action: () => showHistory(e, `cell=${encodeURIComponent(quoteSheet(sh().name) + '!' + A)}`, `${sh().name}!${A}`) },
      ...(tab ? [{ label: `🕘 History of table ${tab.t.name}`, action: () => showHistory(e, `table=${encodeURIComponent(tab.t.name)}`, `table ${tab.t.name}`) }] : []),
      ...(hasNote ? [{ label: 'Remove note', action: () => submit([{ op: 'note', sheet: sh().name, cell: A, text: null }]) }] : []),
      { label: `Copy reference ${quoteSheet(sh().name)}!${rangeToString(R)}`, action: () => navigator.clipboard?.writeText(`${quoteSheet(sh().name)}!${rangeToString(R)}`) },
    ]);
  });

  async function showHistory(anchorEvt, q, title) {
    let list = [];
    try { list = await ctx.get(`/api/history?doc=${encodeURIComponent(ctx.docId)}&${q}&format=json`); } catch (er) { return ctx.toast(er.message, true); }
    const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    ctx.popover({ left: anchorEvt.clientX, bottom: anchorEvt.clientY }, (p) => {
      p.classList.add('histpop');
      p.innerHTML = `<div class="hp-h">🕘 ${esc(title)} <span>${list.length} change${list.length === 1 ? '' : 's'}</span></div>` + (list.length ? list.slice(0, 40).map((x) => {
        const who = x.who || x.by;
        const when = new Date(x.ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const what = x.moved ? `${x.away ? 'cut away' : 'moved'} ${esc(x.moved)}` : x.table ? `table ${esc(x.table)}` : `${x.at && !title.endsWith(x.at.split('!')[1]) ? `<code>${esc(x.at)}</code> ` : ''}${esc(x.old ?? '∅') || '∅'} → <b>${esc(x.new ?? '∅') || '∅'}</b>${x.t && q.startsWith('table') ? ` <em>${esc(x.t)}</em>` : ''}`;
        return `<div class="hp-r"><span class="hp-v">v${x.v}</span><span class="hp-w ${x.by === 'user' ? '' : 'agent'}">${esc(who)}</span><span class="hp-t">${when}</span><div class="hp-x">${what}</div></div>`;
      }).join('') : '<div class="hp-empty">No recorded changes (the log keeps recent history).</div>');
    });
  }

  /** Top-left of the first empty area on a sheet big enough for R (keeps the column, scans downward). */
  function freeSpot(s2, R) {
    const h = R.r2 - R.r1, w = R.c2 - R.c1;
    const busy = (c, r) => !!s2.cells[addr(c, r)] || (s2.tables || []).some((t) => inRange(parseRange(t.range), c, r));
    for (let r = R.r1; r < R.r1 + 2000; r++) {
      let ok = true;
      for (let rr = r; rr <= r + h + 1 && ok; rr++) for (let cc = R.c1; cc <= R.c1 + w && ok; cc++) if (busy(cc, rr)) ok = false;
      if (ok) return addr(R.c1, r === R.r1 ? r : r + 1);
    }
    return addr(R.c1, R.r1);
  }

  function askName(anchorEvt, placeholder, value, done) {
    const at = anchorEvt?.getBoundingClientRect ? anchorEvt : { left: anchorEvt.clientX, bottom: anchorEvt.clientY };
    ctx.popover(at, (p, close) => {
      const i = document.createElement('input');
      i.placeholder = placeholder; i.value = value || '';
      const ok = document.createElement('button');
      ok.className = 'btn'; ok.textContent = 'OK';
      const go = () => { close(); if (i.value.trim()) done(i.value.trim()); ed.focus(); };
      ok.onclick = go;
      i.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } if (ev.key === 'Escape') { ev.preventDefault(); close(); ed.focus(); } ev.stopPropagation(); };
      p.append(i, ok);
      setTimeout(() => { i.focus(); i.select(); });
    });
  }
  /** Contiguous non-empty block around a cell (like Ctrl+A in Excel). */
  function region(c, r) {
    const s = sh();
    let R = { c1: c, r1: r, c2: c, r2: r };
    const filled = (cc, rr) => cc >= 0 && rr >= 0 && hasContent(s, cc, rr);
    for (let grew = true, guard = 0; grew && guard < 500; guard++) {
      grew = false;
      const rowHas = (rr) => { for (let cc = R.c1 - 1; cc <= R.c2 + 1; cc++) if (filled(cc, rr)) return true; return false; };
      const colHas = (cc) => { for (let rr = R.r1 - 1; rr <= R.r2 + 1; rr++) if (filled(cc, rr)) return true; return false; };
      if (R.r1 > 0 && rowHas(R.r1 - 1)) { R.r1--; grew = true; }
      if (rowHas(R.r2 + 1)) { R.r2++; grew = true; }
      if (R.c1 > 0 && colHas(R.c1 - 1)) { R.c1--; grew = true; }
      if (colHas(R.c2 + 1)) { R.c2++; grew = true; }
    }
    return R;
  }
  function createTable(anchor) {
    let R = clampFull(lastR());
    if (R.c1 === R.c2 && R.r1 === R.r2) R = region(R.c1, R.r1);
    if (R.r1 === R.r2) R = { ...R, r2: R.r1 + 1 };
    let n = 1;
    while (allTables(doc).some((x) => sameName(x.t.name, 'Table' + n))) n++;
    askName(anchor, 'Table name', 'Table' + n, (name) => {
      if (submit([{ op: 'table', name, range: quoteSheet(sh().name) + '!' + rangeToString(R) }])) {
        sel = { ranges: [R], active: { c: R.c1, r: R.r1 }, anchor: { c: R.c1, r: R.r1 }, cursor: { c: R.c2, r: R.r2 } };
        afterSelect();
      }
    });
  }
  function autofitRow(r) {
    const s = sh();
    let lines = 1;
    for (const A in s.cells) { const p = parseAddr(A); if (p.r === r) lines = Math.max(lines, cellLines(s, p.c, p.r)); }
    submit([{ op: 'resize', sheet: s.name, rows: { [r + 1]: lines > 1 ? Math.ceil(lines * FONT * 1.3 + 8) : null } }]);
  }

  function noteEditor(A) {
    const p = parseAddr(A);
    const r = scroller.getBoundingClientRect();
    ctx.popover({ left: r.left + sx(p.c) + cw(p.c) * z, bottom: r.top + sy(p.r) }, (pop, close) => {
      const t = document.createElement('textarea');
      t.rows = 4; t.cols = 30;
      t.value = sh().cells[A]?.n || '';
      const ok = document.createElement('button');
      ok.className = 'btn'; ok.textContent = 'Save note';
      ok.onclick = () => { close(); submit([{ op: 'note', sheet: sh().name, cell: A, text: t.value.trim() || null }]); ed.focus(); };
      t.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok.click(); };
      pop.append(t, ok);
      setTimeout(() => t.focus());
    });
  }

  // diff bar
  $('.sv-diffclose').onclick = () => { diffCells = null; diffBar.classList.remove('on'); requestDraw(); resize(); };

  // ================================================================ lifecycle
  const ro = new ResizeObserver(resize);
  ro.observe(gridEl);
  rebuild();
  resize();
  renderTabs();
  afterSelect();
  ed.focus();

  return {
    unmount() { offPacks(); live?.close(); ro.disconnect(); document.removeEventListener('keydown', docKey, true); ctx.toolbar.innerHTML = ''; },
    reload() { undoStack = []; redoStack = []; refresh(); },
    resized: () => setTimeout(resize, 0),
    present(o) { if (o.off) return live?.close(); startLive(o); },
    presence(list) {
      others = (list || []).map((p) => ({ ...p, name: p.name || '?' }));
      live?.people?.(list);
      renderTabs();
      requestDraw();
    },
    activeRef: () => `${quoteSheet(sh().name)}!${addr(sel.active.c, sel.active.r)}`,
    remote(evt) {
      live?.update();
      engine.invalidate();
      if (!doc.sheets.find((s) => sameName(s.name, sheetName))) { sheetName = doc.sheets[0].name; sel = freshSel(); }
      rebuild();
      if (evt.by !== 'user' || evt.who) {
        const t0 = performance.now();
        const human = evt.by === 'user';
        let last = null;
        for (const t of evt.touched || []) {
          const R = parseRange(t.range);
          if (!R) continue;
          flashes.push({ sheet: t.sheet, R, t0, color: human ? evt.color || '#888' : null });
          last = { sheet: t.sheet, R };
          if (!human && !sameName(t.sheet, sheetName)) agentSheets.add(String(t.sheet).toLowerCase());
        }
        if (flashes.length > 400) flashes = flashes.slice(-400);
        if (last && !human) {
          const all = (evt.touched || []).filter((t) => sameName(t.sheet, last.sheet)).map((t) => parseRange(t.range)).filter(Boolean);
          const U = all.reduce((a, b) => ({ c1: Math.min(a.c1, b.c1), r1: Math.min(a.r1, b.r1), c2: Math.max(a.c2, b.c2), r2: Math.max(a.r2, b.r2) }));
          agentBox = { sheet: last.sheet, R: U, label: evt.by, t0 };
        }
      }
      renderTabs();
      if (!edit) syncBars(); else updateStats();
      requestDraw();
    },
    focus(evt) {
      const [sn, rs] = splitSheet(evt.range || '');
      const R = parseRange(rs);
      if (!R) return;
      const sheet = evt.sheet || sn || sheetName;
      agentBox = { sheet, R, label: evt.label ? `${evt.by}: ${evt.label}` : evt.by, t0: performance.now() };
      if (!sameName(sheet, sheetName)) { agentSheets.add(sheet.toLowerCase()); renderTabs(); }
      requestDraw();
    },
    goto(sheet, range) {
      const s = doc.sheets.find((x) => sameName(x.name, sheet));
      if (s) switchSheet(s.name);
      gotoRef(range);
      ed.focus();
    },
    showDiff(d, c) {
      diffCells = new Map();
      let n = 0;
      for (const x of d.docs) for (const ch of x.changes) {
        if (ch.k !== 'set') continue;
        if (!diffCells.has(ch.sheet)) diffCells.set(ch.sheet, new Set());
        diffCells.get(ch.sheet).add(ch.cell);
        n++;
      }
      const moves = d.docs.flatMap((x) => x.structural || []).length;
      $('.sv-difftext').textContent = `Since ${c.id} “${c.message}” (v${c.version}): ${n} changed cell${n === 1 ? '' : 's'} highlighted${moves ? `, ${moves} move/structure op${moves === 1 ? '' : 's'}` : ''}`;
      diffBar.classList.add('on');
      resize();
    },
  };
}
