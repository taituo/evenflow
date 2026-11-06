# HTTP API

Everything the screen does goes through this API, so scripts, other agents and voice glue can do the same. Responses are JSON. A few read endpoints answer in plain text by default, because agents read them; add `format=json` for JSON. Base URL: `http://127.0.0.1:3210`. With `SPREAD_TOKEN` set, send `Authorization: Bearer <token>`.

Most calls take an `agent` id (in the body or the query) and an optional `doc` (the studio canvas; default `studio`). `by` labels who did something (`user`, `voice`, `agent:<id>`, `director`) and shows up in the log.

## Overview and history

| | |
|---|---|
| `GET /api/studio` | every box: status, lights, plan, last sentence, why, open gates, target. Text; `format=json` |
| `GET /api/studio/events?agent=` | the transcript. `since=<seq>`, `before=<seq>`, `limit=`, `format=text` |
| `GET /api/studio/turns?agent=` | every turn: `turn`, `seq` (its prompt event), `snap` (the snapshot just before it), `text` |
| `GET /api/studio/timeline` | the snapshots of all boxes, in time order |
| `GET /api/studio/diff?agent=&from=&to=` | `from` / `to`: a snapshot number, `base` or `last` (or `snap=` for one snapshot against its parent). `path=` for one file, `context=` lines, `format=text` for the patch |
| `GET /api/studio/file?agent=&snap=&path=` | a file as of a snapshot |
| `GET /api/studio/tree?agent=&snap=` | the file list as of a snapshot |
| `GET /api/studio/monitors?agent=` | monitor results, per snapshot |
| `GET /api/studio/gates` | open gates |
| `GET /api/studio/codemap?agent=&snap=&paths=` | files with sizes, and which agent touched which (adds, dels, when) |
| `POST /api/studio/sql` | `{sql, limit?}`, a read-only query on the session database (below). Text table; `format=json` |

## Boxes

| | |
|---|---|
| `POST /api/studio/agents` | a new box. `{preset` or `command, name?, prompt?, x?, y?, w?, h?, worktree?, sparse?, scope?, cwd?, role?, color?}`. Without `x` / `y` it is placed in a free spot. `sparse`: paths (array or comma separated) for a sparse checkout. `worktree: false` works in the project root. Returns `{id, name, cwd, branch}` |
| `DELETE /api/studio/agents?id=` | removes a box: stops its process and keeps its worktree, branch and history |
| `POST /api/studio/start` · `/stop` | `{agent}` |
| `POST /api/studio/prompt` | `{agent, text, interrupt?}`. Queued while the agent works; `interrupt: true` cancels the current turn first |
| `POST /api/studio/cancel` | `{agent}` interrupts the current turn |
| `POST /api/studio/gate` | `{gate, option}` answers a permission with the `optionId` of one of its options (`GET /api/studio/gates` lists them); `{gate, dismiss: true}` closes any gate |
| `POST /api/studio/fork` | `{agent, snap?, name?, prompt?, reason?, preset?}`, a new box from a snapshot (default: the latest) |
| `POST /api/studio/spawn` | `{agent, mode: "same" \| "worktree", role?, prompt?, reason?, preset?}`, a sub-agent |
| `POST /api/studio/rewind` | `{agent, turn, mode}`: to just before a turn, with `mode` `conversation` (files kept, the agent told to check), `both` or `files`. Or `{agent, snap}`: the files back to a snapshot. Refused (409) while the agent works |
| `POST /api/studio/review` | `{agent, from?, to?}`: a reviewer session writes its findings about that diff into a new review panel. Returns `{panel}` |

## Screen, director, terminals

