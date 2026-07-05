---
name: grease-install
description: |
  Use when installing or refreshing the Grease Copilot extension shim in the user's Copilot extension directory.
metadata:
  userInvocable: true
---

# grease-install

Use this skill when the user wants to install or refresh Grease as a user-scoped Copilot extension.

## What it does

The install script does two things from one command:

- writes a real extension directory at `~/.copilot/extensions/grease` with a one-line `extension.mjs` import shim that points back to the checked-out Grease repo, activating the agent tools and passive hooks, and
- links every skill under the repo's `skills/` directory into `~/.copilot/skills/` as a directory junction, so the Grease skills are discovered as personal Copilot skills.

Both the extension shim and the skill junctions point at the clone rather than copying it, so repo edits are picked up on the next Copilot load. It refuses to overwrite a symlink or junction it did not create, and refuses to overwrite a real skill directory it does not own.

## How to run it

The install script lives at `../../scripts/install-extension-shim.mjs` relative to this SKILL.md. Resolve that path against this skill's own base directory to get an absolute path, then run it with node. No user-supplied path is required.

For example, if this SKILL.md is at `C:\path\to\grease\skills\grease-install\SKILL.md`, run:

```powershell
node C:\path\to\grease\scripts\install-extension-shim.mjs
```

The script is self-locating — it resolves the Grease repo root from its own file location using `import.meta.dirname`, so the shim and skill junctions always point at the clone the script was run from.

## Optional targets

To install into a non-default extension directory, pass `--target`. To link skills into a non-default skills directory, pass `--skills-target`:

```powershell
node <resolved-script-path> --target <extension-dir> --skills-target <skills-dir>
```

The default extension target is `~/.copilot/extensions/grease`. The default skills target is `~/.copilot/skills`.

## After install

Reload Copilot extensions and skills from the app or CLI.

## Output

The command writes JSON on stdout:

```json
{
  "ok": true,
  "command": "install-extension-shim",
  "data": {
    "target": "<extension directory>",
    "shimPath": "<extension.mjs path>",
    "sourceExtension": "<repo extension path>",
    "skillsTarget": "<skills directory>",
    "skills": ["grease-install", "grease-triage"]
  }
}
```
