# Grease

Grease is a Copilot CLI extension that captures sources of friction across every Copilot session on your machine and turns them into addressable work.

It passively watches Copilot session events, records failed local tools and MCP calls, and keeps a durable catalog you can search, brief, and update from any session.

## Cross-session capture

Install Grease once at user scope and it observes **every** Copilot CLI session you run on the machine, not just the session you installed it from. Friction that surfaces in one session can be triaged and fixed later in a separate session or in automation, without losing the original context. The catalog is shared across sessions, so a `grease_brief` produced from session A can drive a fix-it session B that closes the items with `grease_update` after validation.

## Local-only by design

**No data ever leaves your machine.** Grease has no telemetry, no analytics, no cloud sync, no remote logging, and makes no outbound network calls of any kind. Everything Grease captures is written to local files under `~/.grease/` and stays there.

Concretely:

- Zero runtime dependencies. The only import from outside the repo is `@github/copilot-sdk`, which is host-injected by Copilot when the extension runs.
- No HTTP client, no `fetch`, no socket connections, no servers of any kind. Grease is a headless capture-and-catalog tool with no network code.
- Captured payloads can include tool names, error messages, working directories, and user message snippets from your own Copilot sessions. They are written to `~/.grease/events.jsonl` and compacted into `~/.grease/catalog.json` on disk. You can delete those files at any time to reset Grease.
- `grease_brief` produces a prompt in your shell; nothing is sent anywhere on your behalf. If you choose to paste a brief into another Copilot session, that is the only path off the machine, and you control it.

## How it loads

Grease loads as a Copilot CLI extension from `.github/extensions/grease/extension.mjs`, with a user-scoped install shim that points `~/.copilot/extensions/grease` back at this repo. It registers agent tools and passive session hooks from the same extension process. The repo-root `extension.mjs` is a compatibility shim for tools that expect a root entrypoint.

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
```

The append-only log is the durable source of truth. `catalog.json` is regenerated from the log and written with a temporary file plus atomic rename.

## Agent tools

The extension registers these six tools:

| Tool | Purpose |
| --- | --- |
| `grease_status` | Show catalog health and paths. |
| `grease_capture` | Manually capture a friction item. |
| `grease_search` | Search catalog items. |
| `grease_get` | Inspect one item with evidence. |
| `grease_update` | Change status, severity, tags, or note on one item (`id`) or many items at once (`ids`). |
| `grease_brief` | Generate a kickoff prompt from one or more items. |

## Programmatic CLI

Grease also ships a dependency-free CLI for scripts and agents:

```powershell
node scripts\grease.mjs schema --summary
node scripts\grease.mjs status
node scripts\grease.mjs search atrium --limit 5
node scripts\grease.mjs brief --query atrium --limit 3
node scripts\grease.mjs update <id> --status resolved --note "Fixed and validated"
node scripts\grease.mjs update <id1> <id2> <id3> --status resolved --note "Closed in bulk"
```

Non-interactive commands write JSON only to stdout. The `schema` command is the source of truth for supported commands.

## Triage skill

The `grease-triage` skill drives the headless triage loop end to end: capture, status, search or get, brief, then update items individually or in bulk. See `skills/grease-triage/SKILL.md`.

Skills and extensions are separate Copilot subsystems: the extension registers tools and hooks, while skills are discovered from the skills directories. `npm run setup` installs both from a single command (see below), so the skills activate alongside the tools.

## Install for local use

From a clone of this repo:

```sh
npm install
npm run setup
```

`npm run setup` runs `scripts/install-extension-shim.mjs`, which:

- writes a one-line `extension.mjs` shim into `~/.copilot/extensions/grease/` that imports back into the clone, activating the agent tools and passive hooks, and
- links every skill under `skills/` into `~/.copilot/skills/` as a directory junction, so the `grease-triage` and `grease-install` skills are discovered as personal Copilot skills.

Both the extension shim and the skill junctions point back at this clone rather than copying it, so edits you make in the repo are picked up the next time Copilot loads. Reload Copilot extensions (and skills) after running setup, or after editing extension or skill files.

The install script is self-locating — it resolves the repo root from its own file location, so no paths need to be edited. It refuses to overwrite a real (non-linked) skill directory it does not own.

## Development

```powershell
npm install
npm run check
npm test
```

No runtime dependencies are required. `@github/copilot-sdk` is host-injected by Copilot when the extension runs.

## Design notes

- One extension product owns capture, storage, and tools.
- Capture and interpretation are separate. Events are logged first; catalog compaction groups them into durable items.
- Grease does not create sessions directly. `grease_brief` produces the kickoff prompt that a session creation flow can use.

## License

MIT. See [LICENSE](LICENSE).
