#!/usr/bin/env node
// Spread as an MCP server (stdio, JSON-RPC 2.0, no dependencies). Every tool is a thin call to the HTTP API,
// so an agent in any MCP client sees exactly what the CLI and the browser see.
//   claude mcp add spread -- node /path/to/spread/bin/mcp.mjs        (CANVAS_URL defaults to http://127.0.0.1:3210)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStep, listSteps, STEPS } from '../lib/demo.js';

const BASE = (process.env.CANVAS_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
let cursor = null;   // the change feed position of this session

async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t}`);
  return t;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d }), num = (d) => ({ type: 'number', description: d }), bool = (d) => ({ type: 'boolean', description: d });

const TOOLS = [
  { name: 'spread_help', description: 'The agent guide for Spread (read once): tables, ops, SQL, Live, visuals, etiquette.', inputSchema: S({}),
    run: () => call('GET', '/api/help') },
  { name: 'spread_overview', description: 'Workbooks, sheets, used ranges, named tables (with columns), charts, traffic lights, the user\'s selection, who is here.', inputSchema: S({}),
    run: () => call('GET', '/api/overview') },
  { name: 'spread_changes', description: 'What changed since your last call (the user\'s and other agents\' edits; your own are filtered out). Moves are one line; "calc:" lists recalculated formulas.', inputSchema: S({ since: num('version to read from (default: where you left off)'), net: bool('net effect per cell instead of every edit') }),
    async run(a) {
      const since = a.since ?? cursor ?? 0;
      const t = await call('GET', '/api/changes?' + qs({ since, exclude: 'agent', mode: a.net ? 'net' : null }));
      const m = /cursor: (\d+)\s*$/.exec(t); if (m) cursor = +m[1];
      return t;
    } },
  { name: 'spread_read', description: 'Read cells or a table: "Sheet!A1:F20", "Sheet!" (used range) or "@Tasks" (records). Formulas show ⇒ value.', inputSchema: S({ range: str('A1 range, Sheet!, or @Table'), doc: str('workbook id (default: first)') }, ['range']),
    run: (a) => call('GET', '/api/read?' + qs({ range: a.range, doc: a.doc })) },
  { name: 'spread_ops', description: 'Apply an atomic batch of ops (set, move, insertRows, format, borders, merge, table, appendRows, updateRows, removeRows, addColumn, addChart, cond, liveLayout, panel, slide…). One batch = one version = one undo. "expect" makes it fail with 409 if those cells changed.', inputSchema: S({ ops: { type: 'array', items: { type: 'object' }, description: 'ops, e.g. [{"op":"set","cells":{"Budget!B2":"10"}}]' }, doc: str('workbook id'), expect: { type: 'object', description: '{"Sheet!A1": "expected raw value"}' } }, ['ops']),
    run: (a) => call('POST', '/api/ops?format=text', { doc: a.doc, by: 'agent', ops: a.ops, expect: a.expect }) },
  { name: 'spread_sql', description: 'SQL over named tables (SQLite). SELECT/JOIN; write=true turns UPDATE/INSERT/DELETE into table ops; into_name/into_at writes a result as a new named table.', inputSchema: S({ sql: str('the query'), write: bool('allow UPDATE/INSERT/DELETE (versioned, undoable)'), into_name: str('result → table name'), into_at: str('result → anchor, e.g. Dashboard!B30'), doc: str('workbook id') }, ['sql']),
    run: (a) => call('POST', '/api/sql', { doc: a.doc, sql: a.sql, write: !!a.write, into: a.into_name ? { name: a.into_name, at: a.into_at } : undefined, by: 'agent' }) },
  { name: 'spread_history', description: 'Who changed a cell (following it through moves and inserts) or a table, and what it was before.', inputSchema: S({ cell: str('e.g. Project!C8'), table: str('table name'), doc: str('workbook id') }),
    run: (a) => call('GET', '/api/history?' + qs({ cell: a.cell, table: a.table, doc: a.doc })) },
  { name: 'spread_live', description: 'What a Live screen shows right now: layout, focus/slide, every card with position and a one-line summary.', inputSchema: S({ screen: str('screen id (see spread_screens); default: the most recent') }),
    run: (a) => call('GET', '/api/live?' + qs({ screen: a.screen })) },
  { name: 'spread_screens', description: 'Open Live views (TVs, laptops, phones) and what each shows.', inputSchema: S({}),
    run: () => call('GET', '/api/screens') },
  { name: 'spread_present', description: 'Drive a Live screen: show a sheet or the combined layout, focus a card (chart:id, table:Name, stat:A1), play a slide, or remote actions next/prev/play/pause/toggle/unfocus. Use only when the user asks or expects it.', inputSchema: S({ sheet: str('sheet to show'), mode: { type: 'string', enum: ['sheet', 'auto'], description: 'auto = combined' }, focus: str('card to focus'), slide: num('slide number to play from'), action: { type: 'string', enum: ['next', 'prev', 'play', 'pause', 'toggle', 'unfocus'] }, theme: str('shader theme'), screen: str('target screen id'), off: bool('leave Live'), doc: str('workbook id') }),
    async run(a) { await call('POST', '/api/present', { ...a, by: 'agent' }); return 'ok — check with spread_live'; } },
  { name: 'spread_viz', description: 'SVG visual packs (spread-viz/1): list, read the spec, check or install a pack you wrote, remove one. Show a pack with =VIZ("id", A1) or an addChart {type:"viz", pack, value}.', inputSchema: S({ action: { type: 'string', enum: ['list', 'spec', 'check', 'install', 'remove'] }, pack: { type: 'object', description: 'the pack JSON (check / install)' }, id: str('pack id (remove)') }, ['action']),
    async run(a) {
      if (a.action === 'list') return call('GET', '/api/viz?format=text');
      if (a.action === 'spec') return call('GET', '/api/viz/spec');
      if (a.action === 'remove') { await call('DELETE', '/api/viz?' + qs({ id: a.id, by: 'agent' })); return 'removed ' + a.id; }
      const r = await fetch(BASE + '/api/viz' + (a.action === 'check' ? '?dry=1' : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: a.pack, by: 'agent' }) });
      const j = await r.json();
      return [r.ok ? (a.action === 'check' ? 'valid' : `installed ${j.id} (rev ${j.rev})`) : 'INVALID', ...(j.errors || []).map((e) => 'error: ' + e), ...(j.warnings || []).map((w) => 'warning: ' + w)].join('\n');
    } },
  { name: 'spread_demo', description: `The guided tour of Spread's features on a separate "demo" workbook (${STEPS.length} steps). list=true shows the steps; step=N runs one and returns what the user should look at. Run them in order, telling the user what to watch.`, inputSchema: S({ list: bool('list the steps'), step: num(`1–${STEPS.length}`), screen: str('Live screen to drive') }),
    async run(a) {
      if (a.list || !a.step) return `Open ${BASE}/#demo in a browser, then run steps 1–${STEPS.length} in order.\n\n` + listSteps();
      const s = STEPS[a.step - 1];
      if (!s) throw new Error(`step must be 1–${STEPS.length}`);
      const out = await runStep(BASE, a.step - 1, { screen: a.screen });
      return `${a.step}/${STEPS.length} ${s.title}\nshows: ${s.features.join(', ') || '—'}\ntell the user to look at: ${s.look.replaceAll('<BASE>', BASE)}${out ? '\n\n' + out : ''}`;
    } },
];

// ------------------------------------------------------------------ JSON-RPC over stdio
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
async function handle(m) {
  if (m.method === 'initialize') return { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spread', version: VERSION }, instructions: `Spread spreadsheet at ${BASE}. Start with spread_help (once) and spread_overview; before each reply, spread_changes.` };
  if (m.method === 'ping') return {};
  if (m.method === 'tools/list') return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  if (m.method === 'tools/call') {
    const t = TOOLS.find((x) => x.name === m.params?.name);
    if (!t) throw Object.assign(new Error(`Unknown tool ${m.params?.name}`), { code: -32602 });
    try { return { content: [{ type: 'text', text: String(await t.run(m.params.arguments || {})) }] }; }
    catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
  }
  throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (m.id === undefined) continue;   // notifications (initialized, cancelled…)
    handle(m).then((result) => send({ id: m.id, result }), (e) => send({ id: m.id, error: { code: e.code || -32603, message: e.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
