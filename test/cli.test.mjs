import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

test("CLI schema summary is machine-readable JSON", async () => {
  const result = await runGrease(["schema", "--summary"]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "schema");
  assert.equal(result.data.schemaVersion, 1);
  assert.ok(result.data.commandPaths.some((pathParts) => pathParts[0] === "brief"));
});

test("CLI doctor is machine-readable JSON", async () => {
  const result = await runGrease(["doctor"]);

  assert.equal(result.ok, true);
  assert.ok(result.checks.some((check) => check.name === "node"));
});

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
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`grease ${args.join(" ")} failed with exit ${code}: ${stderr}`));
      }
    });
  });
  return JSON.parse(output);
}

test("CLI search exposes an offset flag and reports paging state", async () => {
  const schemaResult = await runGrease(["schema"]);
  const searchCommand = schemaResult.data.commands.find((command) => command.path.join(" ") === "search");
  const flags = searchCommand.input.flags.map((flag) => flag.name);
  assert.ok(flags.includes("--offset"), "search accepts --offset");

  const page = await runGrease(["search", "--limit", "1", "--offset", "0"]);
  assert.equal(page.ok, true);
  assert.equal(page.data.offset, 0);
  assert.equal(typeof page.data.total, "number");
  assert.equal(typeof page.data.hasMore, "boolean");
});