// A small VT100/xterm terminal emulator for studio terminal panels (no dependencies).
// Covers what shells and the usual TUIs use: cursor movement, erase, insert/delete lines and chars, scroll
// regions, alternate screen, SGR colors (16, 256, truecolor), bracketed paste, application cursor keys,
// device status reports. Wide characters are treated as one cell.

const PAL = ['#1d1f21', '#e5534b', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#d1d5da', '#636e7b', '#ff938a', '#6bc46d', '#daaa3f', '#6cb6ff', '#dcbdfb', '#56d4dd', '#f0f3f6'];
function c256(n) {
  if (n < 16) return PAL[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const s = [0, 95, 135, 175, 215, 255];
  return `rgb(${s[Math.floor(n / 36)]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`;
}
const BASE = Object.freeze({ fg: null, bg: null, b: 0, d: 0, i: 0, u: 0, v: 0 });
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const blank = (a) => ({ c: ' ', a });

export class Terminal {
  constructor(el, { onData, onResize } = {}) {
    this.el = el; this.onData = onData || (() => {}); this.onResize = onResize || (() => {});
    this.cols = 80; this.rows = 24;
    this.main = { lines: [], top: 0 }; this.alt = null;
    this.attr = BASE; this.x = 0; this.y = 0; this.saved = null;
    this.st = 0; this.par = ''; this.osc = '';
    this.mtop = 0; this.mbot = 23;
    this.modes = { cursor: true, wrap: true, appKeys: false, paste: false };
    this.scrollback = 2000;
    this.dirty = true;
    el.classList.add('vt');
    el.tabIndex = 0;
    el.innerHTML = '<div class="vt-in"></div><span class="vt-m">W</span>';
    Object.assign(el.style, { overflowY: 'auto', overflowX: 'hidden', font: '12.5px/1.32 ui-monospace, "SF Mono", Menlo, Consolas, monospace', color: '#d1d5da', outline: 'none', whiteSpace: 'pre', cursor: 'text', userSelect: 'text' });
    this.inner = el.firstChild;
    this.meter = el.lastChild;
    Object.assign(this.meter.style, { position: 'absolute', visibility: 'hidden' });
    el.addEventListener('keydown', (e) => this.key(e));
    el.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData.getData('text'); this.onData(this.modes.paste ? `\x1b[200~${t}\x1b[201~` : t); });
    el.addEventListener('focus', () => this.draw()); el.addEventListener('blur', () => this.draw());
    this.reset();
  }
  get buf() { return this.alt || this.main; }
  reset() { this.main = { lines: [] }; for (let i = 0; i < this.rows; i++) this.main.lines.push(this.line()); this.alt = null; this.x = this.y = 0; this.mtop = 0; this.mbot = this.rows - 1; this.attr = BASE; this.queue(); }
  line() { return Array.from({ length: this.cols }, () => blank(BASE)); }
  /** screen row r → index into lines */
  idx(r) { return this.buf.lines.length - this.rows + r; }
  row(r) { return this.buf.lines[this.idx(r)]; }

  fit() {
    const r = this.el.getBoundingClientRect(), m = this.meter.getBoundingClientRect();
    if (!r.width || !m.width) return;
    const cols = Math.max(20, Math.floor((r.width - 14) / m.width)), rows = Math.max(5, Math.floor((r.height - 8) / m.height));
    if (cols !== this.cols || rows !== this.rows) { this.resize(cols, rows); this.onResize(cols, rows); }
  }
  resize(cols, rows) {
    for (const b of [this.main, this.alt].filter(Boolean)) {
      for (const L of b.lines) { while (L.length < cols) L.push(blank(BASE)); L.length = cols; }
      while (b.lines.length < rows) b.lines.push(this.line.call({ cols }));
    }
    if (this.alt) while (this.alt.lines.length > rows) this.alt.lines.shift();
    this.cols = cols; this.rows = rows;
    this.mtop = 0; this.mbot = rows - 1;
    this.x = Math.min(this.x, cols - 1); this.y = Math.min(this.y, rows - 1);
    this.queue();
  }

  // ------------------------------------------------------------ input from the program
  write(s) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], code = s.charCodeAt(i);
      if (this.st === 1) {   // ESC
        if (ch === '[') { this.st = 2; this.par = ''; }
        else if (ch === ']') { this.st = 3; this.osc = ''; }
        else if (ch === '(' || ch === ')' || ch === '*' || ch === '+') this.st = 4;
        else { this.st = 0; this.escape(ch); }
        continue;
      }
      if (this.st === 2) {   // CSI
        if (code >= 0x40 && code <= 0x7e) { this.st = 0; this.csi(ch, this.par); }
        else this.par += ch;
        continue;
      }
      if (this.st === 3) {   // OSC: title etc., ignored
        if (ch === '\x07') this.st = 0;
        else if (ch === '\x1b' && s[i + 1] === '\\') { this.st = 0; i++; }
        continue;
      }
      if (this.st === 4) { this.st = 0; continue; }   // charset designation
      if (code < 32 || code === 127) { this.control(ch); continue; }
      this.print(ch);
    }
    this.queue();
  }
  control(ch) {
    switch (ch) {
      case '\x1b': this.st = 1; break;
      case '\r': this.x = 0; break;
      case '\n': case '\x0b': case '\x0c': this.lf(); break;
      case '\b': if (this.x > 0) this.x--; break;
      case '\t': this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); break;
    }
  }
  print(ch) {
    if (this.x >= this.cols) { if (this.modes.wrap) { this.x = 0; this.lf(); } else this.x = this.cols - 1; }
    this.row(this.y)[this.x] = { c: ch, a: this.attr };
    this.x++;
  }
  lf() { if (this.y === this.mbot) this.scrollUp(1); else if (this.y < this.rows - 1) this.y++; }
  scrollUp(n) {
    const b = this.buf;
    for (let k = 0; k < n; k++) {
      if (this.mtop === 0 && this.mbot === this.rows - 1 && !this.alt) {
        b.lines.push(this.line());
        if (b.lines.length > this.rows + this.scrollback) b.lines.shift();
      } else {
        b.lines.splice(this.idx(this.mtop), 1);
        b.lines.splice(this.idx(this.mbot) + 1, 0, this.line());
      }
    }
  }
  scrollDown(n) {
    const b = this.buf;
    for (let k = 0; k < n; k++) { b.lines.splice(this.idx(this.mbot), 1); b.lines.splice(this.idx(this.mtop), 0, this.line()); }
  }
  escape(ch) {
    if (ch === '7') this.saved = { x: this.x, y: this.y, a: this.attr };
    else if (ch === '8' && this.saved) { this.x = this.saved.x; this.y = this.saved.y; this.attr = this.saved.a; }
    else if (ch === 'M') { if (this.y === this.mtop) this.scrollDown(1); else if (this.y > 0) this.y--; }
    else if (ch === 'D') this.lf();
    else if (ch === 'E') { this.x = 0; this.lf(); }
    else if (ch === 'c') this.reset();
  }
  csi(f, p) {
    const priv = p[0] === '?' || p[0] === '>' || p[0] === '=' ? p[0] : '';
    const args = (priv ? p.slice(1) : p).split(';').map((x) => (x === '' ? null : parseInt(x, 10)));
    const n = (i, d = 1) => (args[i] == null || isNaN(args[i]) ? d : args[i]) || d;
    const R = this.row(this.y);
    switch (f) {
      case 'A': this.y = Math.max(this.y < this.mtop ? 0 : this.mtop, this.y - n(0)); break;
      case 'B': case 'e': this.y = Math.min(this.y > this.mbot ? this.rows - 1 : this.mbot, this.y + n(0)); break;
      case 'C': case 'a': this.x = Math.min(this.cols - 1, this.x + n(0)); break;
      case 'D': this.x = Math.max(0, Math.min(this.x, this.cols) - n(0)); break;
      case 'E': this.x = 0; this.y = Math.min(this.rows - 1, this.y + n(0)); break;
      case 'F': this.x = 0; this.y = Math.max(0, this.y - n(0)); break;
      case 'G': case '`': this.x = Math.min(this.cols - 1, n(0) - 1); break;
      case 'd': this.y = Math.min(this.rows - 1, n(0) - 1); break;
      case 'H': case 'f': this.y = Math.min(this.rows - 1, n(0) - 1); this.x = Math.min(this.cols - 1, n(1) - 1); break;
      case 'J': {
        const m = args[0] || 0;
        if (m === 0) { this.clearLine(this.y, this.x, this.cols); for (let r = this.y + 1; r < this.rows; r++) this.clearLine(r, 0, this.cols); }
        else if (m === 1) { this.clearLine(this.y, 0, this.x + 1); for (let r = 0; r < this.y; r++) this.clearLine(r, 0, this.cols); }
        else { for (let r = 0; r < this.rows; r++) this.clearLine(r, 0, this.cols); if (m === 3 && !this.alt) this.main.lines.splice(0, this.main.lines.length - this.rows); }
        break;
      }
      case 'K': { const m = args[0] || 0; this.clearLine(this.y, m === 0 ? this.x : 0, m === 1 ? this.x + 1 : this.cols); break; }
      case 'L': if (this.y >= this.mtop && this.y <= this.mbot) for (let k = 0; k < n(0); k++) { this.buf.lines.splice(this.idx(this.mbot), 1); this.buf.lines.splice(this.idx(this.y), 0, this.line()); } break;
      case 'M': if (this.y >= this.mtop && this.y <= this.mbot) for (let k = 0; k < n(0); k++) { this.buf.lines.splice(this.idx(this.y), 1); this.buf.lines.splice(this.idx(this.mbot) + 1, 0, this.line()); } break;
      case 'P': R.splice(this.x, n(0)); while (R.length < this.cols) R.push(blank(this.attr)); break;
      case '@': for (let k = 0; k < n(0); k++) R.splice(this.x, 0, blank(this.attr)); R.length = this.cols; break;
      case 'X': for (let k = 0; k < n(0) && this.x + k < this.cols; k++) R[this.x + k] = blank(this.attr); break;
      case 'S': this.scrollUp(n(0)); break;
      case 'T': if (!priv) this.scrollDown(n(0)); break;
      case 'r': this.mtop = Math.max(0, n(0) - 1); this.mbot = Math.min(this.rows - 1, (args[1] || this.rows) - 1); if (this.mbot <= this.mtop) { this.mtop = 0; this.mbot = this.rows - 1; } this.x = 0; this.y = 0; break;
      case 's': this.saved = { x: this.x, y: this.y, a: this.attr }; break;
      case 'u': if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; } break;
      case 'm': this.sgr(args); break;
      case 'n': if (args[0] === 6) this.onData(`\x1b[${this.y + 1};${this.x + 1}R`); else if (args[0] === 5) this.onData('\x1b[0n'); break;
      case 'c': if (!priv) this.onData('\x1b[?1;2c'); else if (priv === '>') this.onData('\x1b[>0;10;1c'); break;
      case 'h': case 'l': if (priv === '?') for (const a of args) this.mode(a, f === 'h'); break;
      case 't': break;
    }
  }
  clearLine(r, a, b) { const L = this.row(r); for (let i = a; i < b && i < this.cols; i++) L[i] = blank(this.attr.bg ? { ...BASE, bg: this.attr.bg } : BASE); }
  mode(m, on) {
    if (m === 25) this.modes.cursor = on;
    else if (m === 7) this.modes.wrap = on;
    else if (m === 1) this.modes.appKeys = on;
    else if (m === 2004) this.modes.paste = on;
    else if (m === 1049 || m === 1047 || m === 47) {
      if (on && !this.alt) { this.altSaved = { x: this.x, y: this.y, a: this.attr }; this.alt = { lines: Array.from({ length: this.rows }, () => this.line()) }; this.x = this.y = 0; }
      else if (!on && this.alt) { this.alt = null; if (this.altSaved) { this.x = this.altSaved.x; this.y = this.altSaved.y; this.attr = this.altSaved.a; } }
      this.mtop = 0; this.mbot = this.rows - 1;
    }
  }
  sgr(a) {
    if (!a.length) a = [0];
    let t = { ...this.attr };
    for (let i = 0; i < a.length; i++) {
      const v = a[i] ?? 0;
      if (v === 0) t = { ...BASE };
      else if (v === 1) t.b = 1; else if (v === 2) t.d = 1; else if (v === 3) t.i = 1; else if (v === 4) t.u = 1; else if (v === 7) t.v = 1;
      else if (v === 22) { t.b = 0; t.d = 0; } else if (v === 23) t.i = 0; else if (v === 24) t.u = 0; else if (v === 27) t.v = 0;
      else if (v >= 30 && v <= 37) t.fg = PAL[v - 30]; else if (v >= 90 && v <= 97) t.fg = PAL[v - 82]; else if (v === 39) t.fg = null;
      else if (v >= 40 && v <= 47) t.bg = PAL[v - 40]; else if (v >= 100 && v <= 107) t.bg = PAL[v - 92]; else if (v === 49) t.bg = null;
      else if (v === 38 || v === 48) {
        let col = null;
        if (a[i + 1] === 5) { col = c256(a[i + 2] ?? 0); i += 2; }
        else if (a[i + 1] === 2) { col = `rgb(${a[i + 2] ?? 0},${a[i + 3] ?? 0},${a[i + 4] ?? 0})`; i += 4; }
        if (v === 38) t.fg = col; else t.bg = col;
      }
    }
    this.attr = Object.freeze(t);
  }

  // ------------------------------------------------------------ keys from the user
  key(e) {
    if (e.metaKey) return;   // ⌘C / ⌘V stay with the browser
    const app = this.modes.appKeys;
    const k = e.key;
    let s = null;
    const map = { Enter: '\r', Backspace: e.ctrlKey ? '\x08' : '\x7f', Tab: e.shiftKey ? '\x1b[Z' : '\t', Escape: '\x1b', ArrowUp: app ? '\x1bOA' : '\x1b[A', ArrowDown: app ? '\x1bOB' : '\x1b[B', ArrowRight: app ? '\x1bOC' : '\x1b[C', ArrowLeft: app ? '\x1bOD' : '\x1b[D', Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~', Insert: '\x1b[2~', F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS' };
    if (map[k]) s = map[k];
    else if (e.ctrlKey && k.length === 1) {
      const c = k.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) s = String.fromCharCode(c - 96);
      else if (k === '[') s = '\x1b'; else if (k === '\\') s = '\x1c'; else if (k === ']') s = '\x1d'; else if (k === ' ') s = '\x00';
      else return;
      if (k.toLowerCase() === 'c' && window.getSelection()?.toString()) return;   // copy a selection instead of ^C
    } else if (k.length === 1) s = (e.altKey ? '\x1b' : '') + k;
    if (s == null) return;
    e.preventDefault(); e.stopPropagation();
    this.el.scrollTop = this.el.scrollHeight;
    this.onData(s);
  }

  // ------------------------------------------------------------ render
  queue() { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = null; this.draw(); }); }
  draw() {
    const stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 30;
    const lines = this.buf.lines;
    const cy = this.idx(this.y);
    const showCursor = this.modes.cursor && document.activeElement === this.el;
    let html = '';
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      let out = '', run = '', ra = null;
      const flush = () => { if (!run) return; out += ra === BASE ? esc(run) : `<span style="${style(ra)}">${esc(run)}</span>`; run = ''; };
      let end = L.length;
      if (li !== cy) while (end > 0 && L[end - 1].c === ' ' && L[end - 1].a === BASE) end--;
      for (let x = 0; x < end; x++) {
        const cell = L[x];
        if (li === cy && x === this.x && showCursor) { flush(); out += `<span style="background:#d1d5da;color:#0b0b0d">${esc(cell.c)}</span>`; ra = null; continue; }
        if (cell.a !== ra) { flush(); ra = cell.a; }
        run += cell.c;
      }
      flush();
      if (li === cy && this.x >= end && showCursor) out += `${' '.repeat(Math.max(0, this.x - end))}<span style="background:#d1d5da"> </span>`;
      html += out + '\n';
    }
    this.inner.innerHTML = html;
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }
}
function style(a) {
  let fg = a.fg, bg = a.bg;
  if (a.v) { const t = fg || '#d1d5da'; fg = bg || '#0b0b0d'; bg = t; }
  return `${fg ? `color:${fg};` : ''}${bg ? `background:${bg};` : ''}${a.b ? 'font-weight:700;' : ''}${a.d ? 'opacity:.6;' : ''}${a.i ? 'font-style:italic;' : ''}${a.u ? 'text-decoration:underline;' : ''}`;
}
