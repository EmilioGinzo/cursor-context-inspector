# Agent Context Inspector (`context-inspector`)

See the exact text behind each part of Cursor's agent Context Usage, and keep a local history of agent sessions.

![The inspector open on a chat: the Context Usage breakdown on the left, the exact system message text on the right](docs/images/inspector.png)

Cursor's **Context Usage** popover tells you how many tokens each part of the
agent's context takes: System prompt, Tool definitions, Rules, Skills, MCP &
dynamic tools, Subagent definitions, Summarized conversation and Conversation.
It does not show the text itself. When a rule or skill eats 10K tokens, or a
summary dropped something important, you cannot see why.

This extension shows the exact text behind every row, item by item, exactly as
the model received it. It also records every agent chat on your machine into a
plain folder of Markdown and JSON, so you keep a readable history after Cursor
summarizes or deletes it.

Everything is read locally and read-only from Cursor's own database. Nothing is
sent anywhere.

## Contents

- [Requirements](#requirements)
- [Install and deploy](#install-and-deploy)
- [Usage](#usage)
- [Configuration](#configuration)
- [Session history](#session-history)
- [Where the data comes from](#where-the-data-comes-from)
- [CLI](#cli)
- [Limitations](#limitations)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- [Cursor](https://cursor.com) whose extension host runs Node ≥ 22.5 (the
  extension uses the built-in `node:sqlite`).
- To build: Node ≥ 22.5 with `npx`, and the `cursor` command on your `PATH`
  (Cursor: **Shell Command: Install 'cursor' command**).
- Tested on Linux. macOS and Windows database paths are detected but untested.

## Install and deploy

The extension is not on a marketplace. You build a `.vsix` package from this
repository and install it into Cursor.

**1. Get the source and run the tests**

```sh
git clone git@github.com:EmilioGinzo/cursor-context-inspector.git
cd cursor-context-inspector
npm test
```

All tests pass; there are no npm dependencies to install.

![npm test output: 16 tests, 16 pass, 0 fail](docs/images/deploy-1-test.png)

**2. Package the extension**

```sh
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

This writes `context-inspector-<version>.vsix` to the repository root.

![vsce package output listing the 11 files in the VSIX and "DONE Packaged: context-inspector-0.10.0.vsix"](docs/images/deploy-2-package.png)

**3. Install it into Cursor**

```sh
cursor --install-extension "context-inspector-$(node -p 'require("./package.json").version').vsix" --force
```

![cursor --install-extension output: "Extension 'context-inspector-0.10.0.vsix' was successfully installed."](docs/images/deploy-3-install.png)

The Electron `DeprecationWarning` printed after the success line comes from
the `cursor` CLI and is harmless.

**4. Reload Cursor**

Run **Developer: Reload Window** in every open Cursor window. A **Context**
button appears in the status bar, and history recording starts a few seconds
later.

To update, pull and repeat steps 2–4. To remove it:

```sh
cursor --uninstall-extension local-tools.context-inspector
```

## Usage

Open the inspector in any of these ways:

- click **Context** in the status bar;
- run **Context Inspector: Inspect Agent Context** from the Command Palette;
- press `Ctrl+Alt+Shift+C` (`Cmd+Alt+Shift+C` on macOS).

![The Conversation category expanded with the "User: ping" message selected, showing the user query and the context Cursor attached to it](docs/images/inspector-message.png)

- **Breakdown.** The left side mirrors the Context Usage popover. Click a
  category to expand it into its items: each rule, skill, MCP server, subagent,
  message, tool call and tool result.
- **Text.** Click a category or item to see its text on the right. **Find**,
  **Copy** and **Open in editor** work on whatever is selected. **All prompt
  messages (raw)** lists every message exactly as stored.
- **Exact characters.** Text is shown as the model received it, color-coded
  (XML tags and attributes, Markdown markers, code, JSON, tool labels).
  **Indent** visually indents the contents of nested tags; copying still gives
  the original text.
- **Folding.** Click the opening of a tag that spans several lines (e.g.
  `<rules>`) to fold it up to its closing tag; click it or the `⋯ N lines`
  marker to unfold. Folds nest, are remembered per item, and Find unfolds a
  section when it jumps to a match inside it.
- **Subagents.** A chat that spawned subagents lists them (name, type, context
  used). Click one to open its own breakdown; the breadcrumb above the card
  leads back to the parent. In the conversation, the tool call that spawned a
  subagent has a **↗** badge that opens it (**↗ N subagents** when it spawned
  several). Subagent chats are left out of the chat dropdown.
- **Follow the focused chat.** When checked, the view tracks the chat focused
  in this window and refreshes as it changes, falling back to the most
  recently active chat. Switching chat tabs is picked up within about a
  second; moving focus between chats that are already open shows up once
  Cursor saves its focus history (up to a minute). Pick any other chat from
  the dropdown.
- **↻** reloads and jumps to the focused chat, even when not following. The
  keybinding does the same.

## Configuration

All settings are under **Settings → Extensions → Agent Context Inspector**.

| Setting | Default | Meaning |
| --- | --- | --- |
| `cursorContextInspector.databasePath` | `""` | Path to Cursor's `state.vscdb`. Empty detects it automatically. |
| `cursorContextInspector.showStatusBarItem` | `true` | Show the **Context** button in the status bar. |
| `cursorContextInspector.recordHistory` | `true` | Keep a local history of agent sessions (see below). |
| `cursorContextInspector.historyDirectory` | `""` | Where history is stored. Empty means `~/.cursor-context-history`. |
| `cursorContextInspector.historyDetail` | `"full"` | How much the history records: `conversation`, `standard` or `full` (see [Detail levels](#detail-levels)). |
| `cursorContextInspector.recordOnAgentStop` | `true` | Record a chat as soon as its agent finishes, through a `stop` hook in `~/.cursor/hooks.json` (see below). |
| `cursorContextInspector.historyBackfillDays` | `0` | Also record older chats updated in this many past days; `0` records every chat Cursor still has. |

## Session history

Every 30 s, if Cursor wrote anything, one Cursor window snapshots the chats
that changed into `~/.cursor-context-history`. A chat whose agent is still
running is checked again on every write until its run ends, so the record
holds its final state even when Cursor stores it without a newer timestamp.

The recorder does not wait for the next 30 s check when an agent finishes.
On startup the extension adds a `stop` hook to `~/.cursor/hooks.json`, and
keeps your own hooks. When an agent turn ends, Cursor runs the hook. The hook
writes the turn (conversation id, status) to
`.context-inspector-agent-stopped.json` in the history folder. The recorder
watches that file and records within a second, then checks again after 3 s
and 10 s, because Cursor can store the last messages just after the hook runs.
If you set `recordOnAgentStop` to `false`, the hook is removed at the next
Reload Window, and uninstalling the extension removes it too. If `hooks.json`
is not JSON of the shape Cursor reads (an object whose `hooks` holds arrays),
the extension does not change it. A symlinked `hooks.json` is written through
the link, and keeps its permissions. `recordHistory`, `historyDirectory` and
`recordOnAgentStop` are machine-wide settings (not per workspace), because
every window shares the one hook.

Each step of the recorder has a time budget, so the editor is not held for
long: a tick reads at most about 120 ms of Cursor's store (see
`.store-index.sqlite` below) and records chats for about 60 ms, finishing
the chat it has started (a chat with a large history can take longer than
that). Whatever is left waits for the next tick. Nothing is recorded until the
store has been read up to date, so the lookups below see every message.

| Path | Contents |
| --- | --- |
| `chats/<chat name>/chat.md` | The conversation, readable: your messages, the agent's replies, its thinking and each tool call with its result (collapsed), and links to subagents. Leaves out the system prompt and the context Cursor adds to your messages; the context sent beside the prompt is linked under each of your messages, collapsed. |
| `chats/<chat name>/thinking.json` | The agent's readable thinking, in order, each with the prompt message (and its reasoning part) it belongs to and how long it took. Thinking Cursor showed on a bubble that no turn step kept is there too, with `"source": "bubble"` and no message. See [Thinking](#thinking). |
| `chats/<chat name>/transcript.md` | Every prompt message ever seen in the chat, raw, in order. Messages Cursor later dropped (e.g. by summarizing) are kept and marked. A tool result Cursor replaced in the prompt keeps its earlier version too: Cursor stores it, and it is found by its tool call's id, once the run that made the call has ended (the store is read once into `.store-index.sqlite`, so each lookup is a query). Lists the chat's subagents and links each one where it was spawned; a subagent resumed by another Task call is linked from each of them (`toolCallIds` in its `meta.json` keeps every Task call the recorder saw). |
| `chats/<chat name>/snapshots/<time>.json` | Token breakdown and the prompt's message hashes at each change. `<time>` is when the chat last changed: the send, or the agent's last stored state. A snapshot is never overwritten: a second state under a taken name gets `-at<recorded time>`, then `-at<recorded time>-<k>` when several are recorded in the same millisecond. A state already recorded under the name is not written again. |
| `chats/<chat name>/snapshots/<lastUpdatedAt>-<n>.json` | The first `n` of those hashes: a state the chat went through before that update. Cursor keeps only the newest state, but each assistant message was written by a model call that saw exactly the messages before it (`"state": "prompt"`), and a turn ended before each user message that follows the agent (`"turn end"`). Derived, not observed: only while the chat just grew, so not across a summary or an edit of an earlier message, which rewrite the prompt; the states of such a run are then not recorded. A tool result Cursor replaced in the prompt gets one more: the prompt of the model call after it, with the earlier result at the result's index (`"replaced": <index>`), derived the same way. |
| `chats/<chat name>/latest.json` | Newest snapshot plus Cursor's usage tree. |
| `chats/<chat name>/meta.json` | Name, chat id, model, workspace, message hashes in first-seen order, and `sentContext`: for each of your messages, the context parts sent with it (see below). Messages Cursor's state archives when it summarizes are recorded first, in the archive's order, so they are in the record even when no snapshot of the prompt before the summary was taken. `scannedCalls` lists the tool calls whose stored messages were looked for, and `scannedReplies` the bubbles whose reply was looked for when no message held it (see below). A look that found nothing yet is kept in `scanPending` and repeated (a message Cursor writes later is found) until the store has grown by 20,000 rows past it, then given up. |
| `chats/<chat name>/subagents/<subagent name>/` | The same files for each subagent the chat spawned, nested to any depth; its transcript links back to the parent. |
| `blobs/<sha256>.json` | Each prompt message once, exactly as Cursor stored it; chats refer to them by hash (storage, not for reading). |
| `context/<sha256>.bin` | One part of the context sent beside the prompt (rules, skills, subagent definitions or MCP tools), stored once, named by the sha256 Cursor uses for it. `<sha256>.redacted.bin` when it held credentials, replaced (see [Context sent beside the prompt](#context-sent-beside-the-prompt)). |
| `context/<sha256>.md` | The same part, readable: one collapsed section per rule, skill, subagent or tool. |
| `index.json` | All recorded chats, newest first, each with its subagent tree. Written at most every 30 s while older chats are recorded, and when that ends. |
| `.store-index.sqlite` | An index of the message blobs in Cursor's store by the tool call ids they hold and the digests of their assistant texts, so a lookup of a replaced result or an interrupted reply is a query, not a read of the store. Built once, in steps, from every row of the store (about 8 s of work over a few minutes of ticks for a store of this size); it only gains entries. It keeps its place by the last message blob it read (Cursor never rewrites a blob, unlike the chat rows it replaces on every update): only when that blob is renumbered (VACUUM) or removed is the store read again, and chats are recorded meanwhile, their lookups waiting for the read. A blob Cursor wrote again and that a renumbering then put back at its old rowid would be missed; Cursor has not been seen to do either. A cache: deleting it costs a new read, not a record. |

- **Folder names** follow the chat name, with characters that are not valid
  in file names replaced by `-`. When two chats share a name, the later one
  gets the first 8 characters of its id appended, e.g.
  `Ping request (a9ed13b2)`. A folder is renamed when its chat is renamed.
  Folders written by earlier versions (named by id, or subagents at the top
  level) are renamed and moved automatically.
- **Older chats** are caught up in the background, 50 every 5 s, a step at a
  time: a tick stops recording when its time budget is spent and the rest
  waits for the next one (a few minutes for a couple of thousand chats, more
  for the largest histories). Chats opened but never sent are
  skipped. Expect the full history to take a few GB if you have thousands of
  chats; set `historyBackfillDays` to limit it.
- **Commands:** **Record Focused Chat Now** asks the recorder (in whichever
  window records) to record the chat focused in this window, and its
  subagents, at once, then offers to open its `chat.md`. While the recorder is
  still reading Cursor's store for the first time, the chat is recorded when
  that ends;
  **Record History of All Chats** records everything at once;
  **Open Session History Folder** opens the folder.

### Detail levels

`historyDetail` sets how much is recorded. Each level keeps everything the one
above it keeps:

| Level | Records |
| --- | --- |
| `conversation` | Every prompt message (`blobs/`, `meta.json`), including the ones summarization dropped, and `chat.md`. `latest.json` too: it marks what the recorder has seen. No thinking in `chat.md`. |
| `standard` | Also `thinking.json` (and the thinking in `chat.md`), `transcript.md`, and one snapshot per chat update (`snapshots/<time>.json`). |
| `full` (default) | Also the states before each update (`snapshots/<lastUpdatedAt>-<n>.json`), the context sent beside the prompt (`context/`, `sentContext`), and the messages only Cursor's store has: replaced tool results and interrupted replies. Only this level reads the store into `.store-index.sqlite`. |

A change applies from the next tick, to what is recorded from then on. Nothing
already recorded is deleted. After raising the level, a chat's `thinking.json`
and `transcript.md` are written whole the next time it changes, and the tool
calls and replies a lower level did not look up are looked up then; the
snapshots and sent context of the updates recorded at the lower level are not
recovered.

### Thinking

The prompt Cursor sends keeps the model's thinking only as `redacted-reasoning`:
reasoning that the model's provider returned encrypted (Anthropic's
`redacted_thinking`, OpenAI's `encrypted_content`, Cursor's own models alike).
Cursor passes it back to the model unread and never decrypts it (its own UI
shows `[REDACTED]`). The bytes look like ciphertext: base64 of random-looking
data, about 8 bits of entropy per byte, not protobuf, gzip or text. It cannot
be read on this machine.

The thinking Cursor shows while the agent works is stored separately, in the
chat's turns (`ConversationStep` blobs, protobuf), and is exactly what the
server streamed. The recorder keeps it in `thinking.json` and places each
thinking on the prompt message the model wrote after it: the message with the
agent text or tool call that followed it. `chat.md` shows it there, labelled
**sent to the model encrypted** with the encrypted size. Encrypted thinking with
no readable copy is shown as **encrypted**, with its size. `transcript.md`
quotes the readable thinking after its message.

## Where the data comes from

The extension opens Cursor's `state.vscdb` read-only:

| Key | Contents |
| --- | --- |
| `composerData:<chatId>` | The popover numbers (`promptTokenBreakdown`), Cursor's per-item usage tree (`promptContextUsageTree`, newer chats) and `conversationState`. |
| `agentKv:blob:<sha256>` | The prompt messages (system, user, assistant, tool) as JSON; the chat's turns and their steps (thinking, agent text, tool calls) as protobuf. |

When a chat has Cursor's usage tree, each item is the exact character span
Cursor counted. Text the tree leaves out (for example MCP sections in the
system message, or encrypted reasoning) is still listed, attributed by its tag
and marked **not counted**, so every character of the prompt appears somewhere.
Without a tree, items come from the prompt's XML-style sections (`<rules>`,
`<agent_skills>`, `<available_subagent_types>`, `<dynamic_tools>`, …).

Category totals always come from Cursor's own numbers. Item estimates are
Cursor's when it has a tree, otherwise roughly characters / 4.

### Context sent beside the prompt

With your messages Cursor also sends context that is not in the prompt
messages: every rule with its content (including rules the prompt only lists),
every agent skill, your custom subagents with their prompts, the MCP tools'
definitions and instructions, and small items such as workspace folders and git
remote URLs. On a chat's first message it travels whole; with every message it
travels as four parts (rules, skills, subagents, MCP) named by their sha256,
and the server reuses the parts it already has. A subagent's messages travel with
the same four parts, so the recorder keeps them for subagents too. Cursor stores
none of it.

So the recorder rebuilds the four parts from their sources when it sees a new
message of yours, the way Cursor's client builds them: `.cursor/rules`,
`AGENTS.md` / `CLAUDE.md` and `.cursorrules` of each workspace folder and its
parent folders (and nested ones in git repositories), the skill folders
(`.cursor/skills`, `.claude/skills`, `.codex/skills`, `.agents/skills`,
`~/.cursor/skills-cursor`, installed plugins), `.cursor/agents`, and the MCP
tool snapshots Cursor writes under `~/.cursor/projects/<workspace>/mcps`. It
uses Cursor's own ripgrep and frontmatter parser, so the bytes come out the
same when the files have not changed; the panel shows them as **Sent with the
request, rebuilt (not in the prompt)**. Only messages the recorder sees within 10 minutes
are matched with a rebuild (older chats get none: the files may have changed). A
message is rebuilt for the time it was sent, which Cursor's user bubble (matched by
its text) gives; a chat's messages sent at different times get one entry each, so
the MCP servers connected then are the ones the entry shows.

The MCP part follows what the request carries: the tools of Cursor's built-in
servers in full (the set Cursor's bundle names, `rFE` in `cursor-agent-exec`: the
browser and dev-control servers; the built-in list is used when the bundle is not
found), and every other server's tools by name
with their annotations (`readOnlyHint` and the like), plus each server's
folder and tool files. Annotations are not in the snapshots; they are read from
the copies Cursor kept of this part in its database (`context/tool-annotations.json`,
rescanned hourly, and at once when a tool sent has no annotation yet). Servers change
them, so a tool can have several values there: the one stored last is used, a note
says so, and every value is kept in that file. Each count is of distinct stored parts,
so a rescan does not count one twice.

The files the chat wrote with its Write tool (a successful write, by the result it
got) are part of that context too: Cursor's request context carries their current
contents by path (`file_contents`, in the captured subagent runs: each file an agent
wrote, none it only read). The recorder reads them from disk when it records the chat
and again when they change, as `context/<sha256>.bin` (credentials replaced as above),
in `meta.json` under `files` of the entry (an entry with no message when only a file
changed), and the panel lists them under the sent-context category. Cursor sends a
request context only when it asks for one, which is not every run; StrReplace edits
are not counted (no captured run shows them in `file_contents`).

A rebuilt part is what Cursor sent only when their sha256 match.
`storedByCursor` in `meta.json` lists parts Cursor itself kept a copy of
under the same id. Which MCP servers were connected when the message was sent is
read from Cursor's logs (the folder of its launches, above the extension's own log):
each server's own log says when it connected or failed to, and the workbench logs
say when a client connected or failed (not when one began); the last of those before the message decides, and a failure counts only
for three minutes after it (Cursor retries a server that is down, but does not log
its recovery). A server that was not connected is listed without its tools or
instructions, as the captured requests show, and the note says which; a server the
logs say nothing recent about is taken as connected. Things the rebuild cannot know:
the order MCP servers connected in (Cursor's own servers are put first in the tool
descriptors; the order of the file-system descriptors is the folders' order on disk,
which Cursor re-creates when its MCP state changes), team rules,
Agent Store skills, and plugin database ids, which are taken from a part Cursor
kept in its database when there is one (`context/plugin-ids.json`). Nor the order of a rule
edited while Cursor runs (Cursor moves it to the end of its list), or files
`.cursorignore` excludes. Ripgrep lists rule files with two threads, so the order
of rules in a folder changes from one listing to the next: the most frequent of
a few runs is taken, and a note in `sentContext` says so. The order Cursor sent
is one of the orders ripgrep can produce, not necessarily the one taken, so the
rules part's id may differ.

Credentials are never stored. A git remote URL holds them as git has it
(`https://user:token@host/...`), and a rule may hold a URL or a token
(GitHub, GitLab, OpenAI, Anthropic, Slack, AWS, Google formats): they are
replaced by `[redacted]` (`https://[redacted]@host/...`) in `meta.json`, the
snapshots, `chat.md` and the parts. A part that held one is stored as
`context/<sha256>.redacted.bin`: its name keeps the sha256 of the bytes before
the replacement, the id compared with Cursor's, and `redacted` in its
`sentContext` entry says how many were replaced and where (`dynamicRedacted`
for the environment).

## CLI

The same breakdown is available from a terminal, without Cursor running:

```sh
node bin/cursor-context.cjs --list                    # recent chats
node bin/cursor-context.cjs                           # breakdown of the latest chat
node bin/cursor-context.cjs --chat <id> --show rules  # text of a category or item id
node bin/cursor-context.cjs --db <path>               # use another state.vscdb
```

```text
Ping request  [9f37163b-346e-42d7-8f95-622e23613f9b]  model=composer-2.5  tree=false  messages=6
26.3K / 200.0K tokens
  System prompt                  465      1 items      1974 chars  (parsed)
  Tool definitions              3.6K      0 items         0 chars  (parsed)
  Rules                        10.8K      1 items     39298 chars  (parsed)
  ...
```

## Limitations

- **Built-in tool definitions are not stored locally.** Cursor's backend
  attaches them, so only each tool's name and token estimate are shown. MCP
  tool definitions are sent by the client and recorded (see
  [Context sent beside the prompt](#context-sent-beside-the-prompt)).
- **The context sent beside the prompt is rebuilt, not captured.** It matches
  what Cursor sent when the rule, skill, agent and MCP files did not change in
  between.
- The extension reads undocumented Cursor storage. A Cursor update can change
  it; open an issue if a category comes up empty.
- The history folder contains everything your chats contain, including any
  secrets pasted into them. Treat it like the chats themselves.

## Development

```text
src/extension.cjs     activation, commands, webview panel, history timer
src/cursorStore.cjs   reads state.vscdb and builds the context breakdown
src/history.cjs       session history recorder and backfill
src/storeIndex.cjs    the index of Cursor's message blobs (replaced results, replies)
src/chatMarkdown.cjs  renders chat.md
src/turnSteps.cjs     reads Cursor's turn steps and places their thinking on prompt messages
src/requestContext.cjs  the context parts' wire format (encode, decode)
src/protobuf.cjs      protobuf decoding, with and without a schema
src/contextSources.cjs  rebuilds them from rule, skill, agent and MCP files
src/sentContext.cjs   records them in the history, renders them
src/redact.cjs        replaces credentials before anything is stored
media/inspector.html  the webview UI
bin/cursor-context.cjs  CLI
test/                 node:test suites (npm test)
```

Run `npm test` before packaging. To try a change, package and install it as in
[Install and deploy](#install-and-deploy), then reload the window.

## Contributing

This is a personal tool in a private repository. Questions and bug reports go
to the repository's GitHub issues; pull requests are welcome from
collaborators. Please include a test for behavior changes and keep `npm test`
green.

## License

[MIT](LICENSE) © 2026 Emilio Ginzo
