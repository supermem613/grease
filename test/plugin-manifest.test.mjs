import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncPluginVersion } from "../scripts/sync-version.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const syncScript = path.join(repoRoot, "scripts", "sync-version.mjs");

async function driftedFixture(packageVersion, pluginVersion) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-version-"));
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "grease", version: packageVersion }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "plugin.json"),
    `${JSON.stringify({ name: "grease", version: pluginVersion, skills: "skills/" }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

function runSyncScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [syncScript, ...args], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

test("plugin.json version stays in lockstep with package.json", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(path.join(repoRoot, "plugin.json"), "utf8"));
  assert.equal(
    plugin.version,
    pkg.version,
    `plugin.json version ${plugin.version} must equal package.json version ${pkg.version}`
  );
});

test("npm version runs the sync script so a bump updates plugin.json too", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(
    pkg.scripts.version,
    /scripts\/sync-version\.mjs/,
    "the npm version lifecycle script must run scripts/sync-version.mjs so npm version cannot bump package.json alone"
  );
  assert.match(
    pkg.scripts.check,
    /scripts\/sync-version\.mjs --check/,
    "npm run check must verify plugin.json is in lockstep so drift fails before the test suite"
  );
});

test("sync-version rewrites a drifted plugin.json to the package.json version", async () => {
  const root = await driftedFixture("9.9.9", "9.9.8");
  try {
    const result = await syncPluginVersion({ root });
    assert.equal(result.changed, true, "a drifted manifest is rewritten");
    assert.equal(result.packageVersion, "9.9.9");
    const plugin = JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8"));
    assert.equal(plugin.version, "9.9.9", "plugin.json adopts the package.json version");
    assert.equal(plugin.skills, "skills/", "unrelated manifest fields survive the sync");
    const raw = await readFile(path.join(root, "plugin.json"), "utf8");
    assert.equal(raw.endsWith("\n"), true, "the manifest keeps its trailing newline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync-version leaves an in-lockstep manifest byte-identical", async () => {
  const root = await driftedFixture("9.9.9", "9.9.9");
  try {
    const before = await readFile(path.join(root, "plugin.json"), "utf8");
    const result = await syncPluginVersion({ root });
    assert.equal(result.inSync, true, "a matching manifest reports lockstep");
    assert.equal(result.changed, false, "a matching manifest is not rewritten");
    const after = await readFile(path.join(root, "plugin.json"), "utf8");
    assert.equal(after, before, "an in-lockstep manifest is untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync-version --check reports drift through its exit code", async () => {
  const drifted = await driftedFixture("9.9.9", "9.9.8");
  const matched = await driftedFixture("9.9.9", "9.9.9");
  try {
    assert.equal(
      await runSyncScript(["--check", "--root", drifted]),
      1,
      "--check exits non-zero while plugin.json trails package.json"
    );
    const stillDrifted = JSON.parse(await readFile(path.join(drifted, "plugin.json"), "utf8"));
    assert.equal(stillDrifted.version, "9.9.8", "--check reports drift without writing");
    assert.equal(
      await runSyncScript(["--check", "--root", matched]),
      0,
      "--check exits zero once the versions agree"
    );
  } finally {
    await rm(drifted, { recursive: true, force: true });
    await rm(matched, { recursive: true, force: true });
  }
});

