# Agent Context Inspector

Cursor's **Context Usage** popover shows how many tokens each part of the agent
context takes (System prompt, Tool definitions, Rules, Skills, MCP & dynamic
tools, Subagent definitions, Summarized conversation, Conversation), but not the
text itself. This extension shows the exact text behind each row.

## Use

- Click **Context** in the status bar, run **Context Inspector: Inspect Agent
  Context**, or press `Ctrl+Alt+Shift+C`.
- The left side mirrors the popover. Click a category to expand it into its
  items (each rule, skill, MCP server, subagent, message, tool call/result).
- Click a category or item to see its text on the right. **Find**, **Copy** and
  **Open in editor** work on whatever is selected.
- **All prompt messages (raw)** lists every message exactly as stored.
- **Subagents**: a chat that spawned subagents lists them (name, type, context
  used). Click one to open its own context breakdown; the breadcrumb above the
  card leads back to the parent. In the conversation, the tool call/result that
  spawned a subagent has a **↗** badge that opens it (messages that spawned
  several show **↗ N subagents**). Nested subagents work the same way.
  Subagent chats are left out of the chat dropdown.
- With **Follow the focused chat** on, the view tracks the chat focused in this
  window (Cursor's pane list plus the window's focus history) and refreshes as
  it changes; it falls back to the most recently active chat. Pick any other
  chat from the dropdown.
- The text is shown exactly as the model received it, color-coded (XML tags
  and attributes, markdown markers, code, JSON, tool labels). **Indent**
  visually indents the contents of nested tags; copying still gives the
  original text.

## Session history

The extension keeps a local history of agent sessions (setting
`cursorContextInspector.recordHistory`, on by default). Every 30 s, if Cursor
wrote anything, one Cursor window snapshots the chats that changed into
`~/.cursor-context-history` (`cursorContextInspector.historyDirectory`):

| Path | Contents |
| --- | --- |
| `chats/<chatId>/transcript.md` | every prompt message ever seen in the chat, raw, in order; messages Cursor later dropped (e.g. by summarizing) are kept and marked |
| `chats/<chatId>/snapshots/<lastUpdatedAt>.json` | token breakdown and the prompt's message hashes at each update |
| `chats/<chatId>/latest.json` | newest snapshot plus Cursor's usage tree |
| `chats/<chatId>/meta.json` | name, model, workspace, message hashes in first-seen order |
| `blobs/<sha256>.json` | each prompt message once, exactly as Cursor stored it |
| `index.json` | all recorded chats, newest first |

The first run also records chats from the last
`cursorContextInspector.historyBackfillDays` (7) days. **Record History of All
Chats** backfills everything; **Open Session History Folder** opens it.

## Where the data comes from

Everything is read locally and read-only from Cursor's `state.vscdb`:

| Key | Contents |
| --- | --- |
| `composerData:<chatId>` | the popover numbers (`promptTokenBreakdown`), Cursor's per-item usage tree (`promptContextUsageTree`, newer chats) and `conversationState` |
| `agentKv:blob:<sha256>` | the prompt messages (system, user, assistant, tool) as JSON |

When a chat has Cursor's usage tree, each item is the exact character span
Cursor counted. Text the tree leaves out (for example MCP sections in the
system message, or encrypted reasoning) is still listed, attributed by its tag
and marked **not counted**, so every character of the prompt appears somewhere
in the breakdown. Otherwise items come from the prompt's XML-style sections
(`<rules>`, `<agent_skills>`, `<available_subagent_types>`, `<dynamic_tools>`,
…). Category token totals always come from Cursor's own numbers. Item
estimates are Cursor's when it has a tree, otherwise roughly characters / 4.

**Tool definitions are not stored locally.** Cursor's backend attaches them,
so only each tool's name and token estimate are available.

## CLI

```sh
node bin/cursor-context.cjs --list                    # recent chats
node bin/cursor-context.cjs                           # breakdown of latest chat
node bin/cursor-context.cjs --chat <id> --show rules  # text of a category or item id
```

## Development

```sh
npm test
npx @vscode/vsce package --no-dependencies --allow-missing-repository
cursor --install-extension context-inspector-0.1.0.vsix
```

Requires Cursor's extension host Node ≥ 22.5 (for `node:sqlite`).
