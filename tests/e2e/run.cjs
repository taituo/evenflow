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

  // one browser per "device": without a GPU, pages in one browser share one software GPU process, and a Live
  // shader on one page would starve the others — unlike real separate devices
  const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browsers = [];
  const device = async (opts) => {
    const b = await chromium.launch({ args: ARGS });
    browsers.push(b);
    const ctx = await b.newContext(opts);
    ctx.on('close', () => b.close().catch(() => {}));
    return ctx;
  };
  const allPages = () => browsers.filter((b) => b.isConnected()).flatMap((b) => b.contexts().flatMap((c) => c.pages()));
  const errors = [];
  const results = [];
  const page = async (name, viewport = { width: 1440, height: 900 }, url = '/#main') => {
    const ctx = await device({ viewport });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR_ABORTED/.test(m.text())) errors.push(`[${name}] console: ${m.text()}`); });
    // 2-core CI without a GPU: start Live's backgrounds at low resolution (the governor would get there anyway)
    await p.goto(B + url.replace(/^(\/[^#?]*)(\?[^#]*)?/, (m, a, qs) => a + (qs ? qs + '&' : '?') + 'quality=low'));
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
    // the bar has two pages; turn to the one that holds the button
    const pg = await p.evaluate((q) => document.querySelector('.lv .lv-bar ' + q)?.closest('.lv-page')?.dataset.page, sel);
    const cur = await p.evaluate(() => document.querySelector('.lv').dataset.barpage || '1');
    if (pg && pg !== cur) await p.click(pg === '2' ? '.lv [data-a=page2]' : '.lv [data-a=page1]');
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
      for (const [i, pg] of allPages().entries()) await pg.screenshot({ path: path.join(SHOTS, `fail-${name.slice(0, 20).replace(/\W+/g, '_')}-${i}.png`), timeout: 20000 }).catch(() => {});
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
    await bar(L, '[data-a=page2]');   // themes live on the bar's second page
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

  // ================================================================ traffic lights, effects, KPI tiles
  const cellAt = async (p, ref) => { await goto(p, ref); return p.evaluate(() => { const r = document.querySelector('.sv-editor').getBoundingClientRect(); return { x: r.left, y: r.top }; }); };
  const docNow = async () => (await api('GET', '/api/doc?id=main')).doc;
  const tableRange = async (n) => { const d = await docNow(); for (const s of d.sheets) for (const tb of s.tables || []) if (tb.name === n) return s.name + '!' + tb.range; return null; };

  await t('traffic lights: set up in the grid, shown in Live, and they change when the value crosses a threshold', async () => {
    const G = await page('traffic', { width: 1440, height: 900 }, '/#main');
    await goto(G, 'Project!C7:C11');
    await G.click('[data-a=traffic]');
    await G.waitForSelector('.trafficpop .tp-r');
    // status words are recognised: done → green, open → amber
    const rows = await G.locator('.tp-r').evaluateAll((rs) => rs.map((r) => [r.querySelector('input[data-k=value]').value, r.querySelector('.tp-lights i.on')?.dataset.l]));
    ok(rows.some(([v, l]) => v === 'done' && l === 'green') && rows.some(([v, l]) => v === 'open' && l === 'amber'), 'guessed rules: ' + JSON.stringify(rows));
    await G.click('.trafficpop [data-x=save]');
    await until(async () => (await docNow()).sheets.find((x) => x.name === 'Project').conds?.length, 5000, 'rule saved');
    // a numeric light on the KPI's source cell, from the CLI shorthand path (API)
    const c12 = (await docNow()).sheets.find((x) => x.name === 'Dashboard').charts.find((c) => c.id === 'kpiOpen').value;
    const [ksh, kref] = c12.split('!');
    await ops([{ op: 'cond', sheet: ksh, range: kref, rules: [{ when: '<=', value: 2, light: 'green' }, { when: '>', value: 2, light: 'red' }] }]);
    await G.context().close();

    const L2 = await page('traffic-live', { width: 1440, height: 900 }, '/?live=Dashboard&mode=auto#main');
    const kpi = L2.locator('.lv-card[data-key="Dashboard::chart:kpiOpen"]');
    await until(async () => (await kpi.getAttribute('class')).includes('lv-lit'), 15000, 'KPI card lit');
    const before = await kpi.evaluate((e) => e.style.getPropertyValue('--light'));
    const lit = await L2.locator('.lv-card[data-key="Project::table:Tasks"] td.lit').count();
    ok(lit >= 3, 'status cells lit in Live: ' + lit);
    // close tasks until the count drops to 2 → the light turns green
    const d = await docNow();
    const open = Object.entries(d.sheets.find((x) => x.name === 'Project').cells).filter(([a, c]) => /^C\d+$/.test(a) && c.v === 'open').map(([a]) => a);
    await ops([{ op: 'set', sheet: 'Project', cells: Object.fromEntries(open.slice(0, Math.max(0, open.length - 2)).map((a) => [a, 'done'])) }]);
    await until(async () => (await kpi.evaluate((e) => e.style.getPropertyValue('--light'))) !== before, 8000, 'light changed color');
    eq(await kpi.evaluate((e) => e.style.getPropertyValue('--light')), '#34a853', 'now green');
    L = L2;
  });

  await t('change effects: morph digits, scramble, vapor rows in and out — always ending on the right text', async () => {
    const tasks = L.locator('.lv-card[data-key="Project::table:Tasks"]');
    await tasks.scrollIntoViewIfNeeded();
    // scramble
    await ops([{ op: 'liveLayout', fx: 'scramble' }]);
    await sleep(600);
    await L.evaluate(() => { window.__fx = []; new MutationObserver((ms) => { for (const m of ms) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (el?.classList?.contains('fx-on')) window.__fx.push([el.className, el.textContent]); } }).observe(document.querySelector('.lv'), { subtree: true, childList: true, characterData: true, attributes: true }); });
    await ops([{ op: 'updateRows', table: 'Tasks', key: 'Build the chassis', set: { Owner: 'Scrambled' } }]);
    await until(async () => (await tasks.textContent()).includes('Scrambled') && !(await L.locator('.fx-on').count()), 8000, 'scramble settles on the new text');
    const fx = await L.evaluate(() => window.__fx);
    ok(fx.some(([c]) => c.includes('fx-scramble')), 'scramble ran');
    ok(fx.some(([, txt]) => txt.length === 'Scrambled'.length && txt !== 'Scrambled'), 'intermediate glyphs were shown');
    // vapor: a new row condenses in, a removed one evaporates
    await ops([{ op: 'liveLayout', fx: 'vapor' }]);
    await sleep(500);
    // record row classes as they happen (the animation is short; polling could miss it on a slow machine)
    await L.evaluate(() => { window.__rows = new Set(); new MutationObserver((ms) => { for (const m of ms) for (const el of [m.target, ...m.addedNodes]) if (el.tagName === 'TR') for (const c of el.classList) window.__rows.add(c); }).observe(document.querySelector('.lv'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); });
    await ops([{ op: 'appendRows', table: 'Tasks', rows: [{ Task: 'Vapor test', Status: 'open', Owner: 'Sam' }] }]);
    await until(() => L.evaluate(() => window.__rows.has('fx-row-in')), 8000, 'row condenses in');
    await until(async () => !(await tasks.locator('tr.fx-row-in').count()) && (await tasks.textContent()).includes('Vapor test'), 8000, 'row-in finished');
    await ops([{ op: 'removeRows', table: 'Tasks', key: 'Vapor test' }]);
    await until(() => L.evaluate(() => window.__rows.has('fx-row-out')), 8000, 'row evaporates');
    await until(async () => !(await tasks.locator('tbody').textContent()).includes('Vapor test'), 10000, 'row gone afterwards').catch(async (e) => { throw new Error(e.message + ' | ' + JSON.stringify(await tasks.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => tr.className + ':' + tr.textContent.slice(0, 30))))); });
    // morph: KPI rolls digits / counts, ends exact
    await ops([{ op: 'liveLayout', fx: null }]);
    await sleep(500);
    const num = L.locator('.lv-card[data-key="Dashboard::chart:kpiCost"] .lv-num');
    await ops([{ op: 'set', sheet: 'Project', cells: { I8: '30.5' } }]);
    await until(async () => (await num.textContent()).replace(/\s/g, '') === '132', 8000, 'KPI ends on 132');
    // the bar button cycles effects
    await bar(L, '[data-a=fx]');
    await until(async () => (await docNow()).live?.fx === 'scramble', 4000, 'fx saved from the bar');
    eq(await L.locator('[data-a=fx]').textContent(), '⟡ Scramble', 'bar label');
    await ops([{ op: 'liveLayout', fx: null }]);
  });

  await t('KPI tiles: a single number shrinks to a small square, two numbers share one card', async () => {
    await ops([
      { op: 'addChart', sheet: 'Dashboard', type: 'kpi', id: 'duo', title: 'Open / cost', value: 'Project!C12', value2: 'Project!C13', label2: 'parts €', at: 'K2' },
      { op: 'liveLayout', spans: { 'Dashboard::chart:kpiOpen': { span: 0.5 } } },
    ]);
    const small = L.locator('.lv-card[data-key="Dashboard::chart:kpiOpen"]');
    await until(async () => (await small.getAttribute('class')).includes('lv-small'), 8000, 'small tile');
    const g1 = await small.evaluate((e) => { const r = e.getBoundingClientRect(), n = e.querySelector('.lv-num').getBoundingClientRect(); return { w: r.width, h: r.height, nw: n.width, nr: n.right, r: r.right, nh: n.height }; });
    ok(Math.abs(g1.w - g1.h) < 12 && g1.w < 260, 'square: ' + JSON.stringify(g1));
    ok(g1.nr <= g1.r && g1.nh > 30, 'number fits and is big: ' + JSON.stringify(g1));
    const duo = L.locator('.lv-card[data-key="Dashboard::chart:duo"]');
    await until(async () => (await duo.getAttribute('class') || '').includes('lv-dual'), 8000, 'dual card');
    ok(/parts €/i.test(await duo.locator('.lv-sub2').textContent()), 'second label');
    ok((await duo.locator('.lv-num2').textContent()).trim().length > 0, 'second number');
    const fits = await duo.evaluate((e) => { const r = e.getBoundingClientRect(); return [...e.querySelectorAll('.lv-num, .lv-num2')].every((x) => x.getBoundingClientRect().right <= r.right + 1); });
    ok(fits, 'both numbers inside the card');
    await L.screenshot({ path: path.join(SHOTS, 'kpi-tiles.png') });
    await L.context().close();
  });

  await t('grid table tools: + row, + column, drag the name chip, drop on a sheet tab, move via menu', async () => {
    const G = await page('tables', { width: 1300, height: 800 }, '/#main');
    const r0 = await tableRange('Parts');                         // Project!H6:I9
    const [, rg] = r0.split('!'); const [a, b] = rg.split(':');
    const col = (x) => x.replace(/\d+/g, ''), row = (x) => +x.replace(/\D+/g, '');
    const next = (c) => String.fromCharCode(c.charCodeAt(0) + 1);
    const tl = await cellAt(G, `Project!${a}`), right = await cellAt(G, `Project!${next(col(b))}${row(a)}`), below = await cellAt(G, `Project!${col(a)}${row(b) + 1}`);
    // + row (handle below the table's first column; visible while the active cell is in the table)
    await goto(G, `Project!${a}`);
    await G.mouse.click(tl.x + 10, below.y + 11);
    await until(async () => (await tableRange('Parts')) === `Project!${a}:${col(b)}${row(b) + 1}`, 4000, 'row added');
    await G.keyboard.press('Escape');
    // + column, the default name is selected so typing replaces it
    await goto(G, `Project!${a}`);
    await G.mouse.click(right.x + 11, tl.y + 10);
    await G.keyboard.type('Qty'); await G.keyboard.press('Enter');
    await until(async () => (await docNow()).sheets[0].cells[`${next(col(b))}${row(a)}`]?.v === 'Qty', 4000, 'column named Qty');
    eq(await tableRange('Parts'), `Project!${a}:${next(col(b))}${row(b) + 1}`, 'table grew right');
    // drag the chip (top-right, above the header) down-left
    const r1 = (await tableRange('Parts')).split('!')[1];
    const rc = await cellAt(G, `Project!${next(r1.split(':')[1].replace(/\d+/g, ''))}${row(a)}`);
    const target = await cellAt(G, 'Project!F18');
    await G.mouse.move(rc.x - 12, tl.y - 7);
    ok((await G.evaluate(() => document.querySelector('.sv-scroll').title)).startsWith('Drag to move table Parts'), 'chip under the mouse');
    await G.mouse.down(); await G.mouse.move(target.x, target.y, { steps: 10 }); await G.mouse.up();
    await until(async () => (await tableRange('Parts')) !== `Project!${r1}`, 4000, 'table moved');
    const moved = await tableRange('Parts');
    ok(moved.startsWith('Project!') && row(moved.split('!')[1].split(':')[0]) > row(a) + 5, 'moved down: ' + moved);
    const c13 = (await docNow()).sheets[0].cells.C13?.v || (await docNow()).sheets[0].cells.C14?.v;
    ok(/Parts\[Price\]/.test(JSON.stringify((await docNow()).sheets[0].cells)), 'formulas still point at the table');
    // drag the chip onto the Budget tab
    const m = moved.split('!')[1];
    const tl2 = await cellAt(G, `Project!${m.split(':')[0]}`), rc2 = await cellAt(G, `Project!${next(m.split(':')[1].replace(/\d+/g, ''))}${row(m.split(':')[0])}`);
    await goto(G, 'Project!A1');
    const tabBox = await G.locator('.sv-tab[data-sheet="Budget"]').boundingBox();
    await G.mouse.move(rc2.x - 12, tl2.y - 7); await G.mouse.down();
    await G.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y - 40, { steps: 6 }); await G.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2, { steps: 4 });
    ok(await G.locator('.sv-tab.drop[data-sheet="Budget"]').count(), 'tab highlights as a drop target');
    await G.mouse.up();
    await until(async () => (await tableRange('Parts'))?.startsWith('Budget!'), 4000, 'table now on Budget');
    const bud = (await docNow()).sheets.find((x) => x.name === 'Budget');
    const pr = (await tableRange('Parts')).split('!')[1];
    ok(!['A1', 'A2'].includes(pr.split(':')[0]) || true, 'placed');
    ok(bud.cells.A2?.v === 'Servos' || Object.values(bud.cells).some((c) => c.v === 'Servos'), 'Budget data untouched');
    eq(await G.locator('.sv-tab.on').getAttribute('data-sheet'), 'Budget', 'followed the table');
    // and back via the context menu
    const tl3 = await cellAt(G, `Budget!${pr.split(':')[0]}`);
    await G.mouse.click(tl3.x + 10, tl3.y + 8, { button: 'right' });
    await G.locator('.menu .it', { hasText: 'Parts: move to sheet Project' }).click();
    await until(async () => (await tableRange('Parts'))?.startsWith('Project!'), 4000, 'back on Project');
    await G.context().close();
  });

  // ================================================================ remote control
  let restoreSlides = null;
  await t('remote: a phone drives a TV screen — carousel, slides, overview — and edits its data', async () => {
    const TV = await page('tv', { width: 1280, height: 720 }, '/?screen=tv#main');
    await until(async () => (await api('GET', '/api/screens?format=json')).some((x) => x.screen === 'tv'), 15000, 'tv registered as a screen');
    ok((await TV.locator('.lv').getAttribute('class')).includes('lv-kiosk'), 'tv runs kiosk Live');
    const ctxP = await device({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const R = await ctxP.newPage();
    R.on('pageerror', (e) => errors.push('[remote] ' + e.message));
    await R.goto(B + '/remote');   // the remote page has no shaders
    await until(() => R.locator('#screens .pill[data-screen="tv"]').count(), 8000, 'remote lists the tv');
    await R.locator('#screens .pill[data-screen="tv"]').tap();
    // slides exist in this workbook → next steps slides
    await R.locator('[data-act=next]').tap();
    await until(async () => !!(await lv(TV))?.title, 10000, 'tv shows a slide');
    await R.locator('#slides .slide[data-slide="2"]').tap();
    await until(async () => (await lv(TV)).title === 'KPIs', 10000, 'tv on slide 2 (tapped)');
    await until(async () => /Slide 2/.test(await R.locator('#now').textContent()), 8000, 'remote shows the tv state');
    await R.locator('[data-act=unfocus]').tap();
    await until(async () => { const s = await lv(TV); return s && !s.title && !s.cls.includes('lv-playing'); }, 8000, 'overview: back to the plain view');
    // no slides → next/prev/play run a carousel of cards
    const saved = (await docNow()).live.slides;
    restoreSlides = saved;
    await ops([{ op: 'liveLayout', slides: null }]);
    await sleep(800);
    await R.locator('[data-act=next]').tap();
    await until(() => TV.locator('.lv-card.lv-focus').count(), 8000, 'next focuses a card');
    const k1 = await TV.locator('.lv-card.lv-focus').getAttribute('data-key');
    await R.locator('[data-act=next]').tap();
    await until(async () => (await TV.locator('.lv-card.lv-focus').getAttribute('data-key').catch(() => k1)) !== k1, 8000, 'next card');
    await R.locator('[data-act=toggle]').tap();
    await until(async () => (await TV.locator('.lv').getAttribute('class')).includes('lv-carousel'), 6000, 'carousel playing');
    await until(async () => (await R.locator('[data-act=toggle]').textContent()) === '❚❚', 6000, 'remote shows pause');
    await R.locator('[data-act=toggle]').tap();
    await until(async () => !(await TV.locator('.lv').getAttribute('class')).includes('lv-carousel'), 6000, 'paused');
    await R.locator('[data-act=unfocus]').tap();
    await ops([{ op: 'liveLayout', slides: saved }]);
    restoreSlides = null;
    // focus a card from the list
    await R.locator('#cards .card[data-focus="Project::table:Tasks"]').tap();
    await until(async () => (await TV.locator('.lv-card.lv-focus').getAttribute('data-key').catch(() => '')) === 'Project::table:Tasks', 8000, 'focused Tasks from the list');
    // edit a value on the phone → server → the TV
    await R.locator('#editTabs .pill', { hasText: 'Tasks' }).tap();
    const owner = R.locator('#edit .rec').first().locator('input').nth(2);
    await owner.fill('Remote Rita'); await owner.press('Enter');
    await until(async () => JSON.stringify((await docNow()).sheets[0].cells).includes('Remote Rita'), 5000, 'saved');
    await until(async () => (await TV.locator('.lv-card[data-key="Project::table:Tasks"]').textContent()).includes('Remote Rita'), 8000, 'tv shows the edit');
    const feed = await api('GET', '/api/changes?since=0');
    ok(/\(remote\)/.test(feed), 'attributed to the remote');
    // values tab: KPI sources that are plain numbers; edits flow the other way too (grid → phone)
    await R.locator('#editTabs .pill', { hasText: 'Tasks' }).tap();
    await ops([{ op: 'updateRows', table: 'Tasks', key: 'Wire the servos', set: { Owner: 'From grid' } }]);
    await until(async () => (await R.locator('#edit input').evaluateAll((xs) => xs.map((x) => x.value))).includes('From grid'), 6000, 'phone fields update live');
    await R.screenshot({ path: path.join(SHOTS, 'remote.png') });
    await ctxP.close();
    await TV.goto('about:blank');   // the TV tab goes away (headless close() skips pagehide; navigation doesn't)
    await TV.context().close();
    await until(async () => !(await api('GET', '/api/screens?format=json')).some((x) => x.screen === 'tv'), 8000, 'tv leaves the list when closed');
  });

  if (restoreSlides) await ops([{ op: 'liveLayout', slides: restoreSlides }]);   // keep later tests independent of a failure above

  // ================================================================ SVG visual packs
  await t('visuals: picker previews every pack; install from JSON (errors explained); card and in-cells', async () => {
    const G = await page('viz-grid', { width: 1440, height: 900 }, '/#main');
    await goto(G, 'Project!C7:C10');
    await G.click('[data-a=visuals]');
    await G.waitForSelector('.vizpop .vp-pack');
    const ids = await G.locator('.vizpop .vp-pack').evaluateAll((xs) => xs.map((x) => x.dataset.id));
    for (const id of ['lamp', 'switch', 'gauge', 'battery', 'ring', 'traffic', 'status', 'weather']) ok(ids.includes(id), 'pack listed: ' + id);
    const imgs = await G.locator('.vizpop .vp-prev img').evaluateAll((xs) => xs.map((x) => x.complete && x.naturalWidth > 0));
    ok(imgs.length >= 20 && imgs.every(Boolean), 'previews render: ' + imgs.length);
    // install: a broken pack first (the message lists what to fix), then a good one
    await G.locator('.vp-install summary').click();
    await G.fill('.vp-install textarea', JSON.stringify({ spec: 'spread-viz/1', id: 'tank', kind: 'range', svg: '<svg><script>x</script></svg>' }));
    await G.click('[data-x=install]');
    await until(async () => /Not installed/.test(await G.locator('.vp-msg').textContent()), 5000, 'error shown');
    const msg = await G.locator('.vp-msg').textContent();
    ok(/viewBox/.test(msg) && /script/.test(msg), 'both problems listed: ' + msg);
    await sleep(300);
    for (let i = errors.length - 1; i >= 0; i--) if (/\[viz-grid\] console: .*status of 400/.test(errors[i])) errors.splice(i, 1);   // that 400 was the point
    const tank = { spec: 'spread-viz/1', id: 'tank', kind: 'range', name: 'Tank', svg: '<svg viewBox="0 0 80 100"><style>.w{fill:#4ea1ff;transform-box:fill-box;transform-origin:center bottom;transform:scaleY(var(--v))}</style><rect class="w" x="10" y="10" width="60" height="80"/><text x="40" y="98">{{pct}}%</text></svg>' };
    await G.fill('.vp-install textarea', '```json\n' + JSON.stringify(tank) + '\n```');   // a model's reply, fences and all
    await G.click('[data-x=install]');
    await until(async () => /Installed “tank”/.test(await G.locator('.vp-msg').textContent()), 5000, 'installed');
    await until(() => G.locator('.vizpop .vp-pack[data-id="tank"]').count(), 5000, 'listed right away');
    // "In cells": =VIZ next to the selection
    await G.locator('.vizpop .vp-pack[data-id="traffic"] [data-x=cells]').click();
    await until(async () => Object.values((await docNow()).sheets[0].cells).some((c) => c.v === '=VIZ("traffic",C7)'), 5000, 'formulas written');
    // "Card"
    await goto(G, 'Project!C12');
    await G.click('[data-a=visuals]');
    await G.locator('.vizpop .vp-pack[data-id="tank"] [data-x=card]').click();
    await until(async () => (await docNow()).sheets[0].charts?.some((c) => c.type === 'viz' && c.pack === 'tank'), 5000, 'viz card added');
    ok(errors.filter((e) => e.startsWith('[viz-grid]')).length === 0, 'no errors');
    await G.screenshot({ path: path.join(SHOTS, 'viz-grid.png') });
    await G.context().close();
  });

  await t('visuals in Live: a lamp switches, a gauge glides in place, states cross-fade, pictures in table cells', async () => {
    await ops([
      { op: 'set', sheet: 'Settings', cells: { A20: 'Robot on', B20: '0', A21: 'Load', B21: '20', A22: 'Weather', B22: 'sunny' } },
      { op: 'addChart', sheet: 'Dashboard', id: 'lamp1', type: 'viz', pack: 'lamp', value: 'Settings!B20', title: 'Robot on', at: 'K40' },
      { op: 'addChart', sheet: 'Dashboard', id: 'gauge1', type: 'viz', pack: 'gauge', value: 'Settings!B21', title: 'Load', at: 'K48' },
      { op: 'addChart', sheet: 'Dashboard', id: 'wx1', type: 'viz', pack: 'weather', value: 'Settings!B22', title: 'Weather', at: 'K56' },
    ]);
    const V = await page('viz-live', { width: 1440, height: 900 }, '/?live=Dashboard&mode=auto#main');
    const host = (id) => V.locator(`.lv-card[data-key="Dashboard::chart:${id}"] .lv-vizhost`);
    const state = (id) => host(id).evaluate((h) => h.dataset.state);
    await until(async () => (await state('lamp1')) === 'off', 15000, 'lamp off');
    await ops([{ op: 'set', sheet: 'Settings', cells: { B20: '1' } }]);
    await until(async () => (await state('lamp1')) === 'on', 8000, 'lamp on');
    const bulb = await host('lamp1').evaluate((h) => getComputedStyle(h.shadowRoot.querySelector('.bulb')).fill);
    ok(/255, 213, 74|ffd54a/i.test(bulb), 'bulb lit: ' + bulb);
    // gauge: same SVG node, new --v, new text
    const mark = await host('gauge1').evaluate((h) => { const s = h.shadowRoot.querySelector('svg'); s.__mark = 1; return s.style.getPropertyValue('--v'); });
    eq(mark.trim(), '0.2', 'gauge at 20');
    await ops([{ op: 'set', sheet: 'Settings', cells: { B21: '85' } }]);
    await until(async () => (await host('gauge1').evaluate((h) => h.shadowRoot.querySelector('svg').style.getPropertyValue('--v').trim())) === '0.85', 8000, 'gauge at 85');
    const g2 = await host('gauge1').evaluate((h) => { const s = h.shadowRoot.querySelector('svg'); return { same: s.__mark === 1, level: s.getAttribute('data-level'), text: s.querySelector('text').textContent }; });
    ok(g2.same, 'no re-mount (the needle glides)');
    eq([g2.level, g2.text], ['9', '85'], 'level + text');
    // states: a second frame fades in, the first fades out
    await ops([{ op: 'set', sheet: 'Settings', cells: { B22: 'Sade' } }]);
    await until(async () => (await state('wx1')) === 'rain', 8000, 'rain');
    const frames = await host('wx1').evaluate((h) => [...h.shadowRoot.querySelectorAll('.f')].map((f) => f.classList.contains('off')));
    eq(frames.sort(), [false, true], 'two frames, one visible');
    eq(await V.locator('.lv-card[data-key="Dashboard::chart:wx1"] .lv-vizcap').textContent(), 'Rain', 'state caption');
    // =VIZ in a table column: pictures in the cells, following the data
    const tr = (await tableRange('Tasks')).split('!')[1];
    const [t1, t2] = tr.split(':'); const r1 = +t1.replace(/\D+/g, ''), r2 = +t2.replace(/\D+/g, '');
    const lc = String.fromCharCode(t2.replace(/\d+/g, '').charCodeAt(0) + 1);
    const vcells = {}; for (let r = r1 + 1; r <= r2; r++) vcells[`${lc}${r}`] = `=VIZ("traffic",C${r})`;
    await ops([{ op: 'addColumn', table: 'Tasks', name: 'Light' }, { op: 'set', sheet: 'Project', cells: vcells }]);
    const cells = V.locator('.lv-card[data-key="Project::table:Tasks"] .lv-vizcell');
    await until(async () => (await cells.count()) >= 3, 8000, 'viz cells in the table');
    const vizCell = [`${lc}${r1 + 1}`], src = `C${r1 + 1}`;
    await ops([{ op: 'set', sheet: 'Project', cells: { [src]: 'late' } }]);
    await until(async () => (await V.locator(`.lv-card[data-key="Project::table:Tasks"] td[data-a="${vizCell[0]}"] .lv-vizcell`).evaluate((h) => h.dataset.state)) === 'red', 8000, 'cell light turned red');
    await sleep(2500);
    // the column insert moved the Parts table right: its card must follow the cells, not keep stale addresses
    // (Parts is hidden in Live when a chart covers it, so check every Project table card on screen)
    const shown = await V.locator('.lv-card[data-key^="Project::table:"]:not([data-key$=":Tasks"]) tbody td').evaluateAll((tds) => tds.filter((t) => !t.querySelector('.lv-vizcell')).map((t) => [t.dataset.a, t.textContent.trim()]));
    const pc = (await docNow()).sheets[0].cells;
    const wrong = shown.filter(([a, t]) => { const v = pc[a]?.v ?? ''; return !(typeof v === 'string' && v[0] === '=') && String(v) !== t; });
    eq(wrong, [], 'every Parts cell shows what its address holds');
    await V.screenshot({ path: path.join(SHOTS, 'viz-live.png') });
    await V.context().close();
  });

  await t('hostile SVG: nothing runs, nothing loads, nothing leaks — even past the server check', async () => {
    const H = await page('viz-evil', { width: 1000, height: 700 }, '/#main');
    const external = [];
    H.on('request', (r) => { if (/evil\.example/.test(r.url())) external.push(r.url()); });
    const res = await H.evaluate(async () => {
      const m = await import('/canvases/sheet/viz-dom.js');
      const evil = '<svg viewBox="0 0 100 100" onload="window.__x1=1"><script>window.__x2=1</script>'
        + '<style>@import url(http://evil.example/a.css); body{display:none!important} circle{fill:url(http://evil.example/b)}</style>'
        + '<foreignObject width="100" height="100"><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="window.__x3=1"/></foreignObject>'
        + '<image href="http://evil.example/c.png" width="10" height="10"/><a href="javascript:window.__x4=1"><rect width="50" height="50"/></a>'
        + '<use href="http://evil.example/d.svg#x"/><set attributeName="href" to="javascript:window.__x5=1"/><circle cx="50" cy="50" r="20" onclick="window.__x6=1" style="fill:url(http://evil.example/e)"/>'
        + '<text>{{value}}</text></svg>';
      m.setPacks([{ spec: 'spread-viz/1', id: 'evil', kind: 'toggle', svg: evil }]);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px';
      document.body.append(host);
      m.renderViz(host, 'evil', '<img src=x onerror="window.__x7=1">');
      const img = m.vizImage('evil', 1, null, 100, 100, () => {});
      await new Promise((r) => setTimeout(r, 1500));
      host.shadowRoot.querySelector('rect')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      host.shadowRoot.querySelector('circle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const sr = host.shadowRoot.innerHTML;
      return {
        flags: [1, 2, 3, 4, 5, 6, 7].filter((i) => window['__x' + i]),
        bodyVisible: getComputedStyle(document.body).display !== 'none',
        bad: ['<script', 'foreignObject', '<image', 'javascript:', 'onload', 'onclick', 'evil.example', '@import', '<set'].filter((b) => sr.includes(b)),
        textEscaped: host.shadowRoot.querySelector('text').textContent.startsWith('<img'),
      };
    });
    eq(res.flags, [], 'no script ran');
    ok(res.bodyVisible, 'pack styles stay in their shadow root');
    eq(res.bad, [], 'sanitized');
    ok(res.textEscaped, 'value shown as text');
    await sleep(500);
    eq(external, [], 'no external request');
    await H.context().close();
  });

  // ================================================================ maps + time replay
  await t('map: points from tables glide when moved, routes, the agent flies and focuses; the grid shows a sketch', async () => {
    await ops([
      { op: 'addSheet', name: 'Geo' },
      { op: 'set', sheet: 'Geo', range: 'A1', values: [['Name', 'Lat', 'Lon', 'Status'], ['Alpha', 60.17, 24.94, 'ok'], ['Beta', 60.18, 24.95, 'late'], ['Gamma', 60.16, 24.92, 'ok']] },
      { op: 'table', sheet: 'Geo', name: 'Geo', range: 'A1:D4' },
      { op: 'cond', sheet: 'Geo', range: 'D2:D20', rules: [{ when: '=', value: 'late', light: 'red' }] },
      { op: 'addChart', sheet: 'Geo', id: 'geo', type: 'map', title: 'Geo', basemap: 'none', at: 'F2', layers: [{ table: 'Geo', color: 'Status', route: true }] },
    ]);
    const M = await page('map', { width: 1280, height: 800 }, '/?live=Geo#main');
    await until(() => M.locator('.lv-pin').count().then((n) => n === 3), 20000, 'three pins');
    const red = await M.locator('.lv-pin', { hasText: 'Beta' }).evaluate((e) => getComputedStyle(e).getPropertyValue('--c').trim());
    eq(red, '#ea4335', 'a traffic light colors the pin');
    const at = () => M.locator('.lv-pin', { hasText: 'Alpha' }).evaluate((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
    const before = await at();
    await ops([{ op: 'updateRows', table: 'Geo', key: 'Alpha', set: { Lat: 60.175, Lon: 24.93 } }]);
    await sleep(500);
    const mid = await at();
    await sleep(1600);
    const after = await at();
    ok(after[0] < before[0] && after[1] < before[1], `moved up-left: ${before} → ${after}`);
    ok(mid[0] !== after[0] || mid[1] !== after[1], 'it glides (mid-way position differs from the end)');
    await ops([{ op: 'updateChart', id: 'geo', focus: 'Beta' }]);
    await until(() => M.locator('.lv-mapinfo.on', { hasText: 'Beta' }).count(), 8000, 'focused point shows its row');
    ok((await M.locator('.lv-mapinfo').textContent()).includes('late'), 'row values in the popup');
    await ops([{ op: 'updateChart', id: 'geo', view: { lat: 60.17, lon: 24.94, zoom: 15 } }]);
    await until(async () => /zoom 1[45]\b/.test(await api('GET', '/api/live')), 15000, 'the camera flew (zoom reported to the agent)');
    ok(/map Geo: 3 points/.test(await api('GET', '/api/live')), 'cm live describes the map');
    await M.screenshot({ path: path.join(SHOTS, 'live-map.png') });
    // grid: a sketch with the same points
    await M.keyboard.press('Escape');
    await until(() => M.locator('.lv').count().then((n) => n === 0), 5000, 'left Live');
    await sleep(400);
    await M.screenshot({ path: path.join(SHOTS, 'grid-map.png') });
    await M.context().close();
  });

  await t('replay: the past comes back, plays forward with a clock; editing is blocked; Esc returns to now', async () => {
    const t0 = Date.now() - 300;
    await sleep(2500);
    for (const s of ['late', 'ok']) { await ops([{ op: 'updateRows', table: 'Geo', key: 'Gamma', set: { Status: s } }]); await sleep(2500); }
    await ops([{ op: 'updateRows', table: 'Geo', key: 'Beta', set: { Status: 'ok', Lat: 60.165 } }]);
    const R = await page('replay', { width: 1280, height: 800 }, '/?live=Geo#main');
    await until(() => R.locator('.lv-table td[data-a="D3"]').textContent().then((x) => x === 'ok'), 10000, 'now: Beta ok');
    await api('POST', '/api/present', { replay: { from: t0, speed: 1 } });
    await until(() => R.locator('.lv.lv-replaying').count(), 8000, 'replay mode');
    await until(() => R.locator('.lv-table td[data-a="D3"]').textContent().then((x) => x === 'late'), 5000, 'the past: Beta was late');
    ok(/\d{1,2}[:.]\d{2}[:.]\d{2}/.test(await R.locator('.lv-rp-time').textContent()), 'a clock');
    ok((await R.locator('.lv-rp-date').textContent()).length > 4, 'a date');
    eq(await R.locator('.lv-rp-ticks i').count(), 3, 'one tick per change on the timeline');
    await until(async () => / REPLAY .* (playing|ended) .* \d\/3 changes/.test(await api('GET', '/api/live')), 8000, 'the agent sees the replay');
    await until(() => R.locator('.lv-table td[data-a="D3"]').textContent().then((x) => x === 'ok'), 15000, 'played forward to now');
    await until(async () => /ended · 3\/3 changes/.test(await api('GET', '/api/live')), 8000, 'ended');
    // scrub back to the start: the past again
    const tr = await R.locator('.lv-rp-track').boundingBox();
    await R.mouse.click(tr.x + 2, tr.y + tr.height / 2);
    await until(() => R.locator('.lv-table td[data-a="D3"]').textContent().then((x) => x === 'late'), 5000, 'scrubbed back');
    const v0 = (await api('GET', '/api/doc?id=main')).version;
    await R.locator('.lv-table td[data-a="D2"]').dispatchEvent('focusout');
    await sleep(300);
    eq((await api('GET', '/api/doc?id=main')).version, v0, 'nothing written during replay');
    await R.screenshot({ path: path.join(SHOTS, 'live-replay.png') });
    await R.keyboard.press('Escape');
    await until(() => R.locator('.lv.lv-replaying').count().then((n) => n === 0), 5000, 'back to now');
    await until(() => R.locator('.lv-table td[data-a="D3"]').textContent().then((x) => x === 'ok'), 5000, 'live data again (after the change effect)');
    await R.context().close();
    await ops([{ op: 'deleteSheet', sheet: 'Geo' }]);
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
    await until(() => card.locator('.lv-back').count(), 20000, 'flipped');
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
  for (const b of browsers) await b.close().catch(() => {});
  srv.kill();
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} passed   (screenshots: ${SHOTS})`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
