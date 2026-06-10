import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("repo-root extension shim points to canonical Copilot extension entrypoint", async () => {
  const shim = await readFile(path.join(root, "extension.mjs"), "utf8");

  assert.match(shim, /canonical Copilot extension source lives/);
  assert.match(shim, /import "\.\/\.github\/extensions\/grease\/extension\.mjs";/);
});
