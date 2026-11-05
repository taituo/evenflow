#!/usr/bin/env node
// A deterministic ACP agent for demos and tests. Speaks the same protocol as Kiro / Claude / Gemini ACP agents,
// edits real files in its working directory, streams a plan, tool calls with diffs, permission requests and
// sentence-by-sentence messages. What it does depends on words in the prompt (English or Finnish):
//
//   (anything)            implement a small feature: src/<name>.js + test, asks permission to run the tests
//   break / riko          introduce a syntax error            → the syntax monitor goes red
//   fix / korjaa          repair every file it broke
//   loop / jumi           rewrite the same lines three times  → the churn monitor goes red
//   secret / avain        add a credential to a file          → the secrets monitor goes red
//   deps / riippuvuus     touch package.json                   → the deps monitor goes amber
//   review / arvioi       read the diff in the prompt and answer with a review (no edits)
//   slow / hidas          take its time (to try cancel / steering)
//   alternative / vaihtoehto   call the studio's MCP tool studio_fork: spin off a copy to try another approach
//   reviewer / katselmoija      call studio_spawn: a reviewer sub-agent in the same folder
//
// MOCK_DELAY=ms per streamed chunk (default 45; 0 in tests).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn as spawnProc } from 'node:child_process';

const DELAY = +(process.env.MOCK_DELAY ?? 45);
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let nextId = 1;
const waiting = new Map();
const request = (method, params) => new Promise((ok, bad) => { const id = 'm' + nextId++; waiting.set(id, { ok, bad }); send({ id, method, params }); });
const sessions = new Map();
let caps = {};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && !m.method) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.bad(new Error(m.error.message)) : w.ok(m.result); } return; }
  handle(m).catch((e) => { if (m.id != null) send({ id: m.id, error: { code: -32603, message: e.message } }); });
});
rl.on('close', () => process.exit(0));

async function handle(m) {
  const p = m.params || {};
  if (m.method === 'initialize') {
    caps = p.clientCapabilities || {};
    return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: true } }, agentInfo: { name: 'mock-acp', version: '1.0.0' }, authMethods: [] } });
  }
  if (m.method === 'session/new') {
    const id = 'mock-' + Math.random().toString(36).slice(2, 10);
    sessions.set(id, { cwd: p.cwd, history: [], cancelled: false, broken: new Map(), n: 0, mcp: (p.mcpServers || []).find((x) => x.name === 'studio') || null });
    return send({ id: m.id, result: { sessionId: id, modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }] } } });
  }
  if (m.method === 'session/load') {
    const s = sessions.get(p.sessionId) || { cwd: p.cwd, history: [], cancelled: false, broken: new Map(), n: 0 };
    s.mcp = (p.mcpServers || []).find((x) => x.name === 'studio') || s.mcp || null;
    sessions.set(p.sessionId, s);
    for (const u of s.history) update(p.sessionId, u);
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'session/set_mode') return send({ id: m.id, result: {} });
  if (m.method === 'session/cancel') { const s = sessions.get(p.sessionId); if (s) s.cancelled = true; return; }
  if (m.method === 'session/prompt') {
    const s = sessions.get(p.sessionId);
    if (!s) return send({ id: m.id, error: { code: -32602, message: 'unknown session' } });
    s.cancelled = false;
    let text = (p.prompt || []).map((b) => b.text || b.resource?.text || '').join('\n');
    // context the client prepends (fork history, studio notes) is not the request itself
    const end = text.lastIndexOf('[End of the earlier conversation');
    if (end >= 0) text = text.slice(text.indexOf(']', end) + 1);
    text = text.split('\n').filter((l) => !/^\[Studio:/.test(l)).join('\n').trim();
    const stop = await turn(p.sessionId, s, text);
    return send({ id: m.id, result: { stopReason: stop } });
  }
  if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
}

function update(sessionId, u) { send({ method: 'session/update', params: { sessionId, update: u } }); }
function record(sessionId, s, u) { s.history.push(u); update(sessionId, u); }

