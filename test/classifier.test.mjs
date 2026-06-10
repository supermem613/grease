import test from "node:test";
import assert from "node:assert/strict";
import { classifySessionEvent } from "../.github/extensions/grease/core/classifier.mjs";

test("classifies local tool access denied as high severity friction", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "powershell",
    toolCallId: "call-1",
    error: "Access is denied while opening C:\\secret"
  }, {
    sessionId: "session-1",
    workingDirectory: "C:\\work"
  });

  assert.equal(signal.signal.kind, "access-denied");
  assert.equal(signal.signal.source, "local-tool");
  assert.equal(signal.signal.severity, "high");
  assert.deepEqual(signal.signal.tags, ["access-denied", "local-tool"]);
});

test("classifies Atrium MCP timeouts as high severity friction", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "atrium.run",
    toolCallId: "call-2",
    arguments: { tool: "xray", args: ["search", "thing"] },
    error: "operation timed out waiting for MCP response"
  }, {
    sessionId: "session-1"
  });

  assert.equal(signal.signal.kind, "timeout");
  assert.equal(signal.signal.source, "mcp");
  assert.equal(signal.signal.severity, "high");
  assert.equal(signal.signal.evidence.toolName, "atrium.run");
});

test("preserves enriched tool-start context on timeout friction", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "atrium.run",
    toolCallId: "call-2",
    arguments: { tool: "xray", args: ["search", "thing"] },
    error: { message: "timeout", code: "failure" },
    startedAt: "2026-06-10T14:34:16.000Z",
    completedAt: "2026-06-10T14:34:17.250Z",
    durationMs: 1250,
    sessionId: "session-1",
    sessionName: "Fix timeout",
    workingDirectory: "C:\\repos\\grease"
  });

  assert.equal(signal.sessionId, "session-1");
  assert.equal(signal.sessionName, "Fix timeout");
  assert.equal(signal.workingDirectory, "C:\\repos\\grease");
  assert.equal(signal.signal.kind, "timeout");
  assert.equal(signal.signal.source, "mcp");
  assert.equal(signal.signal.evidence.toolName, "atrium.run");
  assert.equal(signal.signal.evidence.startedAt, "2026-06-10T14:34:16.000Z");
  assert.equal(signal.signal.evidence.completedAt, "2026-06-10T14:34:17.250Z");
  assert.equal(signal.signal.evidence.durationMs, 1250);
  assert.ok(signal.signal.evidence.availableFields.includes("durationMs"));
  assert.match(signal.signal.evidence.arguments, /"xray"/);
  assert.match(signal.signal.evidence.rawEvent, /"workingDirectory"/);
});

test("classifies search-policy blocks before generic access denial", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "rg",
    toolCallId: "call-3",
    error: "Direct rg calls are blocked by search-policy"
  });

  assert.equal(signal.signal.kind, "policy-block");
  assert.equal(signal.signal.severity, "high");
});

test("does not classify argument paths as policy blocks", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "view",
    toolCallId: "call-4",
    error: "Path does not exist",
    arguments: {
      path: "C:\\Users\\agent\\.copilot\\extensions\\search-policy\\README.md",
      view_range: [1, 220]
    }
  });

  assert.equal(signal.signal.kind, "tool-error");
  assert.equal(signal.signal.severity, "medium");
  assert.match(signal.signal.summary, /search-policy/);
});

test("ignores successful tool completions", () => {
  const signals = classifySessionEvent("tool.execution_complete", {
    success: true,
    toolName: "powershell",
    result: "ok"
  });

  assert.deepEqual(signals, []);
});

test("ignores empty session error payloads", () => {
  const signals = classifySessionEvent("session.error", {}, {
    sessionId: "session-1",
    workingDirectory: "C:\\repos\\winch"
  });

  assert.deepEqual(signals, []);
});

test("captures actionable session error payloads", () => {
  const [signal] = classifySessionEvent("session.error", {
    message: "Session crashed while loading project context"
  }, {
    sessionId: "session-1",
    workingDirectory: "C:\\repos\\winch"
  });

  assert.equal(signal.signal.kind, "session-error");
  assert.equal(signal.signal.source, "session");
  assert.equal(signal.signal.summary, "Session crashed while loading project context");
});

test("ignores injected skill context when checking user corrections", () => {
  const signals = classifySessionEvent("user.message", {
    content: `<skill-context name="eidos">
Do not mix PORs and traces. Don't add fallbacks for atrium.
</skill-context>`
  }, {
    sessionId: "session-1"
  });

  assert.deepEqual(signals, []);
});

test("captures actual user correction messages", () => {
  const [signal] = classifySessionEvent("user.message", {
    content: "No, do not add fallbacks for atrium."
  }, {
    sessionId: "session-1"
  });

  assert.equal(signal.signal.kind, "correction");
  assert.equal(signal.signal.source, "user");
  assert.equal(signal.signal.summary, "No, do not add fallbacks for atrium.");
});
