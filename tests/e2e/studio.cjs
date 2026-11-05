// Browser test of the full-screen studio (/studio) with the mock ACP agent: draw a box → agent, hover + type,
// answer a permission with Y, a note dragged onto a box is sent, scrub the timeline, spotlight, semantic zoom.
// Needs Playwright + Chromium:   node tests/e2e/studio.cjs        (PLAYWRIGHT=/path/to/playwright-core, CHROME=/path/to/chrome optional)
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'spread-e2e-studio');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function until(fn, ms = 10000, what = 'condition') { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(60); } }

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-e2e-studio-data-'));
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CANVAS_DATA: data, MOCK_DELAY: '15' }, stdio: 'pipe' });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/help'); break; } catch { await sleep(100); } }
  const api = async (p, body) => { const r = await fetch(B + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const step = async (name, fn) => { process.stdout.write(`• ${name} … `); await fn(); console.log('ok'); };
  try {
    await page.goto(B + '/studio');
    await page.waitForSelector('.st-canvas');

    await step('Shift+drag draws a box and the picker creates an agent with a first task', async () => {
      await page.keyboard.down('Shift');
      await page.mouse.move(300, 300); await page.mouse.down(); await page.mouse.move(900, 760, { steps: 6 }); await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.waitForSelector('.st-pick');
      await page.fill('.st-pick .nm', 'Auth');
      await page.fill('.st-pick .pr', 'implement a greeting helper');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.st-agent .st-ah .nm:text("Auth")');
      await until(async () => (await page.locator('.gate.blocking').count()) === 1, 10000, 'permission gate');
    });

    await step('Y over the box answers the permission', async () => {
      const box = await page.locator('.st-agent').first().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press('y');
      await until(async () => (await page.locator('.gate.blocking').count()) === 0, 8000, 'permission answered');
      await until(async () => /idle/.test(await page.locator('.st-agent .st-ah .pill').first().textContent()), 8000, 'idle');
      await page.screenshot({ path: path.join(SHOTS, '1-first-agent.png') });
    });

    await step('hover + type opens the floating input aimed at the box; Enter sends', async () => {
      await page.keyboard.type('b');
      await page.waitForSelector('.st-input');
      assert.match(await page.locator('.st-input .to').textContent(), /Auth/);
      await page.keyboard.type('reak it');
      await page.keyboard.press('Enter');
      await until(async () => (await page.locator('.gate .ti:text("syntax is red")').count()) === 1, 8000, 'syntax gate');
      await until(async () => (await page.locator('.st-agent .light.red').count()) >= 1, 5000, 'red light');
    });

    await step('a note dragged onto the box is sent as a prompt', async () => {
      await page.mouse.move(1500, 400);
      await page.keyboard.press('t');
      await page.waitForSelector('.st-panel textarea:focus');
      await page.keyboard.type('fix it please');
      await page.keyboard.press('Escape');
      await sleep(600);
      const ph = await page.locator('.st-panel .st-ph').first().boundingBox();
      const ag = await page.locator('.st-agent').first().boundingBox();
      await page.mouse.move(ph.x + 30, ph.y + ph.height / 2); await page.mouse.down();
      await page.mouse.move(ag.x + ag.width / 2, ag.y + ag.height / 2, { steps: 10 });
      assert.equal(await page.locator('.st-agent.drop').count(), 1, 'the box lights up as a drop target');
      await page.mouse.up();
      await until(async () => (await page.locator('.gate .ti:text("syntax is red")').count()) === 0, 8000, 'fixed by the dragged note');
    });

    await step('the tray has a diff card per snapshot; [ scrubs back, Esc returns to live', async () => {
      const cards = await page.locator('.dcard').count();
      assert.ok(cards >= 4, `cards: ${cards}`);
      await page.mouse.move(1500, 300);
      await page.keyboard.press('[');
      await page.waitForSelector('.st-thead .golive.past');
      assert.equal(await page.locator('.dcard.sel').count(), 1);
      await page.screenshot({ path: path.join(SHOTS, '2-scrub.png') });
      await page.keyboard.press('Escape');
      await page.waitForSelector('.st-thead .golive.live');
    });

    await step('fork from a diff card makes a second box with a fork link', async () => {
      await page.locator('.dcard').nth(1).locator('[data-x="fork"]').click();
      await until(async () => (await page.locator('.st-agent').count()) === 2, 8000, 'fork box');
      await page.waitForSelector('.st-links path');
    });

    await step('⌘K spotlight runs a command (review) and SQL into a note', async () => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.st-spot input');
      await page.keyboard.type('review auth');
      await page.keyboard.press('Enter');
      await until(async () => (await page.locator('.st-panel.review').count()) === 1, 8000, 'review panel');
      await until(async () => /Verdict/.test(await page.locator('.st-panel.review textarea').inputValue()), 8000, 'review text');
      await page.keyboard.press('Control+k');
      await page.keyboard.type('select kind, count(*) n from events group by kind');
      await page.keyboard.press('Enter');
      await until(async () => (await page.locator('.st-panel.sql').count()) === 1, 5000, 'sql panel');
    });

    await step('zooming out turns boxes into readable tiles', async () => {
      await page.mouse.move(1280, 500);
      await page.keyboard.down('Control');
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 240); await sleep(30); }
      await page.keyboard.up('Control');
      await until(async () => (await page.locator('.st-agent.lod-chip').count()) === 2, 3000, 'chip LOD');
      await page.keyboard.press('Escape');
      await sleep(500);
      await page.screenshot({ path: path.join(SHOTS, '3-studio.png') });
    });

    const st = await api('/api/studio');
    assert.match(st, /Auth \[/);
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`\nall studio browser checks passed · screenshots in ${SHOTS}`);
  } catch (e) {
    await page.screenshot({ path: path.join(SHOTS, 'fail.png') }).catch(() => {});
    console.error('\nFAILED:', e.message, errors.length ? '\npage errors: ' + errors.join(' | ') : '');
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
  }
})();
