// Previews: show a running UI (a dev server, a dashboard, a voxl desktop stream) inside a studio panel, through
// this server — so a studio on a remote machine shows the remote app over the same SSH tunnel.
//   /preview/<port>/<path>  →  http://127.0.0.1:<port>/<path>
// Apps load absolute paths (/assets/…, /@vite/client): requests that match nothing here are sent to the port the
// page came from (Referer /preview/<port>/…, or the studio_preview cookie). WebSocket upgrades (HMR, voxl's video
// stream) are piped through the same way. Frame-blocking headers are dropped so the page can live in a panel.
import http from 'node:http';
import net from 'node:net';

const OK_PORT = (p, own) => Number.isInteger(p) && p >= 1 && p <= 65535 && p !== own;

export function previewTarget(req, u, ownPort) {
  const m = /^\/preview\/(\d{1,5})(\/.*)?$/.exec(u.pathname);
  if (m) { const port = +m[1]; return OK_PORT(port, ownPort) ? { port, path: (m[2] || '/') + u.search, prefixed: true } : null; }
  const ref = /\/preview\/(\d{1,5})\//.exec(req.headers.referer || '');
  if (ref && OK_PORT(+ref[1], ownPort)) return { port: +ref[1], path: u.pathname + u.search, prefixed: false, via: 'referer' };
  const ck = /(?:^|;\s*)studio_preview=(\d{1,5})/.exec(req.headers.cookie || '');
  if (ck && OK_PORT(+ck[1], ownPort) && !/^\/(api|canvases|shared|vendor|viz)\//.test(u.pathname)) return { port: +ck[1], path: u.pathname + u.search, prefixed: false, via: 'cookie' };
  return null;
}

export function proxyHttp(req, res, t) {
  const headers = { ...req.headers, host: `127.0.0.1:${t.port}` };
  delete headers.cookie;
  if (headers.referer) headers.referer = headers.referer.replace(/\/preview\/\d+/, '');
  const up = http.request({ host: '127.0.0.1', port: t.port, method: req.method, path: t.path, headers }, (r) => {
    const h = { ...r.headers };
    delete h['x-frame-options'];
    if (h['content-security-policy']) h['content-security-policy'] = String(h['content-security-policy']).replace(/frame-ancestors[^;]*;?/i, '');
    if (h.location && /^\//.test(h.location) && t.prefixed) h.location = `/preview/${t.port}${h.location}`;
    if (t.prefixed) h['set-cookie'] = [...[].concat(h['set-cookie'] || []), `studio_preview=${t.port}; Path=/; SameSite=Lax`];
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<body style="font:14px system-ui;color:#71717a;display:grid;place-items:center;height:90vh;margin:0"><div>Nothing is listening on port <b>${t.port}</b> yet.<br><small>${e.code || e.message}</small></div></body>`); } else res.end(); });
  req.pipe(up);
}

export function proxyUpgrade(req, socket, head, t) {
  const up = net.connect(t.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${t.path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (/^host$/i.test(k)) lines.push(`Host: 127.0.0.1:${t.port}`);
      else if (!/^cookie$/i.test(k)) lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const end = () => { try { socket.destroy(); } catch {} try { up.destroy(); } catch {} };
  up.on('error', end); socket.on('error', end);
}
