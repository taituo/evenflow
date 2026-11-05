// Studio canvas: the layout of a coding-agent workspace — agent boxes and text panels on an infinite canvas.
// Only the layout is versioned here (moves, resizes, notes, review text: undoable, replayable, multi-user).
// What the agents do lives in the session database (lib/studio/db.js) and is streamed to the view as events.
export const type = 'studio';

const clone = (x) => JSON.parse(JSON.stringify(x));
const num = (v, d) => (Number.isFinite(+v) ? Math.round(+v) : d);
const AGENT_KEYS = ['name', 'color', 'x', 'y', 'w', 'h', 'scope', 'preset', 'command', 'cwd', 'branch', 'worktree', 'forkOf', 'collapsed'];
const PANEL_KEYS = ['title', 'text', 'kind', 'x', 'y', 'w', 'h', 'color', 'source', 'pinned'];

export function create(title) { return { type, title: title || 'Studio', root: null, agents: [], panels: [] }; }

function cleanAgent(a) {
  if (!a || typeof a.id !== 'string' || !/^[\w-]{1,40}$/.test(a.id)) throw new Error('agent needs an id ([A-Za-z0-9_-])');
  return {
    id: a.id, name: String(a.name || a.id).slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#7f77dd',
    x: num(a.x, 0), y: num(a.y, 0), w: Math.max(160, num(a.w, 560)), h: Math.max(120, num(a.h, 420)),
    preset: a.preset ? String(a.preset).slice(0, 40) : null, command: a.command ? String(a.command).slice(0, 500) : null,
    cwd: a.cwd ? String(a.cwd) : null, branch: a.branch ? String(a.branch).slice(0, 120) : null, worktree: a.worktree !== false,
    scope: Array.isArray(a.scope) ? a.scope.map(String).slice(0, 20) : [], forkOf: a.forkOf || null, collapsed: !!a.collapsed,
  };
}
function cleanPanel(p) {
  if (!p || typeof p.id !== 'string' || !/^[\w-]{1,40}$/.test(p.id)) throw new Error('panel needs an id');
  return {
    id: p.id, title: String(p.title ?? '').slice(0, 120), text: String(p.text ?? '').slice(0, 200000), kind: ['note', 'review', 'prompt', 'sql'].includes(p.kind) ? p.kind : 'note',
    x: num(p.x, 0), y: num(p.y, 0), w: Math.max(140, num(p.w, 320)), h: Math.max(80, num(p.h, 200)),
    color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : null, source: p.source || null, pinned: p.pinned || null,
  };
}

