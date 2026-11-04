#!/usr/bin/env node
// cm — tiny CLI for agents. Text output, remembers a cursor so `cm changes` only shows what's new.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.CANVAS_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const CURSOR = process.env.CM_CURSOR || path.join(os.homedir(), '.spread-cursor');
const DOC = process.env.CM_DOC || '';
const BY = process.env.CM_BY || 'agent';

const [cmd, ...args] = process.argv.slice(2);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();

async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) { console.error(`HTTP ${r.status}: ${t}`); process.exit(1); }
  return t;
}
const readCursor = () => { try { return +fs.readFileSync(CURSOR, 'utf8').trim() || 0; } catch { return 0; } };
const writeCursor = (v) => fs.writeFileSync(CURSOR, String(v));
const out = (t) => process.stdout.write(t.endsWith('\n') ? t : t + '\n');

/** Parse "A1=val" pairs; values beginning with = are formulas. */
function pairs(list) {
  const cells = {};
  for (const a of list) {
    const i = a.indexOf('=');
    if (i <= 0) { console.error(`expected CELL=value, got "${a}"`); process.exit(2); }
    cells[a.slice(0, i)] = a.slice(i + 1);
  }
  return cells;
}
async function ops(list, extra = {}) {
  out(await call('POST', '/api/ops?format=text', { doc: DOC || undefined, by: BY, ops: list, ...extra }));
}

