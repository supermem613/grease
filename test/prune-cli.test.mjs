import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendEvent, readEvents, pathsForStore } from "../.github/extensions/grease/core/catalog.mjs";
import { classifySessionEvent } from "../.github/extensions/grease/core/classifier.mjs";

test("grease prune reports orphaned updates without deleting them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-prune-cli-"));
  try {
    await seed(root);
    await plantOrphan(root, "9cb748027a0daf36");
    await plantOrphan(root, "aaaabbbbccccdddd");

    const before = await readEvents({ root });
    const result = await runGrease(["prune", "--root", root]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "prune");
    assert.equal(result.data.dryRun, true);
    assert.equal(result.data.orphanedUpdates, 2);
    assert.equal(result.data.removed, 0);
    assert.equal((await readEvents({ root })).length, before.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease prune --apply removes the orphaned updates and reports a backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-prune-cli-"));
  try {
    await seed(root);
    await plantOrphan(root, "9cb748027a0daf36");
    await plantOrphan(root, "aaaabbbbccccdddd");

    const before = await readEvents({ root });
    const result = await runGrease(["prune", "--root", root, "--apply"]);

    assert.equal(result.ok, true);
    assert.equal(result.data.dryRun, false);
    assert.equal(result.data.removed, 2);
    assert.equal(typeof result.data.backupPath, "string");
    assert.equal((await readEvents({ root })).length, before.length - 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease schema lists the prune command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-prune-cli-"));
  try {
    const result = await runGrease(["schema", "--summary", "--root", root]);

    assert.equal(result.data.commandPaths.some((parts) => parts[0] === "prune"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function plantOrphan(root, itemId) {
  const record = {
    type: "friction.update",
    at: "2026-07-01T00:00:00.000Z",
    itemId,
    updates: { status: "resolved" },
    id: "orphan-" + itemId
  };
  await appendFile(pathsForStore(root).events, JSON.stringify(record) + "\n");
}

async function seed(root) {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "alpha.run",
    error: "Access denied"
  });
  await appendEvent(signal, { root });
}

async function runGrease(args) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/grease.mjs", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || stdout.length > 0) {
        resolve(stdout);
      } else {
        reject(new Error(`grease ${args.join(" ")} failed with exit ${code}: ${stderr}`));
      }
    });
  });
  return JSON.parse(output);
}
