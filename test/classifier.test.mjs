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
    error: "Direct rg calls are blocked by search-policy",
    arguments: {
      pattern: "^diff --git a/.*(PlanSchema|ExecutePlan|SharePointPlanLoader|SharePointSkillIo|README|compiled-skills|route|dispatcher|manifest|MCP)",
      paths: "C:\\Users\\marcusm\\OneDrive - Microsoft\\patches\\compiled-skills_20260607175756.patch",
      output_mode: "content",
      "-n": true,
      head_limit: 200,
      multiline: false
    },
    decisionContext: {
      recentUserMessages: [{ content: "Find the implementation." }],
      currentToolStart: { toolName: "rg" }
    }
  });

  assert.equal(signal.signal.kind, "policy-block");
  assert.equal(signal.signal.severity, "high");
  assert.deepEqual(signal.signal.tags, ["policy-block", "guardrail"]);
  assert.equal(signal.signal.evidence.guardrailRootCause.category, "direct-search-tool");
  assert.match(signal.signal.evidence.guardrailRootCause.fix, /atrium\.run with tool xray/);
  assert.deepEqual(signal.signal.evidence.guardrailRootCause.approvedReplacement, {
    tool: "xray",
    args: [
      "search",
      "^diff --git a/.*(PlanSchema|ExecutePlan|SharePointPlanLoader|SharePointSkillIo|README|compiled-skills|route|dispatcher|manifest|MCP)",
      "--root",
      "C:\\Users\\marcusm\\OneDrive - Microsoft\\patches",
      "--glob",
      "compiled-skills_20260607175756.patch",
      "--regex",
      "--max",
      "200"
    ]
  });
  assert.match(signal.signal.evidence.decisionContext, /Find the implementation/);
});

test("classifies organization content policy denials as policy guardrails", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "powershell",
    toolCallId: "call-policy",
    error: "Access denied: \"C:\\Users\\marcusm\\repos\\winch\\uatu\" is excluded by organization content policy. Do not attempt to access this file."
  });

  assert.equal(signal.signal.kind, "policy-block");
  assert.equal(signal.signal.source, "local-tool");
  assert.deepEqual(signal.signal.tags, ["policy-block", "guardrail", "local-tool"]);
  assert.equal(signal.signal.evidence.guardrailRootCause.category, "shell-in-excluded-path");
  assert.equal(signal.signal.evidence.guardrailRootCause.workingDirectory, undefined);
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

test("diagnoses exact edit misses", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "edit",
    error: { message: "No match found", code: "failure" },
    arguments: {
      old_str: "stale content",
      new_str: "new content"
    }
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "exact-edit-miss");
  assert.equal(signal.signal.evidence.failureDiagnosis.oldStringLength, 13);
  assert.match(signal.signal.evidence.failureDiagnosis.fix, /Read the current target region/);
});

test("diagnoses missing view paths", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "view",
    error: { message: "Path does not exist", code: "failure" },
    arguments: {
      path: "C:\\Users\\marcusm\\repos\\winch\\tests\\Missing.cs"
    }
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "missing-path");
  assert.equal(signal.signal.evidence.failureDiagnosis.path, "C:\\Users\\marcusm\\repos\\winch\\tests\\Missing.cs");
});

test("diagnoses create calls with missing parent directories", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "create",
    error: { message: "Parent directory does not exist", code: "failure" },
    arguments: {
      path: "C:\\Users\\marcusm\\repos\\kb\\02-Areas\\JanuaryRiver\\Business-Admin\\_index.md"
    }
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "missing-parent-directory");
  assert.equal(signal.signal.evidence.failureDiagnosis.parentDirectory, "C:\\Users\\marcusm\\repos\\kb\\02-Areas\\JanuaryRiver\\Business-Admin");
});

test("diagnoses stale apply_patch context", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "apply_patch",
    error: {
      message: "Error: Failed to find expected lines in C:\\Users\\marcusm\\repos\\winch\\src\\Winch.Adapters.Web\\Substrate\\SubstrateTypes.cs:\ninternal sealed record DomResolution(",
      code: "failure"
    },
    arguments: "*** Begin Patch\n*** Update File: C:\\Users\\marcusm\\repos\\winch\\src\\Winch.Adapters.Web\\Substrate\\Cdp\\CdpSubstrate.cs\n@@\n"
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "stale-patch-context");
  assert.equal(signal.signal.evidence.failureDiagnosis.targetPath, "C:\\Users\\marcusm\\repos\\winch\\src\\Winch.Adapters.Web\\Substrate\\Cdp\\CdpSubstrate.cs");
});

test("diagnoses unavailable repository-scoped memory", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "store_memory",
    error: "Unable to store memory: the repository was not found. The repository may not exist, you may not have write access, or repository-scoped memories may not be enabled for this repository.",
    arguments: {
      scope: "repository",
      subject: "bridgewright profiles"
    }
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "repository-memory-unavailable");
  assert.equal(signal.signal.evidence.failureDiagnosis.scope, "repository");
});

test("diagnoses stale agent ids", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "read_agent",
    error: { message: "Agent not found", code: "failure" },
    arguments: {
      agent_id: "shadow-relay-assess"
    }
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "stale-agent-id");
  assert.equal(signal.signal.evidence.failureDiagnosis.agentId, "shadow-relay-assess");
});

test("diagnoses tool schema missing fields", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "task",
    error: { message: "\"description\": Required", code: "failure" },
    arguments: {
      agent_type: "the-shadow",
      name: "shadow-skill-compile"
    }
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "tool-schema-missing-field");
  assert.equal(signal.signal.evidence.failureDiagnosis.missingField, "description");
});

test("diagnoses web_fetch redirects requiring explicit URLs", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "web_fetch",
    error: "WebFetchRedirectError: web_fetch refused to follow redirect 302 from https://onedrive.visualstudio.com/wiki to https://spsprodwus22.vssps.visualstudio.com/_signin?realm=onedrive.visualstudio.com. Re-invoke web_fetch with the final URL so it can be permission-checked and IP-validated.",
    arguments: {
      url: "https://onedrive.visualstudio.com/wiki"
    }
  });

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "redirect-requires-explicit-url");
  assert.equal(signal.signal.evidence.failureDiagnosis.originalUrl, "https://onedrive.visualstudio.com/wiki");
  assert.match(signal.signal.evidence.failureDiagnosis.redirectUrl, /^https:\/\/spsprodwus22\.vssps\.visualstudio\.com\/_signin/);
});

test("diagnoses session store SQL cloud query timeouts", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "session_store_sql",
    error: {
      message: "CloudQueryError: {\"documentation_url\":\"\",\"message\":\"query timed out\"}\n",
      code: "failure"
    },
    arguments: {
      description: "Find session files for architecture doc",
      query: "SELECT session_id, file_path, tool_name, first_seen_at FROM session_files WHERE file_path ILIKE '%MOS3%Architecture%' OR file_path ILIKE '%MOS3 Skills%' ORDER BY first_seen_at DESC LIMIT 30"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(signal.signal.kind, "timeout");
  assert.equal(diagnosis.category, "session-store-query-timeout");
  assert.equal(diagnosis.description, "Find session files for architecture doc");
  assert.equal(diagnosis.queryShape.hasLeadingWildcardIlike, true);
  assert.equal(diagnosis.queryShape.ilikeCount, 2);
  assert.equal(diagnosis.queryShape.hasOr, true);
  assert.equal(diagnosis.queryShape.hasOrderBy, true);
  assert.equal(diagnosis.queryShape.hasLimit, true);
  assert.match(diagnosis.fix, /Narrow the query before text matching/);
});
