import { appendEvent } from "../../.github/extensions/grease/core/catalog.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function main() {
  const fixturePath = parseFixturePath(process.argv.slice(2));
  if (!fixturePath) {
    console.error("usage: node test/bench/append-hold.mjs --fixture <path>");
    return;
  }

  const resolvedFixturePath = path.resolve(process.cwd(), fixturePath);
  const fixtureText = await readFile(resolvedFixturePath, "utf8");
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-append-hold-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "events.jsonl"), fixtureText, "utf8");

    const durations = [];
    for (let index = 0; index < 200; index += 1) {
      const startedAt = process.hrtime.bigint();
      await appendEvent({
        type: "friction.signal",
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        signal: {
          kind: "bench-append",
          source: "append-hold",
          title: `append ${index}`,
          summary: `bench append ${index}`,
          severity: "low",
          evidence: { index }
        },
        sessionId: `bench-${index}`,
        sessionName: `Bench Session ${index}`,
        workingDirectory: root
      }, { root });
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      durations.push(elapsedMs);
    }

    const sorted = durations.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const p50 = sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
    console.log(`${p50.toFixed(3)} ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseFixturePath(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--fixture") {
      return args[index + 1];
    }
  }
  return undefined;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
