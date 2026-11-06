#!/usr/bin/env node
// The studio's tools for the agents inside it, as an MCP server (stdio). The studio hands this to every ACP
// session it starts (session/new → mcpServers), with STUDIO_AGENT set to that box, so an agent can spin off a
// copy of itself, start a sub-agent, put things on the screen, or leave a note — and the user sees why.
// Without STUDIO_AGENT it is an orchestrator: every tool takes an "agent" argument.
//   claude mcp add studio -- node bin/studio-mcp.mjs      (STUDIO_URL defaults to http://127.0.0.1:3210)
import readline from 'node:readline';

const URL_ = (process.env.STUDIO_URL || process.env.CANVAS_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const SELF = process.env.STUDIO_AGENT || null;
const TOKEN = process.env.SPREAD_TOKEN || null;

async function api(method, path, body) {
  const r = await fetch(URL_ + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) { let m = t; try { m = JSON.parse(t).error || t; } catch {} throw new Error(m); }
  try { return JSON.parse(t); } catch { return t; }
}
const who = (a) => { const id = a.agent || SELF; if (!id) throw new Error('agent is required (this server is not attached to a box)'); return id; };
const agentProp = SELF ? {} : { agent: { type: 'string', description: 'Agent box id (see studio_status)' } };

const TOOLS = [
  {
    name: 'studio_status',
    description: 'What every agent box on the studio canvas is doing: status, monitor lights (syntax, churn, secrets, tests…), plan, last sentence, open gates.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => api('GET', '/api/studio'),
  },
  {
    name: 'studio_fork',
    description: 'Spin off a copy of yourself — same files (a new git worktree from your latest snapshot) and the conversation so far — to try an alternative in parallel instead of explaining it. The user sees your reason on the canvas next to the new box, so say concretely why the alternative is worth trying.',
    inputSchema: { type: 'object', required: ['reason'], properties: { ...agentProp, reason: { type: 'string', description: 'Why this alternative is a good option (shown to the user)' }, prompt: { type: 'string', description: 'What the copy should do first' }, name: { type: 'string' }, snap: { type: 'number', description: 'Fork from this snapshot instead of the latest' } } },
    run: async (a) => { const r = await api('POST', '/api/studio/fork', { agent: who(a), reason: a.reason, prompt: a.prompt, name: a.name, snap: a.snap, by: SELF ? `agent:${SELF}` : 'agent' }); return `Started ${r.name} (${r.id}) in ${r.cwd}${r.branch ? ` on ${r.branch}` : ''}, from snapshot #${r.from.snap}.`; },
  },
  {
    name: 'studio_spawn',
    description: 'Start a sub-agent for a side task (review, tests, docs, an experiment). mode "same" works in your folder and sees your uncommitted work; mode "worktree" gets its own worktree with your current files and a fresh conversation. Its box appears next to yours.',
    inputSchema: { type: 'object', required: ['prompt'], properties: { ...agentProp, prompt: { type: 'string' }, mode: { type: 'string', enum: ['same', 'worktree'], default: 'worktree' }, role: { type: 'string', description: 'e.g. review, tests, docs' }, reason: { type: 'string', description: 'Why (shown to the user)' }, name: { type: 'string' }, preset: { type: 'string', description: 'Another agent preset (kiro, claude, gemini, mock…)' } } },
    run: async (a) => { const r = await api('POST', '/api/studio/spawn', { agent: who(a), prompt: a.prompt, mode: a.mode, role: a.role, reason: a.reason, name: a.name, preset: a.preset, by: SELF ? `agent:${SELF}` : 'agent' }); return `Started ${r.name} (${r.id}) — ${r.mode === 'same' ? 'same folder' : 'own worktree'}: ${r.cwd}`; },
  },
  {
    name: 'studio_show',
    description: 'Control what the studio screens show and where things are. mode: "canvas" | "focus" (classic coding UI around the focused agent). focus: an agent id, a panel id or "self". float: pin a panel to the screen. move: [{id,x,y,w,h}] rearranges boxes and panels by hand. tab: the right-hand tab in focus mode. open: a panel — {kind:"preview", url} for a running web UI (e.g. http://localhost:5173), {kind:"terminal", cmd?} in your folder, {kind:"map", paths?} for a code map, {kind:"note", title, text}. arrange: "grid" | "row" | "tree" | "around" (around the focused box) | "stack". scrub: a snapshot number of yours, or "live". fit: true. theme: "light" | "dark". tray: true/false.',
    inputSchema: { type: 'object', properties: { ...agentProp, focus: { type: 'string' }, open: { type: 'object' }, arrange: { type: 'string' }, scrub: {}, fit: { type: 'boolean' }, theme: { type: 'string' }, tray: { type: 'boolean' },
      mode: { type: 'string', enum: ['canvas', 'focus'], description: 'canvas: every box on the infinite canvas · focus: a classic coding UI around one agent (list, session + composer, changes / terminal / preview tabs)' },
      tab: { type: 'string', description: 'focus mode: the right-hand tab — "changes" or a panel id' },
      float: { type: 'object', description: 'Pin a panel to the screen (stays in both modes): {panel, x, y, w, h} as fractions 0..1 of the screen, or {panel, off: true}' },
      move: { type: 'array', items: { type: 'object' }, description: 'Move / resize boxes and panels on the canvas: [{id, x, y, w, h}] in canvas pixels' },
      reason: { type: 'string', description: 'One short sentence shown on screen: why this view' } } },
    run: async (a) => {
      const self = a.agent || SELF;
      const b = { by: self ? `agent:${self}` : 'agent' };
      if (a.focus) b.focus = a.focus === 'self' ? { agent: self } : /^p[0-9a-f]{8}$/.test(a.focus) ? { panel: a.focus } : { agent: a.focus };
      if (a.open) b.open = { agent: self || undefined, ...a.open };
      if (a.arrange) b.arrange = a.arrange;
      if (a.scrub != null) b.scrub = a.scrub === 'live' ? null : { agent: a.agent && a.agent !== SELF ? a.agent : a.focus && !/^p/.test(a.focus) ? a.focus : self, snap: +a.scrub };
      if (a.fit) b.fit = true;
      if (a.theme) b.theme = a.theme;
      if (a.tray != null) b.tray = a.tray;
      if (a.reason) b.reason = a.reason;
      for (const k of ['mode', 'tab', 'float', 'move']) if (a[k] != null) b[k] = a[k];
      const r = await api('POST', '/api/studio/view', b);
      return r.panel ? `Opened panel ${r.panel}.` : 'Done.';
    },
  },
  {
    name: 'studio_note',
    description: 'Put a note on the canvas next to your box — a summary, a decision to make, a checklist. The user can edit it and drag it onto any box to send it.',
    inputSchema: { type: 'object', required: ['text'], properties: { ...agentProp, title: { type: 'string' }, text: { type: 'string' } } },
    run: async (a) => { const r = await api('POST', '/api/studio/view', { by: 'agent', open: { kind: 'note', agent: a.agent || SELF || undefined, title: a.title || 'Note', text: a.text } }); return `Note ${r.panel} added.`; },
  },
  {
    name: 'studio_prompt',
    description: 'Send a message to another agent box (it is queued if that agent is busy).',
    inputSchema: { type: 'object', required: ['to', 'text'], properties: { to: { type: 'string', description: 'Agent id' }, text: { type: 'string' } } },
    run: async (a) => { await api('POST', '/api/studio/prompt', { agent: a.to, text: a.text, by: SELF ? `agent:${SELF}` : 'agent' }); return 'Sent.'; },
  },
];

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const rl = readline.createInterface({ input: process.stdin });
let busy = 0, closed = false;
const done = () => { if (closed && !busy) process.exit(0); };
rl.on('line', async (line) => { busy++; try { await handle(line); } finally { busy--; done(); } });
async function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;   // notifications (initialized, cancelled)
  try {
    if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spread-studio', version: '0.2.0' }, instructions: 'Tools of the studio canvas you are running in. Prefer studio_fork over long explanations of an alternative approach; use studio_show to put a running UI, a terminal or a code map in front of the user.' } });
    if (m.method === 'ping') return send({ id: m.id, result: {} });
    if (m.method === 'tools/list') return send({ id: m.id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (m.method === 'tools/call') {
      const t = TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return send({ id: m.id, error: { code: -32602, message: `Unknown tool ${m.params?.name}` } });
      try {
        const out = await t.run(m.params.arguments || {});
        return send({ id: m.id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] } });
      } catch (e) { return send({ id: m.id, result: { content: [{ type: 'text', text: e.message }], isError: true } }); }
    }
    send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  } catch (e) { send({ id: m.id, error: { code: -32603, message: e.message } }); }
}
rl.on('close', () => { closed = true; done(); });
