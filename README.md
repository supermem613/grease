# Grease

Grease is a Copilot extension that captures sources of friction across every Copilot session on your machine and turns them into addressable work.

It passively watches Copilot session events, records failed local tools and MCP calls, and keeps a durable catalog you can search, brief, update, and export as a canvas-ready HTML board.

## Cross-session capture

Install Grease once at user scope and it observes **every** Copilot CLI session you run on the machine, not just the session you installed it from. Friction that surfaces in one session can be triaged and fixed later in a separate session or in automation, without losing the original context. The catalog is shared across sessions, so a `grease_brief` produced from session A can drive a fix-it session B that closes the items with `grease_update` after validation.

## Local-only by design

**No data ever leaves your machine.** Grease has no telemetry, no analytics, no cloud sync, no remote logging, and makes no outbound network calls of any kind. Everything Grease captures is written to local files under `~/.grease/` and stays there.

Concretely:

- Zero runtime dependencies. The only import from outside the repo is `@github/copilot-sdk`, which is host-injected by Copilot when the extension runs.
- No HTTP client, no `fetch`, no socket connections. The only network code in the extension is a canvas renderer that binds to `127.0.0.1` on a random port for the local browser canvas; it does not accept non-loopback traffic.
- The canvas page ships with a strict Content Security Policy that blocks every external request (`default-src 'none'`, `connect-src 'self'`, no external scripts, no external fonts, no external images). The canvas cannot load anything from the internet even if you wanted it to.
- Captured payloads can include tool names, error messages, working directories, and user message snippets from your own Copilot sessions. They are written to `~/.grease/events.jsonl` and compacted into `~/.grease/catalog.json` on disk. You can delete those files at any time to reset Grease.
- `grease_brief` and `grease_session_request` produce prompts in your shell; nothing is sent anywhere on your behalf. If you choose to paste a brief into another Copilot session, that is the only path off the machine, and you control it.

## How it loads

Grease loads as a Copilot CLI extension from `.github/extensions/grease/extension.mjs`, with a user-scoped install shim that points `~/.copilot/extensions/grease` back at this repo. It registers agent tools and an extension-owned canvas from the same extension process. The repo-root `extension.mjs` is a compatibility shim for tools that expect a root entrypoint.

## What Grease captures

Grease treats these as first-class friction:

- local tool failures
- MCP failures, including Atrium-style tool calls
- access denied, permission denied, unauthorized, forbidden, `EACCES`, and `EPERM`
- timeouts and deadline failures
- policy blocks such as search-policy and content exclusion failures
- session errors
- user corrections that indicate the agent went down the wrong path

Passive capture is the backbone. Manual capture is available for cases the event stream cannot see.

## Catalog storage

Grease stores data under `~\.grease` by default:

```text
~\.grease\
  events.jsonl      # append-only source of truth
  catalog.json      # compacted derived catalog
  canvas\grease.html
```

The append-only log is the durable source of truth. `catalog.json` is regenerated from the log and written with a temporary file plus atomic rename.

## Agent tools

The extension registers these tools:

| Tool | Purpose |
| --- | --- |
| `grease_status` | Show catalog health and paths. |
| `grease_capture` | Manually capture a friction item. |
| `grease_search` | Search catalog items. |
| `grease_get` | Inspect one item with evidence. |
| `grease_update` | Change status, severity, tags, or note. |
| `grease_brief` | Generate a kickoff prompt from one or more items. |
| `grease_session_request` | Prepare a structured Copilot session request from selected items. |
| `grease_export_canvas` | Write a canvas-ready HTML board. |

## Programmatic CLI

Grease also ships a dependency-free CLI for scripts and agents:

```powershell
node scripts\grease.mjs schema --summary
node scripts\grease.mjs status
node scripts\grease.mjs search atrium --limit 5
node scripts\grease.mjs session-request --query atrium --limit 3
node scripts\grease.mjs update <id> --status resolved --note "Fixed and validated"
```

Non-interactive commands write JSON only to stdout. The `schema` command is the source of truth for supported commands.

## Canvas

The extension registers a `grease` canvas with these actions:

| Action | Purpose |
| --- | --- |
| `refresh_catalog` | Return current item and open counts. |
| `prepare_fix_session` | Prepare a session request from selected item ids, query, status, or limit. |
| `run_in_current_session` | Send selected items into the current Copilot session and mark them in-progress. |
| `export_html` | Export the same board as standalone HTML. |

The canvas renderer is a loopback HTTP server owned by the extension process. It reads the catalog on each request so refreshes show the latest compacted state. The visible UX lets you select friction rows, press **Prepare fix session**, copy the prompt, or press **Run in current session**. Copied prompts include Grease closure instructions so the fixing session can mark the selected items resolved with `grease_update` after validation.

### Live validation

`extensions_reload` terminates the current Grease extension process and starts a
new one. Do not batch `extensions_reload` with `grease_*` tool calls,
`open_canvas`, or `invoke_canvas_action` in the same parallel tool turn. Any
Grease call in that batch can be interrupted because its provider process is the
one being restarted. Run reload as its own step, wait for the new Grease process
to be reported ready, then issue Grease tool or canvas calls in a later step.

When validating the Grease canvas with a browser canvas, use a fresh browser `instanceId` for each run. Do not reuse an `instanceId` across canvas types or after an extension reload. Canvas instance ownership is stable, so reusing an ID such as `grease-lifecycle-debug` for a different canvas can fail with `CanvasInstanceIdConflictError`.

After an extension reload, do not call `invoke_canvas_action` against an old instance. The owning provider connection may be gone, which can fail with `CanvasRuntimeError: Canvas instance "<id>" cannot be reached`. Re-issue `open_canvas` first to rehydrate the instance, then invoke actions on the returned live panel.

Safe pattern:

```text
open_canvas canvasId=browser instanceId=grease-live-refresh-debug-<short-unique-suffix>
```

## Install for local use

From a clone of this repo:

```sh
npm install
npm run setup
```

`npm run setup` runs `scripts/install-extension-shim.mjs`, which writes a one-line `extension.mjs` shim into `~/.copilot/extensions/grease/` that imports back into the clone. Then reload Copilot extensions.

The install script is self-locating — it resolves the repo root from its own file location, so no paths need to be edited.

## Development

```powershell
npm install
npm run check
npm test
```

No runtime dependencies are required. `@github/copilot-sdk` is host-injected by Copilot when the extension runs.

## Design notes

- One extension product owns capture, storage, tools, and exported UI.
- Capture and interpretation are separate. Events are logged first; catalog compaction groups them into durable items.
- App canvas support should use the existing `grease_export_canvas` model and catalog APIs rather than becoming a separate collector.
- Grease does not create sessions directly. `grease_brief` produces the kickoff prompt that a session creation flow can use.

## License

MIT. See [LICENSE](LICENSE).
