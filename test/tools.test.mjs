import test from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

    // grease_update takes a catalog item id; a capture event id does not resolve to one.
    const { items } = await searchCatalog({}, { root });
    const itemId = items[0].id;

    const update = await callTool(tools.get("grease_update"), {
      id: itemId,
      status: "resolved"
    });
    assert.deepEqual(Object.keys(update.data).sort(), ["eventId", "itemCount"]);
    assert.equal(typeof update.data.eventId, "string");
    assert.equal(update.data.itemCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease pr2 bounded projection: grease_get returns reconstructed occurrence evidence at version 7", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    await callTool(tools.get("grease_capture"), {
      title: "PR2 bounded projection",
      summary: "Occurrences reconstructed from the append-only log",
      severity: "medium",
      kind: "tool-failure",
      source: "test",
      evidence: "PR2 evidence"
    });

    const paths = pathsForStore(root);
    const catalogFile = JSON.parse(await readFile(paths.catalog, "utf8"));
    assert.equal(catalogFile.version, 7, "pr2: catalog.json must be version 7");
    assert.equal(catalogFile.occurrences, undefined, "pr2: catalog.json must omit occurrences[]");

    const { items } = await searchCatalog({ query: "PR2 bounded" }, { root });
    assert.equal(items.length, 1);
    const get = await callTool(tools.get("grease_get"), { id: items[0].id });
    assert.equal(get.data.item.id, items[0].id);
    assert.ok(Array.isArray(get.data.occurrences));
    assert.equal(get.data.occurrences.length, 1);
    assert.ok(get.data.item.latestOccurrence, "pr2: item carries latestOccurrence");
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
    await appendEvent({ ...signal, at: "2026-06-10T12:00:00.000Z" }, { root });

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
    await appendEvent({ ...signal, at: "2026-06-09T12:00:00.000Z" }, { root });

    const { items } = await searchCatalog({ query: "status-open" }, { root });
    assert.equal(items.length, 1);
    await updateFriction(items[0].id, { status: "open" }, { root, now: "2026-06-09T12:10:00.000Z" });

    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const paths = pathsForStore(root);
    await writeFile(paths.catalog, "{invalid json", "utf8");

    const result = await callTool(tools.get("grease_status"), {});
    assert.equal(result.ok, true);
    assert.equal(result.command, "grease_status");
    assert.deepEqual(result.data.counts, { total: 1, open: 1, orphanedUpdates: 0 });
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

// The host SDK discards a thrown error's message and reports only "Tool
// execution failed", so a rejected argument has to come back as a returned
// result rather than a throw. This helper reads that result without asserting
// the outcome so the validation tests can inspect a rejection.
async function rawCallTool(tool, args) {
  const result = await tool.handler(args, { sessionId: "session-1", sessionName: "Tool test session" });
  return { result, payload: JSON.parse(result.textResultForLlm) };
}

function problemFor(payload, field) {
  return payload.problems.find((problem) => problem.field === field);
}