| | |
|---|---|
| `POST /api/studio/view` | the view command (below) |
| `POST /api/studio/director` | `{mode: "off" \| "auto" \| "agent", preset?}`. `agent` starts a director box if there is none. Returns `{mode, box}` |
| `POST /api/studio/activity` | the person is using the studio (the screen sends this); the director only reports for a while |
| `POST /api/studio/target` · `GET` | what typing and voice go to: `{kind: "agent" \| "panel", id}` |
| `POST /api/studio/say` | `{text, target?}`, voice or text routed to the target (see [Remote and voice](remote-and-voice.md#voice)) |
| `POST /api/studio/term` | opens (or reattaches to) a terminal panel's PTY |
| `POST /api/studio/term/input` · `/term/resize` | `{id, data}` keystrokes · `{id, cols, rows}` |
| `GET /api/studio/term?id=` | the scrollback |
| `GET /preview/<port>/…` | reverse proxy to a local port, HTTP and WebSocket, for preview panels |

## The view command

`POST /api/studio/view` changes what the screens show. Every field is optional:

| field | |
|---|---|
| `mode` | `"canvas"` or `"focus"` |
| `focus` | bring into view: `{agent}` or `{panel}`. In focus mode it selects the agent, or the panel's tab |
| `tab` | focus mode's right-hand tab: `"changes"` or a panel id |
| `open` | a new panel: `{kind: "preview", url, agent?}`, `{kind: "terminal", agent?, cmd?}`, `{kind: "map", agent?, paths?}`, `{kind: "note", title, text, agent?}`. Returns `{panel}` |
| `float` | pin a panel on top of the screen: `{panel, x, y, w, h}` as fractions of the screen (0–1), or `{panel, off: true}`. An array for several |
| `move` | `[{id, x, y, w, h}]`, boxes and panels on the canvas, in canvas pixels |
| `arrange` | `"grid"`, `"row"`, `"tree"`, `"around"` (around `focus.agent`), `"stack"` |
| `scrub` | `{agent, snap}` shows the studio at that snapshot; `null` returns to live |
| `fit` | `true`: the whole canvas |
| `theme` · `tray` · `idle` | `"light"` / `"dark"` · show / hide the changes tray · `true` sleeps, `false` wakes |
| `reason` | one short sentence shown on screen |
| `by` | who is asking (`director`, `agent:<id>`, …) |

`open`, `float`, `move` and `arrange` change the layout document, so they are versioned and can be undone. The rest is sent to every open screen as an event. Returns `{panel?, moved?}`.

## The event stream

`GET /api/events` is Server-Sent Events. Studio events look like `{"type": "studio", "doc", "agent", "kind", "ts", …}`:

| kind | |
|---|---|
| `status` | `{status: "stopped" \| "starting" \| "idle" \| "working" \| "waiting" \| "error", turn}` |
| `queue` | `{queue}`, prompts waiting |
| `chunk` | a piece of a streamed message or thought: `{seq, msg: "agent" \| "thought", text}` |
| `event` · `tool` | a new or updated event (prompt, tool call, permission, turn end, rewind, …): `{event}` |
| `plan` | `{plan}` |
| `snapshot` | `{snap: {n, ts, reason, adds, dels, files}}` |
| `monitor` | `{snap, monitor, level, summary}` |
| `say` | `{text}`, a finished sentence (for text to speech and subtitles) |
| `gates` | `{gates}`, all open gates |
| `view` | a view command for the screens |
| `panel` | a panel's text being streamed (reviews) |
| `term` | terminal output |
| `mode` | the agent's ACP mode changed |

Changes to the layout document arrive as Spread `batch` events on the same stream.

## The layout document

The canvas (boxes, panels, saved layouts, settings) is a Spread document of type `studio`. `POST /api/ops` with `{doc, ops}` accepts `addAgent`, `updateAgent`, `removeAgent`, `addPanel`, `updatePanel`, `removePanel`, `saveLayout`, `removeLayout`, `setConfig` and `setRoot`. Undo, history and multi-user editing come with it. `GET /api/doc?id=studio` returns it.

A panel: `{id, kind, title, text, x, y, w, h, color, source: {agent?, url?, cmd?, paths?}, float: {x, y, w, h} | null}`, with `kind` one of `note`, `review`, `prompt`, `sql`, `snippet`, `terminal`, `preview`, `map`.

## The session database

`data/studio/sessions.sqlite` (node:sqlite). Read-only queries through `POST /api/studio/sql` or ⌘K → `select …`:

| table | columns |
|---|---|
| `agents` | id, doc, name, command, cwd, root, branch, session_id, agent_info, fork_of, created, updated |
| `events` | seq, ts, agent, kind (`user` `agent` `thought` `tool` `plan` `permission` `turn` `system` `error` `rewind`), text, tool_id, tool_kind, status, title, json, turn |
| `turns` | agent, turn, ts, seq (its prompt event), snap (the snapshot just before it), text |
| `snapshots` | agent, n, ts, commit_id, parent, reason, tool_id, seq, files, adds, dels |
| `monitors` | agent, snap, ts, monitor, level, summary, detail |
| `gates` | id, agent, ts, kind, title, detail, json, blocking, resolved, resolution |

```sql
-- every red monitor, with the tool call that caused it
SELECT s.agent, s.n, s.reason, m.monitor, m.summary
FROM snapshots s JOIN monitors m ON m.agent = s.agent AND m.snap = s.n
WHERE m.level = 'red';

-- failed tool calls per agent
SELECT agent, count(*) FROM events WHERE kind = 'tool' AND status = 'failed' GROUP BY agent;

-- how many lines each turn changed
SELECT t.turn, t.text, sum(s.adds + s.dels) AS lines
FROM turns t JOIN snapshots s ON s.agent = t.agent AND s.n > t.snap
  AND s.n <= coalesce((SELECT snap FROM turns t2 WHERE t2.agent = t.agent AND t2.turn = t.turn + 1), 1e9)
WHERE t.agent = 'a1b2' GROUP BY t.turn;
```