async function say(sessionId, s, text) {
  // stream word groups, like a model does
  const parts = text.match(/\S+\s*/g) || [];
  for (let i = 0; i < parts.length; i += 3) {
    if (s.cancelled) return false;
    record(sessionId, s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: parts.slice(i, i + 3).join('') } });
    await sleep(DELAY);
  }
  return true;
}
async function think(sessionId, s, text) {
  record(sessionId, s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
  await sleep(DELAY * 2);
}
function plan(sessionId, s, entries) { record(sessionId, s, { sessionUpdate: 'plan', entries }); }

const rel = (s, f) => path.relative(s.cwd, f);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

async function write(sessionId, s, file, content, title) {
  const abs = path.resolve(s.cwd, file);
  const old = read(abs);
  const id = 'call_' + (++s.n);
  record(sessionId, s, { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'edit', status: 'pending', locations: [{ path: abs }], rawInput: { path: abs } });
  await sleep(DELAY * 2);
  if (s.cancelled) { record(sessionId, s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' }); return false; }
  if (caps.fs?.writeTextFile) await request('fs/write_text_file', { sessionId, path: abs, content });
  else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
  record(sessionId, s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'diff', path: abs, oldText: old, newText: content }] });
  await sleep(DELAY);
  return true;
}

async function readTool(sessionId, s, file) {
  const abs = path.resolve(s.cwd, file);
  const id = 'call_' + (++s.n);
  record(sessionId, s, { sessionUpdate: 'tool_call', toolCallId: id, title: `Read ${file}`, kind: 'read', status: 'in_progress', locations: [{ path: abs }] });
  let text = null;
  if (caps.fs?.readTextFile) { try { text = (await request('fs/read_text_file', { sessionId, path: abs })).content; } catch { text = null; } }
  else text = read(abs);
  await sleep(DELAY);
  record(sessionId, s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: text == null ? '(no such file)' : `${text.split('\n').length} lines` } }] });
  return text;
}

async function permission(sessionId, s, title, kind, cmd) {
  const id = 'call_' + (++s.n);
  const toolCall = { toolCallId: id, title, kind, status: 'pending', rawInput: { command: cmd } };
  record(sessionId, s, { sessionUpdate: 'tool_call', ...toolCall });
  const r = await request('session/request_permission', { sessionId, toolCall, options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ] });
  const ok = r?.outcome?.outcome === 'selected' && r.outcome.optionId !== 'reject';
  return { id, ok };
}

/** Call one tool on an MCP server given to us in session/new (stdio), the way a real agent would. */
function mcpCall(server, name, args) {
  return new Promise((ok, bad) => {
    const env = { ...process.env };
    for (const e of server.env || []) env[e.name] = e.value;
    const p = spawnProc(server.command, server.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 2) { p.stdin.end(); m.error ? bad(new Error(m.error.message)) : ok(m.result.content.map((c) => c.text).join('\n')); }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    p.on('error', bad);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock-acp' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

async function toolCall(sessionId, s, title, name, args) {
  const id = 'call_' + (++s.n);
  record(sessionId, s, { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', status: 'in_progress', rawInput: args });
  let text, ok = true;
  try { text = s.mcp ? await mcpCall(s.mcp, name, args) : 'no studio tools in this session'; ok = !!s.mcp; } catch (e) { text = e.message; ok = false; }
  record(sessionId, s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text } }] });
  return ok;
}

const slug = (t) => (t.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w))[0] || 'feature').slice(0, 20);
const STOP = new Set(['please', 'could', 'would', 'that', 'this', 'with', 'tehdään', 'tehdä', 'lisää', 'tämä', 'sitten', 'voisitko', 'implement', 'create', 'make', 'build', 'small', 'function', 'funktio', 'pieni']);
const has = (t, ...w) => w.some((x) => t.includes(x));

