// Browser end-to-end tests: grid, multi-user, history, Live, slides, adaptive ink, flip, relations, phone.
// Needs Playwright + Chromium:   node tests/e2e/run.cjs        (npm run e2e)
// Starts its own server on a free port with a throw-away data directory.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');

const ROOT = path.resolve(__dirname, '../..');
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'spread-e2e');
const ONLY = process.argv[2];
const GIF = Buffer.from('R0lGODlhQAAkAIEAAPr16wAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAQAAkAAAITwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh2qMSAAIfkEARQAAQAsAAAAAEAAJACB8Ob6AAAAAAAAAAAACE8AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4c+rcybOnz59AgwodqjEgADs=', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#0b1026"/><circle cx="80" cy="45" r="20" fill="#ff4f6d"><animate attributeName="r" values="10;30;10" dur="2s" repeatCount="indefinite"/></circle></svg>';

const SPLIT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" preserveAspectRatio="none"><rect width="100" height="50" fill="#808080"/><rect width="38" height="50" fill="#fbfaf7"/><rect x="62" width="38" height="50" fill="#0a0c1c"/></svg>';
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-e2e-data-'));
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CANVAS_DATA: data }, stdio: 'pipe' });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/help'); break; } catch { await sleep(100); } }
  const api = async (method, p, body, type) => {
    const r = await fetch(B + p, { method, headers: body !== undefined ? { 'content-type': type || 'application/json' } : {}, body: body === undefined ? undefined : type ? body : JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t}`);
    try { return JSON.parse(t); } catch { return t; }
  };
  const ops = (o, by = 'agent') => api('POST', '/api/ops', { by, ops: o });
  const cellRaw = async (sheet, a) => (await api('GET', '/api/doc?id=main')).doc.sheets.find((s) => s.name === sheet).cells[a]?.v;

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const results = [];
  const page = async (name, viewport = { width: 1440, height: 900 }, url = '/#main') => {
    const ctx = await browser.newContext({ viewport });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR_ABORTED/.test(m.text())) errors.push(`[${name}] console: ${m.text()}`); });
    await p.goto(B + url);
    await p.waitForSelector('.sv-canvas', { timeout: 30000, state: 'attached' });
    await sleep(600);
    return p;
  };
  const until = async (fn, ms = 15000, label = 'condition') => {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(150); }
    throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
  };
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const ok = (v, msg) => { if (!v) throw new Error(msg); };
  // the Live bar hides when the pointer is idle (like a video player): wake it first, as a user's mouse would
  const bar = async (p, sel) => {
    const v = p.viewportSize();
    await p.evaluate(() => { if (window.__cnt) return; window.__cnt = { pm: 0, mm: 0, root: 0 }; addEventListener('pointermove', (e) => { window.__cnt.pm++; window.__cnt.t = (e.target.className?.baseVal ?? e.target.className) + '|' + e.target.isConnected + '|' + !!document.querySelector('.lv')?.contains(e.target) + '|' + e.target.tagName; }, true); addEventListener('mousemove', () => window.__cnt.mm++, true); document.querySelector('.lv')?.addEventListener('pointermove', () => window.__cnt.root++); });
    // keep nudging the mouse, like a person would (a move during a view transition doesn't reach the page)
    await until(async () => {
      await p.mouse.move(v.width / 2 + Math.random() * 60, v.height - 40 - Math.random() * 6);
      return p.evaluate(() => { const r = document.querySelectorAll('.lv'); return r.length === 1 && !r[0].classList.contains('lv-idle'); });
    }, 10000, 'Live bar awake (' + sel + ')').catch(async (e) => {
      throw new Error(e.message + ' | ' + await p.evaluate(() => ({ cls: [...document.querySelectorAll('.lv')].map((x) => x.className), under: document.elementFromPoint(innerWidth / 2, innerHeight - 40)?.outerHTML.slice(0, 80), vt: document.getAnimations().filter((a) => String(a.effect?.pseudoElement || '').includes('view-transition')).slice(0, 3).map((a) => [a.effect.pseudoElement, a.playState, Math.round(a.currentTime), a.effect.getComputedTiming().duration, a.effect.getComputedTiming().iterations]), tl: Math.round(document.timeline.currentTime), hidden: document.visibilityState, cnt: window.__cnt, focus: document.hasFocus(), anims: document.getAnimations().length })).then(JSON.stringify));
    });
    await p.click(sel);
  };
  const goto = async (p, ref) => { await p.fill('.sv-name', ref); await p.press('.sv-name', 'Enter'); await sleep(150); };
  const type = async (p, ref, text) => { await goto(p, ref); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
  const lv = (p) => p.evaluate(() => {
    const r = document.querySelector('.lv');
    return r && {
      cls: r.className, dots: document.querySelector('.lv-dots')?.textContent || '', title: document.querySelector('.lv-slidetext h1')?.textContent || '',
      cards: [...document.querySelectorAll('.lv-stage > .lv-card')].map((c) => c.dataset.key),
      dark: [...document.querySelectorAll('.lv-stage > .lv-card.lv-ink-dark')].length,
    };
  });

  async function t(name, fn) {
    if (ONLY && !new RegExp(ONLY, 'i').test(name)) return;
    const t0 = Date.now();
    try { await fn(); results.push(['ok', name, Date.now() - t0]); console.log(`ok   ${name}  (${Date.now() - t0} ms)`); }
    catch (e) {
      results.push(['FAIL', name, e.message]);
      console.log(`FAIL ${name}\n     ${e.message.split('\n').filter((l) => !/^\s*-\s*(waiting|retrying|attempting)|×/.test(l)).slice(0, 8).join('\n     ')}`);
      for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) await pg.screenshot({ path: path.join(SHOTS, `fail-${name.slice(0, 20).replace(/\W+/g, '_')}-${i}.png`), timeout: 20000 }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- seed: slides + assets
  const gif = (await api('POST', '/api/assets', GIF, 'image/gif')).url;
  const svg = (await api('POST', '/api/assets', SVG, 'image/svg+xml')).url;
  const split = (await api('POST', '/api/assets', SPLIT, 'image/svg+xml')).url;
  await ops([
    { op: 'slide', id: 'title', title: 'Robot build', text: 'Where we are, **what is blocked**', cards: [], duration: 0 },
    { op: 'slide', id: 'kpis', title: 'KPIs', sheet: 'Dashboard', mode: 'auto', cards: ['kpiOpen', 'status', 'Tasks'], duration: 0 },
    { op: 'slide', id: 'bright', title: 'Bright GIF', sheet: 'Dashboard', mode: 'auto', cards: ['kpiOpen', 'parts'], bg: { image: gif }, duration: 0 },
    { op: 'slide', id: 'dither', title: 'Dithered', mode: 'auto', cards: ['parts'], bg: { image: gif, filter: 'dither' }, duration: 0 },
    { op: 'slide', id: 'halftone', title: 'Halftone', mode: 'auto', cards: ['kpiOpen'], bg: { image: gif, filter: 'halftone' }, duration: 0 },
    { op: 'slide', id: 'svg', title: 'Animated SVG', cards: [], bg: { image: svg }, duration: 0 },
    { op: 'slide', id: 'split', title: 'Split', mode: 'auto', cards: ['kpiOpen', 'kpiCost', 'status'], bg: { image: split }, duration: 0 },
  ]);

  // ================================================================ grid + multi-user
  let A, Bp;
  await t('grid boots without errors; identity chip present', async () => {
    A = await page('alice');
    await A.evaluate(() => { localStorage.setItem('spread.user', JSON.stringify({ id: 'ua', name: 'Alice', color: '#e8710a' })); });
    await A.reload(); await A.waitForSelector('.sv-canvas'); await sleep(500);
    eq(await A.locator('#people .av.me').textContent(), 'A', 'my avatar initial');
  });

  await t('two users see each other (avatars, tab dots, server presence)', async () => {
    Bp = await page('bob');
    await Bp.evaluate(() => localStorage.setItem('spread.user', JSON.stringify({ id: 'ub', name: 'Bob', color: '#1a73e8' })));
    await Bp.reload(); await Bp.waitForSelector('.sv-canvas'); await sleep(500);
    await goto(Bp, 'Project!C8');
    await until(async () => (await api('GET', '/api/presence?format=json')).some((p) => p.name === 'Bob' && p.active === 'C8' && p.sheet === 'Project'), 6000, 'Bob presence on server');
    await until(() => A.locator('#people .av:not(.me)[title^="Bob"]').count(), 6000, 'Bob avatar for Alice');
    await until(() => A.locator('.sv-tab .pdot').count(), 6000, 'tab dot for Bob');
    const people = await api('GET', '/api/presence');
    ok(/Alice/.test(people) && /Bob .*Project!C8/.test(people), 'cm people text: ' + people);
  });

  await t('edit by one user appears live for the other, attributed', async () => {
    await type(A, 'Budget!G2', 'from alice');
    await until(async () => (await cellRaw('Budget', 'G2')) === 'from alice', 6000, 'server has G2');
    await goto(Bp, 'Budget!G2');
    await until(async () => (await Bp.inputValue('.sv-fx')) === 'from alice', 6000, 'Bob sees G2 in formula bar');
    const feed = await api('GET', '/api/changes?since=0');
    ok(/user \(Alice\)/.test(feed), 'feed attributes Alice');
  });

  await t('undo is atomic: a multi-cell paste reverts with one Ctrl+Z', async () => {
    await goto(A, 'Settings!D1');
    await A.evaluate(() => {
      const dt = new DataTransfer(); dt.setData('text/plain', '1\t2\t3\n4\t5\t6');
      document.querySelector('.sv-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await until(async () => (await cellRaw('Settings', 'F2')) === '6', 6000, 'paste landed');
    await A.keyboard.press('Control+z');
    await until(async () => (await cellRaw('Settings', 'D1')) === undefined && (await cellRaw('Settings', 'F2')) === undefined, 6000, 'paste undone');
    await A.keyboard.press('Control+y');
    await until(async () => (await cellRaw('Settings', 'E1')) === '2', 6000, 'paste redone');
  });

  await t('cell history popover follows a move', async () => {
    await type(A, 'Budget!H2', 'v1');
    await type(A, 'Budget!H2', 'v2');
    await ops([{ op: 'move', sheet: 'Budget', from: 'H2', to: 'J5' }], 'agent');
    await until(async () => (await cellRaw('Budget', 'J5')) === 'v2', 6000, 'move');
    await goto(A, 'Budget!J5');
    await sleep(300);
    const box = await A.evaluate(() => { const c = document.querySelector('.sv-editor').getBoundingClientRect(); return { x: c.left + 10, y: c.top + 8 }; });
    await A.mouse.click(box.x, box.y, { button: 'right' });
    await A.locator('.menu .it', { hasText: 'History of J5' }).click();
    await A.waitForSelector('.histpop .hp-r');
    const rows = await A.locator('.histpop .hp-x').allTextContents();
    ok(rows.length === 3 && /moved/.test(rows[0]) && /v1 → v2/.test(rows[1]) && /∅ → v1/.test(rows[2]), 'history rows: ' + JSON.stringify(rows));
    ok((await A.locator('.histpop .hp-w').first().textContent()) === 'agent', 'move attributed to agent');
    await A.keyboard.press('Escape');
  });

  await t('table history from the context menu', async () => {
    await ops([{ op: 'updateRows', table: 'Tasks', key: 'Wire the servos', set: { Status: 'done' } }]);
    await goto(A, 'Project!C8');
    await sleep(300);
    const box = await A.evaluate(() => { const c = document.querySelector('.sv-editor').getBoundingClientRect(); return { x: c.left + 10, y: c.top + 8 }; });
    await A.mouse.click(box.x, box.y, { button: 'right' });
    await A.locator('.menu .it', { hasText: 'History of table Tasks' }).click();
    await A.waitForSelector('.histpop .hp-r');
    ok(/open → done/.test(await A.locator('.histpop').textContent()), 'table history shows the status change');
    await A.keyboard.press('Escape');
  });

  // ================================================================ Live
  let L;
  await t('Live combined: relation lines, real-time KPI update', async () => {
    L = await page('live', { width: 1440, height: 900 }, '/?live=Dashboard&mode=auto#main');
    await until(async () => (await lv(L))?.cards.length > 4, 10000, 'combined cards');
    await until(() => L.locator('g.lv-link-line').count(), 6000, 'relation lines');
    const fit = await L.locator('.lv-bar').evaluate((b) => [b.scrollWidth, b.clientWidth]);
    ok(fit[0] <= fit[1] + 1, 'bar fits at 1440px without scrolling: ' + fit);
    // theme picker: collapsed to the current swatch, opens on click, picks, collapses
    eq(await L.locator('.lv-themes .lv-dot:visible').count(), 1, 'one swatch visible');
    await bar(L, '.lv-themes .lv-dot.on');
    ok((await L.locator('.lv-themes .lv-dot:visible').count()) > 5, 'theme row open');
    await bar(L, '.lv-themes .lv-dot[data-t=ocean]');
    await until(async () => (await api('GET', '/api/doc?id=main')).doc.sheets.find((x) => x.name === 'Dashboard').view?.theme === 'ocean', 5000, 'theme saved');
    eq(await L.locator('.lv-themes .lv-dot:visible').count(), 1, 'collapsed again');
    const labels = await L.locator('g.lv-link-line text').allTextContents();
    ok(labels.some((x) => /data/.test(x)), 'lineage line (table → chart): ' + JSON.stringify(labels));
    const kpi = L.locator('.lv-card[data-key="Dashboard::chart:kpiOpen"] .lv-num');
    const before = await kpi.textContent();
    await ops([{ op: 'appendRows', table: 'Tasks', rows: [{ Task: 'Test the battery', Status: 'open', Owner: 'Sam' }] }]);
    await until(async () => (await kpi.textContent()) === String(+before + 1), 6000, `KPI ${before} → ${+before + 1}`);
    // ⛓ toggles the lines off and on (stored in the workbook)
    await bar(L, '[data-a=links]');
    await until(async () => (await L.locator('g.lv-link-line').count()) === 0, 4000, 'links hidden');
    await bar(L, '[data-a=links]');
    await until(() => L.locator('g.lv-link-line').count(), 4000, 'links back');
  });

  await t('flip a card to its sheet side, with history; flip back', async () => {
    const card = L.locator('.lv-card[data-key="Project::table:Tasks"]');
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await card.locator('.lv-flip').click();
    await until(async () => (await card.getAttribute('class')).includes('lv-flipped'), 4000, 'flipped');
    const back = card.locator('.lv-back');
    ok(/Project!B6:/.test(await back.locator('.lv-back-h').textContent()), 'A1 header');
    ok(/Wire the servos/.test(await back.locator('.lv-back-g').textContent()), 'cells visible');
    const color = await back.locator('.lv-back-g td').first().evaluate((e) => getComputedStyle(e).color);
    ok(color !== 'rgba(255, 255, 255, 0.95)' && color !== 'rgb(255, 255, 255)', 'back side text is readable (not white): ' + color);
    await until(async () => /→ Test the battery/.test(await back.locator('.lv-back-hist').textContent()), 8000, 'history on the back (the row appended by the previous test)');
    // still flipped after a live update
    await ops([{ op: 'updateRows', table: 'Tasks', key: 'Name the robot', set: { Owner: 'Alex' } }]);
    await sleep(800);
    ok((await card.getAttribute('class')).includes('lv-flipped'), 'stays flipped across updates');
    ok(/Alex/.test(await back.locator('.lv-back-g').textContent()), 'back side updates live');
    await card.locator('.lv-flip').click();
    await until(async () => !(await card.getAttribute('class')).includes('lv-flipped'), 6000, 'flipped back').catch(async (e) => {
      throw new Error(e.message + ' | ' + await L.evaluate(() => { const c = document.querySelector('.lv-card[data-key="Project::table:Tasks"]'); return JSON.stringify({ n: document.querySelectorAll('.lv-card[data-key="Project::table:Tasks"]').length, cls: c.className, backs: c.querySelectorAll('.lv-back').length, anims: c.getAnimations().map((a) => a.playState) }); }));
    });
  });

  await t('Live: edit a value in a table card; formulas and structure stay locked', async () => {
    const card = L.locator('.lv-card[data-key="Project::table:Tasks"]');
    await card.scrollIntoViewIfNeeded();
    const td = card.locator('tbody tr').nth(2).locator('td').nth(2);           // Speech recognition → Owner
    eq(await td.textContent(), 'Alex', 'cell text');
    await td.click();
    await L.keyboard.press('Control+a');
    await L.keyboard.type('Sam');
    await L.keyboard.press('Enter');
    await until(async () => (await cellRaw('Project', 'D9')) === 'Sam', 5000, 'Project!D9 = Sam');
    // KPI cards are computed: not editable; budget table's Total column is formulas: not editable
    const budget = L.locator('.lv-card[data-key="Budget::table:Budget"], .lv-card[data-key="Budget::range"]').first();
    const totals = await budget.locator('tbody td').evaluateAll((tds) => tds.map((t) => t.contentEditable));
    ok(totals.includes('false') && totals.includes('plaintext-only'), 'formula cells locked, values editable: ' + JSON.stringify(totals.slice(0, 10)));
    // Escape while editing must not close Live
    await td.click(); await L.keyboard.press('Escape');
    ok(await L.locator('.lv').count(), 'Live still open');
  });

  await t('Bob sees that Alice is in Live', async () => {
    await A.evaluate(() => { const u = new URL(location.href); u.searchParams.set('live', 'Dashboard'); history.replaceState(null, '', u); });
    await A.reload(); await A.waitForSelector('.lv');
    await until(async () => (await api('GET', '/api/presence?format=json')).find((p) => p.name === 'Alice')?.live, 6000, 'Alice live in presence');
    await until(async () => /in Live/.test(await Bp.locator('#people .av[title^="Alice"]').getAttribute('title')), 6000, 'Bob sees "in Live"');
    await until(() => A.locator('.lv-people b[title^="Bob"]').count(), 6000, 'Bob avatar in Alice\'s Live');
    await A.keyboard.press('Escape');
    await until(async () => !(await A.locator('.lv').count()), 4000, 'Alice left Live');
    for (const p of [A, Bp, L]) await p.context().close();
  });

  // ================================================================ slides
  let S;
  await t('slideshow: title slide, keys, card filter, Esc', async () => {
    S = await page('slides', { width: 1440, height: 900 }, '/?slides=1#main');
    await until(async () => (await lv(S))?.title === 'Robot build', 10000, 'title slide');
    let st = await lv(S);
    ok(st.cls.includes('lv-slide-solo') && st.cls.includes('lv-playing'), 'solo + playing: ' + st.cls);
    ok(/1 \/ 7/.test(st.dots), 'dots ' + st.dots);
    ok(await S.locator('.lv-slidetext .lv-md b').count(), 'markdown bold in text');
    await S.keyboard.press('ArrowRight');
    await until(async () => (await lv(S)).title === 'KPIs', 6000, 'slide 2');
    st = await lv(S);
    eq(st.cards, ['Dashboard::chart:kpiOpen', 'Dashboard::chart:status', 'Project::table:Tasks'], 'slide 2 shows exactly its cards, in order');
    ok(!st.cls.includes('lv-slide-solo'), 'not solo');
    // cards are laid out (not stacked): distinct tops or lefts
    const boxes = await S.locator('.lv-stage > .lv-card').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.height)]; }));
    ok(new Set(boxes.map((b) => b[0] + ',' + b[1])).size === boxes.length && boxes.every((b) => b[2] > 60), 'cards laid out: ' + JSON.stringify(boxes));
    await S.keyboard.press('ArrowLeft');
    await until(async () => (await lv(S)).title === 'Robot build', 6000, 'back to 1');
    await S.keyboard.press('ArrowLeft');
    await until(async () => (await lv(S)).title === 'Split', 6000, 'wraps to last');
    await S.keyboard.press('Space');
    await until(async () => (await lv(S)).title === 'Robot build', 6000, 'space = next, wraps to first');
    await S.keyboard.press('Escape');
    await until(async () => { const s = await lv(S); return s && !s.cls.includes('lv-playing') && !s.title; }, 4000, 'Esc leaves the slide but stays in Live');
    await S.keyboard.press('Escape');
    await until(async () => !(await lv(S)), 4000, 'second Esc closes Live');
  });

  await t('adaptive ink: dark text on a bright GIF, light text on a dark shader', async () => {
    await api('POST', '/api/present', { slide: 3 });
    await until(async () => (await lv(S))?.title === 'Bright GIF', 20000, 'bright slide via present');
    let st = await lv(S);
    ok(st.cls.includes('lv-has-bgimg'), 'image background');
    eq(await S.locator('.lv-bgimg img').getAttribute('src'), gif, 'GIF is the <img> (animates natively)');
    await until(async () => (await lv(S)).dark === (await lv(S)).cards.length && (await lv(S)).cards.length === 2, 6000, 'all cards dark ink');
    await until(async () => (await S.locator('.lv-slidetext').getAttribute('class')).includes('lv-ink-dark'), 4000, 'title dark ink');
    await until(async () => (await lv(S)).cls.includes('lv-bright'), 4000, 'dots / LIVE label dark too');
    // a dark background: light ink everywhere
    await api('POST', '/api/present', { slide: 6 });
    await until(async () => (await lv(S)).title === 'Animated SVG', 15000, 'dark svg slide');
    await until(async () => !(await lv(S)).cls.includes('lv-bright') && !(await S.locator('.lv-slidetext').getAttribute('class')).includes('lv-ink-dark'), 6000, 'light ink on dark');
    // half white / half black: cards follow what is behind them
    await api('POST', '/api/present', { slide: 7 });
    await until(async () => (await lv(S)).title === 'Split', 15000, 'split slide');
    const keys = ['Dashboard::chart:kpiOpen', 'Dashboard::chart:kpiCost'];
    await until(async () => {
      const r = await S.evaluate((k) => k.map((x) => { const e = document.querySelector(`.lv-card[data-key="${x}"]`); const b = e.getBoundingClientRect(); return [b.left + b.width / 2 < innerWidth * 0.38 ? 'L' : b.left + b.width / 2 > innerWidth * 0.62 ? 'R' : 'M', e.classList.contains('lv-ink-dark')]; }), keys);
      return r[0][0] === 'L' && r[0][1] === true && (r[1][0] !== 'R' || r[1][1] === false) ? r : false;
    }, 8000, 'left card dark ink over white');
    const cards = await S.evaluate(() => [...document.querySelectorAll('.lv-stage > .lv-card')].map((e) => { const b = e.getBoundingClientRect(); return { c: b.left + b.width / 2, dark: e.classList.contains('lv-ink-dark') }; }));
    ok(cards.length === 3 && cards.some((c) => c.c > 1440 * 0.7), 'three cards, one over the dark side: ' + JSON.stringify(cards));
    for (const c of cards) {
      if (c.c < 1440 * 0.3) ok(c.dark, 'card over white is dark ink');
      if (c.c > 1440 * 0.7) ok(!c.dark, 'card over black is light ink');
    }
    await until(async () => (await S.locator('.lv-slidetext').getAttribute('class')).includes('lv-ink-dark'), 6000, 'title over white is dark ink');
    await sleep(1200);
    await S.screenshot({ path: path.join(SHOTS, 'split-ink.png') });
  });

  await t('dither / halftone / animated SVG backgrounds render without errors', async () => {
    const before = errors.length;
    for (const [n, title] of [[4, 'Dithered'], [5, 'Halftone'], [6, 'Animated SVG']]) {
      await api('POST', '/api/present', { slide: n });
      await until(async () => (await lv(S)).title === title, 8000, title);
      await sleep(700);
      const st = await lv(S);
      if (n < 6) {
        ok(!st.cls.includes('lv-has-bgimg'), `${title}: shader, not plain image`);
        const px = await S.evaluate(() => { const c = document.querySelector('.lv-bg canvas'); const p = document.createElement('canvas'); p.width = p.height = 4; const g = p.getContext('2d'); g.drawImage(c, 0, 0, 4, 4); return [...g.getImageData(0, 0, 4, 4).data].filter((_, i) => i % 4 === 3).some((a) => a > 0); });
        ok(px, `${title}: shader canvas drew something`);
      } else {
        ok(st.cls.includes('lv-has-bgimg') && st.cls.includes('lv-slide-solo'), 'svg: image bg + solo');
        eq(await S.locator('.lv-bgimg img').getAttribute('src'), svg, 'svg src');
      }
    }
    ok(errors.length === before, 'no new errors: ' + errors.slice(before).join(' | '));
    await S.screenshot({ path: path.join(SHOTS, 'svg-slide.png') });
  });

  await t('auto-advance by duration; touching the bar leaves the show', async () => {
    await ops([{ op: 'slide', id: 'title', duration: 1 }]);
    await api('POST', '/api/present', { slide: 1 });
    let seen = [];
    await until(async () => { const st = await lv(S); seen.push(st.title + '@' + st.dots); return st.title === 'KPIs'; }, 15000, 'advanced from 1 to 2 by itself')
      .catch(async (e) => { throw new Error(e.message + ' seen: ' + [...new Set(seen)].join(', ') + ' | ' + await S.evaluate(() => document.querySelector('.lv').className) + ' | slides: ' + JSON.stringify((await api('GET', '/api/doc?id=main')).doc.live.slides.map((x) => x.id + ':' + x.duration))); });
    await bar(S, '.lv-modes [data-m=sheet]');
    await until(async () => { const s = await lv(S); return !s.cls.includes('lv-playing') && !s.title; }, 4000, 'left the show');
    await ops([{ op: 'slide', id: 'title', duration: 0 }]);
  });

  await t('slides panel: add view, rename, set background, reorder, delete — all on the server', async () => {
    await bar(S, '[data-a=slides]');
    await S.waitForSelector('.lv-slides-open .lv-sl');
    const n0 = await S.locator('.lv-sl').count();
    await S.click('[data-s=add]');
    await until(async () => (await api('GET', '/api/doc?id=main')).doc.live.slides.length === n0 + 1, 4000, 'slide added on server');
    await until(async () => (await S.locator('.lv-sl').count()) === n0 + 1, 4000, 'panel shows it');
    const last = S.locator('.lv-sl').last();
    const title = last.locator('.lv-sl-title');
    await title.click(); await S.keyboard.press('Control+a'); await S.keyboard.type('Renamed'); await S.keyboard.press('Enter');
    await until(async () => (await api('GET', '/api/doc?id=main')).doc.live.slides.at(-1).title === 'Renamed', 4000, 'title saved');
    await last.locator('input[data-k=image]').fill(gif); await last.locator('input[data-k=image]').press('Tab');
    await until(async () => (await api('GET', '/api/doc?id=main')).doc.live.slides.at(-1).bg?.image === gif, 4000, 'bg saved');
    await S.locator('.lv-sl').last().locator('select[data-k=filter]').selectOption('halftone');
    await until(async () => (await api('GET', '/api/doc?id=main')).doc.live.slides.at(-1).bg?.filter === 'halftone', 4000, 'filter saved');
    await S.locator('.lv-sl').last().locator('[data-s=up]').click();
    await until(async () => (await api('GET', '/api/doc?id=main')).doc.live.slides.at(-2).title === 'Renamed', 4000, 'moved up');
    const id = (await api('GET', '/api/doc?id=main')).doc.live.slides.at(-2).id;
    await S.locator(`.lv-sl[data-id="${id}"] [data-s=del]`).click();
    await until(async () => (await api('GET', '/api/doc?id=main')).doc.live.slides.length === n0, 4000, 'deleted');
    // the bar stays clickable next to the open panel
    const [barR, panelL] = await S.evaluate(() => [document.querySelector('.lv-bar').getBoundingClientRect().right, document.querySelector('.lv-slides').getBoundingClientRect().left]);
    ok(barR <= panelL, `bar (${barR}) clear of the panel (${panelL})`);
    await S.click('[data-s=close]');
    await until(async () => !(await lv(S)).cls.includes('lv-slides-open'), 3000, 'panel closed');
  });

  await t('drop an image file onto a slide', async () => {
    await bar(S, '[data-a=slides]');
    await S.waitForSelector('.lv-sl');
    const b64 = GIF.toString('base64');
    await S.evaluate(async (b) => {
      const bin = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bin], 'x.gif', { type: 'image/gif' }));
      const row = document.querySelector('.lv-sl[data-id="kpis"]');
      row.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      row.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await until(async () => /^\/assets\//.test((await api('GET', '/api/doc?id=main')).doc.live.slides.find((x) => x.id === 'kpis').bg?.image || ''), 5000, 'dropped image saved as bg');
    await S.click('[data-s=close]');
    await S.context().close();
  });

  // ================================================================ hostile content
  await t('HTML in cells, slide text, names and notes is shown as text, never run', async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    await ops([
      { op: 'set', sheet: 'Project', cells: { C7: evil } },
      { op: 'slide', id: 'evil', title: evil, text: `**${evil}** \`${evil}\`\n- ${evil}`, cards: ['Tasks'], mode: 'auto' },
      { op: 'panel', id: 'evilp', title: evil, text: evil },
    ]);
    await api('POST', '/api/presence', { id: 'ux', name: evil, color: '#e52592', doc: 'main', sheet: 'Project', active: 'B2' });
    const X = await page('xss', { width: 1440, height: 900 }, '/#main');
    await goto(X, 'Project!C7');
    await sleep(300);
    const box = await X.evaluate(() => { const c = document.querySelector('.sv-editor').getBoundingClientRect(); return { x: c.left + 10, y: c.top + 8 }; });
    await X.mouse.click(box.x, box.y, { button: 'right' });
    await X.locator('.menu .it', { hasText: 'History of C7' }).click();
    await X.waitForSelector('.histpop .hp-r');
    ok((await X.locator('.histpop').textContent()).includes('<img'), 'history shows the markup as text');
    await X.keyboard.press('Escape');
    const n = (await api('GET', '/api/doc?id=main')).doc.live.slides.findIndex((x) => x.id === 'evil') + 1;
    await api('POST', '/api/present', { slide: n });
    await until(async () => (await lv(X))?.title?.includes('<img'), 15000, 'evil slide shows literal title');
    const card = X.locator('.lv-card[data-key="Project::table:Tasks"]');
    await card.hover(); await card.locator('.lv-flip').click();
    await until(() => card.locator('.lv-back').count(), 5000, 'flipped');
    await sleep(1500);
    eq(await X.evaluate(() => window.__xss), undefined, 'no script ran');
    eq(await X.locator('img[src="x"]').count(), 0, 'no injected <img>');
    await X.context().close();
    await ops([{ op: 'removeSlide', id: 'evil' }, { op: 'removePanel', id: 'evilp' }, { op: 'set', sheet: 'Project', cells: { C7: 'done' } }]);
    await api('POST', '/api/presence', { id: 'ux', leave: true });
  });

  // ================================================================ phone
  await t('phone: Live and slides fit the screen', async () => {
    const P = await page('phone', { width: 390, height: 844 }, '/?live=Dashboard&mode=auto#main');
    await until(async () => (await lv(P))?.cards.length > 3, 10000, 'phone cards');
    const over = await P.evaluate(() => { const s = document.querySelector('.lv-scroll'); return s.scrollWidth - s.clientWidth; });
    ok(over <= 1, 'no horizontal overflow: ' + over);
    await bar(P, '[data-a=slides]');
    const w = await P.locator('.lv-slides').evaluate((e) => e.getBoundingClientRect().width);
    ok(w <= 390, 'slides panel fits: ' + w);
    await P.click('[data-s=close]');
    await api('POST', '/api/present', { slide: 1 });
    await until(async () => (await lv(P))?.title === 'Robot build', 6000, 'title on phone');
    const h1 = await P.locator('.lv-slidetext h1').evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= 390);
    ok(h1, 'title fits horizontally');
    await P.screenshot({ path: path.join(SHOTS, 'phone-slide.png') });
    await P.context().close();
  });

  // ---------------------------------------------------------------- done
  if (errors.length) { results.push(['FAIL', 'browser errors', errors.join('\n')]); console.log('FAIL browser errors\n     ' + errors.join('\n     ')); }
  await browser.close();
  srv.kill();
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} passed   (screenshots: ${SHOTS})`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
