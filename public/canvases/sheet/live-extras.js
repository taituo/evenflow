// Live-mode helpers: adaptive ink (reads the background behind each card), relation lines between cards,
// and the "flip to sheet" back side of a card.

// ------------------------------------------------------------------ adaptive ink
const probe = document.createElement('canvas');
probe.width = 96; probe.height = 54;
const pg = probe.getContext('2d', { willReadFrequently: true });

/** Returns a function (el) -> luminance 0..1 of the background behind el, or null if unknown. */
export function sampleBackground(bgHost) {
  const src = (bgHost.classList.contains('lv-has-bgimg') && bgHost.querySelector('.lv-bgimg img')) || bgHost.querySelector('.lv-bg canvas');
  if (!src) return () => null;
  try {
    pg.clearRect(0, 0, probe.width, probe.height);
    const vw = innerWidth, vh = innerHeight;
    if (src.tagName === 'IMG') {
      if (!src.complete || !src.naturalWidth) return () => null;
      // emulate object-fit: cover
      const k = Math.max(vw / src.naturalWidth, vh / src.naturalHeight);
      const w = src.naturalWidth * k, h = src.naturalHeight * k;
      pg.drawImage(src, ((vw - w) / 2) * probe.width / vw, ((vh - h) / 2) * probe.height / vh, w * probe.width / vw, h * probe.height / vh);
    } else pg.drawImage(src, 0, 0, probe.width, probe.height);
    const data = pg.getImageData(0, 0, probe.width, probe.height).data;
    return (el) => {
      const r = el.getBoundingClientRect();   // an element or a Range (text extent)
      const x1 = Math.max(0, Math.floor((r.left / vw) * probe.width)), x2 = Math.min(probe.width - 1, Math.ceil((r.right / vw) * probe.width));
      const y1 = Math.max(0, Math.floor((r.top / vh) * probe.height)), y2 = Math.min(probe.height - 1, Math.ceil((r.bottom / vh) * probe.height));
      if (x2 < x1 || y2 < y1) return null;
      let sum = 0, n = 0;
      for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
        const i = (y * probe.width + x) * 4;
        sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        n++;
      }
      return n ? sum / n : null;
    };
  } catch { return () => null; }   // tainted canvas (cross-origin image) etc.
}

// ------------------------------------------------------------------ relations between cards
const norm = (v) => String(v ?? '').trim().toLowerCase();
const isNum = (t) => t !== '' && !isNaN(+t.replace(',', '.'));

/** Find column pairs in different tables that share values, and charts fed by tables. */
export function findRelations(items) {
  const tables = items.filter((it) => it.kind === 'table');
  const colSets = tables.map((t) => t.cols.map((_, ci) => new Set(t.rows.map((r) => norm(r[ci]?.text)).filter((x) => x.length >= 2 && !isNum(x)))));
  const rel = [];
  for (let a = 0; a < tables.length; a++) for (let b = a + 1; b < tables.length; b++) {
    let best = null;
    tables[a].cols.forEach((ca, i) => tables[b].cols.forEach((cb, j) => {
      const A = colSets[a][i], B = colSets[b][j];
      if (!A.size || !B.size) return;
      let n = 0;
      for (const x of A) if (B.has(x)) n++;
      const score = n / Math.min(A.size, B.size);
      if (n >= 1 && (n >= 2 || score >= 0.5) && (!best || n > best.n)) best = { n, ca, cb };
    }));
    if (best) rel.push({ a: tables[a].key, b: tables[b].key, label: best.ca === best.cb ? best.ca : `${best.ca} ↔ ${best.cb}`, n: best.n });
  }
  for (const it of items) {
    if (it.kind !== 'chart' || !it.ch.table) continue;
    const t = tables.find((x) => x.name.toLowerCase() === it.ch.table.toLowerCase());
    if (t) rel.push({ a: t.key, b: it.key, label: 'data', n: 0, lineage: true });
  }
  return rel;
}

