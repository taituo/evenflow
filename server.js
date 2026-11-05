// Canvas Mini server. Zero dependencies: node:http + static files + REST + SSE.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, httpErr } from './lib/store.js';
import { nlsTile, nlsKey } from './lib/tiles.js';
import { Feeds, describeKinds } from './lib/feeds.js';
import { Sim } from './lib/sim.js';
import { Studio } from './lib/studio/index.js';
import { previewTarget, proxyHttp, proxyUpgrade } from './lib/studio/preview.js';
import { TYPES } from './public/shared/types/index.js';
import { splitSheet } from './public/shared/a1.js';
import { exportSheet } from './public/shared/export.js';
import { validatePack } from './public/shared/viz.js';
import { runSql, tableJson, jsonToOps, formatResult } from './lib/sql.js';
import { formatEntries, netChanges, formatRead, formatDiff, formatChangeList, formatHistory } from './lib/format.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = +(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.resolve(process.env.CANVAS_DATA || path.join(ROOT, 'data'));
const tokenNow = () => process.env.SPREAD_TOKEN || null;   // set it to serve beyond localhost (e.g. a VPS reached over a tunnel or a LAN)

/** With SPREAD_TOKEN set, every request needs it: ?token= once (becomes a cookie), the cookie, or "Authorization: Bearer". */
function authorized(req, u) {
  const TOKEN = tokenNow();
  if (!TOKEN) return true;
  const ok = (t) => t && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  const cookie = /(?:^|;\s*)spread_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  return ok(u.searchParams.get('token')) || ok(bearer) || ok(cookie && decodeURIComponent(cookie));
}

/** A point in time: epoch ms, ISO, "v123" (that version), "-90m" / "-2h" / "-1d" (ago), "14:30" (today, server time), "m3" (a milestone). */
export function parseWhen(x, store) {
  const t = String(x ?? '').trim();
  if (/^\d{11,}$/.test(t)) return +t;
  let m = /^-(\d+(?:\.\d+)?)\s*(s|m|min|h|d)$/i.exec(t);
  if (m) return Date.now() - +m[1] * { s: 1e3, m: 6e4, min: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  if ((m = /^v(\d+)$/i.exec(t))) { const e = store.fullLog().find((x) => x.v > +m[1]); return e ? e.ts - 1 : Date.now(); }
  if (/^m\d+$|^last$/i.test(t)) { const c = store.commits.find((x) => x.id === t) || (t === 'last' && store.commits.at(-1)); if (!c) throw httpErr(404, `No milestone "${t}"`); return c.ts; }
  if ((m = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(t))) { const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); return +d; }
  const d = Date.parse(t);
  if (!isNaN(d)) return d;
  throw httpErr(400, `Not a time: "${t}" (use epoch ms, ISO, -2h, 14:30, v120 or m3)`);
}

