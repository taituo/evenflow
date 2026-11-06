// Studio: ACP agents on a canvas — protocol, shadow snapshots, monitors, gates, fork / rewind / review, SQL.
// Uses the deterministic mock agent (bin/mock-acp.mjs), so no model and no network are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';
import { splitCommand } from '../lib/studio/acp.js';
import { Shadow, git } from '../lib/studio/shadow.js';
import { checkSyntax, inScope } from '../lib/studio/monitors.js';
import * as studioType from '../public/shared/types/studio.js';
import { arrange, applyLayout, snapshotLayout } from '../public/canvases/studio/layout.js';
import http from 'node:http';
import { spawn } from 'node:child_process';

process.env.MOCK_DELAY = '0';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const getT = (p) => fetch(base + p).then((r) => r.text());
const getJ = (p) => fetch(base + p).then((r) => r.json());
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } if (!r.ok) throw Object.assign(new Error(`${p} ${r.status} ${t}`), { status: r.status }); return j; };
test.after(() => { store.studio.close(); srv.close(); });

async function until(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const state = () => getJ('/api/studio?format=json');
const agent = async (id) => (await state()).agents.find((a) => a.id === id);
const gates = (id, kind) => getJ('/api/studio/gates').then((g) => g.filter((x) => x.agent === id && (!kind || x.kind === kind)));
const idle = (id) => until(async () => (await agent(id))?.status === 'idle' && !(await agent(id)).queue && (await gates(id, 'turn')).length, 8000, `${id} idle`);

test('command lines split like a shell would', () => {
  assert.deepEqual(splitCommand('kiro-cli acp --agent-engine=v3'), ['kiro-cli', 'acp', '--agent-engine=v3']);
  assert.deepEqual(splitCommand(`node "my dir/a.mjs" 'x y' ""`), ['node', 'my dir/a.mjs', 'x y', '']);
});

test('studio layout ops are exact inverses', () => {
  const d = studioType.create('S');
  const before = JSON.stringify(d);
  const inv = [];
  for (const op of [
    { op: 'addAgent', agent: { id: 'a1', name: 'A', x: 1, y: 2, w: 600, h: 400 } },
    { op: 'updateAgent', id: 'a1', set: { x: 50, name: 'Alpha', scope: ['src/**'] } },
    { op: 'addPanel', panel: { id: 'p1', title: 'Note', text: 'hello' } },
    { op: 'updatePanel', id: 'p1', set: { text: 'hello world' } },
    { op: 'setRoot', root: '/tmp/x' },
    { op: 'removeAgent', id: 'a1' },
  ]) inv.unshift(...studioType.apply(d, op).inverse);
  assert.equal(d.panels[0].text, 'hello world');
  for (const op of inv) studioType.apply(d, op);
  assert.equal(JSON.stringify(d), before);
  assert.throws(() => studioType.apply(d, { op: 'addAgent', agent: { id: 'bad id!' } }), /id/);
});

test('layouts: arrange modes, saved layouts restore positions, all as undoable ops', () => {
  const d = studioType.create('S');
  for (const [i, id] of ['a1', 'a2', 'a3'].entries()) studioType.apply(d, { op: 'addAgent', agent: { id, name: id, x: i * 37, y: i * 11, w: 600, h: 400, forkOf: id === 'a3' ? { agent: 'a1', snap: 2 } : null } });
  studioType.apply(d, { op: 'addPanel', panel: { id: 'p1', kind: 'terminal', source: { agent: 'a1' }, x: 5, y: 5 } });
  const saved = snapshotLayout(d);
  studioType.apply(d, { op: 'saveLayout', name: 'mess', items: saved });
  for (const op of arrange(d, 'tree')) studioType.apply(d, op);
  const a1 = d.agents.find((a) => a.id === 'a1'), a3 = d.agents.find((a) => a.id === 'a3');
  assert.ok(a3.x > a1.x + a1.w, 'a fork sits to the right of its parent');
  const p1 = d.panels[0];
  assert.ok(p1.x >= a1.x + a1.w || p1.y >= a1.y + a1.h, 'its terminal moved next to it');
  for (const op of applyLayout(d, d.layouts[0])) studioType.apply(d, op);
  assert.deepEqual(snapshotLayout(d), saved, 'the saved layout comes back exactly');
  const inv = studioType.apply(d, { op: 'removeLayout', name: 'mess' }).inverse;
  assert.equal(d.layouts.length, 0);
  for (const op of inv) studioType.apply(d, op);
  assert.equal(d.layouts[0].name, 'mess');
});

test('syntax checks and scope globs', async () => {
  assert.equal(await checkSyntax('a.js', 'export const x = 1;\n'), null);
  assert.match(await checkSyntax('a.js', 'export function f() {\n'), /SyntaxError|Unexpected/);
  assert.match(await checkSyntax('a.json', '{"a":'), /JSON|Unexpected|end/i);
  assert.equal(await checkSyntax('a.png', 'x'), undefined);
  assert.ok(inScope('src/a/b.js', ['src/**']));
  assert.ok(!inScope('test/a.js', ['src/**', 'lib/*.js']));
  assert.ok(inScope('lib/x.js', ['src/**', 'lib/*.js']));
});

test('shadow git: snapshot, diff, show, rewind, materialize — without touching the project git', async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-wt-'));
  await git(['init', '-q'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n');
  const sh = await new Shadow(path.join(dir, 'sh.git'), wt).init();
  const s0 = await sh.snapshot('base');
  assert.ok(s0.commit);
  assert.equal(await sh.snapshot('again'), null, 'no change, no snapshot');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n');
  const s1 = await sh.snapshot('edit');
  const files = await sh.numstat(s0.commit, s1.commit);
  assert.deepEqual(files.map((f) => [f.path, f.adds, f.dels, f.status]).sort(), [['a.txt', 1, 0, 'M'], ['b.txt', 1, 0, 'A']]);
  assert.match(await sh.diff(s0.commit, s1.commit), /\+two/);
  assert.equal(await sh.show(s0.commit, 'a.txt'), 'one\n');
  assert.deepEqual((await sh.hunks(s0.commit, s1.commit)).find((h) => h.path === 'a.txt'), { path: 'a.txt', oldStart: 1, oldLen: 0, start: 2, len: 1 });
  await sh.restore(s0.commit);
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(!fs.existsSync(path.join(wt, 'b.txt')), 'files added after the snapshot are gone');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-mat-'));
  await sh.materialize(s1.commit, out);
  assert.equal(fs.readFileSync(path.join(out, 'b.txt'), 'utf8'), 'new\n');
  assert.equal((await git(['status', '--porcelain'], { cwd: wt })).trim().split('\n').sort().join(','), '?? a.txt', 'the project index was never touched');
});

let A;
test('an agent box: ACP session in its own worktree, plan, tools, permission by voice, snapshots, monitors', async () => {
  const r = await post('/api/studio/agents', { preset: 'mock', name: 'Auth', prompt: 'implement a greeting helper', by: 'user' });
  A = r.id;
  assert.match(r.branch, /^studio\/auth-/);
  assert.ok(fs.existsSync(r.cwd));
  // the mock asks before running the tests: a blocking gate; "yes" while pointing at the box answers it
  const [perm] = await until(() => gates(A, 'permission').then((g) => g.length && g), 8000, 'permission gate');
  assert.equal(perm.blocking, true);
  assert.equal((await agent(A)).status, 'waiting');
  await post('/api/studio/target', { doc: 'studio', kind: 'agent', id: A });
  assert.equal((await post('/api/studio/say', { text: 'Kyllä!' })).routed, 'allow');
  await idle(A);
  const a = await agent(A);
  assert.ok(a.snapshots.length >= 3, 'base + one snapshot per written file');
  assert.equal(a.snapshots[0].reason, 'base');
  assert.ok(a.snapshots.some((s) => s.reason === 'Write src/greeting.js'), 'snapshots are named after the tool call that made them');
  assert.ok(a.plan.every((p) => p.status === 'completed'));
  assert.ok(fs.existsSync(path.join(r.cwd, 'src', 'greeting.js')));
  const lights = Object.fromEntries(a.lights.map((m) => [m.monitor, m.level]));
  assert.equal(lights.syntax, 'green');
  assert.equal(lights.tests, 'green');
  const ev = await getJ(`/api/studio/events?agent=${A}`);
  assert.deepEqual([...new Set(ev.map((e) => e.kind))].sort(), ['agent', 'permission', 'plan', 'system', 'thought', 'tool', 'turn', 'user'].sort());
  assert.ok(ev.find((e) => e.kind === 'agent').text.startsWith("Okay, I'll add greeting"));
  // the project's own checkout is untouched: the work is on the agent's branch
  const root = (await state()).root;
  assert.ok(!fs.existsSync(path.join(root, 'src', 'greeting.js')));
  const d = await getJ(`/api/studio/diff?agent=${A}&from=base&to=last`);
  assert.ok(d.files.some((f) => f.path === 'src/greeting.js' && f.status === 'A'));
});

test('monitors go red and open gates; fixing the cause clears them', async () => {
  await post('/api/studio/prompt', { agent: A, text: 'break it', by: 'user' });
  await until(() => gates(A, 'monitor').then((g) => g.find((x) => x.json.monitor === 'syntax')), 8000, 'syntax gate');
  await idle(A);
  await post('/api/studio/prompt', { agent: A, text: 'fix it', by: 'user' });
  await until(async () => !(await gates(A, 'monitor')).some((x) => x.json.monitor === 'syntax'), 8000, 'syntax gate cleared');
  await idle(A);
  assert.equal((await agent(A)).lights.find((m) => m.monitor === 'syntax').level, 'green');
  await post('/api/studio/prompt', { agent: A, text: 'loop', by: 'user' });
  const churn = await until(() => gates(A, 'monitor').then((g) => g.find((x) => x.json.monitor === 'churn')), 8000, 'churn gate');
  assert.match(churn.detail, /src\/retry\.js:1 edited 4×/);
  await idle(A);
  await post('/api/studio/prompt', { agent: A, text: 'secret', by: 'user' });
  await until(() => gates(A, 'monitor').then((g) => g.find((x) => x.json.monitor === 'secrets')), 8000, 'secrets gate');
  await idle(A);
  const txt = await getT('/api/studio');
  assert.match(txt, /secrets ✗/);
  assert.match(txt, /churn ✗/);
});

test('fork from an older snapshot: a new box, its own branch, the files of that moment, the conversation so far', async () => {
  const snaps = (await agent(A)).snapshots;
  const at = snaps.find((s) => s.reason === 'Edit src/broken.js');
  const r = await post('/api/studio/fork', { agent: A, snap: at.n, prompt: 'implement a parser' });
  assert.match(r.branch, /^studio\//);
  assert.equal(fs.readFileSync(path.join(r.cwd, 'src', 'broken.js'), 'utf8'), 'export function ok(a, b) {\n  return a + b;\n', 'the broken file as it was then');
  assert.ok(!fs.existsSync(path.join(r.cwd, 'src', 'retry.js')), 'later work is not in the fork');
  const [perm] = await until(() => gates(r.id, 'permission').then((g) => g.length && g), 8000, 'fork permission');
  await post('/api/studio/gate', { gate: perm.id, option: 'reject' });
  await idle(r.id);
  assert.ok(fs.existsSync(path.join(r.cwd, 'src', 'parser.js')), 'the fork did the new task, not the old one');
  const doc = (await getJ('/api/doc?id=studio')).doc;
  assert.deepEqual(doc.agents.find((a) => a.id === r.id).forkOf, { agent: A, snap: at.n, kind: 'fork', by: 'user' });
  assert.match(await getT(`/api/studio/events?agent=${r.id}&format=text`), /Forked from Auth/);
});

test('rewind puts the directory back, is itself a snapshot, and tells the agent next time', async () => {
  const a = await agent(A);
  const cwd = a.cwd;
  const target = a.snapshots.find((s) => s.reason === 'Write test/greeting.test.js') || a.snapshots[2];
  const r = await post('/api/studio/rewind', { agent: A, snap: target.n });
  assert.equal(r.rewound, target.n);
  assert.ok(!fs.existsSync(path.join(cwd, 'src', 'retry.js')));
  assert.ok(!fs.existsSync(path.join(cwd, 'src', 'config.js')));
  assert.ok(fs.existsSync(path.join(cwd, 'src', 'greeting.js')));
  const after = await agent(A);
  assert.match(after.snapshots.at(-1).reason, new RegExp(`rewind to #${target.n}`));
  await until(async () => (await agent(A)).lights.find((m) => m.monitor === 'secrets')?.level === 'green', 4000, 'secrets green after rewind');
  assert.ok(!(await gates(A, 'monitor')).some((g) => g.json.monitor === 'secrets'), 'the gate closed with the cause');
});

test('every turn is tracked in the worktree; rewind a turn: the conversation only (files kept, the agent told to check), both, or the files', async () => {
  const b = await post('/api/studio/agents', { preset: 'mock', name: 'Turns', by: 'user' });
  const B = b.id, f = (x) => fs.existsSync(path.join(b.cwd, x));
  for (const text of ['break it', 'loop', 'secret']) { await post('/api/studio/prompt', { agent: B, text, by: 'user' }); await idle(B); }
  const turns = await getJ(`/api/studio/turns?agent=${B}`);
  assert.deepEqual(turns.map((t) => [t.turn, t.text]), [[1, 'break it'], [2, 'loop'], [3, 'secret']]);
  assert.ok(turns.every((t) => t.snap != null && t.seq != null), 'each turn has its prompt event and the snapshot just before it');
  const session0 = (await agent(B)).sessionId;

  // 1) the conversation goes back to before turn 2; the files stay as they are
  await assert.rejects(post('/api/studio/rewind', { agent: B, turn: 9 }), /404/);
  const r1 = await post('/api/studio/rewind', { agent: B, turn: 2, mode: 'conversation' });
  assert.equal(r1.kept, true);
  assert.ok(f('src/retry.js') && f('src/config.js'), 'files kept');
  assert.notEqual((await agent(B)).sessionId, session0, 'a fresh ACP session that has seen only turn 1');
  let ev = await getJ(`/api/studio/events?agent=${B}`);
  const rw = ev.find((e) => e.kind === 'rewind');
  assert.equal(rw.json.cut, ev.find((e) => e.kind === 'user' && e.turn === 2).seq);
  assert.match(rw.json.note, /^\[Rewound: .*files were kept — the project has moved on/);
  await post('/api/studio/prompt', { agent: B, text: 'loop', by: 'user' });
  await idle(B);
  ev = await getJ(`/api/studio/events?agent=${B}`);
  const reply = ev.filter((e) => e.kind === 'agent' && e.turn === 4)[0];
  assert.match(reply.text, /^The project moved on since that point, so I checked the current state first/, 'the next prompt carried the rewind prefix');

  // 2) conversation and files back to before turn 2: only turn 1's file is there
  await post('/api/studio/rewind', { agent: B, turn: 2, mode: 'both' });
  assert.ok(f('src/broken.js') && !f('src/retry.js') && !f('src/config.js'));
  assert.match((await agent(B)).snapshots.at(-1).reason, /rewind to before turn 2/);

  // 3) the files only, back to before turn 4 (retry.js and config.js were there then); the conversation carries on
  const s4 = (await agent(B)).sessionId;
  await post('/api/studio/rewind', { agent: B, turn: 4, mode: 'files' });
  assert.ok(f('src/retry.js') && f('src/config.js'));
  assert.equal((await agent(B)).sessionId, s4);
});

test('review: a panel on the canvas, written by a read-only reviewer session', async () => {
  await post('/api/studio/prompt', { agent: A, text: 'secret', by: 'user' });
  await idle(A);
  const r = await post('/api/studio/review', { agent: A });
  assert.match(r.header, /^Auth #0→#\d+ · \d+ files? \+\d+ −\d+/);
  const p = await until(async () => (await getJ('/api/doc?id=studio')).doc.panels.find((x) => x.id === r.panel && /Verdict/.test(x.text)), 8000, 'review text');
  assert.equal(p.kind, 'review');
  assert.match(p.text, /credential/);
  assert.match(p.text, /Verdict: request changes/);
});

test('session SQL is read-only; the dashboard twin mirrors agents and lights into a sheet', async () => {
  const t = await post('/api/studio/sql', { sql: "SELECT kind, count(*) n FROM events WHERE agent = '" + A + "' GROUP BY kind ORDER BY kind" });
  assert.match(t, /^kind \| n\n/);
  assert.match(t, /tool \| \d+/);
  await assert.rejects(post('/api/studio/sql', { sql: 'DELETE FROM events' }), /readonly|read-only|400/i);
  await until(async () => /Auth/.test(await getT('/api/read?doc=studio-dash&range=@Agents')), 5000, 'dashboard');
  // the twin is written at most every 1.5 s, so the newest light may still be on its way
  await until(async () => /Monitor: secrets · Level: red/.test(await getT('/api/read?doc=studio-dash&range=@Monitors')), 5000, 'secrets red on the dashboard');
});

test('stop and start again resumes the same ACP session (session/load)', async () => {
  const sid = (await agent(A)).sessionId;
  await post('/api/studio/stop', { agent: A });
  await until(async () => (await agent(A)).status === 'stopped', 4000, 'stopped');
  await post('/api/studio/start', { agent: A });
  const a = await agent(A);
  assert.equal(a.status, 'idle');
  assert.equal(a.sessionId, sid);
  await post('/api/studio/cancel', { agent: A });
});

test('a missing agent command fails visibly, as a gate', async () => {
  const r = await post('/api/studio/agents', { command: 'definitely-not-an-acp-agent --acp', name: 'Ghost' });
  await until(() => gates(r.id, 'error').then((g) => g.length), 5000, 'error gate');
  assert.equal((await agent(r.id)).status, 'error');
  await fetch(`${base}/api/studio/agents?id=${r.id}`, { method: 'DELETE' });
  assert.ok(!(await state()).agents.some((a) => a.id === r.id));
});

// ---------------------------------------------------------------- tools for agents, terminals, previews, maps, remote

test('sub-agents: a reviewer in the same folder, a helper in its own worktree; agents\' spin-offs open an info gate', async () => {
  const same = await post('/api/studio/spawn', { agent: A, mode: 'same', role: 'review', reason: 'second pair of eyes', by: `agent:${A}` });
  const a = await agent(A);
  assert.equal(same.cwd, a.cwd, 'same folder');
  const doc = (await getJ('/api/doc?id=studio')).doc;
  const def = doc.agents.find((x) => x.id === same.id);
  assert.deepEqual([def.role, def.why, def.forkOf.kind, def.forkOf.mode], ['review', 'second pair of eyes', 'spawn', 'same']);
  assert.ok((await gates(A, 'info')).some((g) => g.json.agent === same.id), 'the user sees that an agent started it, and why');
  const wt = await post('/api/studio/spawn', { agent: A, mode: 'worktree', prompt: 'implement docs', reason: 'docs in parallel' });
  assert.notEqual(wt.cwd, a.cwd);
  assert.ok(fs.existsSync(path.join(wt.cwd, 'src', 'greeting.js')), 'it starts from the box\'s files');
  await idle(same.id);
  await until(async () => (await gates(wt.id, 'permission')).length || (await gates(wt.id, 'turn')).length, 8000, 'worktree sub-agent working');
});

test('the agent\'s own tools over MCP: status, note, fork with a reason the user sees', async () => {
  const call = (name, args) => new Promise((ok, bad) => {
    const p = spawn(process.execPath, ['bin/studio-mcp.mjs'], { env: { ...process.env, STUDIO_URL: base, STUDIO_AGENT: A }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; const l = out.split('\n').find((x) => x.includes('"id":2')); if (l) { p.stdin.end(); ok(JSON.parse(l).result); } });
    p.on('error', bad);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: name === 'list' ? 'tools/list' : 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const list = await call('list');
  assert.deepEqual(list.tools.map((t) => t.name), ['studio_status', 'studio_fork', 'studio_spawn', 'studio_show', 'studio_note', 'studio_prompt']);
  assert.match((await call('studio_status', {})).content[0].text, /Auth \[/);
  const note = await call('studio_note', { title: 'Decision', text: 'pick A or B' });
  assert.match(note.content[0].text, /^Note p/);
  const f = await call('studio_fork', { reason: 'try the pure version', prompt: 'implement a pure helper' });
  assert.match(f.content[0].text, /^Started Auth/);
  const doc = (await getJ('/api/doc?id=studio')).doc;
  assert.ok(doc.agents.some((a) => a.why === 'try the pure version' && a.forkOf.agent === A && a.forkOf.by === `agent:${A}`));
  // the mock agent itself calls studio_fork through the MCP server the studio gave its session
  const before = doc.agents.length;
  await post('/api/studio/prompt', { agent: A, text: 'try an alternative', by: 'user' });
  await until(async () => (await getJ('/api/doc?id=studio')).doc.agents.length > before, 8000, 'the agent spun off a copy by itself');
  const ev = await getT(`/api/studio/events?agent=${A}&format=text`);
  assert.match(ev, /tool completed studio_fork/);
});

test('view commands are headless: open panels, arrange in the doc, and a code map that knows who touched what', async () => {
  const r = await post('/api/studio/view', { open: { kind: 'map', agent: A }, by: 'agent' });
  let doc = (await getJ('/api/doc?id=studio')).doc;
  assert.equal(doc.panels.find((p) => p.id === r.panel).kind, 'map');
  const moved = await post('/api/studio/view', { arrange: 'grid' });
  assert.ok(moved.moved >= 1);
  doc = (await getJ('/api/doc?id=studio')).doc;
  const boxes = doc.agents.map((a) => [a.x, a.y, a.w, a.h]);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [x1, y1, w1, h1] = boxes[i], [x2, y2, w2, h2] = boxes[j];
    assert.ok(x1 + w1 <= x2 || x2 + w2 <= x1 || y1 + h1 <= y2 || y2 + h2 <= y1, 'grid boxes do not overlap');
  }
  const map = await getJ(`/api/studio/codemap?agent=${A}`);
  assert.ok(map.files.some((f) => f.path === 'src/greeting.js' && f.size > 0));
  assert.ok(map.touched['src/greeting.js'][A].adds > 0);
  const sliced = await getJ(`/api/studio/codemap?agent=${A}&paths=test`);
  assert.ok(sliced.files.length && sliced.files.every((f) => f.path.startsWith('test/')));
});

test('focus mode and floating panels are driven by the same view command: mode, tab, float, move', async () => {
  // a floating panel is pinned to the screen as fractions, clamped into it; it survives undo like any other field
  const d = studioType.create('F');
  studioType.apply(d, { op: 'addPanel', panel: { id: 'p1', float: { x: 0.9, y: -1, w: 0.5, h: 2 } } });
  assert.deepEqual(d.panels[0].float, { x: 0.5, y: 0, w: 0.5, h: 1 });
  const { inverse } = studioType.apply(d, { op: 'updatePanel', id: 'p1', set: { float: null } });
  assert.equal(d.panels[0].float, null);
  for (const op of inverse) studioType.apply(d, op);
  assert.equal(d.panels[0].float.w, 0.5);
  assert.equal(studioType.cleanFloat('nope'), null);

  const seen = [];
  const off = store.subscribe((e) => { if (e.type === 'studio' && e.kind === 'view') seen.push(e); });
  const term = await post('/api/studio/view', { open: { kind: 'note', agent: A, text: 'pin me' } });
  const r = await post('/api/studio/view', { by: 'director', reason: 'watch Auth', mode: 'focus', tab: 'changes', focus: { agent: A }, float: { panel: term.panel, x: 0.6, y: 0.1 }, move: [{ id: A, x: 40, y: 50, w: 700 }] });
  off();
  assert.equal(r.moved, 2);
  const doc = (await getJ('/api/doc?id=studio')).doc;
  const a = doc.agents.find((x) => x.id === A), p = doc.panels.find((x) => x.id === term.panel);
  assert.deepEqual([a.x, a.y, a.w], [40, 50, 700]);
  assert.deepEqual(p.float, { x: 0.6, y: 0.1, w: 0.34, h: 0.42 });
  const e = seen.at(-1);
  assert.equal(e.mode, 'focus'); assert.equal(e.tab, 'changes'); assert.equal(e.reason, 'watch Auth');
  await post('/api/studio/view', { float: { panel: term.panel, off: true } });
  assert.equal((await getJ('/api/doc?id=studio')).doc.panels.find((x) => x.id === term.panel).float, null);
  await assert.rejects(post('/api/studio/view', { move: [{ id: 'nothing-here', x: 1 }] }), /404/);
  // and the agents' own tool can do all of it
  const tools = await new Promise((ok) => {
    const pr = spawn(process.execPath, ['bin/studio-mcp.mjs'], { env: { ...process.env, STUDIO_URL: base, STUDIO_AGENT: A }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    pr.stdout.on('data', (x) => { out += x; const l = out.split('\n').find((y) => y.includes('"id":2')); if (l) { pr.stdin.end(); ok(JSON.parse(l).result.tools); } });
    pr.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    pr.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
  const show = tools.find((t) => t.name === 'studio_show');
  for (const k of ['mode', 'tab', 'float', 'move']) assert.ok(show.inputSchema.properties[k], `studio_show has ${k}`);
});

test('a real terminal in a box\'s worktree (PTY), with scrollback for late viewers', async () => {
  const r = await post('/api/studio/view', { open: { kind: 'terminal', agent: A } });
  const id = `studio:${r.panel}`;
  const o = await post('/api/studio/term', { doc: 'studio', panel: r.panel, cols: 90, rows: 20 });
  assert.equal(o.cwd, (await agent(A)).cwd);
  await post('/api/studio/term/input', { id, data: 'echo "tty=$(test -t 0 && echo yes) $((6*7)) $(basename $PWD)"\r' });
  const buf = await until(async () => { const b = (await getJ(`/api/studio/term?id=${encodeURIComponent(id)}`)).buf; return /tty=yes 42 a/.test(b) && b; }, 8000, 'shell output');
  assert.match(buf, new RegExp(`tty=yes 42 ${A}`));
  await post('/api/studio/term/resize', { id, cols: 120, rows: 30 });
  await post('/api/studio/term/input', { id, data: 'stty size\r' });
  await until(async () => /30 120/.test((await getJ(`/api/studio/term?id=${encodeURIComponent(id)}`)).buf), 5000, 'resize reached the pty');
  await fetch(`${base}/api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: 'studio', ops: [{ op: 'removePanel', id: r.panel }] }) });
  await until(async () => !(await getJ(`/api/studio/term?id=${encodeURIComponent(id)}`)).buf, 3000, 'terminal closed with its panel');
});

test('previews: a local app through /preview/<port>/, its absolute paths and its WebSocket too', async () => {
  const app = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); return res.end('<script src="/app.js"></script>hello preview'); }
    if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('console.log(1)'); }
    res.writeHead(404); res.end();
  });
  app.on('upgrade', (req, sock) => { sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); sock.end('pong'); });
  await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
  const port = app.address().port;
  test.after(() => app.close());
  const r = await fetch(`${base}/preview/${port}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), null, 'it can live in a panel');
  assert.match(await r.text(), /hello preview/);
  const js = await fetch(`${base}/app.js`, { headers: { referer: `${base}/preview/${port}/` } });
  assert.equal(await js.text(), 'console.log(1)', 'absolute paths follow the page they came from');
  const ws = await new Promise((ok) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: `/preview/${port}/ws`, headers: { connection: 'Upgrade', upgrade: 'websocket' } });
    req.on('upgrade', (res, sock, head) => { let d = head.toString(); sock.on('data', (x) => (d += x)); sock.on('end', () => ok(`${res.statusCode} ${d}`)); });
    req.end();
  });
  assert.equal(ws, '101 pong');
  const gone = await fetch(`${base}/preview/1/`);
  assert.equal(gone.status, 502);
  app.close();
});

test('sparse worktrees: a box can get only a slice of a monorepo', async () => {
  const root = (await state()).root;
  fs.mkdirSync(path.join(root, 'services', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services', 'auth', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'services', 'billing', 'b.js'), 'export const b = 1;\n');
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'services'], { cwd: root });
  const r = await post('/api/studio/agents', { preset: 'mock', name: 'Slice', sparse: 'services/auth', start: false });
  assert.ok(fs.existsSync(path.join(r.cwd, 'services', 'auth', 'a.js')));
  assert.ok(!fs.existsSync(path.join(r.cwd, 'services', 'billing')), 'the rest of the monorepo is not checked out');
  assert.deepEqual((await getJ('/api/doc?id=studio')).doc.agents.find((a) => a.id === r.id).sparse, ['services/auth']);
});

test('remote mode: with SPREAD_TOKEN every request needs the token (query once → cookie, or a bearer header)', async () => {
  process.env.SPREAD_TOKEN = 'sekret-123';
  try {
    assert.equal((await fetch(`${base}/api/studio`)).status, 401);
    assert.equal((await fetch(`${base}/api/studio`, { headers: { authorization: 'Bearer sekret-123' } })).status, 200);
    const r = await fetch(`${base}/studio?token=sekret-123`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/studio`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/studio`, { headers: { cookie: 'spread_token=wrong' } })).status, 401);
  } finally { delete process.env.SPREAD_TOKEN; }
});

test('the director runs the screen: rules move the camera with a reason, report while you work, or a director agent decides', async () => {
  const views = [];
  const off = store.subscribe((e) => { if (e.type === 'studio' && e.kind === 'view' && e.by && e.by !== 'user') views.push(e); });
  try {
    await post('/api/studio/director', { mode: 'auto' });
    assert.equal((await getJ('/api/doc?id=studio')).doc.config.director, 'auto');
    const r = await post('/api/studio/agents', { preset: 'mock', name: 'Dir1', prompt: 'implement a widget', x: 9000, y: 0 });
    const v = await until(() => views.find((e) => e.focus?.agent === r.id && /asks/.test(e.reason || '')) || views.find((e) => e.focus?.agent === r.id), 8000, 'director focus');
    assert.ok(v.reason, 'every move says why');
    // while the person is using the studio, it only reports
    await post('/api/studio/activity', { doc: 'studio' });
    views.length = 0;
    await post('/api/studio/prompt', { agent: r.id, text: 'break it' });
    const g = await until(() => gates(r.id, 'permission').then((x) => x[0]), 8000, 'permission');
    await post('/api/studio/gate', { gate: g.id, option: 'allow' });
    await until(() => views.find((e) => /syntax is red/.test(e.reason || '')), 8000, 'syntax report');
    assert.ok(views.filter((e) => /syntax is red/.test(e.reason || '')).every((e) => e.report), 'reported, not moved');
    // an agent starts a dev server: the director opens it as a preview next to that box
    const before = (await getJ('/api/doc?id=studio')).doc.panels.length;
    await post('/api/studio/prompt', { agent: r.id, text: 'start the dev server' });
    const pv = await until(async () => (await getJ('/api/doc?id=studio')).doc.panels.slice(before).find((p) => p.kind === 'preview' && p.source.agent === r.id), 8000, 'preview opened by the director');
    assert.match(pv.source.url, /^http:\/\/localhost:\d+/);
    const page = await fetch(`${base}/preview/${new URL(pv.source.url).port}/`).then((x) => x.text());
    assert.match(page, /Demo app/);
    // a director agent: gets a digest, answers with studio_show
    const d = await post('/api/studio/director', { mode: 'agent', preset: 'mock' });
    assert.ok(d.box);
    const doc = (await getJ('/api/doc?id=studio')).doc;
    assert.equal(doc.agents.find((a) => a.id === d.box).role, 'director');
    views.length = 0;
    store.studio.director.st('studio').active = 0;
    await post('/api/studio/prompt', { agent: r.id, text: 'secret' });
    const byAgent = await until(() => views.find((e) => e.by === `agent:${d.box}`), 25000, 'the director agent moved the view');
    assert.ok(byAgent.reason);
    assert.match(await getT(`/api/studio/events?agent=${d.box}&format=text`), /\[Director digest\]/);
  } finally {
    off();
    await post('/api/studio/director', { mode: 'off' });
  }
});
