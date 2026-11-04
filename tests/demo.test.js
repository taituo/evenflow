// The guided tour runs end to end against a fresh server; the MCP server speaks JSON-RPC over stdio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';
import { STEPS, runStep, setPace } from '../lib/demo.js';
import * as S from '../public/shared/types/sheet.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-demo-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
test.after(() => srv.close());

test('every step of the tour runs, on its own workbook, and can run again', async () => {
  setPace(0);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < STEPS.length; i++) {
      const s = STEPS[i];
      assert.ok(s.title && s.look, `step ${i + 1} has a title and says what to look at`);
      await runStep(base, i).catch((e) => assert.fail(`step ${i + 1} "${s.title}": ${e.message}`));
    }
  }
  const d = store.doc('demo');
  assert.ok(d.sheets.some((x) => x.name === 'Sensors'));
  assert.ok(d.live.slides.length === 4);
  assert.equal(store.doc('main').title, 'Workbook', 'the user\'s workbook is untouched');
  const features = new Set(STEPS.flatMap((x) => x.features));
  assert.ok(features.size >= 60, `the tour covers ${features.size} features`);
  for (const f of ['SVG', 'Traffic', 'SQL', 'Live', 'slides', 'Remote', 'presence', 'undo']) assert.ok(fs.readFileSync('FEATURES.md', 'utf8').toLowerCase().includes(f.toLowerCase()), 'FEATURES.md mentions ' + f);
});

test('live card styles are validated and undoable', () => {
  const st = S.create('t');
  assert.throws(() => S.apply(st, { op: 'liveLayout', cards: 'frosted' }), /glass \| outline \| clear/);
  assert.throws(() => S.apply(st, { op: 'liveLayout', styles: { x: { lines: 'dots' } } }), /rows \| grid \| none/);
  const r = S.apply(st, { op: 'liveLayout', cards: 'clear', lines: 'grid', styles: { 'chart:a': { card: 'glass' }, empty: {} } });
  assert.deepEqual(st.live, { cards: 'clear', lines: 'grid', styles: { 'chart:a': { card: 'glass' } } });
  for (const inv of r.inverse) S.apply(st, inv);
  assert.equal(st.live, undefined);
});

test('MCP server: initialize, list tools, call tools, report errors', async (t) => {
  const p = spawn(process.execPath, ['bin/mcp.mjs'], { env: { ...process.env, CANVAS_URL: base } });
  t.after(() => p.kill());   // even when an assertion fails
  const replies = new Map();
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); } });
  const ask = async (id, method, params) => {
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let t = 0; t < 200 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 25));
    return replies.get(id);
  };
  const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'spread');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await ask(2, 'tools/list')).result.tools.map((t) => t.name);
  for (const t of ['spread_overview', 'spread_changes', 'spread_ops', 'spread_sql', 'spread_present', 'spread_viz', 'spread_demo', 'spread_map', 'spread_replay']) assert.ok(tools.includes(t), t);
  const call = async (id, name, args) => (await ask(id, 'tools/call', { name, arguments: args })).result;
  assert.match((await call(3, 'spread_ops', { ops: [{ op: 'set', cells: { 'Budget!H1': 'from mcp' } }] })).content[0].text, /ok v\d+[\s\S]*Budget!H1: ∅ → from mcp/);
  await fetch(base + '/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'user', ops: [{ op: 'set', cells: { 'Budget!H2': 'from the user' } }] }) });
  const ch = (await call(4, 'spread_changes', {})).content[0].text;
  assert.match(ch, /from the user/);
  assert.doesNotMatch(ch, /from mcp/, 'own edits filtered out');
  assert.doesNotMatch((await call(5, 'spread_changes', {})).content[0].text, /from the user/, 'the cursor moved on');
  assert.match((await call(6, 'spread_demo', { list: true })).content[0].text, /1\. A fresh demo workbook/);
  assert.match((await call(10, 'spread_map', {})).content[0].text, /no maps yet/);
  assert.match((await call(11, 'spread_map', { doc: 'demo', id: 'mFleet', fly: { to: 'Base', zoom: 15 }, focus: 'Base' })).content[0].text, /view \{"to":"Base","zoom":15\} focus Base/);
  assert.match((await call(12, 'spread_replay', { preview: true, from: '-10m', doc: 'demo' })).content[0].text, /replay \[demo\]/);
  assert.equal((await call(13, 'spread_replay', { from: '-1m', speed: 30 })).isError, undefined);
  const bad = await call(7, 'spread_ops', { ops: [{ op: 'nope' }] });
  assert.equal(bad.isError, true);
  assert.equal((await ask(8, 'tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await ask(9, 'whatever')).error.code, -32601);
  p.kill();
});
