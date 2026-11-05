// Shadow git: a private git repository per agent that snapshots the agent's working directory after every
// tool call or file change, without touching the project's own git (no commits, no index, no branches there).
// That gives the studio its time machine: diff any two moments, show a file as it was, rewind the directory,
// or materialize an old moment into a new directory for a fork.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXCLUDE = ['node_modules/', '.studio/', '.DS_Store', '*.swp', '*~', '__pycache__/', '.venv/', 'target/', 'dist/', '.next/'];

export function git(args, { cwd, env, input, max = 64 * 1024 * 1024 } = {}) {
  return new Promise((ok, bad) => {
    const p = execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env }, maxBuffer: max }, (err, stdout, stderr) => {
      if (err) { err.message = `git ${args.slice(0, 3).join(' ')}: ${(stderr || err.message).trim().split('\n').slice(-2).join(' | ')}`; return bad(err); }
      ok(stdout);
    });
    if (input != null) p.stdin.end(input);
  });
}

export async function isGitRepo(dir) {
  try { return (await git(['rev-parse', '--is-inside-work-tree'], { cwd: dir })).trim() === 'true'; } catch { return false; }
}

export class Shadow {
  constructor(gitDir, workTree) {
    this.gitDir = gitDir;
    this.workTree = workTree;
    this.queue = Promise.resolve();
  }
  g(args, o = {}) { return git(['--git-dir', this.gitDir, '--work-tree', this.workTree, ...args], { cwd: this.workTree, ...o }); }
  /** Run fn after everything queued before it (snapshots, rewinds and checkouts never interleave). */
  serial(fn) { const r = this.queue.then(fn, fn); this.queue = r.catch(() => {}); return r; }

  async init() {
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
      fs.mkdirSync(this.gitDir, { recursive: true });
      await git(['init', '--bare', '-q', this.gitDir]);
      for (const [k, v] of [['core.bare', 'false'], ['user.name', 'studio'], ['user.email', 'studio@localhost'], ['core.autocrlf', 'false'], ['core.quotepath', 'false'], ['gc.auto', '0'], ['commit.gpgsign', 'false']]) await git(['--git-dir', this.gitDir, 'config', k, v]);
      fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
    }
    return this;
  }

  async head() { try { return (await this.g(['rev-parse', '-q', '--verify', 'HEAD'])).trim(); } catch { return null; } }

  /** Commit the working tree if it changed. Returns { commit, parent, tree } or null when nothing changed. */
  snapshot(message) {
    return this.serial(async () => {
      await this.g(['add', '-A', '--ignore-errors', '.']).catch(() => this.g(['add', '-A', '.']));
      const tree = (await this.g(['write-tree'])).trim();
      const parent = await this.head();
      if (parent) {
        const ptree = (await this.g(['rev-parse', parent + '^{tree}'])).trim();
        if (ptree === tree) return null;
      }
      const commit = (await this.g(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', String(message || 'snapshot').slice(0, 500)])).trim();
      await this.g(['update-ref', 'HEAD', commit]);
      return { commit, parent, tree };
    });
  }

  /** [{ path, adds, dels, binary, status }] between two commits. */
  async numstat(a, b) {
    const out = await this.g(['diff', '--numstat', '-z', '--no-renames', a, b]);
    const st = await this.g(['diff', '--name-status', '-z', '--no-renames', a, b]);
    const status = new Map();
    const sp = st.split('\0');
    for (let i = 0; i + 1 < sp.length; i += 2) status.set(sp[i + 1], sp[i]);
    const files = [];
    for (const rec of out.split('\0')) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
      if (!m) continue;
      files.push({ path: m[3], adds: m[1] === '-' ? 0 : +m[1], dels: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-', status: status.get(m[3]) || 'M' });
    }
    return files;
  }

  /** Unified diff text. */
  diff(a, b, paths = [], context = 3) {
    return this.g(['diff', '--no-color', '--no-ext-diff', `-U${context}`, '--no-renames', a, b, '--', ...paths]);
  }

  /** Changed line ranges in the newer commit: [{ path, start, len, oldStart, oldLen }] */
  async hunks(a, b) {
    const out = await this.diff(a, b, [], 0);
    const hs = [];
    let file = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('+++ ')) { file = line.slice(4) === '/dev/null' ? null : line.slice(6); continue; }
      if (line.startsWith('--- ')) { if (line.slice(4) !== '/dev/null') file = line.slice(6); continue; }
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m && file) hs.push({ path: file, oldStart: +m[1], oldLen: m[2] == null ? 1 : +m[2], start: +m[3], len: m[4] == null ? 1 : +m[4] });
    }
    return hs;
  }

  /** Added lines of a diff, per file: Map(path -> [line text]) */
  async addedLines(a, b) {
    const out = await this.diff(a, b, [], 0);
    const m = new Map();
    let file = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('+++ ')) { file = line.slice(6); if (!m.has(file)) m.set(file, []); continue; }
      if (line.startsWith('+') && file) m.get(file).push(line.slice(1));
    }
    return m;
  }

  async show(commit, file) {
    try { return await this.g(['show', `${commit}:${file}`], { max: 16 * 1024 * 1024 }); } catch { return null; }
  }
  async ls(commit) { return (await this.g(['ls-tree', '-r', '--name-only', '-z', commit])).split('\0').filter(Boolean); }

  /** Write the tree of `commit` into `dir` (a fresh directory or an existing one), with a throwaway index. */
  materialize(commit, dir) {
    return this.serial(async () => {
      fs.mkdirSync(dir, { recursive: true });
      const idx = path.join(this.gitDir, `index-mat-${process.pid}-${Date.now()}`);
      try {
        await git(['--git-dir', this.gitDir, '--work-tree', dir, 'read-tree', commit], { cwd: dir, env: { GIT_INDEX_FILE: idx } });
        await git(['--git-dir', this.gitDir, '--work-tree', dir, 'checkout-index', '-a', '-f'], { cwd: dir, env: { GIT_INDEX_FILE: idx } });
      } finally { fs.rmSync(idx, { force: true }); }
    });
  }

  /**
   * Rewind the working directory to `commit`: files added since are deleted, changed and deleted ones come back.
   * The moment before the rewind is snapshotted first, so a rewind is itself undoable.
   */
  async restore(commit) {
    const before = await this.snapshot('before rewind');
    const now = before?.commit || (await this.head());
    await this.serial(async () => {
      const added = (await this.g(['diff', '--name-only', '-z', '--diff-filter=A', '--no-renames', commit, now])).split('\0').filter(Boolean);
      for (const f of added) {
        const abs = path.join(this.workTree, f);
        if (!abs.startsWith(this.workTree + path.sep)) continue;
        fs.rmSync(abs, { force: true });
        let d = path.dirname(abs);
        while (d.startsWith(this.workTree + path.sep)) { try { fs.rmdirSync(d); } catch { break; } d = path.dirname(d); }
      }
    });
    await this.materialize(commit, this.workTree);
    return { before };
  }
}