const help = `cm — Spread agent CLI   (CANVAS_URL=${BASE})
  cm overview                      docs, sheets, used ranges, user selection
  cm read [Sheet!A1:F20]           non-empty cells with formulas ⇒ values
  cm changes [--all] [--net]       what changed since your cursor (default: excludes your own edits)
  cm sel                           what the user has selected right now
  cm set A1=10 B1==A1*2 'Data!C3=hello'
  cm table B2 '[["a",1],["b",2]]'  write a 2D block anchored at B2
  cm move C23:D32 F23              cut/paste, references follow
  cm insert-rows 5 [n] | delete-rows 5 [n] | insert-cols C [n] | delete-cols C [n]   (add --sheet=Name)
  cm fmt A1:E1 '{"b":true,"fill":"#fff2cc"}'
  cm border A1:C3 outer [thick] ['#d93025']   all|inner|horizontal|vertical|outer|left|top|right|bottom|clear
  cm merge A1:C1 [all|horizontal|vertical] | cm unmerge A1:C1
  cm traffic B7:B10 '<100:green' 'between 100 200:amber' '>200:red'   (traffic lights; ':#hex' for any fill; 'off' removes)
  cm note B2 "text"
  cm add-sheet Name | rename-sheet Old New
  cm read @Tasks                    a named table as records:  [7] Task: Wire the servos · Status: open
  cm mktable Tasks B6:E10           name a region (header row first) as a table
  cm add Tasks '{"Task":"Test battery","Status":"open"}' ['{...}']   append records
  cm update Tasks 'Wire the servos' Status=done Owner=Alex     key = first-column value (or 'Status=open' to match)
  cm rm Tasks 'Name the robot' | cm rm Tasks 'Status=done'
  cm addcol Tasks Priority
  cm sql "SELECT t.Task, p.Price FROM Tasks t JOIN Parts p ON …"   (other workbooks: "doc.Table")
  cm sql --write "UPDATE Tasks SET Status='done' WHERE Owner='Alex'"   written back as table ops
  cm sql --into Summary@Project!K2 "SELECT Status, COUNT(*) n FROM Tasks GROUP BY Status"
  cm json Tasks                    table as JSON array
  cm put Tasks file.json [Sheet!B2]      replace/create table from JSON array (- = stdin)
  cm chart column B6:C10 --at K2 --title "Prices"      types: column bar line area pie kpi
  cm chart pie @Parts --x Part --y Price  |  cm chart kpi C12 --title "Open tasks" [--value2 C13 --label2 "cost"] [--size small]
  cm chart-show chart1             the chart's live data as text
  cm chart-set chart1 type=line title="Uusi"  |  cm chart-rm chart1
  cm image B2 photo.png            upload + =IMAGE("/assets/…") in the cell
  cm export Dashboard [md|html]    sheet as a document (headings, tables, charts, KPIs)
  cm present Dashboard [chart:status|Tasks|C12] [--combined]   put the user's screen into Live / Focus mode
  cm present off
  cm viz ls | spec | check pack.json | add pack.json | rm ID       SVG visual packs (spread-viz/1, see cm viz spec)
  cm viz card battery Project!C12 --at K2   a visual card · in a cell: =VIZ("status", B7)
  cm demo [--auto 7] [--step N] [--from N] [--list] [--screen tv]   guided tour of every feature (on a "demo" workbook)
  cm style cards glass|outline|clear · cm style lines rows|grid|none     Live look for the whole workbook
  cm style chart:status card=clear · cm style Tasks lines=grid · cm style Tasks reset   per card (keys from cm live)
  cm map add Places [--lat Lat --lon Lon --label Name --color Status --pack status --value Status --route] [--at K2 --title …]
  cm map [ID] fly 60.17 24.94 [--zoom 13 --pitch 45] | fly "Kamppi" | fly fit | follow Robot1|off | focus Kamppi|off
  cm map [ID] layer Parts [--route] | layer Parts off|on|rm | basemap dark|light|bright|satellite|aerial|topo|fi|none | trail off   ·  cm map (list)
  cm replay --from 09:00 [--to 12:00] [--speed 360] [--loop] [--no-gaps] [--screen tv]   play back what changed, with a clock
  cm replay ls --from -2h          what a replay would show ·  cm replay pause|play|next|prev|stop   (from: 14:30, -2h, v120, m3, ISO)
  cm feed kinds | add trains --map [--every 30 --bbox 24,60,25.5,60.5] | ls | run|pause|resume|rm ID   Finnish open data → tables
  cm config [nls-key KEY]          server settings (a free NLS key enables the Finnish aerial / topo maps)
  cm screens                       open Live views (TV, laptop…) — target one with --screen id
  cm present next|prev|play|pause|unfocus [--screen tv]   remote control: slides, or a carousel of cards
  cm history Sheet!A1 | cm history @Tasks          who changed what, following moves
  cm people                        who else is here (and where / in Live)
  cm slides                        list slides  ·  cm present --slide 1  (play from slide 1)
  cm slide add id '{"title":"Q3","text":"…","sheet":"Dashboard","mode":"auto","focus":"status","bg":{"image":"/assets/x.gif","filter":"dither"},"duration":8}'
  cm slide rm id
  cm live                          what the user's Live screen shows right now (cards, positions, what's visible)
  cm panel add id "Title" "text with **bold** and - bullets" [--value 42 --label EUR --image url --span 2]
  cm panel rm id
  cm slot logo [--span 1 --h 200 --image /assets/logo.png]   reserve empty space (e.g. for a logo); drag it anywhere
  cm layout '{"flow":"horizontal","reveal":true,"order":["Dashboard::chart:status", …]}'
  cm find text
  cm commit "message" | cm commits | cm diff [m3|last] | cm restore m3
  cm focus A1:B5 "label"           highlight where you're working
  cm ops '<json array of ops>'     raw batch
  cm cursor [N]                    show / set cursor
Env: CM_DOC (default first doc), CM_BY (default agent), CM_CURSOR`;

const sheetFlag = () => { const i = args.findIndex((a) => a.startsWith('--sheet=')); if (i < 0) return undefined; const v = args[i].slice(8); args.splice(i, 1); return v; };

