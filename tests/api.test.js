import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const get = (p) => fetch(base + p).then((r) => r.text());
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
test.after(() => srv.close());

test('ops -> changes (text) with recalc, own edits excluded', async () => {
  await post('/api/ops', { by: 'user', ops: [{ op: 'set', sheet: 'Budget', cells: { B2: '10' } }] });
  await post('/api/ops', { by: 'agent', ops: [{ op: 'set', sheet: 'Budget', cells: { G1: 'x' } }] });
  const t = await get('/api/changes?since=0&exclude=agent');
  assert.match(t, /Budget!B2: 4 → 10/);
  assert.match(t, /calc: .*Budget!D2 50→125/);
  assert.doesNotMatch(t, /G1/);
});

test('expect -> 409 on conflict, batch is atomic', async () => {
  const r = await post('/api/ops', { expect: { 'Budget!B2': '4' }, ops: [{ op: 'set', sheet: 'Budget', cells: { B2: '5' } }] });
  assert.equal(r.status, 409);
  const bad = await post('/api/ops', { ops: [{ op: 'set', cells: { Z1: 'a' } }, { op: 'move', from: 'nope', to: 'A1' }] });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await get('/api/read?range=Z1:Z1'), /Z1 a/);
});

test('move is reported compactly and diff vs milestone is move-aware', async () => {
  await (await post('/api/commit', { message: 'base' })).json();
  await post('/api/ops', { by: 'user', ops: [{ op: 'move', sheet: 'Budget', from: 'A2:E5', to: 'A20' }] });
  await post('/api/ops', { by: 'user', ops: [{ op: 'set', sheet: 'Budget', cells: { B20: '7' } }] });
  const ch = await get('/api/changes?since=0&mode=net');
  assert.match(ch, /MOVE Budget!A2:E5 → A20:E23/);
  const d = await get('/api/diff?from=last');
  assert.match(d, /Budget!B20: 10 → 7/);
  assert.doesNotMatch(d, /A2: Servos → ∅/);
});

test('restore milestone', async () => {
  const r = await (await post('/api/restore', { commit: 'last' })).json();
  assert.ok(r.version > 0);
  assert.match(await get('/api/read?range=Budget!B2'), /B2 10/);
});

test('selection + read + find', async () => {
  await post('/api/selection', { doc: 'main', sheet: 'Budget', ranges: ['C23:D32'], active: 'C23' });
  assert.match(await get('/api/selection'), /Budget!C23:D32 active C23/);
  assert.match(await get('/api/find?q=raspberry'), /Budget!A3 Raspberry Pi/);
  assert.match(await get('/api/overview'), /Budget: used/);
});

test('tables over HTTP', async () => {
  await post('/api/ops', { by: 'user', ops: [{ op: 'updateRows', table: 'Tasks', key: 'Wire the servos', set: { Status: 'done' } }] });
  assert.match(await get('/api/changes?since=0'), /⟨Tasks\[Wire the servos\]\.Status⟩/);
  assert.match(await get('/api/read?range=@Tasks'), /Task: Wire the servos · Status: done/);
  assert.match(await get('/api/overview'), /table Tasks B6:E10/);
});

test('text canvas', async () => {
  await post('/api/ops', { doc: 'notes', ops: [{ op: 'append', text: 'hello from the agent' }] });
  assert.match(await get('/api/read?doc=notes'), /hello from the agent/);
});
