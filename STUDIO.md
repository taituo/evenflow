# Studio

**Coding agents on an infinite canvas.** Every box is an [ACP](https://agentclientprotocol.com) session — Kiro CLI, a Claude Code or Gemini ACP adapter, or any other ACP agent — working in its own git worktree (or a sparse slice of a monorepo). Everything it does is recorded as SQL, every file change is snapshotted, deterministic monitors check each snapshot, and the places where it needs you show up as gates. You steer by pointing and typing (or talking); the agents can steer the screen too. Next to them: real terminals, live previews of the app they are building, code maps, notes and snippets.

```
npm start            # then open http://127.0.0.1:3210/studio   (full screen; also a ◫ tab in the normal app)
```

The first box creates a small demo git repository in the data directory, so you can try it at once with the built-in **mock agent** (no model, deterministic). Point it at your own project with `STUDIO_ROOT=/path/to/repo npm start`, or run it on a Linux box and look at it from your Mac (*Remote mode* below).

![Studio, light](docs/studio.jpg)
![Studio, dark](docs/studio-dark.jpg)

## How it works

| | |
|---|---|
| **Box = ACP session** | Draw a box (`Shift`+drag, or `N` then drag) and pick an agent. It starts in a new git worktree on its own branch (`studio/<name>-xxxx`), so agents never step on each other. Give it *paths* and the worktree is a **sparse checkout** (cone mode) — only `services/auth, libs/common` of a monorepo. Removing a box stops its process; the worktree, branch and history stay. |
| **Point + type** | Whatever is under the pointer is the target. Over a box, start typing: a floating input opens aimed at it; `↵` sends (queued if the agent is busy). Over a note, typing writes into it; over a terminal, into the shell. `Tab` in the input moves to the next box. The top-right chip shows the target — the same one voice goes to. |
| **Semantic zoom** | Far away a box is a tile (name, status, red lights, what it last said). Closer, a card. Close up, the whole session: plan, transcript, tool calls, permission prompts, files changed, monitors, and a strip of its snapshots. Double-click or `⌥Z` zooms to a box, `Esc` back out. |
| **Look** | Neutral, quiet surfaces in **light and dark** (follows the system, or ◐ in the toolbar); color only where it means something — an agent's dot, a red monitor, a permission waiting. |
| **Layouts** | Positions are part of the versioned canvas: saved, undoable, the same on every screen. **Arrange** (`L`): grid, one row, forks as a tree, focus the pointed box, tiles. Panels follow their box. *Save this layout…* keeps named layouts to switch between. |
| **Snapshots** | After every tool call and file write the box's working directory is committed into a private *shadow git* — the project's own git, index and branches are never touched. Writes that go through ACP's `fs/write_text_file` are snapshotted before the agent hears back, so each snapshot belongs to exactly one tool call. |
| **Diff tray, timeline, replay** | Bottom of the screen: every snapshot of every agent as a diff card, scrollable, filterable per agent, on one timeline (quiet stretches squeezed). Drag it or press `[` `]`, or **▶ Replay** (`P`) to step through every change: the whole studio shows that moment — each box's transcript, files and lights as they were. `Esc` returns to live. |
| **Rewind / fork** | From any card: **⑂ fork** (a new box, new worktree, the files of that moment, and the conversation up to it as context), **↺ rewind** (put that box's directory back; the moment before is snapshotted first, and the agent is told next turn). |
| **Sub-agents** | From a box's ⋯ menu, the spotlight or an agent's own tools: a **reviewer in the same folder** (sees the uncommitted work, no new branch) or a **sub-agent in its own worktree** with the box's current files and a fresh conversation. The link between boxes says which (`⑂ #3`, `↳ same folder`). |
| **Director** | Who runs the screen (`D`, or ◎ in the toolbar). **Off**: you. **Rules**: no model — a permission or a crash brings that box into view, a red monitor brings its diff, a new box or fork re-arranges the canvas, a dev server an agent starts opens as a preview next to it, a lone working agent is followed, a quiet studio zooms out. **Agent**: a *director box* (any ACP agent, role `director`) gets a digest of what happened every few seconds and decides with its studio tools. Every move shows its reason; while you are using the studio the director only reports, it never takes the camera from you. |
| **Agents drive too** | Every session gets the studio's own tools over MCP (below): an agent can **spin off a copy of itself** to try an alternative instead of explaining it — its reason is shown on the new box and as an update in the right column — start a reviewer, open a preview of what it built, a terminal or a code map, focus the screen on something, or leave a note. |
| **Monitors** | Deterministic checks on each snapshot, no model involved: `syntax` (JS/JSON/Python parse), `churn` (the same lines rewritten 3–4×: the agent is looping), `size`, `tests` (test file or test case removed; source without tests), `secrets` (keys and tokens in added lines), `deps` (manifests and lockfiles), `scope` (files outside the box's globs). Add your own in `.studio/monitors.json`; a `tsconfig.json` with a local `tsc` gives a `typecheck` monitor automatically. |
| **Gates** | The right column: permission requests (blocking — `Y` / `A` / `N` over the box, or the buttons), a monitor that went red (closes itself when the cause is gone), a finished turn waiting for you, a crashed agent, an agent's spin-off. `G` jumps to the next one. |
| **Terminals** | `⌥T` (or ⌨ on a box): a real shell in that box's worktree, in a panel — a PTY on the server (system `python3`, no native modules), a built-in terminal emulator in the browser (colors, cursor movement, scroll regions, alternate screen: shells, `git`, `vim`, `htop`). Late viewers get the scrollback. On a remote studio the shell is on the remote machine. |
| **Previews** | A panel with a running UI: a dev server (`http://localhost:5173`), a dashboard, or a whole Linux desktop streamed by [voxl](https://github.com/tembo/voxl) (`:6901`). Local URLs go through the studio server (`/preview/<port>/…`, WebSockets included), so a studio on a VPS shows the VPS's apps over the same tunnel. Hover to interact; ⌖ keeps it interactive. |
| **Code map** | `⌥M`: a treemap of the repo — or of a box's latest snapshot, or a sparse slice — where every file an agent touched takes its color (fading with time). Click a file to open its latest diff. |
| **Notes, snippets, prompts** | `T` or double-click: a note. Select text anywhere (a transcript, a diff) and press `S`, or drag it onto the canvas: a snippet panel. Drag text onto a box: it is sent to it. Drag a **prompt bubble** from one box onto another to run the same prompt there. Drag a note onto a box to send it. |
| **Review** | `⌥R`: a read-only reviewer session gets the diff since the start (or up to the scrub point) plus the monitor results, and writes its findings into a review panel. *Send to…* hands them back. |
| **Subtitles** | What the agent says streams sentence by sentence as subtitles — the box you point at wins. |
| **Idle** | When nobody touches the studio (60 s by default; spotlight → *Screensaver after…*), the panels fade out one by one and a paper shader is left, colored by the agents and moving faster the more of them work, with each agent's name and last sentence over it. Any input brings everything back. |
| **Spotlight** | `⌘K` / `Ctrl+K`: every command by name; type a URL or a port to preview it, or `select …` to run SQL on the session database into a panel. |
| **Dashboard twin** | The studio is mirrored into an ordinary sheet (`<doc>-dash`: tables *Agents* and *Monitors* with traffic lights), so spread's Live mode, the TV remote, SQL over tables and time replay all work on your agents. |

![Idle](docs/studio-idle.jpg)

### Keys

| key | | key | |
|---|---|---|---|
| `Shift`+drag · `N` | new agent box | `G` | next gate |
| point + type · `↵` · `/` | floating input to the target | `[` `]` · `P` | previous / next snapshot · replay |
| `T` · double-click | new note | `Esc` | close · back to live · fit all |
| select + `S` · drag text | snippet panel (dropped on a box: sent to it) | `L` · `D` | arrange · saved layouts · director |
| `Y` `A` `N` | answer the permission of the box you point at | `B` | show / hide the diff tray |
| `⌥R` `⌥F` `⌥T` `⌥M` | review · fork · terminal · code map for the box under the pointer | `⌥S` `⌥.` `⌥Z` `⌥D` | start/stop · interrupt · zoom · its diffs only |
| drag · wheel | pan | pinch · `⌘`+wheel | zoom |
| `⌘K` | spotlight | `?` | all keys |

## Agents

Presets (the picker lists them; names are yours):

| preset | command |
|---|---|
| `mock` | `node bin/mock-acp.mjs` — deterministic demo agent: implements a small module + test; `break` / `fix` / `loop` / `secret` / `deps` / `review` / `slow` trigger the monitors and flows; `alternative` calls `studio_fork`, `reviewer` calls `studio_spawn`, `serve` starts a little web app (the director previews it); as a director box it answers digests with `studio_show` |
| `kiro` | `kiro-cli acp --agent-engine=v3` |
| `claude` | `claude-code-acp` |
| `gemini` | `gemini --experimental-acp` |

Add or override presets in `data/settings.json` (`"studioAgents": { "kiro-fast": { "label": "Kiro (fast)", "command": "kiro-cli acp --agent-engine=v3 --model haiku" } }`) or with `STUDIO_AGENTS='{"x":{"command":"…"}}'`. `"mcp": false` on a preset leaves out the studio tools for that agent. An agent that cannot start shows up as an *error* gate with its stderr.

The client side of ACP implemented here: `initialize`, `session/new` (with the studio's MCP server in `mcpServers`), `session/load` (a restarted box resumes the same session when the agent supports it; otherwise it gets the transcript as context), `session/prompt`, `session/cancel`, `session/update` (messages, thoughts, tool calls with diffs, plans, modes), `session/request_permission`, `fs/read_text_file` and `fs/write_text_file` (confined to the box's working directory).

## The agents' own tools (MCP)

Every session started by the studio gets `bin/studio-mcp.mjs` as an MCP server (stdio), attached to its box:

| tool | |
|---|---|
| `studio_fork` | spin off a copy of yourself — same files, the conversation so far — to try an alternative. `reason` is shown to the user on the new box: *say why it is worth trying instead of explaining it* |
| `studio_spawn` | a sub-agent: `mode: "same"` (same folder, e.g. `role: "review"`) or `"worktree"` (own copy of your files, fresh conversation) |
| `studio_show` | control the screens: `focus` a box or panel, `open` a preview (`{kind:"preview", url}`), terminal, code map or note, `arrange`, `scrub` to a snapshot, `fit`, `theme`, `tray` |
| `studio_note` | a note next to your box |
| `studio_prompt` | a message to another box |
| `studio_status` | what every box is doing |

Run it yourself as an orchestrator for any MCP client: `claude mcp add studio -- node bin/studio-mcp.mjs` (without `STUDIO_AGENT` every tool takes an `agent` id). Everything is plain HTTP underneath, so it all works **headless**: boxes, panels and layouts live in the server's versioned doc whether or not a browser is open; `POST /api/studio/view` moves every open screen.

## Remote mode: the studio on Linux, the screen on your Mac

Agents, worktrees, terminals and previews belong where the code builds — a VPS, a VM, a workstation. Run the studio there and look at it through one SSH tunnel, like Herdr's remote attach but with a browser:

```
node bin/remote.mjs me@box                       # starts it on the box if needed (~/spread), tunnels, opens /studio
node bin/remote.mjs me@box --dir ~/src/spread --root ~/work/monorepo --local 3310
```

The server on the box listens on 127.0.0.1 only. Closing the tunnel leaves the studio and its agents running; reattach any time (from another machine too). To serve beyond localhost — a LAN, Tailscale — set `SPREAD_TOKEN=…` and open `/studio?token=…` once (it becomes a cookie; scripts send `Authorization: Bearer …`). Everything else, including previews and WebSockets, needs the token too.

## Voice and other inputs

The studio does not ship speech; it gives your own pipeline (e.g. Parakeet STT → text, VoxCPM2 TTS ← text) two ends — locally or through the tunnel:

- **In:** `POST /api/studio/say {"text": "…"}` goes to whatever the user is pointing at (`GET /api/studio/target`), or to `target: {kind, id}`. "stop / seis / peru" interrupts; "yes / kyllä / joo" and "no / ei" answer a pending permission; anything else is a prompt (a panel gets the text; a terminal gets a command line).
- **Out:** the SSE stream `GET /api/events` carries `{"type":"studio","kind":"say","agent":…,"text":…}` for every finished sentence — feed it to TTS.

## Command monitors — `.studio/monitors.json` in the project root

```json
[
  { "id": "typecheck", "run": "npx tsc --noEmit", "match": "\\.tsx?$", "timeout": 120000 },
  { "id": "unit", "run": "npm test --silent", "match": "\\.(js|ts)$" }
]
```

Each runs in the box's working directory after a snapshot whose files match `match` (always, without it). Exit 0 is green, anything else red with the failing lines. One run per monitor at a time, always on the newest snapshot.

## Session SQL

`data/studio/sessions.sqlite` (node:sqlite). `POST /api/studio/sql {"sql": "…"}` runs read-only queries (also from the spotlight):

| table | |
|---|---|
| `agents` | id, doc, name, command, cwd, root, branch, session_id, agent_info, fork_of |
| `events` | seq, ts, agent, kind (`user` `agent` `thought` `tool` `plan` `permission` `turn` `system` `error`), text, tool_id, tool_kind, status, title, json, turn |
| `snapshots` | agent, n, ts, commit_id, parent, reason (the tool call), tool_id, seq (last event), files, adds, dels |
| `monitors` | agent, snap, ts, monitor, level, summary, detail |
| `gates` | id, agent, ts, kind, title, detail, json, blocking, resolved, resolution |

```sql
SELECT s.n, s.reason, m.monitor, m.summary FROM snapshots s JOIN monitors m ON m.agent = s.agent AND m.snap = s.n WHERE m.level = 'red';
SELECT agent, count(*) FROM events WHERE kind = 'tool' AND status = 'failed' GROUP BY agent;
```

## API

Text by default where it helps an agent read it; `format=json` for JSON.

| | |
|---|---|
| `GET /api/studio` | overview: agents, status, lights, plan, last sentence, why, open gates, target |
| `POST /api/studio/agents` | `{preset or command, name?, prompt?, x,y,w,h?, worktree?, sparse?, scope?, cwd?}` → new box (and worktree) |
| `DELETE /api/studio/agents?id=` | remove a box (keeps worktree and history) |
| `POST /api/studio/prompt` | `{agent, text, interrupt?}` |
| `POST /api/studio/start` · `/stop` · `/cancel` | `{agent}` |
| `POST /api/studio/gate` | `{gate, option}` answers a permission; `{gate, dismiss: true}` |
| `POST /api/studio/fork` | `{agent, snap?, name?, prompt?, reason?}` |
| `POST /api/studio/spawn` | `{agent, mode: same/worktree, role?, prompt?, reason?, preset?}` |
| `POST /api/studio/rewind` | `{agent, snap}` |
| `POST /api/studio/review` | `{agent, from?, to?}` → a review panel |
| `POST /api/studio/director` | `{mode: off/auto/agent, preset?}` — `agent` starts a director box if there is none |
| `POST /api/studio/activity` | the person is using the studio (the view sends it): the director reports instead of moving |
| `POST /api/studio/view` | `{focus?, open?, arrange?, scrub?, fit?, theme?, tray?, idle?, reason?}` — panels and layout in the doc, the rest to every screen |
| `POST /api/studio/term` · `/term/input` · `/term/resize` · `GET /api/studio/term?id=` | open a terminal panel's PTY · keystrokes · size · scrollback |
| `GET /preview/<port>/…` | reverse proxy to a local port (HTTP and WebSocket) for preview panels |
| `GET /api/studio/codemap?agent=&paths=` | files with sizes, and who touched which |
| `POST /api/studio/say` · `GET/POST /api/studio/target` | voice / text routed to the pointer |
| `GET /api/studio/events?agent=` | the transcript (`since=`, `before=`, `format=text`) |
| `GET /api/studio/timeline` · `/monitors?agent=` · `/gates` | snapshots of all boxes · monitor history · open gates |
| `GET /api/studio/diff?agent=&from=&to=` | `from`/`to` = snapshot number, `base` or `last`; `format=text` for the patch |
| `GET /api/studio/file?agent=&snap=&path=` · `/tree?agent=&snap=` | a file / the file list as of a snapshot |
| `POST /api/studio/sql` | read-only SQL on the session database |

The layout (boxes, panels, saved layouts) is an ordinary versioned spread doc of type `studio` — `POST /api/ops` with `addAgent` / `updateAgent` / `addPanel` / `updatePanel` / `removePanel` / `saveLayout` / `removeLayout` works, and undo, history and multi-user editing come with it.

## Limits, honestly

- The shadow snapshot runs `git add -A` on the box's directory: fast for ordinary repos; use sparse worktrees for huge monorepos. `.gitignore` is honoured; `node_modules`, `dist`, `target` and `.venv` are always skipped.
- When an agent writes files itself (not through `fs/write_text_file`), snapshots follow its `tool_call_update`s and a file watcher; very fast consecutive writes can land in one snapshot. Two agents in the *same folder* see each other's changes in their snapshots.
- `churn` compares line ranges without following lines that moved; it is a cheap signal, not proof.
- Forking carries the conversation as text in the first prompt — ACP has no way to branch an agent's own history.
- The terminal emulator covers what shells and common TUIs use; it treats wide characters (emoji, CJK) as one cell and has no mouse reporting.
- Previews of apps that build absolute URLs from their own host name, or that refuse to be framed by CSP in JavaScript, may need their dev server's `base` / host settings adjusted.
- No authentication unless `SPREAD_TOKEN` is set. Agents and terminals run with the server user's rights.
