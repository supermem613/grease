---
name: grease-triage
description: |
  Use when triaging Grease friction items: review what Grease captured across Copilot sessions, brief a fix, and close items individually or in bulk after validation.
metadata:
  userInvocable: true
---

# grease-triage

Use this skill to run the Grease triage loop from any Copilot CLI session. Grease passively captures friction across every session on the machine into a shared local catalog. This skill turns that catalog into addressable, closable work.

There is no UI. The entire loop runs through the six Grease agent tools (or the equivalent `./scripts/grease.mjs` CLI commands, run from the repo root).

## The loop

1. **Status** — Start with `grease_status` to see catalog health, counts, and file paths. This confirms Grease is capturing and shows how many items are open.
2. **Find** — Use `grease_search` to find relevant friction by text, status, or limit. Narrow to the items worth acting on.
3. **Inspect** — Use `grease_get` on a single item id to read its full evidence: the occurrences, tool names, error messages, and session context behind the item.
4. **Brief** — Use `grease_brief` with one or more item ids (or a query) to generate a kickoff prompt for a fix-it session. The brief carries the closure instruction so the fixing session knows to mark items resolved after validation.
5. **Capture (as needed)** — Use `grease_capture` to manually record friction the passive event stream cannot see.
6. **Close** — After a fix is validated, use `grease_update` to change status, severity, tags, or a note.

## Triage discipline

The loop is mechanical; triage is judgment. These rules keep triage purposeful and stop the catalog from turning into instruction bloat.

### Triage in bulk, by root cause

Pull all open items and cluster them by tool, error signature, and path family before acting. `latestSummary` holds the evidence: the error detail and the exact tool arguments that failed. Triage each cluster once, not each item in isolation. Occurrence count shows which clusters recur and are worth a durable fix.

### Every item gets exactly one disposition

1. **Root-cause fix** — a deterministic, recurring, unaddressed cause. Fix the source (code, instruction, or workflow), then resolve with a note naming the fix.
2. **Governed hygiene** — already covered by an existing rule or convention. The recurrence is discipline, not a missing rule. Resolve with a note citing the governing rule. Do not add a new rule.
3. **Environment or caller one-off** — non-recurring, or an infra, policy, or tool-backend failure you cannot fix. Resolve as a one-off.

### High bar to add a rule

Only codify a new instruction when the cause is all three: deterministic, recurring across sessions, and not already governed. One-offs and already-governed items are closed, never met with new instructions. Piling instructions for hygiene is friction, not a fix.

For session-store timeout items, use any captured planning guidance in the item's local evidence when you brief a fix-it session or close the item. Treat that guidance as part of the recorded item context, not as a separate signal from outside Grease.

For known-path read preflight items, use `failureDiagnosis.recovery` when you brief a fix-it session or close the item.

### Caller-side vs tool defect

A tool that errors correctly on bad input (missing file, bad root, malformed arguments) is caller-side: fix the caller, usually an instruction. A tool that fails on valid input is a defect: fix or relay it. Do not relay caller-side errors.

### Cross-repo defects: relay first

When an item's root cause lives in another repo, do not fix it in place. Relay it to the owner for review, verify the owner's fix live, then resolve. See the `relay` skill.

## Closing one item vs many

`grease_update` accepts either a single `id` or an `ids` array.

- Close one item: pass `id` with the update fields.
- Close many items atomically: pass `ids` (an array of item ids). All listed items receive the same update in a single catalog write, so the catalog is never left half-updated.

Only close items after the underlying friction is actually fixed and validated. Re-run the failing tool or reproduce the original error to confirm it no longer occurs. A resolved item should reflect a validated fix, not a dismissal.

## CLI equivalents

Every step is also available through the dependency-free CLI for scripts and automation. Run these from the repo root:

```powershell
node ./scripts/grease.mjs status
node ./scripts/grease.mjs search atrium --limit 5
node ./scripts/grease.mjs get <id>
node ./scripts/grease.mjs brief --query atrium --limit 3
node ./scripts/grease.mjs update <id> --status resolved --note "Fixed and validated"
node ./scripts/grease.mjs update <id1> <id2> <id3> --status resolved --note "Closed in bulk"
```

The CLI writes JSON only to stdout. Run `node ./scripts/grease.mjs schema --summary` to see the authoritative command list.
