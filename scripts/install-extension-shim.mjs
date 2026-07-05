import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceExtension = path.join(repoRoot, ".github", "extensions", "grease", "extension.mjs");
const repoSkillsDir = path.join(repoRoot, "skills");
const defaultTarget = path.join(os.homedir(), ".copilot", "extensions", "grease");
const defaultSkillsTarget = path.join(os.homedir(), ".copilot", "skills");

const args = parseArgs(process.argv.slice(2));
const target = path.resolve(args.target ?? defaultTarget);
const skillsTarget = path.resolve(args.skillsTarget ?? defaultSkillsTarget);

await assertSourceExists();
await assertSafeTarget(target);
await mkdir(target, { recursive: true });

const shimPath = path.join(target, "extension.mjs");
const importUrl = pathToFileURL(sourceExtension).href;
await writeFile(shimPath, `await import(${JSON.stringify(importUrl)});\n`, "utf8");

const skills = await linkSkills(skillsTarget);

process.stdout.write(JSON.stringify({
  ok: true,
  command: "install-extension-shim",
  data: {
    target,
    shimPath,
    sourceExtension,
    skillsTarget,
    skills
  }
}) + "\n");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      parsed.target = argv[index + 1];
      index += 1;
    } else if (arg === "--skills-target") {
      parsed.skillsTarget = argv[index + 1];
      index += 1;
    } else if (arg === "--help") {
      process.stdout.write("Usage: node scripts/install-extension-shim.mjs [--target <extension-dir>] [--skills-target <skills-dir>]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function assertSourceExists() {
  await readFile(sourceExtension, "utf8");
}

async function assertSafeTarget(targetPath) {
  const stat = await lstatOrNull(targetPath);
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink: ${targetPath}`);
  }
}

// Link each repo skill into the personal Copilot skills directory so a single
// setup activates the tools and the skills together, and skill edits in the
// repo are picked up live. Skills and extensions are separate discovery
// subsystems, so the extension shim alone does not surface skills. Junctions
// point at the repo instead of copying, which keeps content from drifting.
async function linkSkills(skillsRoot) {
  const entries = await readdir(repoSkillsDir, { withFileTypes: true });
  const skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (skillNames.length === 0) {
    return [];
  }
  await mkdir(skillsRoot, { recursive: true });
  const linked = [];
  for (const name of skillNames) {
    const linkPath = path.join(skillsRoot, name);
    const sourcePath = path.join(repoSkillsDir, name);
    const existing = await lstatOrNull(linkPath);
    if (existing) {
      if (!existing.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite existing skill directory: ${linkPath}`);
      }
      await rm(linkPath, { recursive: true, force: true });
    }
    await symlink(sourcePath, linkPath, "junction");
    linked.push(name);
  }
  return linked.sort();
}

async function lstatOrNull(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
