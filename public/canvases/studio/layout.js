// Arranging the canvas: a few deterministic layouts for agent boxes and panels, and named layouts you save.
// Every arrangement is one batch of updateAgent / updatePanel ops: versioned, undoable, the same for everyone.

const GAP = 48;

/** Panels that belong to a box (terminal, map, review of that agent) go next to it; others go to a free column. */
function owner(p) { return p.source?.agent || null; }

export const MODES = {
  grid: 'Grid',
  row: 'One row',
  tree: 'Forks as a tree',
  focus: 'Focus the pointed box',
  stack: 'Tiles (overview)',
};

export function arrange(doc, mode, { focus = null, origin = { x: 80, y: 80 } } = {}) {
  const agents = doc.agents.slice();
  const pos = new Map();
  const W = (a) => a.w, H = (a) => a.h;
  if (mode === 'row') {
    let x = origin.x;
    for (const a of agents) { pos.set(a.id, { x, y: origin.y }); x += W(a) + GAP; }
  } else if (mode === 'tree') {
    // roots in a column; every fork / sub-agent one column to the right of its parent
    const kids = new Map();
    for (const a of agents) { const p = a.forkOf?.agent; if (p && agents.some((x) => x.id === p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(a); } }
    const colW = Math.max(...agents.map(W), 400) + GAP * 2;
    let y = origin.y;
    const walk = (a, depth) => {
      pos.set(a.id, { x: origin.x + depth * colW, y });
      const ks = kids.get(a.id) || [];
      if (!ks.length) { y += H(a) + GAP; return; }
      for (const k of ks) walk(k, depth + 1);
      y = Math.max(y, pos.get(a.id).y + H(a) + GAP);
    };
    for (const a of agents.filter((a) => !a.forkOf?.agent || !agents.some((x) => x.id === a.forkOf.agent))) walk(a, 0);
  } else if (mode === 'focus' && focus && agents.some((a) => a.id === focus)) {
    const f = agents.find((a) => a.id === focus);
    const others = agents.filter((a) => a !== f);
    const small = 360;
    let y = origin.y;
    for (const a of others) { pos.set(a.id, { x: origin.x, y, w: small, h: Math.round(small * 0.7) }); y += Math.round(small * 0.7) + GAP / 2; }
    pos.set(f.id, { x: origin.x + small + GAP * 1.5, y: origin.y, w: Math.max(f.w, 1100), h: Math.max(f.h, 760) });
  } else if (mode === 'stack') {
    const n = agents.length, cols = Math.ceil(Math.sqrt(n * 1.6)) || 1, tw = 420, th = 300;
    agents.forEach((a, i) => pos.set(a.id, { x: origin.x + (i % cols) * (tw + GAP), y: origin.y + Math.floor(i / cols) * (th + GAP), w: tw, h: th }));
  } else {
    // grid: about √n columns, rows aligned on the tallest box
    const n = agents.length, cols = Math.max(1, Math.round(Math.sqrt(n * 1.5)));
    let y = origin.y;
    for (let r = 0; r * cols < n; r++) {
      const row = agents.slice(r * cols, r * cols + cols);
      let x = origin.x;
      for (const a of row) { pos.set(a.id, { x, y }); x += W(a) + GAP; }
      y += Math.max(...row.map(H)) + GAP;
    }
  }
  const ops = [];
  for (const a of agents) {
    const p = pos.get(a.id);
    if (!p) continue;
    const set = {};
    for (const k of ['x', 'y', 'w', 'h']) if (p[k] != null && Math.round(p[k]) !== a[k]) set[k] = Math.round(p[k]);
    if (Object.keys(set).length) ops.push({ op: 'updateAgent', id: a.id, set });
  }
  // panels follow their box (to its right, stacked), free panels go below everything
  const rect = (a) => ({ ...a, ...(pos.get(a.id) || {}) });
  const stackAt = new Map();
  let bottom = Math.max(origin.y, ...agents.map((a) => { const r = rect(a); return r.y + r.h; })) + GAP;
  let freeX = origin.x;
  for (const p of doc.panels) {
    const o = owner(p) && agents.find((a) => a.id === owner(p));
    let x, y;
    if (o) {
      const r = rect(o);
      const key = o.id;
      const used = stackAt.get(key) ?? r.y;
      // to the right of the box unless another box is there; then under it
      const right = r.x + r.w + GAP / 2;
      const blocked = agents.some((b) => b !== o && rect(b).x < right + p.w && rect(b).x + rect(b).w > right && rect(b).y < used + p.h && rect(b).y + rect(b).h > used);
      if (!blocked) { x = right; y = used; stackAt.set(key, used + p.h + GAP / 2); }
      else { x = freeX; y = bottom; freeX += p.w + GAP / 2; }
    } else { x = freeX; y = bottom; freeX += p.w + GAP / 2; }
    if (Math.round(x) !== p.x || Math.round(y) !== p.y) ops.push({ op: 'updatePanel', id: p.id, set: { x: Math.round(x), y: Math.round(y) } });
  }
  return ops;
}

/** The current positions, to save as a named layout. */
export function snapshotLayout(doc) {
  const items = {};
  for (const x of [...doc.agents, ...doc.panels]) items[x.id] = { x: x.x, y: x.y, w: x.w, h: x.h };
  return items;
}

/** Ops that restore a saved layout (items that no longer exist are skipped; new ones stay where they are). */
export function applyLayout(doc, layout) {
  const ops = [];
  for (const a of doc.agents) { const r = layout.items[a.id]; if (r && (r.x !== a.x || r.y !== a.y || r.w !== a.w || r.h !== a.h)) ops.push({ op: 'updateAgent', id: a.id, set: r }); }
  for (const p of doc.panels) { const r = layout.items[p.id]; if (r && (r.x !== p.x || r.y !== p.y || r.w !== p.w || r.h !== p.h)) ops.push({ op: 'updatePanel', id: p.id, set: r }); }
  return ops;
}
