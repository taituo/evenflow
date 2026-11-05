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
  assert.deepEqual(doc.agents.find((a) => a.id === r.id).forkOf, { agent: A, snap: at.n });
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
