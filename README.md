# Evenflow

**A workspace for coding agents.** Every agent is an [ACP](https://agentclientprotocol.com) session (Kiro CLI, a Claude Code or Gemini ACP adapter, or any other ACP agent) in its own git worktree. See them all on an infinite canvas, or work with one in a classic coding layout. Every step is recorded as SQL, every file change is a snapshot you can replay, rewind or fork from, deterministic monitors check each one, and the places where an agent needs you show up as gates.

![Evenflow](docs/studio-focus.jpg)

```
npm start                                   # → http://127.0.0.1:3210/studio
STUDIO_ROOT=/path/to/your/repo npm start    # work on your own repository
npm test && npm run e2e:studio              # node tests · the studio in a real browser
```

Node 22.13+, git and python3. No npm dependencies. A built-in **mock agent** lets you try everything without a model.

## What it does

- **A box is an agent**: an ACP session in its own worktree and branch, or a sparse checkout of the paths you name in a monorepo. Your checkout is never touched.
- **Two ways to look**: a **canvas** with every agent (zoom out for tiles, zoom in for whole sessions), and **focus mode** (`⌘\`) with the agents on the left, one session and a composer in the middle, and its changes, terminals and previews as tabs on the right. Any panel can **float** over either mode.
- **Every change is a snapshot** in a private shadow git, after every tool call and at the start of every turn. Scrub the timeline, **replay** it, **fork** a new box from any moment.
- **Rewind a turn**: ⟲ on a prompt takes the conversation back to before it while **keeping the files**, and the agent's next message starts with *the project moved on, check the current state*. You can also rewind the conversation and the files together, or only the files.
- **Deterministic monitors** on every snapshot (syntax, churn, size, tests, secrets, dependencies, scope, plus your own commands) and **gates** for permissions, red monitors, finished turns and crashes.
- **A director** runs the screen: built-in rules, or a director agent that switches modes, opens previews, floats and moves panels, always with a reason on screen. It only reports while you are working.
- **Agents have tools too** (MCP): spin off a copy to try an alternative (and say why), start a reviewer, open a preview or a terminal, change the view.
- **Real terminals, live previews, code maps, notes, snippets.**
- **Headless and remote**: everything runs on the server; `node bin/remote.mjs me@box` shows a studio on a Linux machine through one SSH tunnel. A voice pipeline plugs in with one endpoint in and one event stream out.

## Documentation

**[docs/](docs/README.md)**: [getting started](docs/getting-started.md) · [concepts](docs/concepts.md) · [using it](docs/guide.md) · [history and rewind](docs/history.md) · [agents](docs/agents.md) · [monitors and gates](docs/monitors.md) · [director](docs/director.md) · [remote and voice](docs/remote-and-voice.md) · [HTTP API](docs/api.md) · [architecture](docs/architecture.md) · [development](docs/development.md) · [limits](docs/limits.md)

![Canvas](docs/studio.jpg)

## Built on Spread

The studio's layout is a versioned document in **Spread**, the canvas engine Evenflow runs on, so moves are undoable, shared between screens and kept in history. Spread's spreadsheets come along: the agents and their monitor lights are mirrored into a sheet, so Live dashboards, SQL over tables and time replay work on them. Spread's manual is [docs/SPREAD.md](docs/SPREAD.md); `/` opens the sheets.

## Status

Works end to end with the mock agent, which uses the same ACP and MCP surface as a real one. Real agents are presets (`kiro`, `claude`, `gemini`) and need wider testing. See [limits](docs/limits.md).

## License

MIT
