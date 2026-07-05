---
name: grease-triage
description: |
  Use when triaging Grease friction items: review what Grease captured across Copilot sessions, brief a fix, and close items individually or in bulk after validation.
metadata:
  userInvocable: true
---

# grease-triage

Use this skill to run the Grease triage loop from any Copilot CLI session. Grease passively captures friction across every session on the machine into a shared local catalog. This skill turns that catalog into addressable, closable work.

There is no UI. The entire loop runs through the six Grease agent tools (or the equivalent `node scripts/grease.mjs` CLI commands).

## The loop

1. **Status** — Start with `grease_status` to see catalog health, counts, and file paths. This confirms Grease is capturing and shows how many items are open.
2. **Find** — Use `grease_search` to find relevant friction by text, status, or limit. Narrow to the items worth acting on.
3. **Inspect** — Use `grease_get` on a single item id to read its full evidence: the occurrences, tool names, error messages, and session context behind the item.
4. **Brief** — Use `grease_brief` with one or more item ids (or a query) to generate a kickoff prompt for a fix-it session. The brief carries the closure instruction so the fixing session knows to mark items resolved after validation.
5. **Capture (as needed)** — Use `grease_capture` to manually record friction the passive event stream cannot see.
6. **Close** — After a fix is validated, use `grease_update` to change status, severity, tags, or a note.

## Closing one item vs many

`grease_update` accepts either a single `id` or an `ids` array.

- Close one item: pass `id` with the update fields.
- Close many items atomically: pass `ids` (an array of item ids). All listed items receive the same update in a single catalog write, so the catalog is never left half-updated.

Only close items after the underlying friction is actually fixed and validated. A resolved item should reflect a real fix, not a dismissal.

## CLI equivalents

Every step is also available through the dependency-free CLI for scripts and automation:

```powershell
node scripts\grease.mjs status
node scripts\grease.mjs search atrium --limit 5
node scripts\grease.mjs get <id>
node scripts\grease.mjs brief --query atrium --limit 3
node scripts\grease.mjs update <id> --status resolved --note "Fixed and validated"
node scripts\grease.mjs update <id1> <id2> <id3> --status resolved --note "Closed in bulk"
```

The CLI writes JSON only to stdout. Run `node scripts\grease.mjs schema --summary` to see the authoritative command list.
