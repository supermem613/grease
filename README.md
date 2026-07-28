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
- Captured payloads can include tool names, error messages, working directories, and user message snippets from your own Copilot sessions. They are written to `~/.grease/events.jsonl`, retained in `~/.grease/catalog.json`, and projected into `~/.grease/active.json` on disk. You can delete those files at any time to reset Grease.
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
  catalog.json      # disposable full historical projection
  active.json       # disposable actionable working-set projection
```

`events.jsonl` is the only source of truth. Both `catalog.json` and `active.json` are disposable projections rebuilt from the log. If either is missing, stale, incompatible, or interrupted, it is rebuilt from `events.jsonl`. Resolved and ignored items stay queryable through the full catalog, and search output schemas are unchanged.

### Append-only capture

Capture never rewrites a projection. Each capture appends one line to `events.jsonl` and returns. A projection refresh happens off the hot path and only when the projection is actually stale, so a large catalog no longer pays a multi-megabyte rewrite on every event.

### Derived item identity

An item is one friction, and its identity comes from the failure kind, the tool source, the title, the tool name, and the result type. The working directory is deliberately absent, so the same failure hit from two repos is one item rather than two. Every occurrence still records the directory it happened in, and the item carries a `workingDirectories` array.

A tool-failure title names its cause, not just the tool. Grease reduces the raw error to a short signature by discarding the parts that vary between two instances of the same failure, which are file paths, serialized payloads, echoed patterns, identifiers, and digits. `view failed` becomes `view failed: Path does not exist`, and `view failed: view_range out of bounds` stays a separate item instead of being absorbed into it.

The title and the source are derived on read rather than trusted from the stored event, so an improvement to how a cause is named reaches friction that was recorded before the improvement existed. A signal carrying `evidence.errorSignature` was already named at capture time and is left untouched.

### Bounded projections

Projections no longer persist a per-item `occurrences[]` array, so `catalog.json` and `active.json` stay bounded in size as the log grows. Each item keeps a single `item.latestOccurrence`. When a caller needs the full occurrence history, Grease reconstructs it on read from `events.jsonl`. `CATALOG_VERSION` is `6`; an older projection triggers a one-time rebuild into the bounded shape.

### Lock ownership and reclaim

The projection lock records its owner as process id, process start time, and a random token. A holder releases the lock only after checking that token, so a stale rename can never delete a live owner's lock. A dead owner's lock is reclaimed at once. A missing or corrupt owner record is reclaimed only after a bounded grace window.

### Lock-owned temp sweeper

Atomic writes stage a temp file before rename. A crash can leave a strict orphan named `catalog.json.<pid>.<ts>.<n>.tmp` or `active.json.<pid>.<ts>.<n>.tmp`. The projection holder sweeps only those strict orphans while it owns the lock. Unrelated temp files, non-numeric names, an in-flight write, and `events.jsonl` all survive.

### Split append and projection locks

Two locks keep capture off the projection path. `append.lock` serializes only the append to `events.jsonl`. `catalog.lock` serializes projection rebuild, publication, read-repair, and the temp sweep. After appending, capture takes a non-blocking pass at the projection lock and skips maintenance when a live rebuild already holds it, so capture never waits on a slow rebuild. Each rebuild pins its events boundary with one file read and publishes a single generation, so concurrent stale readers publish exactly one generation and appends landing during a rebuild cannot skew it.

## Agent tools

The extension registers these six tools:

| Tool | Purpose |
| --- | --- |
| `grease_status` | Show catalog health and paths, including `orphanedUpdates`, the number of recorded updates whose item id no longer resolves. |
| `grease_capture` | Capture model-observed operational friction that passive telemetry may not see and return the `itemId` of the item it created or updated, which is the `id` to pass to `grease_update`. |
| `grease_search` | Search catalog items, one page at a time. |
| `grease_get` | Inspect one item with evidence. |
| `grease_update` | Change status, severity, tags, or note on one item (`id`) or many items at once (`ids`). An `id` that does not resolve to an existing item is rejected with a `notFound` result and nothing is recorded; a bulk update applies to every `id` or none. |
| `grease_brief` | Generate a kickoff prompt from one or more items. |

A Grease item id identifies a friction item, while an event id identifies a log entry. Only an item id resolves for `grease_update`, so a caller should record the item id returned by `grease_capture` rather than guess one.

Closing an item is a claim that the friction is fixed. If the same friction is captured again after the item was closed, Grease reopens the item and records `reopenedAt`; only items that were `resolved` or `ignored` reopen, while `triaged` and `in-progress` remain active states and recurrence leaves them alone. As a result, a `status=open` search always reflects friction that is currently happening, so closing a batch of items cannot hide a problem that comes back.

Every tool reports a rejected call as a normal result whose payload carries `ok: false`, a `problems` array naming each offending argument, and a `recovery` line. Missing arguments, wrong types, and values outside an accepted set are all reported together, so a caller fixes them in one retry. Tools never reject by throwing, because the host discards a thrown message and shows only `Tool execution failed`.

`grease_search` takes `limit` and `offset` and returns `total`, `offset`, and `hasMore` alongside the page. `limit` is the page size and is clamped to 100, which bounds one response rather than what a caller can reach. Walk the whole result set by raising `offset` by the page size until `hasMore` is false. Paging is applied after the filter and the sort, so it behaves the same against the active projection and the full catalog.

## Programmatic CLI

Grease also ships a dependency-free CLI for scripts and agents. Run these from the repo root:

```powershell
node ./scripts/grease.mjs schema --summary
node ./scripts/grease.mjs status
node ./scripts/grease.mjs search atrium --limit 5
node ./scripts/grease.mjs search --status open --limit 100 --offset 100
node ./scripts/grease.mjs brief --query atrium --limit 3
node ./scripts/grease.mjs update <id> --status resolved --note "Fixed and validated"
node ./scripts/grease.mjs update <id1> <id2> <id3> --status resolved --note "Closed in bulk"
node ./scripts/grease.mjs prune
node ./scripts/grease.mjs prune --apply
node ./scripts/grease.mjs prune --root <store>
```

`grease prune` reports orphaned updates and their item ids without changing anything. `grease prune --apply` removes them after writing a full backup of the event log, and `--root` targets a specific store.

Non-interactive commands write JSON only to stdout. The `schema` command is the source of truth for supported commands.

## Triage skill

The `grease-triage` skill drives the headless triage loop end to end: capture, status, search or get, brief, then update items individually or in bulk. See `skills/grease-triage/SKILL.md`.

The `grease_capture` MCP tool is the primary agent instruction surface because its description and parameter guidance are visible whenever the extension is loaded. It tells agents to record operational friction during the task without waiting for a user request, and specifies the minimum context and redacted evidence each item should carry. The triage skill repeats the policy for operators reviewing the catalog.

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

### Versioning

`package.json` holds the version; `plugin.json` repeats it for the extension host. Bump with `npm version patch --no-git-tag-version` and both files move together, because the npm `version` lifecycle hook runs `scripts/sync-version.mjs`. `npm run check` fails on drift, so a manually edited version never reaches CI. To repair drift by hand, run `npm run sync-version`.

## Design notes

- One extension product owns capture, storage, and tools.
- Capture and interpretation are separate. Events are logged first; catalog compaction groups them into durable items.
- Session-store timeout captures can include deterministic query-shape planning guidance as local catalog context, so the same friction can be briefed and closed with a repeatable plan.
- Grease enriches captured view `Path does not exist` failures for known-path read preflight when paths are stale/unproven or proven file-backed Atrium outputs, with discovery-first or `atrium-read` bounded-range recovery guidance.
- Grease enriches captured stale preimage editing failures from `edit` and `apply_patch` with fresh-read and hunk-rebuild recovery guidance after the failed call is captured.
- Grease records recovery guidance for captured `web_fetch` redirect failures, including final-URL retry guidance and bounded first-page guidance.
- Grease does not create sessions directly. `grease_brief` produces the kickoff prompt that a session creation flow can use.

## License

MIT. See [LICENSE](LICENSE).
