// Panel bodies that are more than text: a real terminal, a live preview of a running UI, a code map.
// mountBody(view, panelEl, panel) → { update(panel), studio(event), destroy() } or null for text panels.
import { Terminal } from './term.js';

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function mountBody(view, node, p) {
  if (p.kind === 'terminal') return terminal(view, node, p);
  if (p.kind === 'preview') return preview(view, node, p);
  if (p.kind === 'map') return codemap(view, node, p);
  return null;
}

// ---------------------------------------------------------------- terminal
function terminal(view, node, p) {
  const body = node.querySelector('.st-body');
  body.innerHTML = '<div class="st-term"></div>';
  const box = body.firstChild;
  const id = `${view.docId}:${p.id}`;
  let sendBuf = '', sendT = null, alive = true;
  const flush = () => { sendT = null; const d = sendBuf; sendBuf = ''; if (d) view.ctx.post('/api/studio/term/input', { id, data: d }).catch((e) => t.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`)); };
  const t = new Terminal(box, {
    onData: (d) => { sendBuf += d; if (!sendT) sendT = setTimeout(flush, 8); },
    onResize: (cols, rows) => view.ctx.post('/api/studio/term/resize', { id, cols, rows }).catch(() => {}),
  });
  const open = async () => {
    const st = await view.ctx.get(`/api/studio/term?id=${encodeURIComponent(id)}`).catch(() => null);
    if (!st?.buf || st.exited) await view.ctx.post('/api/studio/term', { doc: view.docId, panel: p.id, cols: t.cols, rows: t.rows });
    const again = await view.ctx.get(`/api/studio/term?id=${encodeURIComponent(id)}`).catch(() => null);
    if (again?.buf) { t.reset(); t.write(again.buf); }
  };
  requestAnimationFrame(() => { t.fit(); open().catch((e) => t.write(`\x1b[31m${e.message}\x1b[0m\r\n`)); });
  const ro = new ResizeObserver(() => { if (alive) t.fit(); });
  ro.observe(box);
  box.addEventListener('pointerdown', (e) => { e.stopPropagation(); box.focus(); });
  node.querySelector('.grow') && (node.querySelector('.grow').textContent = '');
  return {
    focus: () => box.focus(),
    studio(e) { if (e.kind === 'term' && e.term === id) { if (e.data) t.write(e.data); } },
    update() {},
    restart: () => view.ctx.post('/api/studio/term', { doc: view.docId, panel: p.id, cols: t.cols, rows: t.rows }).then(() => { t.reset(); }),
    destroy() { alive = false; ro.disconnect(); },
  };
}

// ---------------------------------------------------------------- preview
/** localhost URLs go through the server's /preview/<port>/ proxy, so a remote studio shows remote apps. */
export function previewSrc(url) {
  const u = String(url || '').trim();
  if (!u) return 'about:blank';
  const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:(\d{2,5})(\/.*)?$/i.exec(u);
  if (m) return `/preview/${m[1]}${m[2] || '/'}`;
  if (/^\d{2,5}$/.test(u)) return `/preview/${u}/`;
  return /^https?:\/\//.test(u) ? u : 'https://' + u;
}
function preview(view, node, p) {
  const body = node.querySelector('.st-body');
  body.innerHTML = `<div class="st-urlbar"><input spellcheck="false" placeholder="http://localhost:5173 · a port · a URL (a voxl desktop: :6901)"><button class="btn" data-a="reload" title="Reload">↻</button><button class="btn" data-a="live" title="Interact without hovering">⌖</button></div><div class="st-frame"><iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" allow="clipboard-read; clipboard-write; fullscreen; microphone; camera"></iframe><div class="shield"></div></div>`;
  const input = body.querySelector('input'), frame = body.querySelector('iframe');
  let url = p.source?.url || '';
  const load = () => { input.value = url; frame.src = previewSrc(url); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { url = input.value.trim(); view.ctx.submit([{ op: 'updatePanel', id: p.id, set: { source: { ...(p.source || {}), url }, title: url } }], 'preview'); load(); input.blur(); }
    if (e.key === 'Escape') input.blur();
  });
  body.querySelector('[data-a="reload"]').onclick = () => { frame.src = previewSrc(url) + (frame.src.includes('?') ? '&' : '?') + '_r=' + Date.now(); };
  body.querySelector('[data-a="live"]').onclick = (e) => { node.classList.toggle('live'); e.currentTarget.classList.toggle('pri', node.classList.contains('live')); };
  load();
  return { update(np) { if ((np.source?.url || '') !== url) { url = np.source?.url || ''; load(); } p = np; }, destroy() { frame.src = 'about:blank'; }, studio() {} };
}

// ---------------------------------------------------------------- code map
/** Squarified treemap of the repo (or a box's snapshot, or a sparse slice); files an agent touched take its color. */
function codemap(view, node, p) {
  const body = node.querySelector('.st-body');
  body.innerHTML = '<div class="st-map"><svg></svg><div class="legend"></div></div>';
  const svg = body.querySelector('svg'), legend = body.querySelector('.legend');
  let data = null, timer = null, alive = true;
  const load = async () => {
    const q = new URLSearchParams({ doc: view.docId });
    if (p.source?.agent) q.set('agent', p.source.agent);
    if (p.source?.paths) q.set('paths', [].concat(p.source.paths).join(','));
    try { data = await view.ctx.get('/api/studio/codemap?' + q); draw(); } catch (e) { svg.innerHTML = `<text x="12" y="24">${esc(e.message)}</text>`; }
  };
  const draw = () => {
    if (!data || !alive) return;
    const W = body.clientWidth || 600, H = body.clientHeight || 400;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const root = { name: '', kids: new Map(), size: 0 };
    for (const f of data.files) {
      const parts = f.path.split('/');
      let n = root;
      for (const d of parts.slice(0, -1)) { if (!n.kids.has(d)) n.kids.set(d, { name: d, kids: new Map(), size: 0 }); n = n.kids.get(d); }
      n.kids.set(parts.at(-1), { name: parts.at(-1), path: f.path, size: Math.max(400, f.size) });
    }
    const sum = (n) => (n.kids ? (n.size = [...n.kids.values()].reduce((s, k) => s + sum(k), 0)) : n.size);
    sum(root);
    const out = [];
    const now = Date.now();
    const touchedBy = (path) => {
      const t = data.touched[path];
      if (!t) return null;
      let best = null;
      for (const [agent, x] of Object.entries(t)) if (!best || x.last > best.last) best = { agent, ...x };
      return best;
    };
    const place = (n, x, y, w, h, depth) => {
      if (w < 2 || h < 2) return;
      if (!n.kids) {
        const t = touchedBy(n.path);
        const col = t ? view.color(t.agent) : null;
        const age = t ? Math.min(1, (now - t.last) / 600000) : 1;
        out.push(`<rect class="f${t ? ' on' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" data-path="${esc(n.path)}" style="fill:${col || 'var(--fill)'};${t ? `fill-opacity:${(1 - age * 0.55).toFixed(2)}` : ''}"><title>${esc(n.path)}${t ? ` — ${esc(view.name(t.agent))} +${t.adds} −${t.dels} in ${t.n} snapshot${t.n === 1 ? '' : 's'}` : ''}</title></rect>`);
        if (w > 60 && h > 16) out.push(`<text x="${x + 4}" y="${y + 12}">${esc(n.name.length * 6 > w - 8 ? n.name.slice(0, Math.max(1, Math.floor((w - 8) / 6))) : n.name)}</text>`);
        return;
      }
      const pad = depth === 0 ? 0 : 3, head = depth > 0 && h > 40 && w > 50 ? 15 : 0;
      if (head) out.push(`<text class="d" x="${x + pad + 1}" y="${y + 11}">${esc(n.name)}/</text>`);
      squarify([...n.kids.values()].sort((a, b) => b.size - a.size), x + pad, y + pad + head, w - pad * 2, h - pad * 2 - head, depth);
    };
    const squarify = (items, x, y, w, h, depth) => {
      const total = items.reduce((s, k) => s + k.size, 0);
      if (!total) return;
      let rest = items.slice(), X = x, Y = y, Wr = w, Hr = h;
      while (rest.length) {
        const side = Math.min(Wr, Hr), area = (Wr * Hr) / rest.reduce((s, k) => s + k.size, 0);
        const row = [];
        let worst = Infinity;
        for (const k of rest) {
          const test = [...row, k], s = test.reduce((a, b) => a + b.size * area, 0);
          const wst = Math.max(...test.map((t) => Math.max((side * side * t.size * area) / (s * s), (s * s) / (side * side * t.size * area))));
          if (row.length && wst > worst) break;
          row.push(k); worst = wst;
        }
        rest = rest.slice(row.length);
        const s = row.reduce((a, b) => a + b.size * area, 0);
        const thick = s / side;
        let off = 0;
        for (const k of row) {
          const len = (k.size * area) / thick;
          if (Wr >= Hr) place(k, X, Y + off, thick, len, depth + 1); else place(k, X + off, Y, len, thick, depth + 1);
          off += len;
        }
        if (Wr >= Hr) { X += thick; Wr -= thick; } else { Y += thick; Hr -= thick; }
      }
    };
    place(root, 0, 0, W, H, 0);
    svg.innerHTML = out.join('');
    const who = new Set(Object.values(data.touched).flatMap((t) => Object.keys(t)));
    legend.innerHTML = `${data.files.length} files${data.truncated ? ' (first 30k)' : ''}` + [...who].filter((a) => view.agentDef(a)).map((a) => `<span><i style="background:${esc(view.color(a))}"></i>${esc(view.name(a))}</span>`).join('');
  };
  svg.addEventListener('click', (e) => { const r = e.target.closest('rect[data-path]'); if (r) view.showFileAny(r.dataset.path); });
  const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(draw, 80); });
  ro.observe(body);
  load();
  return {
    update(np) { const changed = JSON.stringify(np.source) !== JSON.stringify(p.source); p = np; if (changed) load(); },
    studio(e) { if (e.kind === 'snapshot') { clearTimeout(timer); timer = setTimeout(load, 900); } },
    destroy() { alive = false; ro.disconnect(); },
  };
}
