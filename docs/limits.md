# Limits

What Evenflow does not do, or does only partly. Most of these are choices made to stay simple.

- **Tested with the mock agent.** The mock uses the same ACP and MCP surface as a real agent, but Kiro, Claude and Gemini have not been run through the whole feature set here. Agents differ in how they report tool calls and whether they support `session/load`.
- **Conversation rewind and fork replay history as text.** ACP has no way to cut or branch an agent's own history, so the new session gets the earlier turns as a transcript in its first prompt. Long sessions are cut to the most recent part (about 14 000 characters). Whether an agent then checks the current state, as the `[Rewound: …]` note asks, is up to the agent.
- **Snapshots are `git add -A` of the box's folder.** This is fast for ordinary repositories; use sparse worktrees for very large monorepos. `.gitignore` is honoured, and `node_modules`, `dist`, `target`, `.venv`, `.next` and `__pycache__` are always skipped.
- **Agents that write files themselves** (not through `fs/write_text_file`) are snapshotted after their tool calls and by a file watcher; very fast consecutive writes can land in one snapshot. Two agents in the *same folder* see each other's changes in their snapshots.
- **`churn`** compares line ranges without following lines that moved. It is a cheap signal, not proof.
- **Terminals**: the built-in emulator covers what shells and common TUIs use (colors, cursor movement, scroll regions, the alternate screen). Wide characters (emoji, CJK) take one cell, and there is no mouse reporting.
- **Previews** of apps that build absolute URLs from their own host name, or that refuse framing from JavaScript, may need their dev server's `base` or host settings adjusted.
- **Moving a preview** between canvas, tab and float reloads its page.
- **Security**: there is no authentication unless `SPREAD_TOKEN` is set. Agents and terminals run with the server user's rights.
- **No speech built in**: voice is an API for your own pipeline ([Remote and voice](remote-and-voice.md)).