async function turn(sessionId, s, raw) {
  const t = raw.toLowerCase();
  record(sessionId, s, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: raw } });
  const slow = has(t, 'slow', 'hidas');
  const pace = async (ms) => sleep(slow ? Math.max(ms, 400) : ms);
  const done = () => (s.cancelled ? 'cancelled' : 'end_turn');

  if (has(t, 'review', 'arvioi', 'katselmo')) {
    await think(sessionId, s, 'Reading the diff hunk by hunk.');
    const files = [...raw.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((x) => x[1]);
    const added = raw.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const notes = [];
    if (added.some((l) => /console\.log|debugger/.test(l))) notes.push('- Leftover debug output (console.log / debugger) in the added lines.');
    if (added.some((l) => /TODO|FIXME/.test(l))) notes.push('- New TODO/FIXME: decide before merging.');
    if (added.some((l) => /AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY/.test(l))) notes.push('- A credential was committed. Remove it and rotate the key.');
    if (files.length && !files.some((f) => /test/.test(f))) notes.push('- No test changes for the new code.');
    if (added.length > 200) notes.push(`- Large change (${added.length} added lines): consider splitting it.`);
    const body = `Review of ${files.length} file${files.length === 1 ? '' : 's'}${files.length ? ': ' + files.join(', ') : ''}.\n\n${notes.length ? notes.join('\n') : '- Nothing blocking. The change is small and focused.'}\n\nVerdict: ${notes.some((n) => /credential|No test/.test(n)) ? 'request changes' : 'looks good to merge'}.`;
    await say(sessionId, s, body);
    return done();
  }

  if (has(t, 'alternative', 'vaihtoehto')) {
    await think(sessionId, s, 'Two ways to do this. Rather than explain the other one, I can run it.');
    await say(sessionId, s, 'There is a second approach worth trying: a pure function with no shared state. ');
    const ok = await toolCall(sessionId, s, 'studio_fork', 'studio_fork', { reason: 'Same task as a pure function: no shared state, trivially testable — compare both diffs and keep the better one.', prompt: 'implement the helper as a pure function' });
    await say(sessionId, s, ok ? 'I spun off a copy to try it next to me; compare the two when both are done.' : 'I could not reach the studio tools, so here is the idea in words instead.');
    return done();
  }

  if (has(t, 'reviewer', 'katselmoija')) {
    const ok = await toolCall(sessionId, s, 'studio_spawn', 'studio_spawn', { mode: 'same', role: 'review', reason: 'A second pair of eyes on the uncommitted work before I continue.', prompt: 'Review the current changes in this folder and list findings.' });
    await say(sessionId, s, ok ? 'A reviewer is now looking at this folder next to me.' : 'No studio tools here.');
    return done();
  }

  if (has(t, 'fix', 'korjaa')) {
    plan(sessionId, s, [{ content: 'Find what is broken', priority: 'high', status: 'in_progress' }, { content: 'Repair it', priority: 'high', status: 'pending' }]);
    if (!s.broken.size) { await say(sessionId, s, 'Nothing I broke is still broken. The workspace looks clean to me.'); return done(); }
    for (const [file, good] of s.broken) { await readTool(sessionId, s, file); if (!(await write(sessionId, s, file, good, `Repair ${file}`))) return done(); }
    s.broken.clear();
    plan(sessionId, s, [{ content: 'Find what is broken', priority: 'high', status: 'completed' }, { content: 'Repair it', priority: 'high', status: 'completed' }]);
    await say(sessionId, s, 'Fixed. The syntax error is gone and the file parses again.');
    return done();
  }

  if (has(t, 'break', 'riko')) {
    const file = 'src/broken.js';
    const good = 'export function ok(a, b) {\n  return a + b;\n}\n';
    s.broken.set(file, good);
    await write(sessionId, s, file, 'export function ok(a, b) {\n  return a + b;\n', `Edit ${file}`);
    await say(sessionId, s, 'Edited src/broken.js. I think I may have dropped a closing brace there.');
    return done();
  }

  if (has(t, 'loop', 'jumi')) {
    const file = 'src/retry.js';
    plan(sessionId, s, [{ content: 'Tune the retry delay', priority: 'medium', status: 'in_progress' }]);
    for (const [i, d] of [100, 250, 100, 400].entries()) {
      if (!(await write(sessionId, s, file, `export const RETRY_DELAY_MS = ${d};\nexport const MAX_RETRIES = 3;\n`, `Edit ${file} (attempt ${i + 1})`))) return done();
      await say(sessionId, s, `Trying ${d} ms. `);
    }
    await say(sessionId, s, 'Settled on 400 ms. Hmm, that is the fourth time I rewrote the same line.');
    return done();
  }

  if (has(t, 'secret', 'avain')) {
    await write(sessionId, s, 'src/config.js', "export const config = {\n  region: 'eu-north-1',\n  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',\n};\n", 'Edit src/config.js');
    await say(sessionId, s, 'Added the AWS config with the access key inline.');
    return done();
  }

  if (has(t, 'deps', 'riippuvuu')) {
    const pkgPath = path.join(s.cwd, 'package.json');
    const pkg = JSON.parse(read(pkgPath) || '{"name":"demo","version":"0.0.0"}');
    pkg.dependencies = { ...(pkg.dependencies || {}), 'left-pad': '^1.3.0' };
    await write(sessionId, s, 'package.json', JSON.stringify(pkg, null, 2) + '\n', 'Edit package.json');
    await say(sessionId, s, 'Added left-pad as a dependency.');
    return done();
  }

  // default: implement a small feature, with a plan, a test, and a permission to run it
  const name = slug(raw);
  const fn = name.replace(/[^a-z0-9]/g, '') || 'feature';
  const P = (a, b, c) => [{ content: `Write src/${name}.js`, priority: 'high', status: a }, { content: `Add test/${name}.test.js`, priority: 'medium', status: b }, { content: 'Run the tests', priority: 'medium', status: c }];
  plan(sessionId, s, P('in_progress', 'pending', 'pending'));
  await think(sessionId, s, `The user wants ${name}. Small module plus a test.`);
  if (!(await say(sessionId, s, `Okay, I'll add ${name} as a small module with a test. `))) return done();
  await readTool(sessionId, s, 'package.json');
  await pace(DELAY);
  const src = path.join(s.cwd, 'src', name + '.js');
  const prev = read(src);
  const k = prev ? (prev.match(/^export function/gm) || []).length + 1 : 1;
  const body = `export function ${fn}${k > 1 ? k : ''}(input) {\n  if (input == null) return null;\n  return String(input).trim();\n}\n`;
  if (!(await write(sessionId, s, `src/${name}.js`, (prev ? prev + '\n' : '') + body, `Write src/${name}.js`))) return done();
  plan(sessionId, s, P('completed', 'in_progress', 'pending'));
  const testBody = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${fn}${k > 1 ? k : ''} } from '../src/${name}.js';\n\ntest('${fn} trims', () => {\n  assert.equal(${fn}${k > 1 ? k : ''}('  hi  '), 'hi');\n});\n`;
  const tf = path.join(s.cwd, 'test', name + '.test.js');
  if (!(await write(sessionId, s, `test/${name}.test.js`, (read(tf) ? read(tf) + '\n' : '') + testBody, `Write test/${name}.test.js`))) return done();
  plan(sessionId, s, P('completed', 'completed', 'in_progress'));
  if (s.cancelled) return done();
  const perm = await permission(sessionId, s, 'Run node --test', 'execute', 'node --test');
  if (!perm.ok) {
    record(sessionId, s, { sessionUpdate: 'tool_call_update', toolCallId: perm.id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Rejected by the user' } }] });
    plan(sessionId, s, P('completed', 'completed', 'pending'));
    await say(sessionId, s, 'Fine, I did not run the tests. The code and the test are written; run them when you want.');
    return done();
  }
  record(sessionId, s, { sessionUpdate: 'tool_call_update', toolCallId: perm.id, status: 'in_progress' });
  await pace(DELAY * 4);
  record(sessionId, s, { sessionUpdate: 'tool_call_update', toolCallId: perm.id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '✔ 1 test passed (12 ms)' } }] });
  plan(sessionId, s, P('completed', 'completed', 'completed'));
  await say(sessionId, s, `Done. ${name} is in src/${name}.js and its test passes. Want me to wire it into the rest of the code?`);
  return done();
}
