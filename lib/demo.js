// The Spread tour: an agent demos (nearly) every feature on a separate "demo" workbook, step by step,
// over the same HTTP API the CLI and the MCP server use. Each step says what to look at — a manual test script.
//   node bin/cm.mjs demo            interactive (Enter = next, b = back, r = repeat, q = quit)
//   node bin/cm.mjs demo --auto 6   hands-free, 6 s per step      · --list · --step 12 · --from 8 · --screen tv
// Steps only touch the "demo" workbook (and add/remove one visual pack, "demo-tank").

const DOC = 'demo';
let pace = 1;
/** 0 = no pauses (tests), 1 = normal. */
export const setPace = (k) => { pace = k; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * pace));

export function client(base) {
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t}`);
    try { return JSON.parse(t); } catch { return t; }
  };
  const ops = (list, extra = {}) => call('POST', '/api/ops?format=text', { doc: DOC, by: 'demo', ops: list, ...extra });
  const present = (o, screen) => call('POST', '/api/present', { doc: DOC, by: 'demo', screen, ...o });
  return { call, ops, present, get: (p) => call('GET', p) };
}

const TANK = {
  spec: 'spread-viz/1', id: 'demo-tank', kind: 'range', name: 'Demo water tank', min: 0, max: 100,
  description: 'Installed by the demo — made from the example in VIZ_SPEC.md',
  svg: '<svg viewBox="0 0 80 100"><style>.w{fill:#4ea1ff;transform-box:fill-box;transform-origin:center bottom;transform:scaleY(var(--v))}[data-level="0"] .w,[data-level="1"] .w{fill:#ea4335}.t{font:700 16px system-ui;fill:currentColor;text-anchor:middle}</style><rect x="10" y="6" width="60" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="4"/><rect class="w" x="14" y="10" width="52" height="72" rx="5"/><text class="t" x="40" y="98">{{pct}}%</text></svg>',
};
const BRIGHT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7e8"/><stop offset="1" stop-color="#d9e6ff"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><circle cx="130" cy="20" r="14" fill="#ffd54a"/></svg>';

/** Every step: what it shows (features), what to look at, and what the agent does. */
export const STEPS = [
  {
    title: 'A fresh demo workbook',
    features: ['multiple workbooks', 'sheets', 'formatting', 'merged cells', 'fonts'],
    look: 'Open the URL below (or switch to the “Spread demo” tab). Title in a merged, big cell; four sheets.',
    async run(c) {
      await c.call('DELETE', '/api/docs?id=demo&by=demo').catch(() => {});   // the tour always starts from scratch
      await c.call('POST', '/api/docs', { type: 'sheet', id: DOC, title: 'Spread demo', by: 'demo' });
      await c.ops([
        { op: 'renameSheet', sheet: 'Sheet1', name: 'Robot' },
        { op: 'addSheet', name: 'Dashboard' }, { op: 'addSheet', name: 'Sensors' }, { op: 'addSheet', name: 'Slides' },
        { op: 'set', sheet: 'Robot', cells: { A1: 'Robot build — demo', A2: 'Everything you see was made by an agent through the API' } },
        { op: 'merge', sheet: 'Robot', range: 'A1:F1' },
        { op: 'format', sheet: 'Robot', range: 'A1', style: { fs: 24, b: true, ff: 'display' } },
        { op: 'format', sheet: 'Robot', range: 'A2', style: { i: true, color: '#5f6368' } },
        { op: 'resize', sheet: 'Robot', rows: { 1: 40 }, cols: { B: 170, E: 120 } },
      ]);
      return 'Open: <BASE>/#demo';
    },
  },
  {
    title: 'Named tables and structured formulas',
    features: ['named tables', 'Table[Column] refs', 'COUNTIF / SUM', 'borders', 'agent focus box'],
    look: 'Two tables (blue name chips). C12/C13 compute from them. A purple box shows where the agent works.',
    async run(c) {
      await c.ops([
        { op: 'set', sheet: 'Robot', range: 'B4', values: [['Task', 'Status', 'Owner', 'Due'], ['Build the chassis', 'done', 'Sam', '2026-11-02'], ['Wire the servos', 'open', 'Alex', '2026-11-06'], ['Speech recognition', 'open', 'Alex', '2026-11-12'], ['Name the robot', 'open', 'Sam', '2026-11-20'], ['Battery test', 'late', 'Sam', '2026-11-01']] },
        { op: 'table', sheet: 'Robot', name: 'Tasks', range: 'B4:E9' },
        { op: 'set', sheet: 'Robot', range: 'H4', values: [['Part', 'Price', 'Qty', 'Total'], ['Servo', 12.5, 4, '=I5*J5'], ['Battery', 24.9, 2, '=I6*J6'], ['Pi', 89, 1, '=I7*J7']] },
        { op: 'table', sheet: 'Robot', name: 'Parts', range: 'H4:K7' },
        { op: 'set', sheet: 'Robot', cells: { B12: 'Open tasks', C12: '=COUNTIF(Tasks[Status],"open")', B13: 'Parts cost', C13: '=SUM(Parts[Total])', B14: 'Budget', C14: '250' } },
        { op: 'borders', sheet: 'Robot', range: 'B12:C14', type: 'outer', style: 'medium', color: '#188038' },
        { op: 'format', sheet: 'Robot', range: 'C12:C14', style: { b: true } },
      ]);
      await c.call('POST', '/api/focus', { doc: DOC, by: 'demo', sheet: 'Robot', range: 'B12:C14', label: 'formulas over tables' });
    },
  },
  {
    title: 'The agent edits records; you see what changed',
    features: ['record updates', 'change feed', 'recalc diffs', 'agent flash'],
    look: 'Cells flash purple; the open-tasks count drops. Below: the change feed the agent reads.',
    async run(c) {
      const v = +/ok v(\d+)/.exec(await c.ops([{ op: 'updateRows', table: 'Tasks', key: 'Wire the servos', set: { Status: 'done' } }]))[1];
      await c.ops([{ op: 'appendRows', table: 'Tasks', rows: [{ Task: 'Paint it', Status: 'open', Owner: 'Alex', Due: '2026-11-25' }] }]);
      return 'What the agent reads (cm changes):\n' + String(await c.get(`/api/changes?doc=demo&since=${v - 1}&format=text`)).trim();
    },
  },
  {
    title: 'Cut & paste: references follow (one move op)',
    features: ['move semantics', 'formula rewrite', 'tables move with cells'],
    look: 'The summary block jumps to F12; its formulas still work; history shows one MOVE.',
    async run(c) {
      await c.ops([{ op: 'move', sheet: 'Robot', from: 'B12:C14', to: 'G12' }]);
      return String(await c.get('/api/read?doc=demo&range=Robot!G12:H14')).trim();
    },
  },
  {
    title: 'SQL over tables — both ways',
    features: ['SQL SELECT/JOIN', 'SQL write-back', 'SQL into a new table'],
    look: 'A StatusMix table appears on Dashboard (made by SQL). Sam\'s late task became open (write-back).',
    async run(c) {
      const q = await c.call('POST', '/api/sql?doc=demo', { doc: DOC, sql: 'SELECT Owner, COUNT(*) AS n FROM Tasks GROUP BY Owner ORDER BY n DESC' });
      await c.call('POST', '/api/sql?doc=demo', { doc: DOC, sql: "UPDATE Tasks SET Status='open' WHERE Status='late'", write: true, by: 'demo' });
      await c.call('POST', '/api/sql?doc=demo', { doc: DOC, sql: 'SELECT Status, COUNT(*) AS count FROM Tasks GROUP BY Status', into: { name: 'StatusMix', at: 'Dashboard!B30' }, by: 'demo' });
      return typeof q === 'string' ? q : JSON.stringify(q).slice(0, 400);
    },
  },
  {
    title: 'Charts and KPIs (a small tile, two figures)',
    features: ['column/pie charts', 'KPI', 'dual-value KPI', 'KPI tiles'],
    look: 'Dashboard: a column chart of part prices, a pie of task status, KPIs incl. “open · cost”.',
    async run(c) {
      await c.ops([
        { op: 'set', sheet: 'Dashboard', cells: { B2: 'Robot dashboard' } },
        { op: 'format', sheet: 'Dashboard', range: 'B2', style: { fs: 32, b: true, ff: 'display' } },
        { op: 'addChart', sheet: 'Dashboard', id: 'kOpen', type: 'kpi', value: 'Robot!H12', title: 'Open tasks', at: 'B5' },
        { op: 'addChart', sheet: 'Dashboard', id: 'kCost', type: 'kpi', value: 'Robot!H13', title: 'Parts cost €', at: 'E5' },
        { op: 'addChart', sheet: 'Dashboard', id: 'kDuo', type: 'kpi', value: 'Robot!H12', value2: 'Robot!H13', label2: 'cost €', title: 'Open · cost', at: 'H5' },
        { op: 'addChart', sheet: 'Dashboard', id: 'cParts', type: 'column', table: 'Parts', x: 'Part', y: ['Price'], title: 'Part prices', at: 'B12' },
        { op: 'addChart', sheet: 'Dashboard', id: 'cStatus', type: 'pie', table: 'StatusMix', title: 'Task status', at: 'H12' },
        { op: 'liveLayout', spans: { 'Dashboard::chart:kOpen': { span: 0.5 } } },
      ]);
    },
  },
  {
    title: 'Traffic lights',
    features: ['conditional formatting', 'formula thresholds', 'status words'],
    look: 'Robot: Status cells green/amber, the Total column lights by price; the open-tasks cell turns red above 2.',
    async run(c) {
      await c.ops([
        { op: 'cond', sheet: 'Robot', range: 'C5:C10', rules: [{ when: '=', value: 'done', light: 'green' }, { when: '=', value: 'open', light: 'amber' }, { when: '=', value: 'late', light: 'red' }] },
        { op: 'cond', sheet: 'Robot', range: 'K5:K7', rules: [{ when: '<', value: 40, light: 'green' }, { when: 'between', value: 40, value2: 80, light: 'amber' }, { when: '>', value: 80, light: 'red' }] },
        { op: 'cond', sheet: 'Robot', range: 'H12', rules: [{ when: '<=', value: 2, light: 'green' }, { when: '>', value: 2, light: 'red' }] },
      ]);
    },
  },
  {
    title: 'SVG visuals: cells, cards, and a pack made from the spec',
    features: ['=VIZ() in cells', 'visual cards', 'built-in packs', 'installing a pack', 'validation'],
    look: 'Sensors: a status column of icons; Dashboard: gauge, lamp, weather, battery and the new “Demo water tank”.',
    async run(c) {
      const bad = await fetch(c.base + '/api/viz?dry=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...TANK, svg: '<svg><script>x</script></svg>' }) }).then((r) => r.json()).then((j) => j.errors.join('; '));
      await c.call('POST', '/api/viz', { pack: TANK, by: 'demo' }).catch(async () => { await c.call('DELETE', '/api/viz?id=demo-tank'); return c.call('POST', '/api/viz', { pack: TANK, by: 'demo' }); });
      await c.ops([
        { op: 'set', sheet: 'Sensors', range: 'A3', values: [['Sensor', 'Value', 'State', 'Icon'], ['Battery', 72, 'ok', '=VIZ("status",C4)'], ['Load', 35, 'ok', '=VIZ("status",C5)'], ['Robot on', 1, 'ok', '=VIZ("lamp",B6)'], ['Weather', 'sunny', 'warn', '=VIZ("weather",B7)'], ['Tank', 64, 'ok', '=VIZ("demo-tank",B8)']] },
        { op: 'table', sheet: 'Sensors', name: 'Sensors', range: 'A3:D8' },
        { op: 'resize', sheet: 'Sensors', rows: { 4: 34, 5: 34, 6: 34, 7: 34, 8: 34 } },
        { op: 'addChart', sheet: 'Dashboard', id: 'vGauge', type: 'viz', pack: 'gauge', value: 'Sensors!B5', title: 'Load', at: 'B22' },
        { op: 'addChart', sheet: 'Dashboard', id: 'vLamp', type: 'viz', pack: 'lamp', value: 'Sensors!B6', title: 'Robot on', at: 'E22' },
        { op: 'addChart', sheet: 'Dashboard', id: 'vWx', type: 'viz', pack: 'weather', value: 'Sensors!B7', title: 'Weather', at: 'H22' },
        { op: 'addChart', sheet: 'Dashboard', id: 'vBatt', type: 'viz', pack: 'battery', value: 'Sensors!B4', title: 'Battery', at: 'K22' },
        { op: 'addChart', sheet: 'Dashboard', id: 'vTank', type: 'viz', pack: 'demo-tank', value: 'Sensors!B8', title: 'Tank', at: 'K12' },
      ]);
      return 'A broken pack is refused with reasons:\n  ' + String(bad).replace(/.*Invalid pack: /, '').split('; ').join('\n  ');
    },
  },
  {
    title: 'History: who changed what (follows moves)',
    features: ['cell history', 'table history', 'attribution'],
    look: 'Below: the open-tasks cell\'s history across the move, and the Tasks table\'s history. In the grid: right-click → History of…',
    async run(c) {
      const a = await c.get('/api/history?doc=demo&cell=Robot!H12');
      const b = await c.get('/api/history?doc=demo&table=Tasks');
      return String(a).split('\n').slice(0, 6).join('\n') + '\n' + String(b).split('\n').slice(0, 6).join('\n');
    },
  },
  {
    title: 'Milestones and diffs',
    features: ['milestones', 'move-aware diff', 'restore (not run)'],
    look: 'History panel → a milestone “demo: before the show”. The diff below lists only what changed since.',
    async run(c) {
      await c.call('POST', '/api/commit', { doc: DOC, message: 'demo: before the show', by: 'demo' });
      await c.ops([{ op: 'set', sheet: 'Sensors', cells: { B5: 48 } }]);
      return String(await c.get('/api/diff?doc=demo&from=last')).split('\n').slice(0, 8).join('\n');
    },
  },
  {
    title: 'Live: the combined dashboard',
    features: ['Live mode', 'combined layout', 'shader background', 'presence in Live'],
    look: 'Your screen switches to Live: every table, chart, KPI and visual of the workbook, composed on glass.',
    async run(c, o) { await c.present({ sheet: 'Dashboard', mode: 'auto' }, o.screen); },
  },
  {
    title: 'Real time: values glide, effects show change',
    features: ['real-time updates', 'morph', 'scramble', 'vapor rows', 'gauge needle', 'lamp', 'weather states'],
    look: 'Watch: numbers roll (morph), text churns (scramble), a row condenses in and evaporates (vapor), the needle swings, the lamp switches, the weather changes.',
    async run(c) {
      await c.ops([{ op: 'set', sheet: 'Sensors', cells: { B5: 91 } }, { op: 'set', sheet: 'Robot', cells: { I6: 31.5 } }]); await sleep(1800);
      await c.ops([{ op: 'liveLayout', fx: 'scramble' }, { op: 'updateRows', table: 'Tasks', key: 'Name the robot', set: { Owner: 'Robotti' } }]); await sleep(1800);
      await c.ops([{ op: 'set', sheet: 'Sensors', cells: { B6: 0, B7: 'rain' } }]); await sleep(1800);
      await c.ops([{ op: 'liveLayout', fx: 'vapor' }, { op: 'appendRows', table: 'Tasks', rows: [{ Task: 'Evaporating task', Status: 'open', Owner: 'demo' }] }]); await sleep(2200);
      await c.ops([{ op: 'removeRows', table: 'Tasks', key: 'Evaporating task' }]); await sleep(1500);
      await c.ops([{ op: 'liveLayout', fx: null }, { op: 'set', sheet: 'Sensors', cells: { B6: 1, B7: 'sunny', B5: 40 } }]);
    },
  },
  {
    title: 'Card looks: glass → outline → clear (per card too)',
    features: ['card styles', 'table lines', 'per-card overrides'],
    look: 'Cards lose their glass, then their frames: content floats on the background. Tables switch to a grid, then no lines. The pie keeps its glass (a per-card override).',
    async run(c) {
      await c.ops([{ op: 'liveLayout', cards: 'outline', lines: 'grid' }]); await sleep(2500);
      await c.ops([{ op: 'liveLayout', cards: 'clear', lines: 'none', styles: { 'chart:cStatus': { card: 'glass' } } }]); await sleep(3000);
      await c.ops([{ op: 'liveLayout', cards: null, lines: null, styles: null }]);
    },
  },
  {
    title: 'Themes and fonts',
    features: ['13 shader themes', 'Live fonts'],
    look: 'The background changes a few times; the typeface switches to serif, then back.',
    async run(c) {
      for (const t of ['ocean', 'ember', 'neuro', 'aurora']) { await c.ops([{ op: 'view', sheet: 'Dashboard', theme: t, font: t === 'ember' ? 'serif' : null }]); await sleep(1800); }
    },
  },
  {
    title: 'Focus a card · agent panel · reserved space',
    features: ['focus mode', 'agent panels', 'slots (logo space)', 'relation lines'],
    look: 'The pie fills the screen, then back. An “Agent summary” panel appears on top; dashed lines connect tables that share values.',
    async run(c, o) {
      await c.present({ sheet: 'Dashboard', mode: 'auto', focus: 'chart:cStatus' }, o.screen); await sleep(3000);
      await c.present({ action: 'unfocus' }, o.screen);
      await c.ops([{ op: 'panel', id: 'brief', title: 'Agent summary', text: '**3 tasks open.**\n- Next: speech recognition\n- Parts within budget', span: 1 }]);
      await c.ops([{ op: 'liveLayout', links: null }]);
    },
  },
  {
    title: 'Slides: a deck made of views',
    features: ['slides', 'title slides', 'card filters', 'image/SVG backgrounds', 'dither shader', 'adaptive ink'],
    look: 'A slideshow starts: a title slide, KPIs only, then a bright background (text turns dark), then a dithered one.',
    async run(c, o) {
      const asset = await fetch(c.base + '/api/assets', { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: BRIGHT }).then((r) => r.json());
      await c.ops([
        { op: 'slide', id: 'd1', title: 'Robot build', text: 'Week 45 — where we are', cards: [], duration: 5 },
        { op: 'slide', id: 'd2', title: 'The numbers', sheet: 'Dashboard', mode: 'auto', cards: ['kOpen', 'kCost', 'vGauge', 'vLamp'], duration: 6 },
        { op: 'slide', id: 'd3', title: 'On a bright background', sheet: 'Dashboard', mode: 'auto', cards: ['kDuo', 'cParts', 'vWx'], bg: { image: asset.url }, duration: 6 },
        { op: 'slide', id: 'd4', title: 'Dithered', sheet: 'Dashboard', mode: 'auto', cards: ['vBatt', 'vTank'], bg: { image: asset.url, filter: 'dither' }, duration: 6 },
      ]);
      await c.present({ slide: 1 }, o.screen);
    },
  },
  {
    title: 'Remote control',
    features: ['screens', 'remote actions', 'card carousel', '/remote phone page'],
    look: 'Open <BASE>/remote on a phone. The demo now steps the show from “outside”: next, next, pause, overview.',
    async run(c, o) {
      for (const a of ['next', 'next', 'pause', 'unfocus']) { await c.present({ action: a }, o.screen); await sleep(2200); }
      return String(await c.get('/api/screens'));
    },
  },
  {
    title: 'Someone else is here',
    features: ['multi-user presence', 'names and colors', 'tab dots', 'edits in their color'],
    look: 'Press Esc to leave Live. A user “Demo Bot” appears in the top bar, walks across Robot!B5:B10 and edits a cell in orange.',
    async run(c) {
      const me = { id: 'demo-bot', name: 'Demo Bot', color: '#e8710a', doc: DOC, sheet: 'Robot' };
      for (const r of [5, 6, 7, 8, 9]) { await c.call('POST', '/api/presence', { ...me, active: `B${r}`, ranges: [`B${r}:E${r}`] }); await sleep(700); }
      await c.ops([{ op: 'set', sheet: 'Robot', cells: { E8: '2026-11-15' } }], { by: 'user', who: 'Demo Bot', color: '#e8710a' });
      await sleep(1500);
      await c.call('POST', '/api/presence', { id: 'demo-bot', leave: true });
    },
  },
  {
    title: 'Atomic undo of an agent batch',
    features: ['atomic batches', 'exact inverses', 'Ctrl+Z for whole batches'],
    look: 'Three changes land at once (one version), then disappear at once.',
    async run(c) {
      const r = await c.call('POST', '/api/ops', { doc: DOC, by: 'demo', wantInverse: true, ops: [
        { op: 'set', sheet: 'Robot', cells: { G16: 'temporary', G17: '=G16&"!"' } }, { op: 'format', sheet: 'Robot', range: 'G16:G17', style: { fill: '#fff2cc' } },
      ] });
      await sleep(2500);
      await c.call('POST', '/api/ops', { doc: DOC, by: 'demo', ops: r.inverse });
      return `batch v${r.version} undone with ${r.inverse.length} inverse ops`;
    },
  },
  {
    title: 'Documents out',
    features: ['export to Markdown/HTML', 'JSON tables'],
    look: 'Below: the Robot sheet exported as Markdown (title, tables, values) — the same is available as HTML.',
    async run(c) { return String(await c.get('/api/export?doc=demo&sheet=Robot&format=md')).split('\n').slice(0, 18).join('\n'); },
  },
  {
    title: 'Done',
    features: [],
    look: 'That was the tour. The demo workbook stays — explore it, or run the tour again (it rebuilds from scratch). See FEATURES.md for the full checklist.',
    async run() {},
  },
];

/** Run one step (0-based). Returns text to show (may be empty). */
export async function runStep(base, i, o = {}) {
  const c = { ...client(base), base };
  const s = STEPS[i];
  if (!s) throw new Error(`No step ${i + 1} (1–${STEPS.length})`);
  const out = await s.run(c, o);
  return (out ? String(out) : '').replaceAll('<BASE>', base);
}
export const listSteps = () => STEPS.map((s, i) => `${String(i + 1).padStart(2)}. ${s.title}\n    shows: ${s.features.join(', ') || '—'}`).join('\n');
