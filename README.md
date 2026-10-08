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
- With **Follow the most recently active chat** on, the view tracks the chat
  you are working in and refreshes as it changes. Pick any older chat from the
  dropdown.

## Where the data comes from

Everything is read locally and read-only from Cursor's `state.vscdb`:

| Key | Contents |
| --- | --- |
| `composerData:<chatId>` | the popover numbers (`promptTokenBreakdown`), Cursor's per-item usage tree (`promptContextUsageTree`, newer chats) and `conversationState` |
| `agentKv:blob:<sha256>` | the prompt messages (system, user, assistant, tool) as JSON |

When a chat has Cursor's usage tree, each item is the exact character span
Cursor counted. Otherwise items come from the prompt's XML-style sections
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
