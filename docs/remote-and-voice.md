# Remote and voice

## Agents on a Linux box, the screen on your Mac

Agents, worktrees, terminals and previews belong where the code builds: a VPS, a VM, a workstation. Run Evenflow there and look at it through one SSH tunnel:

```
node bin/remote.mjs me@box                       # start it on the box if needed (~/evenflow), tunnel, open /studio
node bin/remote.mjs me@box --dir ~/src/evenflow --root ~/work/monorepo --local 3310
node bin/remote.mjs me@box --no-start --no-open   # just the tunnel
```

| option | default | |
|---|---|---|
| `--dir` | `~/evenflow` | where Evenflow is checked out on the box |
| `--root` | | the repository the agents work on (`STUDIO_ROOT`) |
| `--port` | `3210` | the port on the box |
| `--local` | same as `--port` | the port on your machine |
| `--no-start` | | do not start the server on the box |
| `--no-open` | | do not open a browser |

The server on the box listens on `127.0.0.1` only, so nothing is exposed. The script uses an SSH control connection and forwards one port. Previews of apps on the box work through the same tunnel, because local URLs go through the studio server (`/preview/<port>/`, WebSockets included). Closing the tunnel leaves the studio and its agents running; reattach any time, from another machine too.

### Beyond localhost

To serve on a LAN or a tailnet, set a token:

```
SPREAD_TOKEN=$(openssl rand -hex 16) HOST=0.0.0.0 npm start
```

Open `/studio?token=…` once; the token becomes a cookie. Scripts send `Authorization: Bearer …`, and the MCP server passes `SPREAD_TOKEN` on. Every request needs it, including previews and WebSockets.

Agents and terminals run with the server user's rights. Expose the studio only to people you would give a shell.

## Voice

Evenflow does not ship speech recognition or synthesis. It gives your own pipeline two ends (for example Parakeet for speech to text and VoxCPM2 for text to speech), locally or through the tunnel.

**In: `POST /api/studio/say {"text": "…"}`** goes to what the person is pointing at (the target chip; in focus mode, the selected agent), or to `target: {kind, id}`:

| said | does |
|---|---|
| "stop" · "seis" · "peru" · "cancel" · "keskeytä" | interrupts the agent |
| "yes" · "kyllä" · "joo" · "ok" · "allow" · "salli" | allows a pending permission |
| "no" · "ei" · "reject" · "deny" · "älä" | rejects it |
| anything else | a prompt to the agent; a note gets the text; a terminal gets it as a command line |

`GET /api/studio/target` tells your glue what is targeted; `POST /api/studio/target` sets it.

**Out: the event stream `GET /api/events`** carries `{"type":"studio","kind":"say","agent":"…","text":"…"}` for every finished sentence an agent says. Feed those to text to speech. The same sentences appear as subtitles on screen.

A minimal loop:

```js
const es = new EventSource('http://127.0.0.1:3210/api/events');
es.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type === 'studio' && e.kind === 'say') speak(e.text); };
onTranscript((text) => fetch('http://127.0.0.1:3210/api/studio/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
```
