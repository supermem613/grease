import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendEvent, getFriction, pathsForStore, readCatalog, readEvents, searchCatalog, updateFriction } from "../.github/extensions/grease/core/catalog.mjs";
import { classifySessionEvent } from "../.github/extensions/grease/core/classifier.mjs";

test("append-only log is source of truth for compacted catalog", async () => {
  const root = await tempRoot();
  try {
    const [first] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "powershell",
      toolCallId: "call-1",
      error: "Access denied"
    }, {
      sessionId: "session-1",
      sessionName: "First session",
      workingDirectory: "C:\\repo"
    });
    const [second] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "powershell",
      toolCallId: "call-2",
      error: "Access denied"
    }, {
      sessionId: "session-2",
      sessionName: "Second session",
      workingDirectory: "C:\\repo"
    });

    await appendEvent(first, { root, now: "2026-06-09T12:00:00.000Z", machineName: "devbox-1" });
    await appendEvent(second, { root, now: "2026-06-09T12:01:00.000Z", machineName: "devbox-2" });

    const events = await readEvents({ root });
    const catalog = await readCatalog({ root });

    assert.equal(events.length, 2);
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items[0].occurrenceCount, 2);
    assert.deepEqual(catalog.items[0].machineNames, ["devbox-1", "devbox-2"]);
    assert.deepEqual(catalog.items[0].sessionNames, ["First session", "Second session"]);
    assert.equal(catalog.items[0].origins.length, 2);
    assert.equal(catalog.occurrences[0].machineName, "devbox-2");
    assert.equal(catalog.occurrences[0].sessionName, "Second session");
    assert.equal(catalog.occurrences.length, 2);
    const machineSearch = await searchCatalog({ query: "devbox-2" }, { root });
    assert.equal(machineSearch.items.length, 1);
    const sessionSearch = await searchCatalog({ query: "Second session" }, { root });
    assert.equal(sessionSearch.items.length, 1);

    const logText = await readFile(pathsForStore(root).events, "utf8");
    assert.match(logText, /friction\.signal/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates are appended and applied to the derived item", async () => {
  const root = await tempRoot();
  try {
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "atrium.run",
      error: "deadline timeout"
    });
    await appendEvent(signal, { root });
    const { items } = await searchCatalog({ query: "atrium" }, { root });
    assert.equal(items.length, 1);

    await updateFriction(items[0].id, {
      status: "triaged",
      severity: "critical",
      tags: ["atrium", "mcp"],
      note: "Needs MCP access investigation"
    }, { root });

    const updated = await getFriction(items[0].id, { root });
    assert.equal(updated.item.status, "triaged");
    assert.equal(updated.item.severity, "critical");
    assert.equal(updated.item.latestNote, "Needs MCP access investigation");
    assert.ok(updated.item.tags.includes("atrium"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent updates against one store serialize safely", async () => {
  const root = await tempRoot();
  const originalDateNow = Date.now;
  Date.now = () => 1781105858562;
  try {
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "grease_update",
      error: "Tool execution failed"
    });
    await appendEvent(signal, { root });
    const { items } = await searchCatalog({ query: "grease_update" }, { root });
    assert.equal(items.length, 1);

    await Promise.all([
      updateFriction(items[0].id, {
        status: "ignored",
        note: "first concurrent update"
      }, { root }),
      updateFriction(items[0].id, {
        tags: ["race-validated"],
        note: "second concurrent update"
      }, { root })
    ]);

    const updated = await getFriction(items[0].id, { root });
    assert.equal(updated.item.status, "ignored");
    assert.equal(updated.item.latestNote, "second concurrent update");
    assert.ok(updated.item.tags.includes("race-validated"));

    const events = await readEvents({ root });
    assert.equal(events.filter((event) => event.type === "friction.update").length, 2);
  } finally {
    Date.now = originalDateNow;
    await rm(root, { recursive: true, force: true });
  }
});

test("updates from multiple processes share one store safely", async () => {
  const root = await tempRoot();
  try {
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "grease_update",
      error: "EPERM during rename"
    });
    await appendEvent(signal, { root });
    const { items } = await searchCatalog({ query: "grease_update" }, { root });
    assert.equal(items.length, 1);

    const catalogModule = pathToFileURL(path.resolve(".github/extensions/grease/core/catalog.mjs")).href;
    const workers = Array.from({ length: 4 }, (_, index) => runNodeModule(`
      const { updateFriction } = await import(${JSON.stringify(catalogModule)});
      await updateFriction(${JSON.stringify(items[0].id)}, {
        tags: [${JSON.stringify(`process-${index}`)}],
        note: ${JSON.stringify(`process update ${index}`)}
      }, {
        root: ${JSON.stringify(root)},
        now: ${JSON.stringify(`2026-06-09T12:0${index}:00.000Z`)}
      });
    `));

    await Promise.all(workers);

    const updated = await getFriction(items[0].id, { root });
    for (let index = 0; index < 4; index += 1) {
      assert.ok(updated.item.tags.includes(`process-${index}`));
    }
    const events = await readEvents({ root });
    assert.equal(events.filter((event) => event.type === "friction.update").length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "grease-test-"));
}

function runNodeModule(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
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
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`worker exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}
