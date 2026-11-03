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
