// Canvas Mini server. Zero dependencies: node:http + static files + REST + SSE.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, httpErr } from './lib/store.js';
import { TYPES } from './public/shared/types/index.js';
import { splitSheet } from './public/shared/a1.js';
import { exportSheet } from './public/shared/export.js';
import { runSql, tableJson, jsonToOps, formatResult } from './lib/sql.js';
import { formatEntries, netChanges, formatRead, formatDiff, formatChangeList, formatHistory } from './lib/format.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = +(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.resolve(process.env.CANVAS_DATA || path.join(ROOT, 'data'));

export function createServer(store) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

  const send = (res, status, body, type) => {
    if (typeof body !== 'string') { body = JSON.stringify(body); type ||= 'application/json; charset=utf-8'; }
    res.writeHead(status, { 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(body);
  };
  const body = (req) => new Promise((ok, bad) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 50e6) { bad(httpErr(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(httpErr(400, 'Invalid JSON')); } });
  });
  const wantText = (u) => (u.searchParams.get('format') || 'text') === 'text';

  const routes = {
    'GET /api/help': (req, res) => send(res, 200, fs.readFileSync(path.join(ROOT, 'AGENT_SKILL.md'), 'utf8'), MIME['.md']),

    'GET /api/workspace': (req, res) => send(res, 200, {
      version: store.state.version, docs: store.docList(), commits: store.commits.slice(-50), selection: store.selection,
    }),

    'GET /api/overview': (req, res, u) => {
      const s = store.state;
      const lines = [`Spread v${s.version}${store.commits.length ? ` · last milestone ${store.commits.at(-1).id} "${store.commits.at(-1).message}" (v${store.commits.at(-1).version})` : ''}`];
      for (const id of s.order) {
        const d = s.docs[id];
        const info = TYPES[d.type].describe(d);
        lines.push(`[${id}] ${d.type} "${d.title}"`);
        if (Array.isArray(info)) for (const sh of info) {
          lines.push(`  ${sh.name}: used ${sh.used ?? '-'} · ${sh.cells} cells · ${sh.formulas} formulas${sh.freeze.rows || sh.freeze.cols ? ` · frozen ${sh.freeze.rows}r/${sh.freeze.cols}c` : ''}`);
          if (sh.merges.length) lines.push(`    merged: ${sh.merges.slice(0, 20).join(', ')}${sh.merges.length > 20 ? ' …' : ''}`);
          for (const c of sh.charts) lines.push(`    chart ${c.id} ${c.type}${c.title ? ` "${c.title}"` : ''} ← ${c.source} @${c.at}`);
          for (const t of sh.tables) lines.push(`    table ${t.name} ${t.range} · ${t.rows} rows · [${t.columns.join(' | ')}]`);
        }
        else lines.push(`  ${info.lines} lines`);
      }
      const ppl = store.people();
      if (ppl.length) lines.push(`people here: ${ppl.map((p) => `${p.name} (${p.live ? 'Live ' + (p.live.mode === 'auto' ? 'combined' : p.live.sheet) : `${p.sheet ?? ''}${p.active ? '!' + p.active : ''}`})`).join(', ')}`);
      if (store.selection) lines.push(`user selection: [${store.selection.doc}] ${store.selection.sheet}!${store.selection.ranges.join(',')} (active ${store.selection.active})`);
      wantText(u) ? send(res, 200, lines.join('\n')) : send(res, 200, { version: s.version, docs: s.order.map((id) => ({ id, type: s.docs[id].type, title: s.docs[id].title, info: TYPES[s.docs[id].type].describe(s.docs[id]) })), selection: store.selection });
    },

    'GET /api/doc': (req, res, u) => send(res, 200, { version: store.state.version, doc: store.doc(u.searchParams.get('id')) }),

    'POST /api/docs': async (req, res) => { const b = await body(req); const e = store.createDoc({ type: b.type || 'sheet', title: b.title, id: b.id, by: b.by || 'agent' }); send(res, 200, { version: e.v, id: e.doc }); },
    'DELETE /api/docs': (req, res, u) => { const e = store.deleteDoc(u.searchParams.get('id'), u.searchParams.get('by') || 'user'); send(res, 200, { version: e.v }); },
    'PATCH /api/docs': async (req, res, u) => { const b = await body(req); const e = store.renameDoc(u.searchParams.get('id') || b.id, b.title, b.by || 'user'); send(res, 200, { version: e.v }); },

    'POST /api/ops': async (req, res, u) => {
      const b = await body(req);
      const e = store.batch({ doc: b.doc, by: b.by || 'agent', clientId: b.clientId, ops: b.ops || (b.op ? [b] : null), expect: b.expect, label: b.label, who: b.who, color: b.color });
      if (u.searchParams.get('format') === 'text') return send(res, 200, [`ok v${e.v}`, ...formatChangeList(e.changes, e.recalc)].join('\n'));
      send(res, 200, { version: e.v, changes: e.changes, recalc: e.recalc, inverse: b.wantInverse ? e.inverse : undefined });
    },

    'GET /api/changes': (req, res, u) => {
      const p = u.searchParams;
      const r = store.changes({ since: +(p.get('since') || 0), doc: p.get('doc'), exclude: p.get('exclude'), by: p.get('by'), limit: +(p.get('limit') || 200) });
      if (p.get('mode') === 'net') return send(res, 200, netChanges(r));
      wantText(u) ? send(res, 200, formatEntries(r)) : send(res, 200, r);
    },

    'GET /api/read': (req, res, u) => {
      const d = store.doc(u.searchParams.get('doc'));
      const T = TYPES[d.type];
      const r = T.read(d, u.searchParams.get('range') || '', { limit: +(u.searchParams.get('limit') || 400) });
      wantText(u) ? send(res, 200, `v${store.state.version} ` + formatRead(r)) : send(res, 200, { version: store.state.version, ...r });
    },

    'POST /api/sql': async (req, res, u) => {
      const b = await body(req);
      const docId = b.doc || store.state.order.find((id) => store.state.docs[id].type === 'sheet');
      const r = await runSql(store.state, docId, String(b.sql || ''), { write: !!b.write }).catch((e) => { throw Object.assign(e, { status: e.status || 400 }); });
      const by = b.by || 'agent';
      let msg = formatResult(r);
      if (r.kind === 'rows' && b.into) {
        const rows = r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
        const e = store.batch({ doc: docId, by, ops: jsonToOps(store.doc(docId), b.into.name, rows, b.into.at), label: `sql → ${b.into.name}` });
        msg += `\nwritten to table ${b.into.name} (v${e.v})`;
      }
      if (r.kind === 'write') {
        for (const [d, ops] of Object.entries(r.opsByDoc)) {
          const e = store.batch({ doc: d, by, ops, label: 'sql: ' + String(b.sql).slice(0, 80) });
          msg += `\n[${d}] v${e.v}: ${e.changes.filter((c) => c.k === 'set').length} cells changed`;
        }
      }
      (u.searchParams.get('format') || b.format) === 'json' ? send(res, 200, r) : send(res, 200, msg);
    },
    'GET /api/table': (req, res, u) => send(res, 200, tableJson(store.doc(u.searchParams.get('doc')), u.searchParams.get('name'))),
    'PUT /api/table': async (req, res) => {
      const b = await body(req);
      const d = store.doc(b.doc);
      const e = store.batch({ doc: d.id, by: b.by || 'agent', ops: jsonToOps(d, b.name, b.rows, b.at), label: `json → ${b.name}` });
      send(res, 200, { version: e.v });
    },

    'GET /api/chart': (req, res, u) => {
      const d = store.doc(u.searchParams.get('doc'));
      const x = TYPES.sheet.allCharts(d).find((x) => x.ch.id === u.searchParams.get('id'));
      if (!x) throw httpErr(404, 'No such chart');
      const data = TYPES.sheet.chartData(d, x.sh.name, x.ch);
      if (u.searchParams.get('format') === 'json') return send(res, 200, { ...x.ch, data });
      if (data.kpi) return send(res, 200, `${x.ch.id} kpi "${x.ch.title || ''}": ${data.kpi.text}`);
      send(res, 200, [`${x.ch.id} ${x.ch.type} "${x.ch.title || ''}"`, `label | ${data.series.map((s) => s.name).join(' | ')}`,
        ...data.labels.map((l, i) => `${l} | ${data.series.map((s) => s.values[i] ?? '∅').join(' | ')}`)].join('\n'));
    },

    'POST /api/assets': (req, res) => new Promise((ok, bad) => {
      const type = (req.headers['content-type'] || '').split(';')[0];
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[type];
      if (!ext) return bad(httpErr(415, 'Only png/jpg/gif/webp/svg images'));
      const chunks = []; let n = 0;
      req.on('data', (d) => { n += d.length; if (n > 20e6) { bad(httpErr(413, 'Image too large (20 MB)')); req.destroy(); } else chunks.push(d); });
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
        fs.mkdirSync(path.join(store.dir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(store.dir, 'assets', name), buf);
        send(res, 200, { url: '/assets/' + name });
        ok();
      });
    }),
    'GET /api/export': (req, res, u) => {
      const d = store.doc(u.searchParams.get('doc'));
      const fmt = u.searchParams.get('format') || 'md';
      const out = exportSheet(d, u.searchParams.get('sheet'), fmt);
      send(res, 200, out, fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8');
    },

    'GET /api/find': (req, res, u) => {
      const d = store.doc(u.searchParams.get('doc'));
      if (d.type !== 'sheet') throw httpErr(400, 'find works on sheet docs');
      const hits = TYPES.sheet.find(d, u.searchParams.get('q') || '');
      wantText(u) ? send(res, 200, hits.map((h) => `${h.at} ${h.raw}${h.raw !== h.value ? ' ⇒ ' + h.value : ''}`).join('\n') || 'no matches') : send(res, 200, hits);
    },

    'GET /api/commits': (req, res, u) => wantText(u)
      ? send(res, 200, store.commits.map((c) => `${c.id} v${c.version} ${c.by} ${new Date(c.ts).toISOString().slice(0, 16)} "${c.message}"`).join('\n') || 'no milestones')
      : send(res, 200, store.commits),
    'POST /api/commit': async (req, res) => { const b = await body(req); send(res, 200, store.commit({ message: b.message, by: b.by || 'agent' })); },
    'GET /api/diff': (req, res, u) => {
      const d = store.diff({ from: u.searchParams.get('from') || 'last', doc: u.searchParams.get('doc') });
      wantText(u) ? send(res, 200, formatDiff(d)) : send(res, 200, d);
    },
    'POST /api/restore': async (req, res) => { const b = await body(req); send(res, 200, store.restore({ commit: b.commit, doc: b.doc, by: b.by || 'user' })); },

    'GET /api/selection': (req, res, u) => {
      const s = store.selection;
      if (!wantText(u)) return send(res, 200, s || {});
      send(res, 200, s ? `[${s.doc}] ${s.sheet}!${s.ranges.join(',')} active ${s.active}` : 'no selection');
    },
    'POST /api/selection': async (req, res) => {
      const b = await body(req);
      store.selection = { doc: b.doc, sheet: b.sheet, ranges: b.ranges || [], active: b.active, ts: Date.now() };
      send(res, 200, { ok: true });
    },
    'POST /api/present': async (req, res) => {
      const b = await body(req);
      store.emit({ type: 'present', by: b.by || 'agent', doc: b.doc || null, sheet: b.sheet, mode: b.mode, focus: b.focus, off: !!b.off, slide: b.slide });
      send(res, 200, { ok: true });
    },
    'POST /api/presence': async (req, res) => { const b = await body(req); if (b.leave) store.leavePresence(b.id); else store.touchPresence(b); send(res, 200, { ok: true }); },
    'GET /api/presence': (req, res, u) => {
      const ppl = store.people();
      if (u.searchParams.get('format') === 'json') return send(res, 200, ppl);
      send(res, 200, ppl.length ? ppl.map((p) => `${p.name}  [${p.doc}] ${p.sheet ?? ''}${p.active ? '!' + p.active : ''}${p.ranges?.length ? ' sel ' + p.ranges.join(',') : ''}${p.live ? `  · LIVE ${p.live.mode === 'auto' ? 'combined' : p.live.sheet}${p.live.focus ? ' focus ' + p.live.focus : ''}` : ''}`).join('\n') : 'nobody else is here');
    },
    'GET /api/history': (req, res, u) => {
      const d = store.doc(u.searchParams.get('doc'));
      const q = u.searchParams;
      let list, title;
      if (q.get('table')) { list = store.tableHistory(d.id, q.get('table')); title = `history of table ${q.get('table')}`; }
      else {
        const [sn, a] = splitSheet(q.get('cell') || '');
        const sheet = (sn ? d.sheets.find((x) => x.name.toLowerCase() === sn.toLowerCase()) : d.sheets[0])?.name;
        list = store.cellHistory(d.id, sheet, String(a).toUpperCase()); title = `history of ${sheet}!${String(a).toUpperCase()}`;
      }
      q.get('format') === 'json' ? send(res, 200, list) : send(res, 200, formatHistory(list, title));
    },
    'POST /api/live-state': async (req, res) => { store.live = await body(req); store.live.ts = Date.now(); send(res, 200, { ok: true }); },
    'GET /api/live': (req, res, u) => {
      const L = store.live;
      if (u.searchParams.get('format') === 'json') return send(res, 200, L || { open: false });
      if (!L || !L.open) return send(res, 200, 'Live mode is not open on the user\'s screen');
      const lines = [`Live open · ${L.mode === 'auto' ? 'combined' : 'sheet ' + L.sheet} · ${L.flow || 'vertical'} · viewport ${L.vw}×${L.vh}${L.focus ? ' · FOCUS ' + L.focus : ''}${L.slide ? ' · SLIDE ' + L.slide : ''}${L.quality && L.quality !== 'full' ? ' · background quality ' + L.quality + ' (slow device)' : ''} · updated ${Math.round((Date.now() - L.ts) / 1000)}s ago`];
      for (const c of L.cards || []) lines.push(`  ${c.visible ? '●' : '○'} ${c.key}  ${c.kind}${c.title ? ` "${c.title}"` : ''}  @${c.x},${c.y} ${c.w}×${c.h}${c.summary ? '  ' + c.summary : ''}`);
      lines.push('(● = on screen now; positions in CSS px of the live canvas)');
      send(res, 200, lines.join('\n'));
    },
    'POST /api/focus': async (req, res) => {
      const b = await body(req);
      store.emit({ type: 'focus', by: b.by || 'agent', doc: b.doc || store.state.order[0], sheet: b.sheet, range: b.range, label: b.label });
      send(res, 200, { ok: true });
    },

    'GET /api/events': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', version: store.state.version })}\n\n`);
      const off = store.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { off(); clearInterval(ping); });
    },
  };

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      const h = routes[`${req.method} ${u.pathname}`];
      if (h) return await h(req, res, u);
      if (u.pathname.startsWith('/api/')) throw httpErr(404, `No route ${req.method} ${u.pathname}. See GET /api/help`);
      if (u.pathname.startsWith('/assets/')) {
        const f = path.join(store.dir, 'assets', path.basename(u.pathname));
        if (!fs.existsSync(f)) throw httpErr(404, 'No such asset');
        const ext = path.extname(f).slice(1);
        res.writeHead(200, { 'content-type': { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' });
        return fs.createReadStream(f).pipe(res);
      }
      // static
      let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (p === '/' || p === '\\') p = '/index.html';
      const f = path.join(PUBLIC, p);
      if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) throw httpErr(404, 'Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.message, ...(e.extra || {}) });
      else res.end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const store = new Store(DATA).init();
  const srv = createServer(store);
  srv.listen(PORT, HOST, () => {
    console.log(`Spread  http://${HOST}:${PORT}   data: ${DATA}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.warn('WARNING: no auth. Do not expose to untrusted networks.');
  });
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