test("an injected clock stamps captures and updates without reaching the store layer", async () => {
  // createGreaseTools takes now as a clock function while the store layer takes
  // a timestamp string. Forwarding the function to the store wrote it into
  // event.at, where JSON.stringify dropped it and left the event undated.
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root, now: () => "2026-07-27T06:00:00.000Z" }).map((tool) => [tool.name, tool]));

    const capture = await callTool(tools.get("grease_capture"), {
      title: "Clock seam",
      summary: "An injected clock must stamp the captured event",
      severity: "low",
      kind: "tool-failure",
      source: "test",
      evidence: "Capture through the tool with an injected clock"
    });
    assert.equal(capture.data.itemCount, 1);

    // grease_update takes a catalog item id; a capture event id does not resolve to one.
    const { items } = await searchCatalog({}, { root });
    const itemId = items[0].id;

    await callTool(tools.get("grease_update"), { id: itemId, status: "resolved" });

    const events = (await readFile(pathsForStore(root).events, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.at, "2026-07-27T06:00:00.000Z", "every event carries the injected timestamp");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the store layer refuses a clock function in place of a timestamp", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const [signal] = classifySessionEvent("tool.execution_complete", { success: false, toolName: "clock", error: "Boom" });
    await assert.rejects(
      () => appendEvent(signal, { root, now: () => "2026-07-27T06:00:00.000Z" }),
      /now option must be an ISO timestamp string/,
      "a non-string now is refused rather than written into the event"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capture missing a required field names that field instead of failing opaquely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const { payload } = await rawCallTool(tools.get("grease_capture"), {
      summary: "Every required field except title is supplied",
      severity: "low",
      kind: "tool-failure",
      source: "test",
      evidence: "Omit title on purpose"
    });

    assert.equal(payload.ok, false);
    assert.equal(payload.command, "grease_capture");
    assert.equal(problemFor(payload, "title").problem, "missing");
    assert.match(payload.recovery, /title/, "the recovery text names the field the caller must supply");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capture missing several required fields reports all of them in one response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const { payload } = await rawCallTool(tools.get("grease_capture"), { severity: "low" });

    assert.equal(payload.ok, false);
    assert.deepEqual(
      payload.problems.map((problem) => problem.field).sort(),
      ["evidence", "kind", "source", "summary", "title"],
      "one response lists every missing field so the caller fixes them in a single retry"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capture with a wrong-typed field reports the type it received", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const { payload } = await rawCallTool(tools.get("grease_capture"), {
      title: 42,
      summary: "Title is a number",
      severity: "low",
      kind: "tool-failure",
      source: "test",
      evidence: "Send a number where a string belongs"
    });

    assert.equal(payload.ok, false);
    const problem = problemFor(payload, "title");
    assert.equal(problem.problem, "wrong type");
    assert.equal(problem.received, "number");
    assert.equal(problem.expected, "a non-empty string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capture with an out-of-enum severity lists the accepted values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const { payload } = await rawCallTool(tools.get("grease_capture"), {
      title: "Severity out of range",
      summary: "Severity is not one of the accepted values",
      severity: "urgent",
      kind: "tool-failure",
      source: "test",
      evidence: "Send an unsupported severity"
    });

    assert.equal(payload.ok, false);
    const problem = problemFor(payload, "severity");
    assert.equal(problem.problem, "not an accepted value");
    assert.equal(problem.received, "urgent");
    assert.deepEqual(problem.accepted, ["low", "medium", "high", "critical"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected capture writes no event, so a validation mistake leaves no catalog entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    await rawCallTool(tools.get("grease_capture"), { severity: "low" });

    const { items } = await searchCatalog({}, { root });
    assert.equal(items.length, 0, "a rejected call leaves the catalog untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease_get without an id names the missing field rather than failing opaquely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const { payload } = await rawCallTool(tools.get("grease_get"), {});

    assert.equal(payload.ok, false);
    assert.equal(problemFor(payload, "id").problem, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease_update with neither id nor ids says which arguments satisfy the call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const { payload } = await rawCallTool(tools.get("grease_update"), { status: "resolved" });

    assert.equal(payload.ok, false);
    const problem = problemFor(payload, "id");
    assert.equal(problem.problem, "missing");
    assert.match(problem.expected, /ids/, "the caller is told the bulk alternative exists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease_update with an out-of-enum status lists the accepted values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const { payload } = await rawCallTool(tools.get("grease_update"), { id: "abc", status: "done" });

    assert.equal(payload.ok, false);
    const problem = problemFor(payload, "status");
    assert.equal(problem.problem, "not an accepted value");
    assert.deepEqual(problem.accepted, ["open", "triaged", "in-progress", "resolved", "ignored"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("grease_search pages through the full result set and reports how far along it is", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    for (const token of ["alpha", "bravo", "charlie"]) {
      const captured = await callTool(tools.get("grease_capture"), {
        title: `Paging fixture ${token}`,
        summary: `A distinct friction named ${token}.`,
        severity: "low",
        kind: "tool-error",
        source: "paging-test",
        evidence: `Fixture ${token}.`
      });
      assert.equal(captured.ok, true);
    }

    const first = await callTool(tools.get("grease_search"), { query: "paging fixture", limit: 2, offset: 0 });
    const second = await callTool(tools.get("grease_search"), { query: "paging fixture", limit: 2, offset: 2 });

    assert.equal(first.data.total, 3);
    assert.equal(first.data.offset, 0);
    assert.equal(first.data.items.length, 2);
    assert.equal(first.data.hasMore, true);
    assert.equal(second.data.offset, 2);
    assert.equal(second.data.items.length, 1);
    assert.equal(second.data.hasMore, false);

    const seen = new Set([...first.data.items, ...second.data.items].map((item) => item.id));
    assert.equal(seen.size, 3, "the two pages together cover every match exactly once");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease_search rejects a wrong-typed offset instead of silently ignoring it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const result = await rawCallTool(tools.get("grease_search"), { offset: "100" });

    assert.equal(result.payload.ok, false);
    assert.equal(problemFor(result.payload, "offset").problem, "wrong type");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});