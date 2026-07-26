import test from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGreaseTools } from "../.github/extensions/grease/core/tools.mjs";
import { appendEvent, pathsForStore, searchCatalog, updateFriction } from "../.github/extensions/grease/core/catalog.mjs";
import { classifySessionEvent } from "../.github/extensions/grease/core/classifier.mjs";

test("grease pr1 decouple capture: grease_capture and grease_update preserve eventId and itemCount", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));

    const capture = await callTool(tools.get("grease_capture"), {
      title: "Tool output shape regression",
      summary: "The capture tool should report eventId and itemCount in its output",
      severity: "medium",
      kind: "tool-output",
      source: "test",
      evidence: "Call the capture and update tools and inspect the returned payload"
    });
    assert.deepEqual(Object.keys(capture.data).sort(), ["eventId", "itemCount"]);
    assert.equal(typeof capture.data.eventId, "string");
    assert.equal(capture.data.itemCount, 1);

    const update = await callTool(tools.get("grease_update"), {
      id: capture.data.eventId,
      status: "resolved"
    });
    assert.deepEqual(Object.keys(update.data).sort(), ["eventId", "itemCount"]);
    assert.equal(typeof update.data.eventId, "string");
    assert.equal(update.data.itemCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture tool tells agents when and how to record operational friction", () => {
  const capture = createGreaseTools().find((tool) => tool.name === "grease_capture");

  assert.match(capture.description, /whenever you encounter operational friction/i);
  assert.match(capture.description, /without waiting for the user/i);
  assert.match(capture.parameters.properties.summary.description, /attempted/i);
  assert.match(capture.parameters.properties.summary.description, /expected/i);
  assert.match(capture.parameters.properties.summary.description, /actual/i);
  assert.match(capture.parameters.properties.summary.description, /impact/i);
  assert.match(capture.parameters.properties.evidence.description, /reproduce/i);
  assert.match(capture.parameters.properties.evidence.description, /secret/i);
  assert.deepEqual(capture.parameters.required, [
    "title",
    "summary",
    "severity",
    "kind",
    "source",
    "evidence"
  ]);
  assert.equal(capture.parameters.properties.evidence.type, "string");
});

test("tools capture, search, and brief", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const capture = await callTool(tools.get("grease_capture"), {
      title: "Atrium access denied",
      summary: "atrium.run returned access denied while calling xray",
      severity: "high",
      kind: "access-denied",
      source: "mcp",
      tags: ["atrium", "mcp"],
      evidence: "Call atrium.run with tool xray. It returns access denied."
    });
    assert.equal(capture.ok, true);

    const search = await callTool(tools.get("grease_search"), {
      query: "atrium"
    });
    assert.equal(search.data.items.length, 1);
    assert.deepEqual(search.data.items[0].sessionNames, ["Tool test session"]);
    assert.ok(search.data.items[0].machineNames.length > 0);

    const brief = await callTool(tools.get("grease_brief"), {
      ids: [search.data.items[0].id]
    });
    assert.match(brief.data.prompt, /Atrium access denied/);
    assert.match(brief.data.prompt, /origins: .*Tool test session/);
    assert.match(brief.data.prompt, /Root cause/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease brief surfaces extension-name-resolution guidance for extensions_manage inspect failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const error = {
      message: 'Extension "project:backlog" not found. Available extensions: user:backlog, user:grease, user:uhura',
      arguments: {
        operation: "inspect",
        name: "project:backlog"
      }
    };
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "extensions_manage",
      error,
      arguments: error.arguments
    }, {
      sessionId: "session-extension-name",
      sessionName: "Extension name session",
      workingDirectory: "C:\\repo"
    });
    await appendEvent(signal, { root, now: "2026-06-10T12:00:00.000Z" });

    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const search = await callTool(tools.get("grease_search"), {
      query: "project:backlog"
    });
    assert.equal(search.data.items.length, 1);

    const brief = await callTool(tools.get("grease_brief"), {
      ids: [search.data.items[0].id]
    });
    assert.match(brief.data.prompt, /extension-name resolution/i);
    assert.match(brief.data.prompt, /requested extension name/i);
    assert.match(brief.data.prompt, /project:backlog/i);
    assert.match(brief.data.prompt, /suggested extension IDs/i);
    assert.match(brief.data.prompt, /user:backlog/i);
    assert.match(brief.data.prompt, /reload the extension host or install the extension with the fully qualified extension ID/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease status tool preserves its public result shape from the active summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "status-open",
      error: "Open issue"
    }, {
      sessionId: "session-status",
      sessionName: "Status Session",
      workingDirectory: "C:\\repo"
    });
    await appendEvent(signal, { root, now: "2026-06-09T12:00:00.000Z" });

    const { items } = await searchCatalog({ query: "status-open" }, { root });
    assert.equal(items.length, 1);
    await updateFriction(items[0].id, { status: "open" }, { root, now: "2026-06-09T12:10:00.000Z" });

    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const paths = pathsForStore(root);
    await writeFile(paths.catalog, "{invalid json", "utf8");

    const result = await callTool(tools.get("grease_status"), {});
    assert.equal(result.ok, true);
    assert.equal(result.command, "grease_status");
    assert.deepEqual(result.data.counts, { total: 1, open: 1 });
    assert.deepEqual(result.data.paths, pathsForStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease_get returns typed not-found guidance for stale ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    await callTool(tools.get("grease_capture"), {
      title: "Known issue",
      summary: "Known issue summary",
      severity: "medium",
      kind: "tool-failure",
      source: "test",
      evidence: "Known issue evidence"
    });

    const result = await callTool(tools.get("grease_get"), {
      id: "0fe2c31529871869"
    });

    assert.equal(result.ok, true);
    assert.equal(result.command, "grease_get");
    assert.equal(result.data.notFound, true);
    assert.equal(result.data.id, "0fe2c31529871869");
    assert.match(result.data.recovery, /grease_search/i);
    assert.ok(Array.isArray(result.data.nearestMatches));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function callTool(tool, args) {
  const result = await tool.handler(args, { sessionId: "session-1", sessionName: "Tool test session" });
  assert.equal(result.resultType, "success");
  return JSON.parse(result.textResultForLlm);
}
