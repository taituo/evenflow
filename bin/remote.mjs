#!/usr/bin/env node
// Remote mode: the studio runs on a Linux box (VPS, VM, a big workstation) — agents, worktrees, terminals and
// previews all live there — and your Mac only shows it, through one SSH tunnel. Like Herdr's remote attach,
// but the client is a browser window.
//
//   node bin/remote.mjs me@box                     start the studio on the box if it is not running, tunnel, open /studio
//   node bin/remote.mjs me@box --dir ~/src/spread --port 3210 --local 3310 --root ~/work/monorepo
//   node bin/remote.mjs me@box --no-start --no-open
//
// The server on the box listens on 127.0.0.1 only; nothing is exposed. Voice glue on the Mac (Parakeet → text,
// text → VoxCPM2) talks to http://127.0.0.1:<local>/api/studio/say and reads sentences from /api/events, as if
// the studio were local. Stop with Ctrl+C (the studio keeps running on the box; agents keep working).
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const dir = flag('dir', '~/spread');
const port = +flag('port', 3210);
const local = +flag('local', port);
const root = flag('root', null);
const noStart = flag('no-start', false) === true;
const noOpen = flag('no-open', false) === true;
const host = args.find((a) => !a.startsWith('--'));
if (!host) { console.error('usage: node bin/remote.mjs user@host [--dir ~/spread] [--port 3210] [--local 3210] [--root /path/to/repo] [--no-start] [--no-open]'); process.exit(2); }

const control = path.join(os.tmpdir(), `spread-ssh-%r@%h-%p`);
const SSH = ['-o', 'ControlMaster=auto', '-o', `ControlPath=${control}`, '-o', 'ControlPersist=10m', '-o', 'ServerAliveInterval=20', '-o', 'BatchMode=yes'];
const ssh = (cmd) => execFileSync('ssh', [...SSH, host, cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const up = () => { try { return ssh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/api/help || true`) === '200'; } catch { return false; } };

try { ssh('true'); } catch (e) { console.error(`ssh ${host} failed (key or agent auth is required): ${String(e.stderr || e.message).trim()}`); process.exit(1); }
if (!up()) {
  if (noStart) { console.error(`Nothing on ${host}:${port}. Start it there (cd ${dir} && npm start) or drop --no-start.`); process.exit(1); }
  console.log(`Starting the studio on ${host} (${dir}, port ${port})…`);
  const env = `PORT=${port} HOST=127.0.0.1${root ? ` STUDIO_ROOT=${q(root)}` : ''}`;
  ssh(`cd ${dir} && (${env} nohup node server.js > studio.log 2>&1 < /dev/null &) && sleep 1`);
  for (let i = 0; i < 20 && !up(); i++) execFileSync('sleep', ['0.5']);
  if (!up()) { console.error(`It did not come up; see ${dir}/studio.log on ${host}.`); process.exit(1); }
}
const url = `http://127.0.0.1:${local}/studio`;
console.log(`Tunnel 127.0.0.1:${local} → ${host}:127.0.0.1:${port}\nStudio: ${url}\nVoice in: POST http://127.0.0.1:${local}/api/studio/say · sentences out: GET http://127.0.0.1:${local}/api/events\nCtrl+C closes the tunnel; the studio and its agents keep running on ${host}.`);
const t = spawn('ssh', [...SSH, '-N', '-L', `${local}:127.0.0.1:${port}`, host], { stdio: 'inherit' });
if (!noOpen) setTimeout(() => { try { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref(); } catch {} }, 800);
t.on('exit', (c) => process.exit(c ?? 0));
process.on('SIGINT', () => t.kill('SIGTERM'));
