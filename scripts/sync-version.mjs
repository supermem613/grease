import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// package.json is the single source of truth for the released version, and
// plugin.json must repeat it for the extension host. npm bumps only
// package.json, so this script runs from the npm `version` lifecycle hook to
// close that gap. Keep plugin.json serialized as 2-space JSON with a trailing
// newline so a sync never shows up as unrelated formatting churn.
const repoRoot = path.resolve(import.meta.dirname, "..");

export async function syncPluginVersion(options = {}) {
  const root = options.root ?? repoRoot;
  const packagePath = path.join(root, "package.json");
  const pluginPath = path.join(root, "plugin.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const plugin = JSON.parse(await readFile(pluginPath, "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`package.json is missing a version: ${packagePath}`);
  }
  const previousVersion = plugin.version;
  const inSync = previousVersion === pkg.version;
  if (!inSync && !options.checkOnly) {
    plugin.version = pkg.version;
    await writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`, "utf8");
  }
  return {
    packageVersion: pkg.version,
    previousVersion,
    inSync,
    changed: !inSync && !options.checkOnly,
    pluginPath
  };
}

function parseArgs(argv) {
  const options = { checkOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.checkOnly = true;
    } else if (arg === "--root") {
      index += 1;
      options.root = argv[index];
      if (!options.root) {
        throw new Error("--root requires a directory path");
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await syncPluginVersion(options);
  if (result.inSync) {
    console.log(`plugin.json already matches package.json at ${result.packageVersion}`);
    return;
  }
  if (options.checkOnly) {
    console.error(
      `plugin.json version ${result.previousVersion} must equal package.json version ${result.packageVersion}. Run: npm run sync-version`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`plugin.json version ${result.previousVersion} -> ${result.packageVersion}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
