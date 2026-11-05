// Real terminals for the studio canvas: a shell in a PTY (bin/pty-bridge.py, system python3 — no native modules),
// output streamed to every view over SSE, keystrokes back over HTTP. Runs wherever the server runs, so a studio
// on a Linux VPS gives you terminals on the VPS. A terminal belongs to a panel; it dies with it.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/pty-bridge.py');
const KEEP = 256 * 1024;   // scrollback kept for views that open later

export class Terms {
  constructor(emit) { this.emit = emit; this.t = new Map(); }

  open({ id, cwd, cmd, cols = 100, rows = 30, doc = null }) {
    const have = this.t.get(id);
    if (have && !have.exited) return { id, running: true, cwd: have.cwd };
    if (!cwd || !fs.existsSync(cwd)) throw Object.assign(new Error(`No such directory: ${cwd}`), { status: 400 });
    const argv = Array.isArray(cmd) ? cmd : cmd ? ['/bin/sh', '-c', String(cmd)] : [];
    const env = { ...process.env, COLS: String(cols | 0 || 100), ROWS: String(rows | 0 || 30), TERM: 'xterm-256color' };
    const p = spawn('python3', [BRIDGE, ...argv], { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const dec = new StringDecoder('utf8');
    const term = { id, doc, cwd, proc: p, buf: have?.buf || '', pending: '', timer: null, exited: null, cols, rows };
    const flush = () => {
      term.timer = null;
      if (!term.pending) return;
      const data = term.pending;
      term.pending = '';
      this.emit(term.doc, 'term', { term: id, data });
    };
    const out = (d) => {
      const s = typeof d === 'string' ? d : dec.write(d);
      if (!s) return;
      term.buf = (term.buf + s).slice(-KEEP);
      term.pending += s;
      if (!term.timer) term.timer = setTimeout(flush, 16);
    };
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    p.on('error', (e) => out(`\r\n[terminal failed: ${e.message} — needs python3]\r\n`));
    p.on('exit', (code) => {
      out(`\r\n\x1b[2m[process exited ${code ?? ''}]\x1b[0m\r\n`);
      flush();
      term.exited = { code, ts: Date.now() };
      this.emit(term.doc, 'term', { term: id, exit: code ?? 0 });
    });
    p.stdin.on('error', () => {});
    p.stdio[3]?.on?.('error', () => {});
    this.t.set(id, term);
    return { id, running: true, cwd };
  }
  get(id) { const t = this.t.get(id); if (!t) throw Object.assign(new Error(`No terminal "${id}"`), { status: 404 }); return t; }
  input(id, data) { const t = this.get(id); if (t.exited) throw Object.assign(new Error('The terminal has exited — reopen it'), { status: 409 }); t.proc.stdin.write(String(data)); }
  resize(id, cols, rows) {
    const t = this.t.get(id);
    if (!t) return;   // not opened yet: it opens with the size the view sends
    cols = Math.max(10, Math.min(500, cols | 0)); rows = Math.max(3, Math.min(300, rows | 0));
    if (t.exited || (t.cols === cols && t.rows === rows)) return;
    t.cols = cols; t.rows = rows;
    try { t.proc.stdio[3].write(`R ${cols} ${rows}\n`); } catch {}
  }
  buffer(id) { const t = this.t.get(id); return t ? { buf: t.buf, exited: t.exited, cwd: t.cwd, cols: t.cols, rows: t.rows } : null; }
  kill(id) { const t = this.t.get(id); if (!t) return; try { t.proc.kill('SIGHUP'); } catch {} this.t.delete(id); }
  list() { return [...this.t.values()].map((t) => ({ id: t.id, cwd: t.cwd, exited: t.exited, cols: t.cols, rows: t.rows })); }
  close() { for (const id of [...this.t.keys()]) this.kill(id); }
}
