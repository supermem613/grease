import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

    assert.equal(typeof catalogStore.readActiveCatalog, "function");

    const activeProjection = await catalogStore.readActiveCatalog({ root });
    assert.equal(activeProjection.path, path.join(root, "active.json"));
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

    const staleActiveProjection = {
      ...afterDelete,
      generatedAt: "stale-generated-at",
      generationId: "stale-generation-id",
      items: [{ id: "wrong-item", status: "open" }],
      occurrences: [],
      statusCounts: {
        open: 1,
        triaged: 0,
        "in-progress": 0,
        resolved: 0,
        ignored: 0
      }
    };
    await writeFile(initialActive.path, JSON.stringify(staleActiveProjection, null, 2));

    const afterStaleWrite = await catalogStore.readActiveCatalog({ root });
    const catalog = await readCatalog({ root });
    assert.deepEqual(afterStaleWrite.items.map((item) => item.id).sort(), [openId, triagedId, inProgressId].sort());
    assert.equal(afterStaleWrite.version, catalog.version);
    assert.equal(afterStaleWrite.generatedAt, catalog.generatedAt);
    assert.equal(afterStaleWrite.sourceEventLogBytes, (await stat(paths.events)).size);
    assert.notEqual(afterStaleWrite.generationId, staleActiveProjection.generationId);
    assert.equal(afterStaleWrite.generationId, catalog.generationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-size event log rewrite rebuilds active projection with updated metadata", async () => {
  const root = await tempRoot();
  try {
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "same-size-rewrite",
      error: "Original signal content"
    }, {
      sessionId: "session-rewrite",
      sessionName: "Rewrite Session",
      workingDirectory: "C:\\repo"
    });
    await appendEvent(signal, { root, now: "2026-06-09T12:00:00.000Z" });

    const initialActive = await catalogStore.readActiveCatalog({ root });
    const paths = pathsForStore(root);
    const originalLine = (await readFile(paths.events, "utf8")).trim();
    const originalEvent = JSON.parse(originalLine);
    const originalTitle = String(originalEvent.signal?.title ?? "");
    const originalSummary = String(originalEvent.signal?.summary ?? "");
    const replacementTitle = `fresh-${"x".repeat(Math.max(0, originalTitle.length - 5))}`.slice(0, originalTitle.length);
    const replacementSummary = `fresh-${"x".repeat(Math.max(0, originalSummary.length - 5))}`.slice(0, originalSummary.length);
    const replacementLine = JSON.stringify({
      ...originalEvent,
      signal: {
        ...originalEvent.signal,
        title: replacementTitle,
        summary: replacementSummary
      }
    });

    assert.equal(Buffer.byteLength(replacementLine, "utf8"), Buffer.byteLength(originalLine, "utf8"));
    await writeFile(paths.events, `${replacementLine}\n`, "utf8");
    await utimes(paths.events, new Date("2026-06-10T00:00:00.000Z"), new Date("2026-06-10T00:00:00.000Z"));

    const rebuiltActive = await catalogStore.readActiveCatalog({ root });
    const currentStats = await stat(paths.events);

    assert.equal(rebuiltActive.items[0].title, replacementTitle);
    assert.equal(rebuiltActive.items[0].latestSummary, replacementSummary);
    assert.notEqual(rebuiltActive.generationId, initialActive.generationId);
    assert.equal(rebuiltActive.sourceEventLogBytes, currentStats.size);
    assert.equal(rebuiltActive.sourceEventLogMtimeMs, currentStats.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent stale active reads reuse the first rebuild", async () => {
  const root = await tempRoot();
  try {
    await seedActiveProjectionItems(root);
    const paths = pathsForStore(root);
    const activePath = path.join(root, "active.json");
    await rm(activePath, { force: true });

    const results = await Promise.all(Array.from({ length: 4 }, () => catalogStore.readActiveCatalog({ root })));
    assert.equal(results.length, 4);
    const expectedItems = results[0].items.map((item) => item.id).sort();
    const currentStats = await stat(paths.events);
    for (const result of results) {
      assert.deepEqual(result.items.map((item) => item.id).sort(), expectedItems);
      assert.equal(result.generationId, results[0].generationId);
      assert.equal(result.generatedAt, results[0].generatedAt);
      assert.equal(result.sourceEventLogBytes, currentStats.size);
      assert.equal(result.sourceEventLogMtimeMs, currentStats.mtimeMs);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient tail parse errors wait for a locked repair before returning the projection", async () => {
  const root = await tempRoot();
  try {
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "transient-tail",
      error: "Tail parse repair"
    }, {
      sessionId: "session-tail",
      sessionName: "Tail Session",
      workingDirectory: "C:\\repo"
    });

    await appendEvent(signal, { root, now: "2026-06-09T12:00:00.000Z" });
    await catalogStore.readActiveCatalog({ root });

    const paths = pathsForStore(root);
    const incompleteTail = '{"type":"friction.signal","id":"transient-tail","at":"2026-06-09T12:00:01.000Z","machineName":"devbox-1","signal":{"kind":"tool","source":"test","title":"pending","summary":"before repair"';
    await writeFile(paths.events, `${incompleteTail}\n`, "utf8");

    const lockPath = path.join(root, "catalog.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, id: "lock-fixture", acquiredAt: new Date().toISOString() }, null, 2)}\n`, "utf8");

    const readPromise = catalogStore.readActiveCatalog({ root });
    await new Promise((resolve) => setImmediate(resolve));

    const completedTail = JSON.stringify({
      ...signal,
      id: "transient-tail",
      at: "2026-06-09T12:00:01.000Z",
      machineName: "devbox-1",
      signal: {
        ...signal.signal,
        title: "repaired",
        summary: "after repair"
      }
    });
    await writeFile(paths.events, `${completedTail}\n`, "utf8");
    await rm(lockPath, { recursive: true, force: true });

    const repairedProjection = await readPromise;
    const catalog = await readCatalog({ root });
    assert.equal(repairedProjection.items.some((item) => item.title === "repaired"), true);
    assert.equal(repairedProjection.generationId, catalog.generationId);
    assert.equal(repairedProjection.sourceEventLogBytes, (await stat(paths.events)).size);
    assert.equal(repairedProjection.sourceEventLogMtimeMs, (await stat(paths.events)).mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active status searches use the active projection without changing all-status semantics", async () => {
  const root = await tempRoot();
  try {
    const { openId, resolvedId } = await seedActiveProjectionItems(root);
    const paths = pathsForStore(root);
    const validCatalogText = await readFile(paths.catalog, "utf8");

    await writeFile(paths.catalog, "{invalid json", "utf8");

    const activeSearch = await searchCatalog({ query: "active-open", status: "open" }, { root });
    assert.equal(activeSearch.items.length, 1);
    assert.equal(activeSearch.items[0].id, openId);

    const activeGet = await catalogStore.getFriction(openId, { root });
    assert.equal(activeGet.item.id, openId);
    assert.equal(activeGet.item.status, "open");
    assert.equal(activeGet.occurrences.length, 2);

    await writeFile(paths.catalog, validCatalogText, "utf8");

    const noStatusSearch = await searchCatalog({ query: "active-" }, { root });
    assert.ok(noStatusSearch.items.some((item) => item.id === openId));
    assert.ok(noStatusSearch.items.some((item) => item.id === resolvedId));

    const resolvedSearch = await searchCatalog({ query: "active-resolved", status: "resolved" }, { root });
    assert.equal(resolvedSearch.items.length, 1);
    assert.equal(resolvedSearch.items[0].id, resolvedId);

    const resolvedGet = await catalogStore.getFriction(resolvedId, { root });
    assert.equal(resolvedGet.item.id, resolvedId);
    assert.equal(resolvedGet.occurrences.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog summary preserves status output without loading the full catalog", async () => {
  const root = await tempRoot();
  try {
    await seedActiveProjectionItems(root);
    const paths = pathsForStore(root);

    await writeFile(paths.catalog, "{invalid json", "utf8");

    const summary = await catalogStore.readCatalogSummary({ root });
    assert.deepEqual(summary.counts, { total: 5, open: 1 });
    assert.deepEqual(summary.paths, pathsForStore(root));
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
