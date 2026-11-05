// Agent Client Protocol (ACP) client: JSON-RPC 2.0 over a child process's stdio, one JSON message per line.
// Spec: https://agentclientprotocol.com — any ACP agent works (Kiro CLI `acp`, Claude Code / Gemini ACP adapters, …).
//
// The client side we implement:
//   → initialize, session/new, session/load, session/prompt, session/cancel (notification), session/set_mode
//   ← session/update (notification), session/request_permission, fs/read_text_file, fs/write_text_file
// Everything the agent says arrives as an 'update' event; requests the agent makes of us are handled by the
// callbacks given to the constructor (permission is async: the UI answers it later).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const PROTOCOL_VERSION = 1;

/** Split a command line into argv, honouring "double" and 'single' quotes. */
export function splitCommand(cmd) {
  if (Array.isArray(cmd)) return cmd.map(String);
  const out = [];
  let cur = '', q = null, any = false;
  for (const ch of String(cmd)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

export class AcpClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string|string[]} o.command   e.g. "kiro-cli acp --agent-engine=v3"
   * @param {string} o.cwd
   * @param {object} [o.env]
   * @param {(params) => Promise<object>} [o.onPermission]  resolves to { outcome: { outcome: 'selected', optionId } } or { outcome: { outcome: 'cancelled' } }
   * @param {(params) => Promise<object>} [o.onReadFile]
   * @param {(params) => Promise<object>} [o.onWriteFile]
   */
  constructor(o) {
    super();
    this.o = o;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
    this.closed = false;
    this.agentCapabilities = {};
    this.agentInfo = null;
  }

  start() {
    const [bin, ...args] = splitCommand(this.o.command);
    if (!bin) throw new Error('empty agent command');
    this.proc = spawn(bin, args, { cwd: this.o.cwd, env: { ...process.env, ...(this.o.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._data(d));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-8000); this.emit('stderr', d); });
    this.proc.on('error', (e) => this._close(e));
    this.proc.on('exit', (code, sig) => this._close(code === 0 || sig === 'SIGTERM' ? null : new Error(`agent exited (${sig || code})${this.stderr ? ': ' + this.stderr.trim().split('\n').slice(-3).join(' | ') : ''}`), code));
    this.proc.stdin.on('error', () => {});
    return this;
  }

  _close(err, code) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err || new Error('agent closed'));
    this.pending.clear();
    this.emit('exit', { error: err ? err.message : null, code });
  }

  _data(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.emit('noise', line); continue; }
      this._message(msg);
    }
  }

  _send(msg) {
    if (this.closed) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  async _message(m) {
    if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'agent error'), { code: m.error.code, data: m.error.data }));
      else p.resolve(m.result);
      return;
    }
    if (!m.method) return;
    if (m.id == null) {   // notification
      if (m.method === 'session/update') this.emit('update', m.params);
      else this.emit('notification', m);
      return;
    }
    // a request from the agent
    try {
      let result;
      if (m.method === 'session/request_permission') result = await (this.o.onPermission ? this.o.onPermission(m.params) : { outcome: { outcome: 'cancelled' } });
      else if (m.method === 'fs/read_text_file' && this.o.onReadFile) result = await this.o.onReadFile(m.params);
      else if (m.method === 'fs/write_text_file' && this.o.onWriteFile) result = await this.o.onWriteFile(m.params);
      else { this._send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } }); return; }
      this._send({ id: m.id, result: result ?? null });
    } catch (e) {
      this._send({ id: m.id, error: { code: -32603, message: e.message } });
    }
  }

  request(method, params, timeoutMs = 0) {
    if (this.closed) return Promise.reject(new Error('agent is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let t = null;
      if (timeoutMs) t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._send({ id, method, params });
    });
  }
  notify(method, params) { this._send({ method, params }); }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'spread-studio', version: '0.1.0' },
    }, 60000);
    this.agentCapabilities = r?.agentCapabilities || {};
    this.agentInfo = r?.agentInfo || null;
    this.authMethods = r?.authMethods || [];
    return r;
  }
  async newSession(cwd) {
    const r = await this.request('session/new', { cwd, mcpServers: [] }, 120000);
    this.sessionId = r.sessionId;
    this.modes = r.modes || null;
    return r;
  }
  async loadSession(sessionId, cwd) {
    if (!this.agentCapabilities.loadSession) throw new Error('agent cannot load sessions');
    const r = await this.request('session/load', { sessionId, cwd, mcpServers: [] }, 120000);
    this.sessionId = sessionId;
    return r;
  }
  prompt(text) {
    const blocks = Array.isArray(text) ? text : [{ type: 'text', text: String(text) }];
    return this.request('session/prompt', { sessionId: this.sessionId, prompt: blocks });
  }
  cancel() { this.notify('session/cancel', { sessionId: this.sessionId }); }
  setMode(modeId) { return this.request('session/set_mode', { sessionId: this.sessionId, modeId }, 30000); }

  stop() {
    if (this.closed || !this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill('SIGTERM');
    const p = this.proc;
    setTimeout(() => { try { if (p.exitCode == null) p.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
}
