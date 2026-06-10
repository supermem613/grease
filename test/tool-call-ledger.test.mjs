import test from "node:test";
import assert from "node:assert/strict";
import { createToolCallLedger } from "../.github/extensions/grease/core/tool-call-ledger.mjs";

test("enriches generic timeout completions with start event details", () => {
  const ledger = createToolCallLedger();
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
