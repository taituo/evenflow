// Deterministic monitors: cheap, repeatable checks that run on every snapshot of an agent's working tree.
// No model in the loop — the agent does the work, the monitors tell the truth about it.
//
// Built in (always on):
//   syntax   changed .js/.mjs/.cjs (node --check), .json (parse), .py (py_compile); broken files stay red until fixed
//   churn    the same lines rewritten again and again (amber at 3 edits, red at 4) — the agent is going in circles;
//            stays lit for the next 4 snapshots
//   size     lines changed since the session started (amber 400, red 1200 by default)
//   tests    a test file deleted or a test case removed (red); source changed without any test change (amber)
//   secrets  credentials in added lines (AWS keys, private keys, tokens) — red until the line is gone again
//   deps     package manifests or lockfiles changed since the session started (amber: a human should look)
//   scope    files changed outside the agent's scope globs, when the box has a scope (red)
// Command monitors (opt in): .studio/monitors.json in the project root, or found automatically
//   (a tsconfig.json with a local tsc gives a "typecheck" monitor):
//   [{ "id": "typecheck", "run": "npx tsc --noEmit", "match": "\\.tsx?$", "timeout": 120000 }]
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUILTIN = ['syntax', 'churn', 'size', 'tests', 'secrets', 'deps', 'scope'];
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const TEST_CASE = /\b(?:it|test)(?:\.only|\.skip|\.todo)?\s*\(|^\s*def test_|^\s*func Test|#\[test\]/gm;
const DEPS = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/;
const SECRETS = [
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['API key', /\b(sk|rk)-(?:live-|proj-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['hard-coded secret', /\b(api[_-]?key|secret|passw(or)?d|token)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];

const run = (cmd, args, o) => new Promise((ok) => execFile(cmd, args, { timeout: 30000, maxBuffer: 8 << 20, ...o }, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr), killed: !!err?.killed })));
const sh = (cmd, cwd, timeout) => new Promise((ok) => execFile('/bin/sh', ['-c', cmd], { cwd, timeout, maxBuffer: 16 << 20, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } }, (err, stdout, stderr) => ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: (String(stdout) + String(stderr)).replace(/\x1b\[[0-9;]*m/g, ''), killed: !!err?.killed })));
const tail = (s, n = 12) => s.trim().split('\n').slice(-n).join('\n');

let hasPython = null;
async function pyOk() { if (hasPython == null) hasPython = (await run('python3', ['--version'])).code === 0; return hasPython; }

