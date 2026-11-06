# Agents

Any agent that speaks [ACP](https://agentclientprotocol.com) over stdio can be a box.

## Presets

| preset | command |
|---|---|
| `mock` | `node bin/mock-acp.mjs`, a deterministic demo agent (below) |
| `kiro` | `kiro-cli acp --agent-engine=v3` |
| `claude` | `claude-code-acp` |
| `gemini` | `gemini --experimental-acp` |

Add your own or override these in `data/settings.json`:

```json
{
  "studioAgents": {
    "kiro-fast": { "label": "Kiro (fast)", "command": "kiro-cli acp --agent-engine=v3 --model haiku" },
    "local":     { "label": "Local", "command": ["node", "/opt/agents/acp.mjs"], "mcp": false }
  }
}
```

The same can be given in `STUDIO_AGENTS='{"x":{"command":"…"}}'`. `command` is a string (split like a shell would) or an array. `"mcp": false` leaves out the studio's own tools for that agent. The picker lists every preset, and `1`–`9` picks one.

A box can also be created with an explicit `command` over the API (`POST /api/studio/agents`).

## What of ACP is used

The studio is the ACP **client**:

| | |
|---|---|
| `initialize` | announces `fs.readTextFile` and `fs.writeTextFile` |
| `session/new` | with the studio's MCP server in `mcpServers` |
| `session/load` | a restarted box resumes its session when the agent supports it; otherwise it gets the transcript as context |
| `session/prompt`, `session/cancel` | prompts (queued while the agent works) and interrupts |
| `session/update` | message and thought chunks, tool calls and their updates (including diffs), plans, mode changes, available commands |
| `session/request_permission` | becomes a blocking gate; the answer goes back as the chosen option |
| `fs/read_text_file`, `fs/write_text_file` | confined to the box's working directory; a write is snapshotted before the agent hears back |

Agents that write files themselves (not through `fs/write_text_file`) are snapshotted after their tool calls complete, and a file watcher catches the rest.

## The agents' own tools (MCP)

Every session gets `bin/studio-mcp.mjs` as an MCP server over stdio, bound to its box:

| tool | |
|---|---|
| `studio_status` | what every box is doing: status, turn, lights, last sentence, open gates |
| `studio_fork` | spin off a copy of yourself (same files, the conversation so far) to try an alternative. `reason` is shown to the user on the new box: *say why it is worth trying instead of explaining it* |
| `studio_spawn` | a sub-agent: `mode: "same"` (same folder, e.g. `role: "review"`) or `"worktree"` (its own copy of your files, a fresh conversation) |
| `studio_show` | control the screens: `mode` (`canvas` / `focus`), `focus` a box or panel, `tab`, `open` a preview / terminal / code map / note, `float` a panel, `move` boxes and panels, `arrange`, `scrub`, `fit`, `theme`, `tray`, with a `reason` shown on screen |
| `studio_note` | a note next to your box |
| `studio_prompt` | a message to another box |

The same server works for any MCP client as an orchestrator: `claude mcp add studio -- node bin/studio-mcp.mjs`. Without `STUDIO_AGENT`, every tool takes an `agent` id. It needs `STUDIO_URL` (default `http://127.0.0.1:3210`) and, for a remote studio, `SPREAD_TOKEN`.

## What an agent is told

The studio adds short bracketed notes in front of a prompt when the agent needs context it cannot have:

| | |
|---|---|
| `[Studio: you are a fork of …]` | a fork's first prompt, with the conversation up to the fork point |
| `[Studio: you are a sub-agent of …]` | a spawned sub-agent's first prompt |
| `[Studio: the agent process was restarted …]` | after a restart, when the old session could not be loaded |
| `[Studio: your conversation was rewound …]` | after a conversation rewind, with the turns before it |
| `[Rewound: …]` | after any rewind: what happened to the conversation and the files, and to check the current state (see [History](history.md#rewind-a-turn)) |
| `[Director digest] …` | for a director agent only (see [The director](director.md)) |

## The mock agent

`bin/mock-acp.mjs` is a real ACP agent without a model. It streams, thinks, plans, calls tools, asks permission and uses the studio's MCP tools, which makes it good for demos and tests. It reacts to words in the prompt:

| prompt contains | it does |
|---|---|
| anything else | a module and its test, then asks to run the tests |
| `break` / `riko` | an edit that breaks the syntax (the `syntax` monitor goes red) |
| `fix` / `korjaa` | repairs it |
| `loop` / `jumi` | rewrites the same lines again and again (`churn`) |
| `secret` / `avain` | writes a key into a file (`secrets`) |
| `deps` | changes `package.json` (`deps`) |
| `review` | reads the changes and gives a verdict |
| `slow` | a long turn, to try interrupts |
| `alternative` / `vaihtoehto` | calls `studio_fork` with a reason |
| `reviewer` / `katselmoija` | calls `studio_spawn` for a reviewer in the same folder |
| `serve` / `palvelin` / `dev server` | starts a small web app and says its URL (the director previews it) |
| `[Director digest]` | as a director: answers with `studio_show` |

After a conversation-only rewind it first says it checked the current state, as a real agent should.

## Kiro and other real agents

- The agent runs with the server user's rights, in the box's working directory. Use scope globs (⋯ → *Scope*) to get a red `scope` monitor when it strays.
- Permission prompts come from the agent. If it has an "always allow" mode, its options appear in the gate (`A`).
- A sparse worktree only contains the paths you named, so an agent that needs to read the rest of a monorepo will not find it there.
