import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

test("install shim writes a file URL import", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "grease-shim-"));
  try {
    const result = await runNode(["scripts/install-extension-shim.mjs", "--target", target]);
    assert.equal(result.ok, true);
    const shim = await readFile(path.join(target, "extension.mjs"), "utf8");
    assert.match(shim, /^await import\("file:\/\/\//);
    assert.match(shim, /extension\.mjs"\);/);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

async function runNode(args) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
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
        reject(new Error(`node ${args.join(" ")} failed with exit ${code}: ${stderr}`));
      }
    });
  });
  return JSON.parse(output);
}