/** Check one file's text. Returns null if fine (or not checkable), else an error line. */
export async function checkSyntax(file, text) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') { try { JSON.parse(text); return null; } catch (e) { return e.message; } }
  if (!['.js', '.mjs', '.cjs', '.py'].includes(ext)) return undefined;
  if (ext === '.py' && !(await pyOk())) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-syntax-'));
  try {
    const esm = ext === '.mjs' || (ext === '.js' && /^\s*(import|export)\b/m.test(text));
    const tmp = path.join(dir, 'f' + (ext === '.py' ? '.py' : esm ? '.mjs' : '.cjs'));
    fs.writeFileSync(tmp, text);
    const r = ext === '.py' ? await run('python3', ['-m', 'py_compile', tmp]) : await run(process.execPath, ['--check', tmp]);
    if (r.code === 0) return null;
    const lines = r.out.split('\n').map((l) => l.replace(tmp, file));
    const msg = lines.find((l) => /Error|error/.test(l) && !/^\s+at /.test(l)) || lines[0];
    const where = lines.find((l) => l.startsWith(file + ':'));
    return `${where ? where.trim() + ' ' : ''}${(msg || 'syntax error').trim()}`;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const globRe = (g) => new RegExp('^' + g.split('**').map((p) => p.split('*').map((x) => x.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
export const inScope = (file, globs) => globs.some((g) => globRe(g.replace(/^\.\//, '')).test(file) || (g.endsWith('/') && file.startsWith(g)));

/**
 * Run the built-in monitors for snapshot `cur` (parent `prev`, session base `base`).
 * state: per-agent memory { hunks: [], syntaxBroken: Map, secrets: [] } — rebuilt from scratch is fine (it only
 * makes churn forget older edits). Returns [{ monitor, level, summary, detail }] — only monitors with something to say.
 */
export async function builtinMonitors({ shadow, base, prev, cur, n, state, scope = [], limits = {} }) {
  const out = [];
  const step = await shadow.numstat(prev, cur);
  const total = prev === base ? step : await shadow.numstat(base, cur);
  const changed = step.filter((f) => f.status !== 'D').map((f) => f.path);

  // syntax: changed files plus anything that was broken before
  {
    const check = new Set([...changed, ...state.syntaxBroken.keys()]);
    const broken = new Map();
    let checked = 0;
    for (const f of check) {
      const text = await shadow.show(cur, f);
      if (text == null) continue;                    // deleted: no longer broken
      const err = await checkSyntax(f, text);
      if (err === undefined) continue;
      checked++;
      if (err) broken.set(f, err);
    }
    if (checked || state.syntaxBroken.size) {
      state.syntaxBroken = broken;
      out.push(broken.size
        ? { monitor: 'syntax', level: 'red', summary: `${[...broken.keys()][0]}${broken.size > 1 ? ` +${broken.size - 1}` : ''}: ${[...broken.values()][0]}`.slice(0, 200), detail: [...broken].map(([f, e]) => `${f}: ${e}`).join('\n') }
        : { monitor: 'syntax', level: 'green', summary: `${checked} file${checked === 1 ? '' : 's'} parse` });
    }
  }

  // churn: how often were these lines edited in the recent snapshots?
  {
    const hs = await shadow.hunks(prev, cur);
    let worst = null;
    for (const h of hs) {
      const lo = h.start, hi = h.start + Math.max(h.len, 1) - 1;
      const hits = state.hunks.filter((p) => p.path === h.path && p.snap >= n - 12 && p.start <= hi && p.start + Math.max(p.len, 1) - 1 >= lo);
      const times = new Set(hits.map((p) => p.snap)).size + 1;
      if (!worst || times > worst.times) worst = { path: h.path, line: h.start, times, snaps: [...new Set(hits.map((p) => p.snap)), n] };
    }
    state.hunks.push(...hs.map((h) => ({ ...h, snap: n })));
    if (state.hunks.length > 4000) state.hunks = state.hunks.slice(-3000);
    // a loop stays visible for the next few snapshots instead of vanishing with the first unrelated edit
    state.churn = (state.churn || []).filter((c) => c.n >= n - 4);
    if (worst && worst.times >= 3) state.churn.push({ ...worst, n });
    const top = state.churn.reduce((m, c) => (!m || c.times > m.times ? c : m), null);
    if (hs.length || top) {
      const level = !top ? 'green' : top.times >= 4 ? 'red' : 'amber';
      out.push({ monitor: 'churn', level, summary: !top ? 'no repeated edits' : `${top.path}:${top.line} edited ${top.times}× (snapshots ${top.snaps.map((x) => '#' + x).join(' ')})`, detail: null });
    }
  }

  // size: everything since the session started
  {
    const lines = total.reduce((a, f) => a + f.adds + f.dels, 0);
    const amber = limits.sizeAmber ?? 400, red = limits.sizeRed ?? 1200;
    out.push({ monitor: 'size', level: lines >= red ? 'red' : lines >= amber ? 'amber' : 'green', summary: `${lines} lines in ${total.length} file${total.length === 1 ? '' : 's'} since the start`, detail: null });
  }

  // tests
  {
    const reds = [];
    for (const f of step.filter((x) => TEST_FILE.test(x.path))) {
      if (f.status === 'D') { reds.push(`deleted ${f.path}`); continue; }
      const before = f.status === 'A' ? '' : (await shadow.show(prev, f.path)) || '';
      const after = (await shadow.show(cur, f.path)) || '';
      const a = (before.match(TEST_CASE) || []).length, b = (after.match(TEST_CASE) || []).length;
      if (b < a) reds.push(`${f.path}: ${a} → ${b} test cases`);
    }
    if (reds.length) state.testReds = reds;
    else if (step.some((f) => TEST_FILE.test(f.path))) state.testReds = [];
    const src = total.filter((f) => !TEST_FILE.test(f.path) && /\.(m?[jt]sx?|cjs|py|go|rs|rb|java|kt|cs|cpp|c|h|swift|php)$/.test(f.path));
    const tests = total.filter((f) => TEST_FILE.test(f.path));
    if (state.testReds?.length) out.push({ monitor: 'tests', level: 'red', summary: state.testReds[0] + (state.testReds.length > 1 ? ` +${state.testReds.length - 1}` : ''), detail: state.testReds.join('\n') });
    else if (src.length && !tests.length) out.push({ monitor: 'tests', level: 'amber', summary: `${src.length} source file${src.length === 1 ? '' : 's'} changed, no test changes`, detail: src.map((f) => f.path).join('\n') });
    else if (src.length || tests.length) out.push({ monitor: 'tests', level: 'green', summary: `${tests.length} test file${tests.length === 1 ? '' : 's'} changed`, detail: null });
  }

  // secrets: new findings in added lines, old findings kept while the line is still there
  {
    const added = await shadow.addedLines(prev, cur);
    const found = [];
    for (const old of state.secrets) {
      const text = changed.includes(old.path) || step.some((f) => f.path === old.path) ? await shadow.show(cur, old.path) : 'keep';
      if (text === 'keep' || (text && text.includes(old.match))) found.push(old);
    }
    for (const [file, lines] of added) for (const l of lines) for (const [name, re] of SECRETS) {
      const m = re.exec(l);
      if (m && !found.some((x) => x.path === file && x.match === m[0])) found.push({ path: file, name, match: m[0] });
    }
    const had = state.secrets.length;
    state.secrets = found;
    if (found.length || had) out.push(found.length
      ? { monitor: 'secrets', level: 'red', summary: `${found[0].name} in ${found[0].path}${found.length > 1 ? ` +${found.length - 1}` : ''}`, detail: found.map((x) => `${x.path}: ${x.name} ${x.match.slice(0, 8)}…`).join('\n') }
      : { monitor: 'secrets', level: 'green', summary: 'no credentials in the diff' });
  }

  // deps
  {
    const deps = total.filter((f) => DEPS.test(f.path));
    if (deps.length || state.depsSeen) { state.depsSeen = deps.length > 0; out.push(deps.length ? { monitor: 'deps', level: 'amber', summary: `changed: ${deps.map((f) => f.path).join(', ')}`.slice(0, 200), detail: null } : { monitor: 'deps', level: 'green', summary: 'no dependency changes' }); }
  }

  // scope
  if (scope.length) {
    const outside = total.filter((f) => !inScope(f.path, scope)).map((f) => f.path);
    out.push(outside.length ? { monitor: 'scope', level: 'red', summary: `${outside.length} file${outside.length === 1 ? '' : 's'} outside ${scope.join(', ')}: ${outside.slice(0, 3).join(', ')}`, detail: outside.join('\n') } : { monitor: 'scope', level: 'green', summary: `all changes inside ${scope.join(', ')}` });
  }
  return { results: out, changed: step };
}

/** Command monitors configured for a project root (plus auto-detected ones). */
export function commandMonitors(root) {
  const list = [];
  const f = path.join(root, '.studio', 'monitors.json');
  if (fs.existsSync(f)) {
    try {
      for (const m of JSON.parse(fs.readFileSync(f, 'utf8'))) if (m && /^[\w-]{1,24}$/.test(m.id) && typeof m.run === 'string' && !BUILTIN.includes(m.id)) list.push({ id: m.id, run: m.run, match: m.match ? new RegExp(m.match) : null, timeout: Math.min(+m.timeout || 120000, 600000) });
    } catch (e) { list.push({ id: 'config', error: `.studio/monitors.json: ${e.message}` }); }
  }
  if (!list.some((m) => m.id === 'typecheck') && fs.existsSync(path.join(root, 'tsconfig.json')) && fs.existsSync(path.join(root, 'node_modules', '.bin', 'tsc')))
    list.push({ id: 'typecheck', run: 'node_modules/.bin/tsc --noEmit -p .', match: /\.(m|c)?tsx?$/, timeout: 180000, auto: true });
  return list;
}

/** Run one command monitor in the agent's working directory. */
export async function runCommandMonitor(m, cwd) {
  if (m.error) return { monitor: m.id, level: 'red', summary: m.error, detail: null };
  const t0 = Date.now();
  const r = await sh(m.run, cwd, m.timeout);
  const ms = Date.now() - t0;
  if (r.killed) return { monitor: m.id, level: 'red', summary: `timed out after ${Math.round(ms / 1000)} s`, detail: tail(r.out) };
  const errs = r.out.split('\n').filter((l) => /error|fail|✗|✖/i.test(l));
  return r.code === 0
    ? { monitor: m.id, level: 'green', summary: `ok in ${(ms / 1000).toFixed(1)} s`, detail: null }
    : { monitor: m.id, level: 'red', summary: (errs[0] || `exit ${r.code}`).trim().slice(0, 200), detail: tail(r.out, 30) };
}
