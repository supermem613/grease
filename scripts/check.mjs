import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoots = [
  root,
  path.join(root, ".github", "extensions", "grease"),
  path.join(root, "scripts"),
  path.join(root, "test")
];

const files = [];

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (dir === root && entry.isDirectory()) {
      continue;
    }
    if (entry.isDirectory()) {
      await collect(fullPath);
    } else if (entry.isFile() && fullPath.endsWith(".mjs")) {
      files.push(fullPath);
    }
  }
}

for (const dir of sourceRoots) {
  await collect(dir);
}

for (const file of files) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", file], {
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Syntax check failed for ${path.relative(root, file)} with exit ${code}`));
      }
    });
  });
}