export function apply(st, op) {
  const done = (inverse, changes) => ({ inverse, changes });
  switch (op.op) {
    case 'addAgent': {
      const a = cleanAgent(op.agent);
      if (st.agents.some((x) => x.id === a.id)) throw new Error(`agent "${a.id}" exists`);
      st.agents.splice(op.index ?? st.agents.length, 0, a);
      return done([{ op: 'removeAgent', id: a.id }], [{ k: 'agent', action: 'add', id: a.id, name: a.name }]);
    }
    case 'removeAgent': {
      const i = st.agents.findIndex((x) => x.id === op.id);
      if (i < 0) throw new Error(`no agent "${op.id}"`);
      const [a] = st.agents.splice(i, 1);
      return done([{ op: 'addAgent', agent: a, index: i }], [{ k: 'agent', action: 'remove', id: a.id, name: a.name }]);
    }
    case 'updateAgent': {
      const a = st.agents.find((x) => x.id === op.id);
      if (!a) throw new Error(`no agent "${op.id}"`);
      const old = {};
      for (const k of Object.keys(op.set || {})) if (AGENT_KEYS.includes(k)) old[k] = clone(a[k] ?? null);
      Object.assign(a, cleanAgent({ ...a, ...pick(op.set, AGENT_KEYS) }));
      return done([{ op: 'updateAgent', id: a.id, set: old }], [{ k: 'agent', action: 'update', id: a.id, name: a.name, keys: Object.keys(old) }]);
    }
    case 'addPanel': {
      const p = cleanPanel(op.panel);
      if (st.panels.some((x) => x.id === p.id)) throw new Error(`panel "${p.id}" exists`);
      st.panels.splice(op.index ?? st.panels.length, 0, p);
      return done([{ op: 'removePanel', id: p.id }], [{ k: 'panel', action: 'add', id: p.id, title: p.title }]);
    }
    case 'removePanel': {
      const i = st.panels.findIndex((x) => x.id === op.id);
      if (i < 0) throw new Error(`no panel "${op.id}"`);
      const [p] = st.panels.splice(i, 1);
      return done([{ op: 'addPanel', panel: p, index: i }], [{ k: 'panel', action: 'remove', id: p.id, title: p.title }]);
    }
    case 'updatePanel': {
      const p = st.panels.find((x) => x.id === op.id);
      if (!p) throw new Error(`no panel "${op.id}"`);
      const old = {};
      for (const k of Object.keys(op.set || {})) if (PANEL_KEYS.includes(k)) old[k] = clone(p[k] ?? null);
      Object.assign(p, cleanPanel({ ...p, ...pick(op.set, PANEL_KEYS) }));
      const ch = { k: 'panel', action: 'update', id: p.id, title: p.title, keys: Object.keys(old) };
      if ('text' in old) { ch.old = String(old.text ?? '').slice(0, 200); ch.new = p.text.slice(0, 200); }
      return done([{ op: 'updatePanel', id: p.id, set: old }], [ch]);
    }
    case 'setRoot': {
      const old = st.root;
      st.root = op.root ? String(op.root) : null;
      return done([{ op: 'setRoot', root: old }], [{ k: 'root', old, new: st.root }]);
    }
    default: throw new Error(`Unknown studio op "${op.op}"`);
  }
}
const pick = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => keys.includes(k)));

export function diff(a, b) {
  const out = [];
  const A = new Map((a.agents || []).map((x) => [x.id, x])), B = new Map((b.agents || []).map((x) => [x.id, x]));
  for (const [id, x] of B) if (!A.has(id)) out.push({ k: 'agent', action: 'add', id, name: x.name }); else if (JSON.stringify(A.get(id)) !== JSON.stringify(x)) out.push({ k: 'agent', action: 'update', id, name: x.name });
  for (const [id, x] of A) if (!B.has(id)) out.push({ k: 'agent', action: 'remove', id, name: x.name });
  const P = new Map((a.panels || []).map((x) => [x.id, x])), Q = new Map((b.panels || []).map((x) => [x.id, x]));
  for (const [id, x] of Q) if (!P.has(id)) out.push({ k: 'panel', action: 'add', id, title: x.title }); else if (JSON.stringify(P.get(id)) !== JSON.stringify(x)) out.push({ k: 'panel', action: 'update', id, title: x.title });
  for (const [id, x] of P) if (!Q.has(id)) out.push({ k: 'panel', action: 'remove', id, title: x.title });
  if (a.root !== b.root) out.push({ k: 'root', old: a.root, new: b.root });
  return out;
}

export function describe(st) {
  return { agents: st.agents.length, panels: st.panels.length, root: st.root, summary: `${st.agents.length} agent box${st.agents.length === 1 ? '' : 'es'} (${st.agents.map((a) => a.name).join(', ') || '–'}) · ${st.panels.length} panels · root ${st.root || '(not set)'}` };
}

export function read(st) {
  return { studio: { root: st.root, agents: st.agents.map((a) => ({ id: a.id, name: a.name, at: `${a.x},${a.y} ${a.w}×${a.h}`, cwd: a.cwd, branch: a.branch, forkOf: a.forkOf })), panels: st.panels.map((p) => ({ id: p.id, title: p.title, kind: p.kind, text: p.text.slice(0, 2000) })) } };
}
