# Development

## Tests

```
npm test               # every node test: the engine, the API, and the studio
npm run e2e:studio     # the studio in a real browser (Playwright + Chromium)
```

`tests/studio.test.js` runs a real server with the mock agent (`MOCK_DELAY=0`) and covers the ACP flow, snapshots, monitors and gates, fork, rewinding a snapshot and a turn (all three modes), review, session SQL, restart with `session/load`, a failing agent, sub-agents, the MCP tools, view commands (including mode, float and move), terminals, previews (HTTP and WebSocket), sparse worktrees, token auth and the director.

`tests/e2e/studio.cjs` drives the studio in Chromium: drawing a box, a permission with `Y`, typing to a box, dragging a note onto it, the timeline, a fork, the spotlight, a terminal, snippets, arrange and themes, idle mode, semantic zoom, focus mode, the composer, rewinding from a prompt, floating a terminal, and a director view command.

```
PLAYWRIGHT=/path/to/playwright-core CHROME=/path/to/chrome npm run e2e:studio
E2E_SHOTS=./shots E2E_VIEW=1680x1050@2 npm run e2e:studio     # screenshots for the docs
```

`E2E_VIEW` is `<width>x<height>@<scale>` (default `2560x1440@1`). The documentation screenshots in `docs/studio*.jpg` come from that run at `1680x1050@2`, scaled to 1680 px.

## The mock agent

`bin/mock-acp.mjs` behaves like a real ACP agent (streaming, plans, tool calls, permissions, `fs/*` requests, MCP tool calls) and reacts to keywords; see [Agents](agents.md#the-mock-agent). New features that involve an agent get a keyword there, so they can be tested end to end without a model.

## Conventions

- No npm dependencies. Node built-ins (`node:sqlite`, `node:test`), git and python3 only.
- The layout is a document: anything that moves or opens something on the canvas is an op with an inverse (`public/shared/types/studio.js`), so it can be undone and is shared.
- What agents do is an event in SQL, and every screen hears about it through `/api/events`. The browser keeps no state the server does not have, apart from view preferences.
- Everything the screen can do has an API endpoint, and everything an agent might want to do on the screen goes through the view command.
- Deterministic first: monitors, the director's rules and snapshots involve no model.
- UI text is short and plain. Color means something (an agent, a state); everything else is neutral, in light and dark.

## Adding things

| to add | where |
|---|---|
| a monitor | `builtinMonitors` in `lib/studio/monitors.js` (and `BUILTIN`), a test in `tests/studio.test.js`, a row in [monitors.md](monitors.md) |
| a panel kind | `PANEL_KINDS` in `public/shared/types/studio.js`, a body in `panels.js` (or text in `view.js`), an icon in `focus.js` |
| a view command field | `Studio.view` in `lib/studio/index.js`, `onView` in `view.js`, `studio_show` in `bin/studio-mcp.mjs`, the director's primer, [api.md](api.md) |
| an agent preset | `defaultPresets()` in `lib/studio/index.js` |
| a key | `onKey` in `view.js` (canvas) or `focus.js` (focus mode), the help overlay, [guide.md](guide.md#keys) |