switch (cmd) {
  case 'overview': out(await call('GET', '/api/overview')); break;
  case 'read': out(await call('GET', '/api/read?' + qs({ doc: DOC, range: args[0] }))); break;
  case 'sel': case 'selection': out(await call('GET', '/api/selection')); break;
  case 'changes': {
    const all = args.includes('--all'), net = args.includes('--net');
    const since = readCursor();
    const t = await call('GET', '/api/changes?' + qs({ since, doc: DOC, exclude: all ? '' : BY, mode: net ? 'net' : '' }));
    out(t);
    const m = /cursor: (\d+)\s*$/.exec(t);
    // advance to latest version even when our own edits were filtered out
    const v = JSON.parse(await call('GET', '/api/workspace')).version;
    writeCursor(Math.max(m ? +m[1] : since, v));
    break;
  }
  case 'cursor': if (args[0]) writeCursor(+args[0]); out(String(readCursor())); break;
  case 'set': await ops([{ op: 'set', cells: pairs(args) }]); break;
  case 'table': await ops([{ op: 'set', range: args[0], values: JSON.parse(args[1]) }]); break;
  case 'move': await ops([{ op: 'move', from: args[0], to: args[1] }]); break;
  case 'insert-rows': case 'delete-rows': case 'insert-cols': case 'delete-cols': {
    const sheet = sheetFlag();
    const op = { 'insert-rows': 'insertRows', 'delete-rows': 'deleteRows', 'insert-cols': 'insertCols', 'delete-cols': 'deleteCols' }[cmd];
    await ops([{ op, sheet, at: /^\d+$/.test(args[0]) ? +args[0] : args[0], count: +(args[1] || 1) }]);
    break;
  }
  case 'fmt': case 'format': await ops([{ op: 'format', range: args[0], style: JSON.parse(args[1]) }]); break;
  case 'border': case 'borders': await ops([{ op: 'borders', range: args[0], type: args[1] || 'all', style: args[2], color: args[3] }]); break;
  case 'merge': await ops([{ op: 'merge', range: args[0], type: args[1] || 'all' }]); break;
  case 'unmerge': await ops([{ op: 'unmerge', range: args[0] }]); break;
  case 'traffic': {
    // cm traffic B7:B10 '<100:green' 'between 100 200:amber' '>200:red'   ·   cm traffic B7:B10 off   ·   --id c1 to replace
    const { parseRule } = await import('../public/shared/cond.js');
    const ii = args.indexOf('--id'); const id = ii >= 0 ? args.splice(ii, 2)[1] : undefined;
    const [range, ...rs] = args;
    if (rs[0] === 'off') { await ops([{ op: 'removeCond', range }]); break; }
    let rules;
    try { rules = rs.map(parseRule); } catch (e) { console.error(e.message); process.exit(1); }
    await ops([{ op: 'cond', range, rules, ...(id ? { id } : {}) }]);
    break;
  }
  case 'note': await ops([{ op: 'note', cell: args[0], text: args.slice(1).join(' ') || null }]); break;
  case 'add-sheet': await ops([{ op: 'addSheet', name: args[0] }]); break;
  case 'rename-sheet': await ops([{ op: 'renameSheet', sheet: args[0], name: args[1] }]); break;
  case 'mktable': await ops([{ op: 'table', name: args[0], range: args[1] }]); break;
  case 'add': await ops([{ op: 'appendRows', table: args[0], rows: args.slice(1).map((a) => JSON.parse(a)) }]); break;
  case 'update': case 'rm': {
    const sel = args[1].includes('=') ? { match: pairs([args[1]]) } : { key: args[1] };
    if (cmd === 'update') await ops([{ op: 'updateRows', table: args[0], ...sel, set: pairs(args.slice(2)) }]);
    else await ops([{ op: 'removeRows', table: args[0], ...sel }]);
    break;
  }
  case 'addcol': await ops([{ op: 'addColumn', table: args[0], name: args[1] }]); break;
  case 'sql': {
    const write = args.includes('--write');
    const ii = args.indexOf('--into');
    let into;
    if (ii >= 0) { const [name, at] = args[ii + 1].split('@'); into = { name, at }; args.splice(ii, 2); }
    const sql = args.filter((a) => a !== '--write').join(' ');
    out(await call('POST', '/api/sql', { doc: DOC || undefined, sql, write, into, by: BY }));
    break;
  }
  case 'json': out(await call('GET', '/api/table?' + qs({ doc: DOC, name: args[0] }))); break;
  case 'put': {
    const src = args[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args[1], 'utf8');
    out(await call('PUT', '/api/table', { doc: DOC || undefined, name: args[0], rows: JSON.parse(src), at: args[2], by: BY }));
    break;
  }
  case 'chart': {
    const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
    const at = flag('at'), title = flag('title'), x = flag('x'), y = flag('y'), label = flag('label'), sheet = flag('sheet'), value2 = flag('value2'), label2 = flag('label2'), size = flag('size');
    const [type, src] = args;
    const o = { op: 'addChart', type, at, title, sheet, label, value2, label2 };
    if (type === 'kpi') o.value = src; else if (src.startsWith('@')) { o.table = src.slice(1); o.x = x; o.y = y ? y.split(',') : undefined; } else o.range = src;
    if (size !== 'small') { await ops([o]); break; }
    // --size small: a square tile in Live's combined layout
    const r = JSON.parse(await call('POST', '/api/ops', { doc: DOC || undefined, by: BY, ops: [o] }));
    const ch = r.changes.find((c) => c.k === 'chart');
    const spans = JSON.parse(await call('GET', '/api/doc?id=' + (DOC || 'main'))).doc.live?.spans || {};
    await ops([{ op: 'liveLayout', spans: { ...spans, [`${ch.sheet}::chart:${ch.id}`]: { span: 0.5 } } }]);
    break;
  }
  case 'chart-show': out(await call('GET', '/api/chart?' + qs({ doc: DOC, id: args[0] }))); break;
  case 'chart-rm': await ops([{ op: 'deleteChart', id: args[0] }]); break;
  case 'chart-set': await ops([{ op: 'updateChart', id: args[0], ...Object.fromEntries(args.slice(1).map((a) => { const i = a.indexOf('='); const k = a.slice(0, i), v = a.slice(i + 1); return [k, ['w', 'h', 'dx', 'dy'].includes(k) ? +v : v]; })) }]); break;
  case 'image': {
    const file = args[1];
    const ext = path.extname(file).slice(1).toLowerCase();
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
    const r = await fetch(BASE + '/api/assets', { method: 'POST', headers: { 'content-type': type }, body: fs.readFileSync(file) });
    const { url } = await r.json();
    const m = /(\d+)$/.exec(args[0]);
    await ops([{ op: 'set', cells: { [args[0]]: `=IMAGE("${url}")` } }, ...(m ? [{ op: 'resize', sheet: args[0].includes('!') ? args[0].split('!')[0].replace(/^'|'$/g, '') : undefined, rows: { [m[1]]: 120 } }] : [])]);
    break;
  }
  case 'export': out(await call('GET', '/api/export?' + qs({ doc: DOC, sheet: args[0], format: args[1] || 'md' }))); break;
  case 'live': out(await call('GET', '/api/live')); break;
  case 'history': out(await call('GET', '/api/history?' + qs(args[0].startsWith('@') ? { doc: DOC, table: args[0].slice(1) } : { doc: DOC, cell: args[0] }))); break;
  case 'people': out(await call('GET', '/api/presence')); break;
  case 'slides': {
    const d = JSON.parse(await call('GET', '/api/doc?id=' + (DOC || 'main'))).doc;
    const sl = d.live?.slides || [];
    out(sl.length ? sl.map((x, i) => `${i + 1}. ${x.id}  "${x.title || ''}"  ${x.sheet || ''} ${x.mode || ''}${x.focus ? ' focus ' + x.focus : ''}${x.bg?.image ? ' bg ' + x.bg.image + (x.bg.filter ? ' ' + x.bg.filter : '') : ''}${x.duration ? ' ' + x.duration + 's' : ''}`).join('\n') : 'no slides');
    break;
  }
  case 'slide': {
    if (args[0] === 'rm') { await ops([{ op: 'removeSlide', id: args[1] }]); break; }
    await ops([{ op: 'slide', id: args[1], ...(args[2] ? JSON.parse(args[2]) : {}) }]);
    break;
  }
  case 'panel': case 'slot': case 'layout': {
    const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
    if (cmd === 'layout') { await ops([{ op: 'liveLayout', ...JSON.parse(args[0]) }]); break; }
    if (cmd === 'panel' && args[0] === 'rm') { await ops([{ op: 'removePanel', id: args[1] }]); break; }
    const value = flag('value'), label = flag('label'), image = flag('image'), span = flag('span'), h = flag('h');
    if (cmd === 'panel') {
      const [, id, title, text] = args;
      await ops([{ op: 'panel', id, title, text, value, label, image, span: span ? +span : undefined, h: h ? +h : undefined, by: BY }]);
    } else {
      const ov = JSON.parse(await call('GET', '/api/doc?id=' + (DOC || 'main'))).doc.live || {};
      const slots = (ov.slots || []).filter((x) => x.id !== args[0]);
      if (args[1] !== 'rm') slots.push({ id: args[0], span: span ? +span : 1, h: h ? +h : 180, ...(image ? { image } : {}) });
      await ops([{ op: 'liveLayout', slots }]);
    }
    break;
  }
  case 'viz': {
    // SVG visual packs (spread-viz/1)
    const sub = args[0];
    if (sub === 'ls' || !sub) { out(await call('GET', '/api/viz?format=text')); break; }
    if (sub === 'spec') { out(await call('GET', '/api/viz/spec')); break; }
    if (sub === 'show') { out(await call('GET', '/api/viz?' + qs({ id: args[1] }))); break; }
    if (sub === 'rm') { await call('DELETE', '/api/viz?' + qs({ id: args[1], by: BY })); out('ok'); break; }
    if (sub === 'add' || sub === 'check') {
      const pack = JSON.parse(args[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args[1], 'utf8'));
      const r = await fetch(BASE + '/api/viz' + (sub === 'check' ? '?dry=1' : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack, by: BY }) });
      const j = await r.json();
      const lines = [r.ok ? (sub === 'check' ? `valid: ${pack.id}` : `${j.replaced ? 'updated' : 'installed'} ${j.id} (rev ${j.rev})`) : `INVALID ${pack.id ?? ''}`];
      for (const e of j.errors || []) lines.push('  error: ' + e);
      for (const w of j.warnings || []) lines.push('  warning: ' + w);
      out(lines.join('\n'));
      if (!r.ok) process.exit(1);
      break;
    }
    if (sub === 'card') {
      // cm viz card battery Project!C12 --at K2 [--title "…"] [--size small]
      const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
      const at = flag('at'), title = flag('title'), sheet = flag('sheet'), size = flag('size');
      const r = JSON.parse(await call('POST', '/api/ops', { doc: DOC || undefined, by: BY, ops: [{ op: 'addChart', type: 'viz', pack: args[1], value: args[2], at, title, sheet }] }));
      const ch = r.changes.find((c) => c.k === 'chart');
      out(`ok v${r.version}  chart ${ch.id} (viz ${args[1]} ← ${args[2]})`);
      if (size === 'small') {
        const spans = JSON.parse(await call('GET', '/api/doc?id=' + (DOC || 'main'))).doc.live?.spans || {};
        await ops([{ op: 'liveLayout', spans: { ...spans, [`${ch.sheet}::chart:${ch.id}`]: { span: 0.5 } } }]);
      }
      break;
    }
    out('cm viz ls | spec | show ID | check FILE | add FILE | rm ID | card PACK CELL [--at K2 --title … --size small]   (FILE "-" = stdin)');
    break;
  }
  case 'demo': {
    // the guided tour: every feature, driven over the API on a separate "demo" workbook
    const { STEPS, runStep, listSteps } = await import('../lib/demo.js');
    const flag = (n, dflt) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; const has = v && !v.startsWith('--'); args.splice(i, has ? 2 : 1); return has ? v : dflt; };
    const auto = flag('auto', '7'), step = flag('step'), from = flag('from'), screen = flag('screen');
    if (args.includes('--list')) { out(listSteps()); break; }
    const show = async (i) => {
      const s = STEPS[i];
      console.log(`\n\x1b[1m${i + 1}/${STEPS.length}  ${s.title}\x1b[0m`);
      if (s.features.length) console.log(`  shows: ${s.features.join(' · ')}`);
      console.log(`  look:  ${s.look.replaceAll('<BASE>', BASE)}`);
      try { const t = await runStep(BASE, i, { screen }); if (t) console.log(t.split('\n').map((l) => '  │ ' + l).join('\n')); } catch (e) { console.log('  ✗ ' + e.message); }
    };
    if (step) { await show(+step - 1); break; }
    let i = from ? +from - 1 : 0;
    console.log(`Spread tour — ${STEPS.length} steps on the "demo" workbook. Open ${BASE}/#demo in a browser.${auto ? '' : '\nEnter = next · b = back · r = repeat · q = quit'}`);
    if (auto) { for (; i < STEPS.length; i++) { await show(i); await new Promise((r) => setTimeout(r, +auto * 1000)); } break; }
    const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => new Promise((r) => rl.question('\n› ', r));
    await show(i);
    for (;;) {
      const a = (await ask()).trim().toLowerCase();
      if (a === 'q') break;
      if (a === 'r') { await show(i); continue; }
      if (a === 'b') { i = Math.max(0, i - 1); await show(i); continue; }
      if (/^\d+$/.test(a)) { i = Math.min(STEPS.length - 1, +a - 1); await show(i); continue; }
      if (i >= STEPS.length - 1) break;
      await show(++i);
    }
    rl.close();
    break;
  }
  case 'map': {
    // maps: points from named tables, the camera steered by the agent
    const doc = JSON.parse(await call('GET', '/api/doc?id=' + (DOC || 'main'))).doc;
    const all = doc.sheets.flatMap((sh) => (sh.charts || []).filter((c) => c.type === 'map').map((c) => ({ sh: sh.name, ch: c })));
    const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; const has = v !== undefined && !v.startsWith('--'); args.splice(i, has ? 2 : 1); return has ? v : true; };
    const layerFlags = () => { const L = {}; for (const k of ['lat', 'lon', 'label', 'color', 'pack', 'value', 'name']) { const v = flag(k); if (v !== undefined) L[k] = v; } if (flag('route')) L.route = true; return L; };
    let sub = args[0];
    if (!sub || sub === 'ls') { if (!all.length) { out('no maps — cm map add Places [--route]'); break; } for (const m of all) out(await call('GET', '/api/chart?' + qs({ doc: DOC, id: m.ch.id }))); break; }
    if (sub === 'add') {
      const table = args[1];
      const t = doc.sheets.flatMap((sh) => (sh.tables || []).map((x) => ({ sh: sh.name, t: x }))).find((x) => x.t.name.toLowerCase() === String(table).toLowerCase());
      const o = { id: flag('id'), at: flag('at'), title: flag('title'), basemap: flag('basemap'), sheet: flag('sheet') || t?.sh };
      const r = JSON.parse(await call('POST', '/api/ops', { doc: DOC || undefined, by: BY, ops: [{ op: 'addChart', type: 'map', layers: [{ table, ...layerFlags() }], ...o }] }));
      const ch = r.changes.find((c) => c.k === 'chart');
      out(`ok v${r.version}  map ${ch.id} ← @${table}   (cm map ${ch.id} fly … | follow … | layer …)`);
      break;
    }
    let m = all.find((x) => x.ch.id === sub);
    if (m) { args.shift(); sub = args[0]; } else if (all.length === 1) m = all[0];
    else { console.error(all.length ? `which map? ${all.map((x) => x.ch.id).join(', ')} — cm map ID ${sub} …` : 'no maps — cm map add Places'); process.exit(2); }
    const id = m.ch.id, upd = (o) => ops([{ op: 'updateChart', id, ...o }]);
    const off = (v) => ['off', 'none', 'stop', 'clear', '-'].includes(String(v).toLowerCase());
    const rest = args.slice(1);
    switch (sub) {
      case 'fly': case 'view': {
        if (rest[0] === 'fit' || !rest.length) { await upd({ view: null, follow: null }); break; }
        const zoom = flag('zoom'), pitch = flag('pitch'), bearing = flag('bearing');
        const r2 = args.slice(1);
        const v = {};
        if (r2.length >= 2 && !isNaN(+r2[0]) && !isNaN(+r2[1])) { v.lat = +r2[0]; v.lon = +r2[1]; } else if (r2.length && /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(r2[0])) { [v.lat, v.lon] = r2[0].split(',').map(Number); } else if (r2.length) v.to = r2.join(' ');
        if (zoom !== undefined) v.zoom = +zoom; if (pitch !== undefined) v.pitch = +pitch; if (bearing !== undefined) v.bearing = +bearing;
        await upd({ view: v, follow: null });
        break;
      }
      case 'zoom': await upd({ view: { ...(m.ch.view || {}), zoom: +rest[0] } }); break;
      case 'follow': await upd(off(rest[0]) ? { follow: null } : { follow: rest.join(' '), view: null }); break;
      case 'focus': await upd({ focus: off(rest[0]) ? null : rest.join(' ') }); break;
      case 'basemap': await upd({ basemap: rest[0] === 'dark' ? null : rest[0] }); break;
      case 'trail': await upd({ trail: off(rest[0]) ? false : null }); break;
      case 'layer': case 'route': {
        const name = rest[0], state = rest[1];
        const layers = m.ch.layers.map((L) => ({ ...L }));
        const i = layers.findIndex((L) => (L.name || L.table).toLowerCase() === String(name).toLowerCase());
        if (sub === 'route') { if (i < 0) { console.error('no layer ' + name); process.exit(2); } layers[i].route = !off(state); if (!layers[i].route) delete layers[i].route; }
        else if (state === 'rm' || state === 'remove') { if (i < 0) { console.error('no layer ' + name); process.exit(2); } layers.splice(i, 1); }
        else if (state === 'off' || state === 'hide') layers[i].hidden = true;
        else if (state === 'on' || state === 'show') delete layers[i].hidden;
        else { const L = { table: name, ...layerFlags() }; if (i >= 0) layers[i] = { ...layers[i], ...L }; else layers.push(L); }
        await upd({ layers });
        break;
      }
      case 'rm': await ops([{ op: 'deleteChart', id }]); break;
      default: console.error('cm map [ID] fly LAT LON|LABEL|fit [--zoom 12 --pitch 45 --bearing 0] · zoom Z · follow LABEL|off · focus LABEL|off · layer TABLE [on|off|rm|--route --color Col …] · route TABLE on|off · basemap dark|light|bright|satellite|aerial|topo|fi|none · trail on|off · rm'); process.exit(2);
    }
    break;
  }
  case 'replay': {
    // time replay on a Live screen: cm replay --from 09:00 [--to 12:00] [--speed 360] · cm replay stop|pause|play|next|prev · cm replay ls --from -2h
    const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; const has = v !== undefined && !v.startsWith('--'); args.splice(i, has ? 2 : 1); return has ? v : true; };
    const when = (t) => { const m = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(String(t)); if (!m) return t; const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); return +d; };   // your clock, not the server's
    const from = flag('from'), to = flag('to'), speed = flag('speed'), screen = flag('screen'), sheet = flag('sheet');
    const gaps = !flag('no-gaps'), loop = !!flag('loop'), combined = !!flag('combined');
    const sub = args[0];
    if (sub === 'ls' || sub === 'list') { out(await call('GET', '/api/replay?' + qs({ doc: DOC, from: when(from ?? '-1h'), to: to && when(to) }))); break; }
    if (sub === 'stop' || sub === 'off') { await call('POST', '/api/present', { doc: DOC || undefined, replay: 'stop', screen, by: BY }); out('ok'); break; }
    if (['pause', 'play', 'toggle', 'next', 'prev'].includes(sub)) { await call('POST', '/api/present', { doc: DOC || undefined, action: sub, screen, by: BY }); out('ok'); break; }
    await call('POST', '/api/present', { doc: DOC || undefined, sheet, mode: combined ? 'auto' : undefined, screen, by: BY, replay: { from: when(from ?? sub ?? '-1h'), to: to && when(to), speed: speed ? +speed : undefined, gaps, loop } });
    out('ok — replaying on the Live screen (cm live shows where it is; cm replay stop)');
    break;
  }
  case 'feed': case 'feeds': {
    // open data → tables: cm feed kinds · cm feed add trains [--map --every 30 --bbox 24,60,25.5,60.5 --places Helsinki,Oulu --limit 100 --sheet S --at A1 --keep] · cm feed run|pause|resume|rm ID
    const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; const has = v !== undefined && !v.startsWith('--'); args.splice(i, has ? 2 : 1); return has ? v : true; };
    const sub = args[0];
    if (!sub || sub === 'ls') { out(await call('GET', '/api/feeds')); break; }
    if (sub === 'kinds') { out(await call('GET', '/api/feeds?kinds')); break; }
    if (sub === 'add') {
      const o = { kind: args[1], id: flag('id'), every: flag('every'), table: flag('table'), sheet: flag('sheet'), at: flag('at'), limit: flag('limit'), map: !!flag('map'), keep: !!flag('keep'), doc: DOC || undefined };
      const bb = flag('bbox'), pl = flag('places');
      if (bb) o.bbox = String(bb).split(',').map(Number);
      if (pl) o.places = String(pl).split(',').map((x) => x.trim());
      const r = JSON.parse(await call('POST', '/api/feeds', o));
      const s2 = r.status;
      out(s2.ok ? `ok — feed ${r.id}: ${s2.rows} rows into ${r.table}${s2.created ? ' (new table' + (r.map ? ' + map' : '') + ')' : ''}, every ${r.every}s` : `feed ${r.id} added, but the first poll failed: ${s2.error}`);
      break;
    }
    if (sub === 'run') { const r = JSON.parse(await call('POST', '/api/feeds/run', { id: args[1] })); out(r.status.ok ? `ok — ${r.status.rows} rows (+${r.status.added} ~${r.status.updated} -${r.status.removed})` : 'ERROR ' + r.status.error); break; }
    if (sub === 'pause' || sub === 'resume') { await call('POST', '/api/feeds/set', { id: args[1], on: sub === 'resume' }); out('ok'); break; }
    if (sub === 'rm') { await call('DELETE', '/api/feeds?' + qs({ id: args[1] })); out('ok (the table stays)'); break; }
    out('cm feed [ls] | kinds | add KIND [--map …] | run ID | pause ID | resume ID | rm ID');
    break;
  }
  case 'config': {
    // server settings: cm config · cm config nls-key KEY (Finnish aerial / topo maps) · cm config nls-key off
    if (args[0] === 'nls-key') { await call('POST', '/api/config', { nlsKey: args[1] === 'off' ? null : args[1] }); out('ok'); break; }
    out(await call('GET', '/api/config'));
    break;
  }
  case 'style': {
    // Live look: cm style cards glass|outline|clear · cm style lines rows|grid|none · cm style chart:status card=clear [lines=none] · cm style Tasks reset
    const [what, ...rest] = args;
    if (what === 'cards' || what === 'lines') { await ops([{ op: 'liveLayout', [what]: rest[0] === 'glass' || rest[0] === 'rows' || rest[0] === 'reset' ? null : rest[0] }]); break; }
    if (!what) { const L = JSON.parse(await call('GET', '/api/doc?id=' + (DOC || 'main'))).doc.live || {}; out(`cards: ${L.cards || 'glass'} · lines: ${L.lines || 'rows'}\n` + Object.entries(L.styles || {}).map(([k, v]) => `  ${k}: ${Object.entries(v).map(([a, b]) => a + '=' + b).join(' ')}`).join('\n')); break; }
    const styles = JSON.parse(await call('GET', '/api/doc?id=' + (DOC || 'main'))).doc.live?.styles || {};
    if (rest[0] === 'reset') delete styles[what];
    else styles[what] = { ...(styles[what] || {}), ...Object.fromEntries(rest.map((x) => x.split('='))) };
    await ops([{ op: 'liveLayout', styles: Object.keys(styles).length ? styles : null }]);
    break;
  }
  case 'screens': out(await call('GET', '/api/screens')); break;
  case 'present': {
    const si2 = args.indexOf('--screen'); const screen = si2 >= 0 ? args.splice(si2, 2)[1] : undefined;
    const act = ['next', 'prev', 'play', 'pause', 'toggle', 'unfocus'].find((a) => args[0] === a || args[0] === '--' + a);
    if (act) { await call('POST', '/api/present', { action: act, screen, doc: DOC || undefined, by: BY }); out('ok'); break; }
    if (args[0] === 'off') { await call('POST', '/api/present', { off: true, screen, doc: DOC || undefined }); out('ok'); break; }
    const si = args.indexOf('--slide');
    if (si >= 0) { await call('POST', '/api/present', { doc: DOC || undefined, slide: +args[si + 1] || 1, screen, by: BY }); out('ok'); break; }
    const combined = args.includes('--combined');
    const [sheet, focus] = args.filter((a) => a !== '--combined');
    await call('POST', '/api/present', { doc: DOC || undefined, sheet, focus, mode: combined ? 'auto' : undefined, screen, by: BY });
    out('ok');
    break;
  }
  case 'find': out(await call('GET', '/api/find?' + qs({ doc: DOC, q: args.join(' ') }))); break;
  case 'commit': out(await call('POST', '/api/commit', { message: args.join(' '), by: BY })); break;
  case 'commits': out(await call('GET', '/api/commits')); break;
  case 'diff': out(await call('GET', '/api/diff?' + qs({ from: args[0] || 'last', doc: DOC }))); break;
  case 'restore': out(await call('POST', '/api/restore', { commit: args[0], doc: DOC || undefined, by: BY })); break;
  case 'focus': await call('POST', '/api/focus', { doc: DOC || undefined, range: args[0], label: args.slice(1).join(' '), by: BY }); out('ok'); break;
  case 'ops': await ops(JSON.parse(args[0])); break;
  default: out(help);
}
