// Session store: every ACP session as SQL. One SQLite file (node:sqlite) for the whole studio:
//
//   agents     one row per agent box (process, ACP session id, working directory)
//   events     the conversation: user prompts, agent messages, thoughts, tool calls, plans, permissions, turns
//   snapshots  shadow-git commits of the agent's working tree (after every tool call / file change)
//   monitors   deterministic monitor results per snapshot (green / amber / red)
//   gates      places where an agent needs a human: permission, a red monitor, a finished turn, a crash
//
// The UI, the replay scrubber and `POST /api/studio/sql` all read the same tables.
import fs from 'node:fs';
import path from 'node:path';

function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
  try { return process.getBuiltinModule('node:sqlite'); } finally { process.emitWarning = emit; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, doc TEXT, name TEXT, command TEXT, cwd TEXT, root TEXT, branch TEXT,
  session_id TEXT, agent_info TEXT, fork_of TEXT, created INTEGER, updated INTEGER);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL,
  kind TEXT NOT NULL,          -- user | agent | thought | tool | plan | permission | turn | system | error
  text TEXT, tool_id TEXT, tool_kind TEXT, status TEXT, title TEXT, json TEXT, turn INTEGER);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent, seq);
CREATE UNIQUE INDEX IF NOT EXISTS events_tool ON events(agent, tool_id) WHERE tool_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS snapshots (
  agent TEXT NOT NULL, n INTEGER NOT NULL, ts INTEGER NOT NULL, commit_id TEXT NOT NULL, parent TEXT,
  reason TEXT, tool_id TEXT, seq INTEGER, files TEXT, adds INTEGER, dels INTEGER, PRIMARY KEY (agent, n));
CREATE TABLE IF NOT EXISTS monitors (
  agent TEXT NOT NULL, snap INTEGER NOT NULL, ts INTEGER NOT NULL, monitor TEXT NOT NULL,
  level TEXT NOT NULL,         -- green | amber | red | skip | running
  summary TEXT, detail TEXT, PRIMARY KEY (agent, snap, monitor));
CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  title TEXT, detail TEXT, json TEXT, blocking INTEGER DEFAULT 0, resolved INTEGER, resolution TEXT);
CREATE INDEX IF NOT EXISTS gates_open ON gates(resolved);
`;

export class SessionDB {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = sqlite();
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.st = {};
    const q = (k, sql) => (this.st[k] = this.db.prepare(sql));
    q('addEvent', 'INSERT INTO events (ts, agent, kind, text, tool_id, tool_kind, status, title, json, turn) VALUES (?,?,?,?,?,?,?,?,?,?)');
    q('appendText', 'UPDATE events SET text = text || ? WHERE seq = ?');
    q('toolBySeq', 'SELECT seq FROM events WHERE agent = ? AND tool_id = ?');
    q('updTool', 'UPDATE events SET status = coalesce(?, status), title = coalesce(?, title), tool_kind = coalesce(?, tool_kind), json = coalesce(?, json), text = coalesce(?, text) WHERE seq = ?');
    q('events', 'SELECT * FROM events WHERE agent = ? AND seq > ? ORDER BY seq LIMIT ?');
    q('eventsBefore', 'SELECT * FROM (SELECT * FROM events WHERE agent = ? AND seq <= ? ORDER BY seq DESC LIMIT ?) ORDER BY seq');
    q('lastSeq', 'SELECT max(seq) AS s FROM events');
    q('putAgent', `INSERT INTO agents (id, doc, name, command, cwd, root, branch, session_id, agent_info, fork_of, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET doc=excluded.doc, name=excluded.name, command=excluded.command, cwd=excluded.cwd, root=excluded.root, branch=excluded.branch,
      session_id=coalesce(excluded.session_id, agents.session_id), agent_info=coalesce(excluded.agent_info, agents.agent_info), fork_of=coalesce(excluded.fork_of, agents.fork_of), updated=excluded.updated`);
    q('agent', 'SELECT * FROM agents WHERE id = ?');
    q('setSession', 'UPDATE agents SET session_id = ?, agent_info = ?, updated = ? WHERE id = ?');
    q('addSnap', 'INSERT INTO snapshots (agent, n, ts, commit_id, parent, reason, tool_id, seq, files, adds, dels) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    q('snaps', 'SELECT * FROM snapshots WHERE agent = ? ORDER BY n');
    q('snap', 'SELECT * FROM snapshots WHERE agent = ? AND n = ?');
    q('putMon', 'INSERT INTO monitors (agent, snap, ts, monitor, level, summary, detail) VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent, snap, monitor) DO UPDATE SET ts=excluded.ts, level=excluded.level, summary=excluded.summary, detail=excluded.detail');
    q('monsAt', `SELECT m.* FROM monitors m JOIN (SELECT monitor, max(snap) AS s FROM monitors WHERE agent = ? AND snap <= ? AND level != 'running' GROUP BY monitor) x ON m.monitor = x.monitor AND m.snap = x.s WHERE m.agent = ?`);
    q('monHistory', 'SELECT snap, monitor, level, summary FROM monitors WHERE agent = ? ORDER BY snap');
    q('addGate', 'INSERT INTO gates (id, agent, ts, kind, title, detail, json, blocking) VALUES (?,?,?,?,?,?,?,?)');
    q('resolveGate', 'UPDATE gates SET resolved = ?, resolution = ? WHERE id = ? AND resolved IS NULL');
    q('openGates', 'SELECT * FROM gates WHERE resolved IS NULL ORDER BY blocking DESC, ts');
    q('gate', 'SELECT * FROM gates WHERE id = ?');
    q('gatesOf', 'SELECT * FROM gates WHERE agent = ? ORDER BY ts');
  }

  addEvent(e) {
    const r = this.st.addEvent.run(e.ts ?? Date.now(), e.agent, e.kind, e.text ?? null, e.toolId ?? null, e.toolKind ?? null, e.status ?? null, e.title ?? null, e.json == null ? null : JSON.stringify(e.json), e.turn ?? null);
    return Number(r.lastInsertRowid);
  }
  appendText(seq, text) { this.st.appendText.run(text, seq); }
  toolSeq(agent, toolId) { return this.st.toolBySeq.get(agent, toolId)?.seq ?? null; }
  updateTool(seq, { status, title, toolKind, json, text }) { this.st.updTool.run(status ?? null, title ?? null, toolKind ?? null, json == null ? null : JSON.stringify(json), text ?? null, seq); }
  events(agent, since = 0, limit = 500) { return this.st.events.all(agent, since, limit).map(rowEvent); }
  eventsBefore(agent, seq, limit = 500) { return this.st.eventsBefore.all(agent, seq, limit).map(rowEvent); }
  lastSeq() { return this.st.lastSeq.get().s || 0; }

  putAgent(a) {
    const now = Date.now();
    this.st.putAgent.run(a.id, a.doc ?? null, a.name ?? a.id, a.command ?? null, a.cwd ?? null, a.root ?? null, a.branch ?? null, a.sessionId ?? null, a.agentInfo ? JSON.stringify(a.agentInfo) : null, a.forkOf ? JSON.stringify(a.forkOf) : null, a.created ?? now, now);
  }
  agent(id) { const r = this.st.agent.get(id); return r ? { ...r, agent_info: r.agent_info ? JSON.parse(r.agent_info) : null, fork_of: r.fork_of ? JSON.parse(r.fork_of) : null } : null; }
  setSession(id, sessionId, info) { this.st.setSession.run(sessionId, info ? JSON.stringify(info) : null, Date.now(), id); }

  addSnapshot(s) { this.st.addSnap.run(s.agent, s.n, s.ts, s.commit, s.parent ?? null, s.reason ?? null, s.toolId ?? null, s.seq ?? null, JSON.stringify(s.files || []), s.adds || 0, s.dels || 0); }
  snapshots(agent) { return this.st.snaps.all(agent).map(rowSnap); }
  snapshot(agent, n) { const r = this.st.snap.get(agent, n); return r ? rowSnap(r) : null; }

  putMonitor(m) { this.st.putMon.run(m.agent, m.snap, m.ts ?? Date.now(), m.monitor, m.level, m.summary ?? null, m.detail ?? null); }
  monitorsAt(agent, snap = 1e9) { return this.st.monsAt.all(agent, snap, agent); }
  monitorHistory(agent) { return this.st.monHistory.all(agent); }

  addGate(g) { this.st.addGate.run(g.id, g.agent, g.ts ?? Date.now(), g.kind, g.title ?? null, g.detail ?? null, g.json == null ? null : JSON.stringify(g.json), g.blocking ? 1 : 0); }
  resolveGate(id, resolution) { return Number(this.st.resolveGate.run(Date.now(), resolution ?? null, id).changes) > 0; }
  openGates() { return this.st.openGates.all().map(rowGate); }
  gate(id) { const r = this.st.gate.get(id); return r ? rowGate(r) : null; }
  gatesOf(agent) { return this.st.gatesOf.all(agent).map(rowGate); }

  /** Read-only SQL for people and agents: a second connection opened read-only, so nothing can be written. */
  query(sql, limit = 500) {
    if (!this.ro) { const { DatabaseSync } = sqlite(); this.ro = new DatabaseSync(this.file, { readOnly: true }); }
    const st = this.ro.prepare(String(sql));
    const rows = [];
    for (const r of st.iterate()) { rows.push(r); if (rows.length >= limit) break; }
    return { columns: rows.length ? Object.keys(rows[0]) : (st.columns?.().map((c) => c.name) || []), rows, truncated: rows.length >= limit };
  }
  close() { try { this.ro?.close(); } catch {} try { this.db.close(); } catch {} }
}

const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return s; } };
const rowEvent = (r) => ({ seq: r.seq, ts: r.ts, agent: r.agent, kind: r.kind, text: r.text, toolId: r.tool_id, toolKind: r.tool_kind, status: r.status, title: r.title, json: parse(r.json), turn: r.turn });
const rowSnap = (r) => ({ agent: r.agent, n: r.n, ts: r.ts, commit: r.commit_id, parent: r.parent, reason: r.reason, toolId: r.tool_id, seq: r.seq, files: parse(r.files) || [], adds: r.adds, dels: r.dels });
const rowGate = (r) => ({ id: r.id, agent: r.agent, ts: r.ts, kind: r.kind, title: r.title, detail: r.detail, json: parse(r.json), blocking: !!r.blocking, resolved: r.resolved, resolution: r.resolution });
