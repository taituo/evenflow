# Monitors and gates

## Monitors

Monitors are cheap, repeatable checks that run on **every snapshot** of a box's working directory. No model is involved: the agent does the work, and the monitors report what is actually in the files. Each one has a light, **green**, **amber** or **red**, shown on the box, in the agent list, in the Changes tab and on the diff card of the snapshot where it changed.

### Built in

| monitor | red when | amber when |
|---|---|---|
| `syntax` | a changed `.js` / `.mjs` / `.cjs` file fails `node --check`, a `.json` file does not parse, or a `.py` file fails `py_compile`. It stays red until the file is fixed | — |
| `churn` | the same lines were rewritten 4 times (the agent is going in circles). It stays lit for the next 4 snapshots | 3 times |
| `size` | more than 1200 lines changed since the session started | more than 400 |
| `tests` | a test file was deleted or a test case removed | source changed without any test change |
| `secrets` | an added line holds a credential (AWS keys, private keys, common token formats). Red until the line is gone again | — |
| `deps` | — | a package manifest or lockfile changed since the session started (npm, pnpm, yarn, bun, pip, poetry, uv, Cargo, Go, Bundler, Composer, Maven, Gradle) |
| `scope` | files changed outside the box's scope globs (only when the box has a scope: ⋯ → *Scope*) | — |

### Your own: command monitors

Put `.studio/monitors.json` in the project root (or in a box's own folder):

```json
[
  { "id": "typecheck", "run": "npx tsc --noEmit", "match": "\\.tsx?$", "timeout": 120000 },
  { "id": "unit", "run": "npm test --silent", "match": "\\.(js|ts)$" }
]
```

Each command runs in the box's working directory after a snapshot whose changed files match `match` (after every snapshot when there is no `match`). Exit code 0 is green, and anything else is red with the last lines of output as the detail. Each monitor runs once at a time, always on the newest snapshot; while it runs, its light is blue.

A `tsconfig.json` with a local `node_modules/.bin/tsc` gives a `typecheck` monitor automatically.

## Gates

A gate is a place where an agent needs a person. In canvas mode the gates are in the column on the right; in focus mode they are under the agent list, and the selected agent's permission question also sits above the composer.

| kind | from | blocks the agent | goes away when |
|---|---|---|---|
| **permission** | the agent asks (`session/request_permission`) | yes | you answer: the buttons, or `Y` (allow once), `A` (allow always), `N` (reject) while pointing at the box. Voice: "yes / kyllä / joo", "no / ei" |
| **monitor** | a monitor turned red | no | the cause is gone (the monitor is green again), or you dismiss it. *Show* opens the diff, *Ask to fix* sends the finding to the agent |
| **turn** | the agent finished a turn with nothing queued | no | you send it something, *Review*, or dismiss it |
| **error** | the agent process could not start or crashed | — | *Restart*, or dismiss |
| **info** | an agent spun off a copy or a sub-agent, with its reason | no | *Show* or *OK* |

`G` (canvas) or ⌘K → *Next gate* goes through them in order. Clicking a gate brings its box into view (canvas) or selects the agent (focus mode).

The director treats gates as the most important thing on screen: with the rules on, a new permission or a red monitor brings that box into view, unless you are busy (see [The director](director.md)).
