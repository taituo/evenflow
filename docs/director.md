# The director

The director decides what the screen shows, so that whoever is in front of it sees what matters without driving. Choose it with `D` on the canvas, ◎ in the toolbar or the sidebar, or ⌘K.

| | |
|---|---|
| **Off** | The screen is yours. |
| **Rules** | Deterministic rules, no model. |
| **Agent** | A *director box*: any ACP agent with the role `director`, which gets a digest of what happened and decides with its studio tools. The rules still open previews and report. |

## The rules

| when | the director |
|---|---|
| an agent asks permission, or crashes | brings its box into view |
| a monitor turns red | brings the box and the diff of that snapshot into view |
| a new box or a fork appears | re-arranges the canvas (grid, or a tree for forks) around it |
| an agent starts a dev server (a URL in what it says or in a tool result) | opens a preview of it next to the box |
| exactly one agent is working | follows it |
| the studio goes quiet | zooms out to the whole picture |

## It never fights you

- While you are using the studio (pointer, keys, wheel), and for 15 seconds after, the director only **reports**: a small note at the top says what it would have shown and why. It does not move anything.
- It moves at most once every 3.5 seconds.
- Every move carries a **reason**, shown on screen ("◎ Director: Auth asks to run the tests").

## The director agent

`Agent` mode starts a director box (in the project root, no worktree) if there is none, with a primer that explains its job and its tools. Every 12 seconds, if anything happened, it gets a **`[Director digest]`**: new boxes, permissions, red monitors, finished turns, errors, previews. It answers with `studio_show`:

```
studio_show {focus: {agent: "a1b2"}, reason: "Auth needs a decision"}
studio_show {mode: "focus", focus: {agent: "a1b2"}, tab: "changes"}
studio_show {open: {kind: "preview", agent: "a1b2", url: "http://localhost:5173"}}
studio_show {float: {panel: "p9x", x: 0.62, y: 0.08, w: 0.34, h: 0.4}}
studio_show {move: [{id: "a1b2", x: 0, y: 0, w: 900, h: 700}]}
studio_show {arrange: "tree"} · {scrub: 7} · {fit: true} · {theme: "dark"}
```

It can switch between canvas and focus mode, pick the agent and the tab, float a panel, and place boxes and panels itself. Because it is an agent box like any other, you can talk to it ("keep the reviewer's panel on screen", "don't follow Docs").

## The view command

Everything the director does is a **view command**, `POST /api/studio/view`, and anyone can send one: a script, another agent, your voice pipeline. Changes to the layout (opened panels, floats, moves, arrangements) go into the layout document and can be undone. The rest (focus, mode, tab, scrub, theme, idle) goes to every open screen. See [HTTP API](api.md#the-view-command).
