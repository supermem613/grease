import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("setup links every repo skill into the personal skills dir, live from the repo", async () => {
  const extTarget = await mkdtemp(path.join(os.tmpdir(), "grease-ext-"));
  const skillsTarget = await mkdtemp(path.join(os.tmpdir(), "grease-skills-"));
  try {
    const result = await runNode([
      "scripts/install-extension-shim.mjs",
      "--target", extTarget,
      "--skills-target", skillsTarget
    ]);
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.data.skills), "result reports installed skills");
    assert.ok(result.data.skills.includes("grease-triage"), "grease-triage is linked");
    assert.ok(result.data.skills.includes("grease-install"), "grease-install is linked");

    const linkedSkill = path.join(skillsTarget, "grease-triage", "SKILL.md");
    const linkedContent = await readFile(linkedSkill, "utf8");
    assert.match(linkedContent, /name:\s*grease-triage/);

    const linkedReal = await realpath(linkedSkill);
    const repoReal = await realpath(path.join(repoRoot, "skills", "grease-triage", "SKILL.md"));
    assert.equal(linkedReal, repoReal, "linked skill resolves to the live repo file");
  } finally {
    await rm(extTarget, { recursive: true, force: true });
    await rm(skillsTarget, { recursive: true, force: true });
  }
});

test("setup refuses to overwrite a real skill directory it does not own", async () => {
  const extTarget = await mkdtemp(path.join(os.tmpdir(), "grease-ext-"));
  const skillsTarget = await mkdtemp(path.join(os.tmpdir(), "grease-skills-"));
  try {
    const realSkillDir = path.join(skillsTarget, "grease-triage");
    await runNode(["-e", `require("fs").mkdirSync(${JSON.stringify(realSkillDir)}, { recursive: true })`]);
    await writeFile(path.join(realSkillDir, "SKILL.md"), "user owned", "utf8");

    await assert.rejects(
      runNode([
        "scripts/install-extension-shim.mjs",
        "--target", extTarget,
        "--skills-target", skillsTarget
      ]),
      /Refusing to overwrite/
    );
  } finally {
    await rm(extTarget, { recursive: true, force: true });
    await rm(skillsTarget, { recursive: true, force: true });
  }
});

async function runNode(args) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
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
  return output.trim() === "" ? {} : JSON.parse(output);
}
