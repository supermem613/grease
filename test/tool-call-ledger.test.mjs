import test from "node:test";
import assert from "node:assert/strict";
import { createToolCallLedger } from "../.github/extensions/grease/core/tool-call-ledger.mjs";

test("enriches generic timeout completions with start event details", () => {
  const ledger = createToolCallLedger();
  ledger.rememberUserMessage({
    content: "Search the repo for the timeout handler.",
    timestamp: "2026-06-10T14:34:15.000Z"
  }, {
    sessionId: "session-1",
    sessionName: "Improve grease"
  });
  ledger.rememberStart({
    toolCallId: "call-1",
    toolName: "atrium-run",
    arguments: { tool: "xray", args: ["search", "timeout"] },
    timestamp: "2026-06-10T14:34:16.000Z",
    workingDirectory: "C:\\repos\\grease"
  }, {
    sessionId: "session-1",
    sessionName: "Improve grease"
  });

  const enriched = ledger.enrich({
    toolCallId: "call-1",
    toolName: "tool",
    success: false,
    error: { message: "timeout", code: "failure" },
    timestamp: "2026-06-10T14:34:17.250Z"
  });

  assert.equal(enriched.toolName, "atrium-run");
  assert.equal(enriched.sessionId, "session-1");
  assert.equal(enriched.sessionName, "Improve grease");
  assert.equal(enriched.workingDirectory, "C:\\repos\\grease");
  assert.equal(enriched.startedAt, "2026-06-10T14:34:16.000Z");
  assert.equal(enriched.completedAt, "2026-06-10T14:34:17.250Z");
  assert.equal(enriched.durationMs, 1250);
  assert.deepEqual(enriched.arguments, { tool: "xray", args: ["search", "timeout"] });
  assert.deepEqual(enriched.decisionContext.recentUserMessages, [{
    at: "2026-06-10T14:34:15.000Z",
    sessionId: "session-1",
    sessionName: "Improve grease",
    turnId: undefined,
    interactionId: undefined,
    content: "Search the repo for the timeout handler."
  }]);
  assert.equal(enriched.decisionContext.currentToolStart.toolName, "atrium-run");
});

test("enriches blocked tools with previous tool attempts from the same session", () => {
  const ledger = createToolCallLedger();
  ledger.rememberStart({
    toolCallId: "call-1",
    toolName: "view",
    arguments: { path: "C:\\repos\\grease\\README.md" },
    timestamp: "2026-06-10T14:34:16.000Z"
  }, {
    sessionId: "session-1"
  });
  ledger.rememberStart({
    toolCallId: "call-2",
    toolName: "grep",
    arguments: { pattern: "blocked" },
    timestamp: "2026-06-10T14:34:17.000Z"
  }, {
    sessionId: "session-1"
  });

  const enriched = ledger.enrich({
    toolCallId: "call-2",
    toolName: "grep",
    success: false,
    error: "Direct grep calls are blocked by search-policy",
    timestamp: "2026-06-10T14:34:18.000Z"
  });

  assert.equal(enriched.decisionContext.currentToolStart.toolName, "grep");
  assert.deepEqual(enriched.decisionContext.previousToolStarts.map((entry) => entry.toolName), ["view"]);
});

test("leaves completions unchanged when no start event exists", () => {
  const ledger = createToolCallLedger();
  const completion = {
    toolCallId: "missing",
    toolName: "tool",
    success: false,
    error: "timeout"
  };

  assert.equal(ledger.enrich(completion), completion);
});