/** Draw relations as soft curves in an SVG layer inside the stage. */
export function drawRelations(stage, rel, nodes) {
  let svg = stage.querySelector(':scope > svg.lv-links');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lv-links');
    stage.prepend(svg);
  }
  svg.setAttribute('width', stage.scrollWidth);
  svg.setAttribute('height', stage.scrollHeight);
  const parts = [];
  for (const r of rel) {
    const A = nodes.get(r.a)?.el, B = nodes.get(r.b)?.el;
    if (!A || !B || A.offsetParent === null || B.offsetParent === null) continue;
    const a = box(A), b = box(B);
    // connect the closest sides
    const horizontal = Math.abs(a.cx - b.cx) > Math.abs(a.cy - b.cy);
    let p1, p2, c1, c2;
    if (horizontal) {
      const L = a.cx < b.cx ? [a, b] : [b, a];
      p1 = [L[0].x + L[0].w, L[0].cy]; p2 = [L[1].x, L[1].cy];
      const d = Math.max(40, (p2[0] - p1[0]) / 2);
      c1 = [p1[0] + d, p1[1]]; c2 = [p2[0] - d, p2[1]];
    } else {
      const T = a.cy < b.cy ? [a, b] : [b, a];
      p1 = [T[0].cx, T[0].y + T[0].h]; p2 = [T[1].cx, T[1].y];
      const d = Math.max(30, (p2[1] - p1[1]) / 2);
      c1 = [p1[0], p1[1] + d]; c2 = [p2[0], p2[1] - d];
    }
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    // label only where it is readable: in the gap between cards, not on top of one
    const covered = [...nodes.values()].some((n) => { const q = box(n.el); return n.el.offsetParent !== null && mid[0] > q.x - 2 && mid[0] < q.x + q.w + 2 && mid[1] - 8 > q.y - 4 && mid[1] - 8 < q.y + q.h + 4; });
    const path = `M${p1} C${c1} ${c2} ${p2}`;
    const cls = r.lineage ? 'lv-link-line lineage' : 'lv-link-line';
    parts.push(`<g class="${cls}" data-a="${esc(r.a)}" data-b="${esc(r.b)}"><path class="glow" d="${path}"/><path class="line" d="${path}"/>`
      + `<circle cx="${p1[0]}" cy="${p1[1]}" r="3.5"/><circle cx="${p2[0]}" cy="${p2[1]}" r="3.5"/>`
      + (covered ? '' : `<text x="${mid[0]}" y="${mid[1] - 8}">${esc(r.label)}${r.n > 1 ? ` · ${r.n}` : ''}</text>`) + `<title>${esc(r.label)}</title></g>`);
  }
  svg.innerHTML = parts.join('');
}
const box = (el) => { const x = el.offsetLeft, y = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight; return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 }; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ flip a card to its sheet side
export function flip(el, makeBack) {
  // State changes at once (and the content swaps on a timer at the half-turn), so a slow screen never ends up
  // half-flipped; the rotation is decoration on top.
  const toBack = !el.querySelector(':scope > .lv-back');
  el.classList.toggle('lv-flipped', toBack);
  el.animate([
    { transform: 'perspective(1400px) rotateY(0deg)' },
    { transform: 'perspective(1400px) rotateY(90deg)', offset: 0.5, easing: 'cubic-bezier(0,0,.5,1)' },
    { transform: 'perspective(1400px) rotateY(0deg)' },
  ], { duration: 420, easing: 'cubic-bezier(.5,0,1,1)' });
  setTimeout(() => {
    const back = el.querySelector(':scope > .lv-back');
    if (!el.classList.contains('lv-flipped')) { back?.remove(); return; }
    if (back) return;
    const b = document.createElement('div');
    b.className = 'lv-back';
    el.append(b);
    makeBack(b);
  }, 200);
}

/** The back side: the cells behind a card, A1 addresses, raw formulas — plus recent history. */
export function backSide(it, { doc, chartData }) {
  const h = [];
  const head = (title, sub) => h.push(`<div class="lv-back-h"><b>${esc(title)}</b><span>${esc(sub)}</span></div>`);
  const grid = (cols, rows) => h.push(`<div class="lv-back-g"><table><thead><tr><th></th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><th>${esc(r[0])}</th>${r.slice(1).map((c) => `<td class="${c.f ? 'f' : ''}">${esc(c.t)}${c.v !== undefined ? `<i>⇒ ${esc(c.v)}</i>` : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
  if (it.kind === 'table') {
    const letters = (it.rows[0] || []).map((c) => c.A.replace(/\d+/g, ''));
    const hdrRow = it.rows[0] ? +it.rows[0][0].A.replace(/\D+/g, '') - 1 : 1;
    head(`${it.sheet}!${letters[0] || ''}${hdrRow}:${letters.at(-1) || ''}${hdrRow + it.rows.length}`, `table ${it.name}`);
    grid(letters, [[String(hdrRow), ...it.cols.map((c) => ({ t: c }))], ...it.rows.map((r) => [r[0].A.replace(/\D+/g, ''), ...r.map((c) => ({ t: c.raw, f: c.formula, v: c.formula ? c.text : undefined }))])]);
  } else if (it.kind === 'chart') {
    head(it.ch.table ? `@${it.ch.table}` : it.ch.range, `${it.ch.type} chart ${it.ch.id}`);
    const d = it.data;
    grid(['label', ...d.series.map((s) => s.name)], d.labels.map((l, i) => [String(i + 1), { t: l }, ...d.series.map((s) => ({ t: s.values[i] ?? '' }))]));
  } else if (it.kind === 'kpi') {
    head(it.ch.value, `kpi ${it.ch.id}`);
    h.push(`<div class="lv-back-f">${esc(rawOf(doc, it.ch.value, it.sheet))}</div><div class="lv-back-v">⇒ ${esc(it.data.kpi.text)}</div>`);
  } else if (it.kind === 'stat') {
    head(`${it.sheet}!${it.value.A}`, it.label);
    h.push(`<div class="lv-back-f">${esc(it.value.raw)}</div><div class="lv-back-v">⇒ ${esc(it.value.text)}</div>`);
  } else if (it.kind === 'panel') {
    head(it.p.id, `panel${it.p.by ? ' by ' + it.p.by : ''}`);
    h.push(`<pre class="lv-back-f">${esc(it.p.text || '')}</pre>`);
  }
  h.push('<div class="lv-back-hist"></div>');
  return h.join('');
}
function rawOf(doc, ref, sheet) {
  const i = ref.lastIndexOf('!');
  const sn = i >= 0 ? ref.slice(0, i).replace(/^'|'$/g, '') : sheet;
  const a = (i >= 0 ? ref.slice(i + 1) : ref).toUpperCase();
  const s = doc.sheets.find((x) => x.name.toLowerCase() === String(sn).toLowerCase());
  return s?.cells[a]?.v ?? '';
}
