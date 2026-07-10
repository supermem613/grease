import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as catalogStore from "../.github/extensions/grease/core/catalog.mjs";
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

test("active projection contains only actionable items and shares generation metadata", async () => {
  const root = await tempRoot();
  try {
    const { openId, triagedId, inProgressId, resolvedId, ignoredId } = await seedActiveProjectionItems(root);
    const paths = pathsForStore(root);
    const catalog = await readCatalog({ root });

    assert.equal(paths.active, path.join(root, "active.json"));
    assert.equal(typeof catalogStore.readActiveCatalog, "function");

    const activeProjection = await catalogStore.readActiveCatalog({ root });
    assert.deepEqual(activeProjection.items.map((item) => item.id).sort(), [openId, triagedId, inProgressId].sort());
    assert.equal(activeProjection.occurrences.length, 4);
    assert.equal(activeProjection.occurrences.filter((occurrence) => occurrence.frictionId === openId).length, 2);
    assert.deepEqual(activeProjection.occurrences.map((occurrence) => occurrence.frictionId).sort(), [openId, openId, triagedId, inProgressId].sort());
    assert.deepEqual(activeProjection.statusCounts, {
      open: 1,
      triaged: 1,
      "in-progress": 1,
      resolved: 1,
      ignored: 1
    });
    assert.equal(activeProjection.version, catalog.version);
    assert.equal(activeProjection.generatedAt, catalog.generatedAt);
    assert.equal(activeProjection.sourceEventLogBytes, (await stat(paths.events)).size);

    assert.ok(activeProjection.items.every((item) => ["open", "triaged", "in-progress"].includes(item.status)));
    assert.ok(!activeProjection.items.some((item) => [resolvedId, ignoredId].includes(item.id)));

    const activeFileText = await readFile(activeProjection.path, "utf8");
    const activeFileProjection = JSON.parse(activeFileText);
    assert.equal(activeFileProjection.version, activeProjection.version);
    assert.equal(activeFileProjection.generatedAt, activeProjection.generatedAt);
    assert.equal(activeFileProjection.sourceEventLogBytes, activeProjection.sourceEventLogBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or stale active projection rebuilds from events", async () => {
  const root = await tempRoot();
  try {
    const { openId, triagedId, inProgressId } = await seedActiveProjectionItems(root);
    const paths = pathsForStore(root);

    assert.equal(typeof catalogStore.readActiveCatalog, "function");
    const initialActive = await catalogStore.readActiveCatalog({ root });
    assert.equal(initialActive.path, path.join(root, "active.json"));

    await rm(initialActive.path, { force: true });

    const afterDelete = await catalogStore.readActiveCatalog({ root });
    assert.deepEqual(afterDelete.items.map((item) => item.id).sort(), [openId, triagedId, inProgressId].sort());

    await writeFile(initialActive.path, JSON.stringify({
      ...afterDelete,
      version: afterDelete.version + 1,
      sourceEventLogBytes: afterDelete.sourceEventLogBytes + 1
    }, null, 2));

    const afterStaleWrite = await catalogStore.readActiveCatalog({ root });
    assert.deepEqual(afterStaleWrite.items.map((item) => item.id).sort(), [openId, triagedId, inProgressId].sort());
    assert.equal(afterStaleWrite.version, afterDelete.version);
    assert.equal(afterStaleWrite.generatedAt, afterDelete.generatedAt);
    assert.equal(afterStaleWrite.sourceEventLogBytes, (await stat(paths.events)).size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function seedActiveProjectionItems(root) {
  const [openSignal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "active-open",
    error: "Open issue"
  }, {
    sessionId: "session-open",
    sessionName: "Open Session",
    workingDirectory: "C:\\repo"
  });
  const [triagedSignal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "active-triaged",
    error: "Triaged issue"
  }, {
    sessionId: "session-triaged",
    sessionName: "Triaged Session",
    workingDirectory: "C:\\repo"
  });
  const [inProgressSignal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "active-in-progress",
    error: "In progress issue"
  }, {
    sessionId: "session-in-progress",
    sessionName: "In Progress Session",
    workingDirectory: "C:\\repo"
  });
  const [resolvedSignal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "active-resolved",
    error: "Resolved issue"
  }, {
    sessionId: "session-resolved",
    sessionName: "Resolved Session",
    workingDirectory: "C:\\repo"
  });
  const [ignoredSignal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "active-ignored",
    error: "Ignored issue"
  }, {
    sessionId: "session-ignored",
    sessionName: "Ignored Session",
    workingDirectory: "C:\\repo"
  });

  await appendEvent(openSignal, { root, now: "2026-06-09T12:00:00.000Z" });
  await appendEvent(openSignal, { root, now: "2026-06-09T12:00:30.000Z" });
  await appendEvent(triagedSignal, { root, now: "2026-06-09T12:01:00.000Z" });
  await appendEvent(inProgressSignal, { root, now: "2026-06-09T12:02:00.000Z" });
  await appendEvent(resolvedSignal, { root, now: "2026-06-09T12:03:00.000Z" });
  await appendEvent(ignoredSignal, { root, now: "2026-06-09T12:04:00.000Z" });

  const open = (await searchCatalog({ query: "active-open" }, { root })).items[0];
  const triaged = (await searchCatalog({ query: "active-triaged" }, { root })).items[0];
  const inProgress = (await searchCatalog({ query: "active-in-progress" }, { root })).items[0];
  const resolved = (await searchCatalog({ query: "active-resolved" }, { root })).items[0];
  const ignored = (await searchCatalog({ query: "active-ignored" }, { root })).items[0];

  await updateFriction(open.id, { status: "open" }, { root, now: "2026-06-09T12:10:00.000Z" });
  await updateFriction(triaged.id, { status: "triaged" }, { root, now: "2026-06-09T12:11:00.000Z" });
  await updateFriction(inProgress.id, { status: "in-progress" }, { root, now: "2026-06-09T12:12:00.000Z" });
  await updateFriction(resolved.id, { status: "resolved" }, { root, now: "2026-06-09T12:13:00.000Z" });
  await updateFriction(ignored.id, { status: "ignored" }, { root, now: "2026-06-09T12:14:00.000Z" });

  return {
    openId: open.id,
    triagedId: triaged.id,
    inProgressId: inProgress.id,
    resolvedId: resolved.id,
    ignoredId: ignored.id
  };
}

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
