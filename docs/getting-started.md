# Getting started

## Requirements

- **Node 22.13 or newer** (uses the built-in `node:sqlite`). No npm dependencies to install.
- **git** (worktrees and snapshots).
- **python3** for terminals (a small PTY bridge; nothing to install).
- An ACP agent for real work: Kiro CLI, `claude-code-acp`, Gemini CLI with `--experimental-acp`, or any other. Not needed to try it; there is a built-in mock agent.

## Run it

```
git clone https://github.com/taituo/evenflow && cd evenflow
npm start
```

Open **http://127.0.0.1:3210/studio**. The server listens on `127.0.0.1` only; see [Remote and voice](remote-and-voice.md) to reach it from another machine.

| Variable | Default | |
|---|---|---|
| `PORT` | `3210` | |
| `HOST` | `127.0.0.1` | |
| `STUDIO_ROOT` | a demo repository | the repository the agents work on |
| `CANVAS_DATA` | `./data` | where documents, sessions, snapshots and worktrees are kept |
| `STUDIO_AGENTS` | | extra agent presets as JSON (see [Agents](agents.md)) |
| `SPREAD_TOKEN` | | require a token for every request (remote use) |
| `STUDIO_MCP=0` | | do not give agents the studio's own tools |
| `MOCK_DELAY` | `45` | the mock agent's delay per streamed chunk, in ms (tests use 0–15) |

## The first agent

1. **Draw a box**: hold `Shift` and drag on the canvas (or press `N`, then drag). A picker opens.
2. **Pick an agent.** `Mock` needs nothing installed; `Kiro`, `Claude` and `Gemini` need their CLIs. Give it a name if you like, and optionally a first task. *Only these paths* makes a sparse checkout of a monorepo.
3. **Create.** The box starts an ACP session in a new git worktree on its own branch (`studio/<name>-xxxx`). The first box of a fresh install creates a small demo repository to work on.
4. **Talk to it**: point at the box and start typing. A floating input opens aimed at the box; `↵` sends.

With the mock agent, try `implement a greeting helper`. It plans, writes a module and a test, and asks permission to run the tests: a **gate** appears in the right column. Press `Y` while pointing at the box (or click *Allow*). Then try `break it`, which makes the `syntax` monitor go red, and `fix it`.

Press **`⌘\`** (Ctrl+\\ on Linux and Windows) for **focus mode**: the agents on the left, the session and a composer in the middle, its changes on the right. Press it again to go back to the canvas.

## Your own repository

```
STUDIO_ROOT=~/src/my-app npm start
```

Agents work in worktrees under `data/studio/wt/`, on branches named `studio/…`. Your checkout, index and branches are not touched. Snapshots go into a separate shadow git per box. When an agent's work is good, merge its branch the usual way (`git merge studio/auth-1a2b`), or open a terminal in its box (`⌥T`) and commit from there.

A monorepo: give the box a few paths in the picker (`services/auth, libs/common`) and its worktree is a sparse checkout of just those.

## Real agents

The presets `kiro`, `claude` and `gemini` run `kiro-cli acp --agent-engine=v3`, `claude-code-acp` and `gemini --experimental-acp`. They have to be on the `PATH` and signed in. To change a command or add your own agent, see [Agents](agents.md#presets).

If an agent cannot start, its box shows an *error* gate with the agent's stderr.

## Where things are kept

```
data/
  state.json, log.jsonl        documents (the canvas layout is one) and their history of operations
  commits/                     milestones
  settings.json                settings, including your own agent presets (studioAgents)
  studio/sessions.sqlite       every session: events, snapshots, monitor results, gates, turns
  studio/shadow/<agent>.git    each box's snapshots (a bare git repository of its own)
  studio/wt/<agent>/           the worktrees
```

Removing a box stops its process. The worktree, the branch and the history stay.