export function createServer(store) {
  if (!store.feeds) store.feeds = new Feeds(store).start();   // open-data feeds poll into tables
  if (!store.sim) store.sim = new Sim(store);                  // race / qualifying / practice sessions
  if (!store.studio) store.studio = new Studio(store).init();  // coding agents (ACP) on a canvas
  const studio = store.studio;
  const agentOf = (u, b) => { const id = (b && (b.agent || b.id)) || u.searchParams.get('agent'); if (!id) throw httpErr(400, 'agent is required'); return studio.get(id); };
  const snapOf = (r, v, dflt) => { const all = studio.db.snapshots(r.id); if (!all.length) throw httpErr(404, 'no snapshots yet'); if (v == null || v === '' || v === 'last') return dflt === 'base' ? all[0] : all.at(-1); if (v === 'base') return all[0]; const n = +String(v).replace(/^#/, ''); const s = all.find((x) => x.n === n); if (!s) throw httpErr(404, `No snapshot #${v}`); return s; };
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

  if (!store.viz) store.loadViz(path.join(PUBLIC, 'viz'));
  const routes = {
    // ---------------------------------------------------------- SVG visual packs (spread-viz/1)
    'GET /api/viz/spec': (req, res) => send(res, 200, fs.readFileSync(path.join(ROOT, 'VIZ_SPEC.md'), 'utf8'), MIME['.md']),
    'GET /api/viz': (req, res, u) => {
      const id = u.searchParams.get('id');
      const list = [...store.viz.values()];
      if (id) { const p = store.viz.get(id); if (!p) throw httpErr(404, `No pack "${id}"`); return send(res, 200, p); }
      if (u.searchParams.get('format') === 'text') return send(res, 200, list.map((p) => `${p.id.padEnd(14)} ${p.kind.padEnd(7)} ${p.name}${p.kind === 'states' ? ' [' + p.states.map((x) => x.id).join(' ') + ']' : p.kind === 'range' ? ` [${p.min}…${p.max}]` : ''}${p.builtin ? '  (built in)' : `  rev ${p.rev}`}`).join('\n'));
      send(res, 200, list);
    },
    'POST /api/viz': async (req, res, u) => {
      const b = await body(req);
      const pack = b.pack || b;
      if (u.searchParams.has('dry')) {
        const r = validatePack(pack);
        return send(res, r.ok ? 200 : 400, { ok: r.ok, errors: r.errors, warnings: r.warnings, ...(r.ok ? {} : { error: 'Invalid pack: ' + r.errors.join('; ') }) });
      }
      const r = store.putViz(pack, b.by || u.searchParams.get('by') || 'agent');
      send(res, 200, { ok: true, id: r.pack.id, rev: r.pack.rev, replaced: r.replaced, warnings: r.warnings });
    },
    'DELETE /api/viz': (req, res, u) => { store.deleteViz(u.searchParams.get('id'), u.searchParams.get('by') || 'user'); send(res, 200, { ok: true }); },
    // ---------------------------------------------------------- studio: coding agents (ACP) on a canvas
    'GET /api/studio': (req, res, u) => {
      const st = studio.state(u.searchParams.get('doc') || studio.ensureDoc().id);
      if (u.searchParams.get('format') === 'json') return send(res, 200, st);
      const ic = { green: '✓', amber: '⚠', red: '✗', running: '…', skip: '–' };
      const d = studio.studioDoc(st.doc);
      send(res, 200, [`studio [${st.doc}] root ${st.root || '(not set)'} · presets ${Object.keys(st.presets).join(', ')}`,
        ...st.agents.map((a) => { const def = d.agents.find((x) => x.id === a.id); const last = a.snapshots.at(-1); return `${def.name} [${a.id}] ${a.status}${a.queue ? ` (+${a.queue} queued)` : ''} · turn ${a.turn} · ${a.snapshots.length} snapshots${last ? ` (last #${last.n} ${last.reason})` : ''}${def.branch ? ' · ' + def.branch : ''}${def.forkOf ? ` · ${def.forkOf.kind === 'spawn' ? 'started by' : 'fork of'} ${d.agents.find((x) => x.id === def.forkOf.agent)?.name || def.forkOf.agent}${def.forkOf.snap != null ? '#' + def.forkOf.snap : ''}${def.forkOf.mode === 'same' ? ' (same folder)' : ''}` : ''}${def.why ? `\n    why: ${def.why}` : ''}\n    lights: ${a.lights.map((m) => `${m.monitor} ${ic[m.level] || m.level}`).join('  ') || '–'}${a.subtitle ? `\n    said: ${a.subtitle}` : ''}${a.plan ? `\n    plan: ${a.plan.map((p) => `${p.status === 'completed' ? '☑' : p.status === 'in_progress' ? '▸' : '☐'} ${p.content}`).join(' · ')}` : ''}`; }),
        st.gates.length ? 'gates:' : 'no open gates', ...st.gates.map((g) => `  ${g.blocking ? '■' : '□'} ${g.id} ${d.agents.find((x) => x.id === g.agent)?.name || g.agent} ${g.kind}: ${g.title}${g.detail ? ' — ' + g.detail : ''}${g.kind === 'permission' ? `  [${g.json.options.map((o) => o.optionId).join(' | ')}]` : ''}`),
        st.target ? `pointing at: ${st.target.kind} ${st.target.id}` : ''].filter(Boolean).join('\n'));
    },
    'GET /api/studio/events': (req, res, u) => {
      const r = agentOf(u), q = u.searchParams;
      const ev = q.get('before') ? studio.db.eventsBefore(r.id, +q.get('before'), +(q.get('limit') || 400)) : studio.db.events(r.id, +(q.get('since') || 0), +(q.get('limit') || 800));
      if (q.get('format') !== 'text') return send(res, 200, ev);
      send(res, 200, ev.map((e) => `#${e.seq} ${e.kind}${e.status ? ' ' + e.status : ''}${e.title ? ' ' + e.title : ''}${e.text ? ': ' + e.text : ''}${e.kind === 'plan' ? ': ' + e.json.map((p) => p.content).join(' · ') : ''}`).join('\n'));
    },
    'GET /api/studio/timeline': (req, res, u) => {
      const d = studio.studioDoc(u.searchParams.get('doc') || studio.ensureDoc().id);
      send(res, 200, d.agents.flatMap((a) => studio.db.snapshots(a.id).map((s) => ({ agent: a.id, n: s.n, ts: s.ts, reason: s.reason, adds: s.adds, dels: s.dels, files: s.files, seq: s.seq }))).sort((a, b) => a.ts - b.ts));
    },
    'GET /api/studio/diff': async (req, res, u) => {
      const r = agentOf(u), q = u.searchParams;
      await r.shadow.init();
      const to = snapOf(r, q.get('to') ?? q.get('snap'));
      const from = q.get('from') != null ? snapOf(r, q.get('from')) : (to.n > 0 ? snapOf(r, to.n - 1) : to);
      const paths = q.get('path') ? [q.get('path')] : [];
      const patch = from.commit === to.commit ? '' : await r.shadow.diff(from.commit, to.commit, paths, +(q.get('context') || 3));
      if (q.get('format') === 'text') return send(res, 200, patch || '(no changes)');
      const files = from.commit === to.commit ? [] : await r.shadow.numstat(from.commit, to.commit);
      send(res, 200, { agent: r.id, from: from.n, to: to.n, files, patch: patch.length > 2e6 ? patch.slice(0, 2e6) + '\n… (truncated)' : patch });
    },
    'GET /api/studio/file': async (req, res, u) => {
      const r = agentOf(u), q = u.searchParams;
      await r.shadow.init();
      const s = snapOf(r, q.get('snap'));
      const t = await r.shadow.show(s.commit, q.get('path') || '');
      if (t == null) throw httpErr(404, `No ${q.get('path')} in snapshot #${s.n}`);
      send(res, 200, t);
    },
    'GET /api/studio/tree': async (req, res, u) => {
      const r = agentOf(u);
      await r.shadow.init();
      const s = snapOf(r, u.searchParams.get('snap'));
      send(res, 200, { snap: s.n, files: await r.shadow.ls(s.commit) });
    },
    'GET /api/studio/monitors': (req, res, u) => send(res, 200, studio.db.monitorHistory(agentOf(u).id)),
    'GET /api/studio/gates': (req, res, u) => {
      const g = studio.db.openGates();
      u.searchParams.get('format') === 'text' ? send(res, 200, g.map((x) => `${x.blocking ? '■' : '□'} ${x.id} [${x.agent}] ${x.kind}: ${x.title}${x.detail ? ' — ' + x.detail : ''}`).join('\n') || 'no open gates') : send(res, 200, g);
    },
    'POST /api/studio/agents': async (req, res) => send(res, 200, await studio.createAgent(await body(req))),
    'DELETE /api/studio/agents': async (req, res, u) => send(res, 200, await studio.removeAgent(u.searchParams.get('id'), u.searchParams.get('by') || 'user')),
    'POST /api/studio/start': async (req, res, u) => { const r = agentOf(u, await body(req)); await r.start(); send(res, 200, { ok: true, status: r.status, sessionId: r.sessionId }); },
    'POST /api/studio/stop': async (req, res, u) => { const r = agentOf(u, await body(req)); r.stop(); send(res, 200, { ok: true }); },
    'POST /api/studio/prompt': async (req, res, u) => {
      const b = await body(req);
      const r = agentOf(u, b);
      if (b.interrupt && r.status === 'working') r.cancel();
      r.prompt(b.text, b.by || 'agent');
      send(res, 200, { ok: true, status: r.status, queued: r.queue.length });
    },
    'POST /api/studio/cancel': async (req, res, u) => { const r = agentOf(u, await body(req)); r.cancel(); send(res, 200, { ok: true }); },
    'POST /api/studio/gate': async (req, res) => { const b = await body(req); send(res, 200, b.dismiss ? studio.dismiss(b.gate) : studio.answer(b.gate, b.option)); },
    'POST /api/studio/rewind': async (req, res, u) => { const b = await body(req); const r = agentOf(u, b); send(res, 200, await r.rewind(+String(b.snap).replace(/^#/, ''))); },
    'POST /api/studio/fork': async (req, res, u) => { const b = await body(req); const r = agentOf(u, b); send(res, 200, await studio.fork(r.id, { ...b, snap: b.snap == null ? null : +String(b.snap).replace(/^#/, '') })); },
    'POST /api/studio/review': async (req, res, u) => { const b = await body(req); const r = agentOf(u, b); send(res, 200, await studio.review(r.id, b)); },
    'POST /api/studio/spawn': async (req, res, u) => { const b = await body(req); const r = agentOf(u, b); send(res, 200, await studio.spawn(r.id, b)); },
    'POST /api/studio/view': async (req, res) => send(res, 200, studio.view(await body(req))),
    'POST /api/studio/activity': async (req, res) => { const b = await body(req); studio.director.activity(b.doc || studio.ensureDoc().id); send(res, 200, { ok: true }); },
    'POST /api/studio/director': async (req, res) => {
      // director: off | auto | agent (agent also starts a director box if there is none)
      const b = await body(req);
      const d = studio.studioDoc(b.doc || studio.ensureDoc().id);
      store.batch({ doc: d.id, by: b.by || 'user', ops: [{ op: 'setConfig', set: { director: b.mode || 'auto' } }], label: 'director ' + b.mode });
      let box = studio.director.directorBox(d.id);
      if (b.mode === 'agent' && !box) box = await studio.createAgent({ doc: d.id, role: 'director', preset: b.preset, by: b.by || 'user' });
      send(res, 200, { mode: b.mode, box: box?.id || null });
    },
    'GET /api/studio/codemap': async (req, res, u) => { const q = u.searchParams; send(res, 200, await studio.codemap({ doc: q.get('doc'), agent: q.get('agent'), snap: q.get('snap'), paths: q.get('paths') })); },
    'POST /api/studio/term': async (req, res) => {
      const b = await body(req);
      const d = studio.studioDoc(b.doc || studio.ensureDoc().id);
      const p = d.panels.find((x) => x.id === b.panel);
      if (!p || p.kind !== 'terminal') throw httpErr(404, 'No terminal panel ' + b.panel);
      const src = p.source || {};
      const cwd = src.agent ? studio.get(src.agent).cwd : src.cwd || (await studio.root(d));
      send(res, 200, studio.terms.open({ id: `${d.id}:${p.id}`, doc: d.id, cwd, cmd: src.cmd, cols: b.cols, rows: b.rows }));
    },
    'GET /api/studio/term': (req, res, u) => send(res, 200, studio.terms.buffer(u.searchParams.get('id')) || { buf: '', exited: null }),
    'POST /api/studio/term/input': async (req, res) => { const b = await body(req); studio.terms.input(b.id, b.data); send(res, 200, { ok: true }); },
    'POST /api/studio/term/resize': async (req, res) => { const b = await body(req); studio.terms.resize(b.id, b.cols, b.rows); send(res, 200, { ok: true }); },
    'POST /api/studio/target': async (req, res) => send(res, 200, { target: studio.setTarget(await body(req)) }),
    'GET /api/studio/target': (req, res) => send(res, 200, { target: studio.target }),
    'POST /api/studio/say': async (req, res) => { const b = await body(req); send(res, 200, await studio.say(b.text, b.target, b.by || 'voice')); },
    'POST /api/studio/sql': async (req, res, u) => {
      const b = await body(req);
      let r;
      try { r = studio.db.query(b.sql, Math.min(+b.limit || 500, 5000)); } catch (e) { throw httpErr(400, e.message); }
      if ((u.searchParams.get('format') || b.format) === 'json') return send(res, 200, r);
      const cell = (v) => (v == null ? '∅' : String(v).replace(/\s+/g, ' ').slice(0, 120));
      send(res, 200, [r.columns.join(' | '), ...r.rows.map((row) => r.columns.map((c) => cell(row[c])).join(' | ')), `(${r.rows.length} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ', truncated' : ''})`].join('\n'));
    },
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
          for (const c of sh.conds || []) lines.push(`    traffic lights ${c.id} ${c.range}: ${c.rules.join(', ')}`);
          for (const c of sh.charts) lines.push(`    chart ${c.id} ${c.type}${c.title ? ` "${c.title}"` : ''} ← ${c.source} @${c.at}`);
          for (const t of sh.tables) lines.push(`    table ${t.name} ${t.range} · ${t.rows} rows · [${t.columns.join(' | ')}]`);
        }
        else lines.push(`  ${info.summary || info.lines + ' lines'}`);
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
      if (data.track) {
        const t = data.track;
        return send(res, 200, [`${x.ch.id} track ${t.layout} "${x.ch.title || ''}"${t.trail ? ' trail ' + t.trail : ''}${t.points ? ` · ${t.points.length} shape points` : ''}${t.zones.length ? ` · zones ${t.zones.map((z) => `${z.label} ${z.from}–${z.to}`).join(', ')}` : ''}`,
          ...t.layers.flatMap((L) => [`layer ${L.name}: ${L.items.length}`, ...L.items.slice(0, 40).map((i) => `  ${i.label}  at ${i.dist}${i.value != null ? '  ' + i.value : ''}`)]), ...t.errors.map((e) => 'error: ' + e)].join('\n'));
      }
      if (data.viz) return send(res, 200, `${x.ch.id} viz ${data.viz.pack} "${x.ch.title || ''}": ${data.viz.text}`);
      if (data.map) {
        const m = data.map;
        return send(res, 200, [`${x.ch.id} map "${x.ch.title || ''}" basemap ${m.basemap}${m.view ? ' view ' + JSON.stringify(m.view) : ' view: fit'}${m.follow ? ' follow ' + m.follow : ''}${m.focus ? ' focus ' + m.focus : ''}`,
          ...m.layers.flatMap((L) => [`layer ${L.name} (@${L.table})${L.route ? ' route' : ''}${L.hidden ? ' hidden' : ''}: ${L.points.length} points${L.skipped ? `, ${L.skipped} rows without coordinates` : ''}${L.error ? ' — ' + L.error : ''}`,
            ...L.points.map((p) => `  ${p.label}  ${p.lat}, ${p.lon}  ${p.cell}${p.light ? ' ●' : ''}`)])].join('\n'));
      }
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
    // session simulator: race / qualifying / practice on the Pitwall dashboard
    'GET /api/sim': (req, res, u) => {
      const st = store.sim.status();
      if (u.searchParams.get('format') === 'json') return send(res, 200, st);
      send(res, 200, st.session ? `${st.session} [${st.doc}] ${st.running ? 'running' : st.done ? 'finished' : 'stopped'} · t ${st.t}s ×${st.speed} · flag ${st.flag} · seed ${st.seed} · leader ${st.leader} · focus ${st.focus} P${st.position} lap ${st.lap}${st.session === 'race' ? '/' + st.laps : ''}${st.timeLeft != null ? ` · ${Math.ceil(st.timeLeft / 60)} min left` : ''}` : 'no session — cm sim start race');
    },
    'POST /api/sim': async (req, res) => {
      const b = await body(req);
      try {
        if (b.action === 'stop') { store.sim.stop(); return send(res, 200, store.sim.status()); }
        if (b.action === 'focus') return send(res, 200, store.sim.setFocus(b.focus));
        if (b.action === 'start' || !b.action) return send(res, 200, store.sim.start(b));
        throw Object.assign(new Error('action: start | stop | focus'), { status: 400 });
      } catch (e) { throw httpErr(e.status || 400, e.message); }
    },
    // open data feeds (Finnish real-time sources → tables)
    'GET /api/feeds': (req, res, u) => {
      if (u.searchParams.has('kinds')) return send(res, 200, describeKinds());
      if (u.searchParams.get('format') === 'json') return send(res, 200, store.feeds.list().map((f) => ({ ...f, status: store.feeds.status.get(f.id) || null })));
      send(res, 200, store.feeds.describe());
    },
    'POST /api/feeds': async (req, res) => send(res, 200, await store.feeds.add(await body(req)).catch((e) => { throw httpErr(e.status || 400, e.message); })),
    'POST /api/feeds/run': async (req, res) => { const b = await body(req); try { send(res, 200, await store.feeds.run(b.id)); } catch (e) { throw httpErr(e.status || 400, e.message); } },
    'POST /api/feeds/set': async (req, res) => { const b = await body(req); try { send(res, 200, store.feeds.setOn(b.id, b.on !== false)); } catch (e) { throw httpErr(e.status || 400, e.message); } },
    'DELETE /api/feeds': (req, res, u) => { try { store.feeds.remove(u.searchParams.get('id')); } catch (e) { throw httpErr(e.status || 400, e.message); } send(res, 200, { ok: true }); },
    // server settings: API keys for map tiles (kept out of the versioned workbook)
    'GET /api/config': (req, res, u) => {
      const k = nlsKey(store);
      const c = { nlsKey: k ? k.slice(0, 4) + '…' : null };
      u.searchParams.get('format') === 'json' ? send(res, 200, c) : send(res, 200, `nls-key: ${c.nlsKey || '(not set — Finnish aerial / topo maps need one: https://www.maanmittauslaitos.fi/en/rajapinnat/api-avaimen-ohje)'}`);
    },
    'POST /api/config': async (req, res) => {
      const b = await body(req);
      if ('nlsKey' in b) { if (b.nlsKey != null && !/^[\w-]{8,100}$/.test(String(b.nlsKey))) throw httpErr(400, 'nlsKey looks wrong'); store.saveSettings({ nlsKey: b.nlsKey || null }); }
      send(res, 200, { ok: true });
    },
    'GET /api/replay': (req, res, u) => {
      const q = u.searchParams;
      const r = store.replay({ doc: q.get('doc') || undefined, from: parseWhen(q.get('from'), store), to: q.get('to') ? parseWhen(q.get('to'), store) : undefined });
      if (q.get('format') === 'json') return send(res, 200, r);
      const t = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
      const who = new Map();
      for (const f of r.frames) who.set(f.who || f.by, (who.get(f.who || f.by) || 0) + 1);
      send(res, 200, [`replay [${r.doc}] ${t(r.from)} → ${t(r.to)} UTC · ${r.frames.length} changes${who.size ? ' by ' + [...who].map(([k, n]) => `${k} ${n}`).join(', ') : ''}${r.note ? ` · starts later: ${r.note}` : ''}`,
        ...r.frames.slice(0, 40).map((f) => `  ${t(f.ts).slice(11)} v${f.v} ${f.who || f.by}: ${f.label || f.touched.map((x) => (x.sheet ? x.sheet + '!' : '') + x.range).join(', ') || f.ops.map((o) => o.op).join(',')}`),
        r.frames.length > 40 ? `  … ${r.frames.length - 40} more` : ''].filter(Boolean).join('\n'));
    },
    'POST /api/present': async (req, res) => {
      const b = await body(req);
      const ACTIONS = ['next', 'prev', 'play', 'pause', 'toggle', 'unfocus'];
      if (b.action && !ACTIONS.includes(b.action)) throw httpErr(400, `action must be one of ${ACTIONS.join(' ')}`);
      if (b.screen && !store.screens.has(String(b.screen))) throw httpErr(404, `No screen "${b.screen}" — see GET /api/screens`);
      let replay = null;
      if (b.replay != null) {
        if (['stop', 'off', false].includes(b.replay)) replay = { stop: true };
        else {
          const o = typeof b.replay === 'object' ? b.replay : {};
          const from = parseWhen(o.from ?? '-1h', store), to = o.to != null ? parseWhen(o.to, store) : Date.now();
          if (!(from < to)) throw httpErr(400, 'replay: from must be before to');
          const speed = o.speed ?? 60;
          if (!(typeof speed === 'number' && speed >= 1 && speed <= 100000)) throw httpErr(400, 'replay.speed: 1…100000 (× real time)');
          replay = { from, to, speed, gaps: o.gaps !== false, loop: !!o.loop };
        }
      }
      store.emit({ type: 'present', by: b.by || 'agent', doc: b.doc || null, sheet: b.sheet, mode: b.mode, focus: b.focus, off: !!b.off, slide: b.slide, action: b.action || null, theme: b.theme || null, screen: b.screen ? String(b.screen) : null, replay });
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
    // every open Live view is a screen (a TV, a laptop, a phone); remotes and agents drive them by id
    'POST /api/live-state': async (req, res) => { const b = await body(req); store.setScreen(b); send(res, 200, { ok: true }); },
    'GET /api/screens': (req, res, u) => {
      const list = store.screenList();
      if (u.searchParams.get('format') === 'json') return send(res, 200, list);
      send(res, 200, list.length ? list.map((L) => `${L.screen}  "${L.name}"  ${L.mode === 'auto' ? 'combined' : 'sheet ' + L.sheet}${L.focus ? ' · focus ' + L.focus : ''}${L.slide ? ' · slide ' + L.slide + (L.playing ? ' ▶' : ' ⏸') : ''}${L.replay ? ` · replay at ${new Date(L.replay.at).toISOString().slice(11, 19)} UTC ×${L.replay.speed}${L.replay.playing ? ' ▶' : ' ⏸'}` : ''} · ${L.cards?.length || 0} cards · ${L.vw}×${L.vh}`).join('\n') : 'no screens: nobody has Live open');
    },
    'GET /api/live': (req, res, u) => {
      const want = u.searchParams.get('screen');
      const list = store.screenList();
      const L = want ? list.find((x) => x.screen === want) : list[0];
      if (u.searchParams.get('format') === 'json') return send(res, 200, L ? { ...L, screens: list.map((x) => ({ screen: x.screen, name: x.name })) } : { open: false, screens: [] });
      if (!L) return send(res, 200, 'Live mode is not open on any screen');
      const lines = [`Live open on "${L.name}" [${L.screen}] · ${L.mode === 'auto' ? 'combined' : 'sheet ' + L.sheet} · ${L.flow || 'vertical'} · viewport ${L.vw}×${L.vh}${L.focus ? ' · FOCUS ' + L.focus : ''}${L.slide ? ' · SLIDE ' + L.slide : ''}${L.quality && L.quality !== 'full' ? ' · background quality ' + L.quality + ' (slow device)' : ''} · updated ${Math.round((Date.now() - L.ts) / 1000)}s ago`];
      if (L.replay) { const R = L.replay, T = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19); lines.push(`  REPLAY ${T(R.from)} → ${T(R.to)} UTC · now at ${T(R.at)} · ×${R.speed} · ${R.ended ? 'ended' : R.playing ? 'playing' : 'paused'} · ${R.applied}/${R.changes} changes${R.note ? ' · ' + R.note : ''}`); }
      if (list.length > 1) lines.push(`  (${list.length} screens: ${list.map((x) => x.screen).join(', ')} — ?screen=id for another)`);
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

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (!authorized(req, u)) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0;color:#52525b">This Spread needs a token: open it with <code>?token=…</code></body>');
      }
      const TOKEN = tokenNow();
      if (TOKEN && u.searchParams.has('token') && req.method === 'GET' && !u.pathname.startsWith('/api/')) {
        u.searchParams.delete('token');
        res.writeHead(302, { location: u.pathname + (u.search || '') + u.hash, 'set-cookie': `spread_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
        return res.end();
      }
      if (u.pathname.startsWith('/preview/')) {
        const t = previewTarget(req, u, srv.address()?.port);
        if (!t) throw httpErr(400, 'Bad preview port');
        return proxyHttp(req, res, t);
      }
      {
        // a page shown in a preview asks for its own absolute paths (/app.js, /@vite/client): they are its, not ours
        const t = !u.pathname.startsWith('/api/') && previewTarget(req, u, srv.address()?.port);
        if (t?.via === 'referer') return proxyHttp(req, res, t);
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      const h = routes[`${req.method} ${u.pathname}`];
      if (h) return await h(req, res, u);
      if (u.pathname.startsWith('/api/')) throw httpErr(404, `No route ${req.method} ${u.pathname}. See GET /api/help`);
      if (u.pathname.startsWith('/tiles/nls/') && req.method === 'GET') {
        const [layer, z, x, y] = u.pathname.slice(11).split('/');
        const t = await nlsTile(store, layer, z, x, y);
        res.writeHead(200, { 'content-type': t.type, 'cache-control': 'public, max-age=86400', 'x-cache': t.cached ? 'hit' : 'miss' });
        return res.end(t.body);
      }
      if (u.pathname.startsWith('/assets/')) {
        const f = path.join(store.dir, 'assets', path.basename(u.pathname));
        if (!fs.existsSync(f)) { const t = previewTarget(req, u, srv.address()?.port); if (t) return proxyHttp(req, res, t); throw httpErr(404, 'No such asset'); }
        const ext = path.extname(f).slice(1);
        res.writeHead(200, { 'content-type': { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' });
        return fs.createReadStream(f).pipe(res);
      }
      // static
      let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (p === '/' || p === '\\') p = '/index.html';
      if (p === '/remote' || p === '\\remote') p = '/remote.html';
      if (p === '/studio' || p === '\\studio') p = '/studio.html';
      const f = path.join(PUBLIC, p);
      if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        const t = previewTarget(req, u, srv.address()?.port);   // a previewed app asking for its own absolute paths
        if (t) return proxyHttp(req, res, t);
        throw httpErr(404, 'Not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.message, ...(e.extra || {}) });
      else res.end();
    }
  });
  srv.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    const t = authorized(req, u) && previewTarget(req, u, srv.address()?.port);
    if (t) proxyUpgrade(req, socket, head, t); else socket.destroy();
  });
  srv.on('listening', () => { const a = srv.address(); if (a && typeof a === 'object') studio.url = `http://127.0.0.1:${a.port}`; });
  return srv;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const store = new Store(DATA).init();
  const srv = createServer(store);
  srv.listen(PORT, HOST, () => {
    console.log(`Evenflow  http://${HOST}:${PORT}/studio   (sheets: http://${HOST}:${PORT}/)   data: ${DATA}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !tokenNow()) console.warn('WARNING: no auth. Set SPREAD_TOKEN before exposing this beyond localhost.');
  });
  const bye = () => { store.studio?.close(); store.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
