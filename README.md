# Evenflow

**Coding agents on an infinite canvas.** Every box is an [ACP](https://agentclientprotocol.com) session — Kiro CLI, a Claude Code or Gemini ACP adapter, or any other ACP agent — in its own git worktree. You steer by pointing and typing (or talking); a director keeps what matters on screen. Every step is recorded as SQL, every file change is a snapshot, deterministic monitors check each one, and wherever an agent needs you shows up as a gate. All the diffs scroll on one timeline you can replay, rewind or fork from.

![Evenflow](docs/studio.jpg)

```
npm start          # → http://127.0.0.1:3210/studio
npm test           # node tests (engine, API, studio: ACP, snapshots, monitors, terminals, previews, director…)
npm run e2e:studio # the studio in a real browser (Playwright + Chromium)
```

Node 22.13+, git and python3 (for terminals). Zero npm dependencies. The first box creates a small demo repository, so you can try it at once with the built-in **mock agent** (no model, deterministic). Point it at your own project with `STUDIO_ROOT=/path/to/repo npm start`.

## What it does

- **A box is an agent.** `Shift`+drag on the canvas, pick an agent: it starts in a new worktree on its own branch — or a **sparse checkout** of only the paths you name in a monorepo. Point at a box and start typing to talk to it.
- **Or a classic coding UI.** `⌘\` switches to **focus mode**: agents on the left, one session and a composer in the middle, its changes, terminals and previews as tabs on the right — the same boxes and panels, moved into place. Any panel can **float** over the screen in either mode. The director switches modes, floats and moves things too.
- **Semantic zoom.** Far away a box is a tile (name, status, red lights, its last sentence); close up it is the whole session — plan, transcript, tool calls, permissions, files, monitors, snapshots.
- **Snapshots, replay, rewind, fork.** Every tool call is snapshotted into a private shadow git (your repo's git is never touched). The diff tray shows every change of every agent on one timeline: scrub it, **replay** it, **rewind** a box to any moment, or **fork** a new box from it.
- **Deterministic monitors** on every snapshot, no model involved: syntax, churn (the agent is looping), size, tests, secrets, dependencies, scope, plus your own commands (`.studio/monitors.json`).
- **Gates.** Permissions, red monitors, finished turns, crashes — the right column is where the agents need you. `Y`/`N` over a box answers it.
- **A director runs the screen.** *Rules* (no model) bring permissions, red monitors, new boxes and freshly started dev servers into view, with a reason on screen; or a *director agent* gets digests and decides. It only reports while you are using the studio.
- **Agents have tools of their own** (MCP, given to every session): spin off a copy to try an alternative — with the reason shown to you — start a reviewer in the same folder, open a preview or a terminal, focus the screen, leave a note.
- **Real terminals, live previews, code maps.** A shell in any box's worktree; the app the agents are building (or a [voxl](https://github.com/tembo/voxl) desktop) live in a panel; a treemap of the repo colored by who touched what.
- **Notes, snippets, prompts.** Select text and press `S`, drag it onto the canvas or onto a box; drag a prompt from one box to run it in another.
- **Layouts and looks.** Arrange as a grid, a fork tree or around one box; save named layouts. Light and dark. Idle, the panels fade away and a shader of the agents at work remains.
- **Remote.** Run it on a Linux box and look at it from your Mac: `node bin/remote.mjs me@box` (one SSH tunnel; `SPREAD_TOKEN` for anything beyond localhost).
- **Voice-ready.** `POST /api/studio/say` goes to whatever you point at; finished sentences stream out on `/api/events` for text-to-speech.

The full manual — keys, agents and presets, the agents' tools, director, remote mode, monitors, the session SQL and the HTTP API — is **[STUDIO.md](STUDIO.md)**.

![Focus mode](docs/studio-focus.jpg)

![Dark](docs/studio-dark.jpg)

## How it is built

```
lib/studio/
  acp.js          ACP client (JSON-RPC over stdio): sessions, prompts, permissions, fs
  index.js        boxes, worktrees (sparse), runtime per agent, fork / spawn / rewind / review, view commands
  director.js     who runs the screen: rules, or digests for a director agent
  shadow.js       shadow git per box: snapshots, diffs, rewind, materialize
  monitors.js     deterministic checks on every snapshot
  db.js           sessions as SQL (node:sqlite): events, snapshots, monitors, gates
  terms.js        terminals (PTY via bin/pty-bridge.py)
  preview.js      /preview/<port>/ reverse proxy, HTTP and WebSocket
public/canvases/studio/
  view.js         the canvas: boxes, panels, gates, tray, timeline, spotlight, director controls
  focus.js        focus mode (agents · session + composer · tabs) and floating panels
  panels.js       terminal, preview and code-map panels · term.js the terminal emulator
  layout.js       arrangements and saved layouts · saver.js idle mode
bin/
  mock-acp.mjs    a deterministic ACP agent for demos and tests
  studio-mcp.mjs  the studio's tools for agents (MCP over stdio)
  remote.mjs      start on a remote box and tunnel to it
```

The canvas layout (boxes, panels, layouts, settings) is a versioned document in **Spread**, the canvas engine Evenflow is built on — so it is undoable, multi-user and has history. Spread's sheets come along: the studio mirrors its agents and monitor lights into a sheet, so Live dashboards, replay and SQL over tables work on them too (`/` opens the sheets; see [docs/SPREAD.md](docs/SPREAD.md)).

## Status

Tested end to end with the mock agent (which uses the same ACP and MCP surface as a real one); real agents are configured as presets (`kiro`, `claude`, `gemini`) and in `data/settings.json`. Known limits are listed at the end of [STUDIO.md](STUDIO.md).

## License

MIT
