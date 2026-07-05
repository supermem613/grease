import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("plugin.json version stays in lockstep with package.json", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(path.join(repoRoot, "plugin.json"), "utf8"));
  assert.equal(
    plugin.version,
    pkg.version,
    `plugin.json version ${plugin.version} must equal package.json version ${pkg.version}`
  );
});
