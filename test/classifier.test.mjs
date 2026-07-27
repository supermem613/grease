import test from "node:test";
import assert from "node:assert/strict";
import { classifySessionEvent } from "../.github/extensions/grease/core/classifier.mjs";

function recoveryText(diagnosis) {
  if (typeof diagnosis.recovery === "string") {
    return diagnosis.recovery;
  }
  const candidates = [];
  if (diagnosis.recovery?.text) {
    candidates.push(diagnosis.recovery.text);
  }
  if (Array.isArray(diagnosis.recovery?.steps)) {
    candidates.push(...diagnosis.recovery.steps);
  }
  return candidates.join("\n");
}

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

test("diagnoses extensions_manage inspect failures with extension-name resolution guardrails", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "extensions_manage",
    toolCallId: "call-extensions-name",
    error: {
      message: "Extension \"project:backlog\" not found. Available extensions: user:backlog, user:grease, user:uhura",
      code: "failure"
    },
    arguments: {
      operation: "inspect",
      name: "project:backlog"
    }
  });

  assert.equal(signal.signal.kind, "policy-block");
  assert.equal(signal.signal.source, "local-tool");
  assert.deepEqual(signal.signal.tags, ["policy-block", "guardrail", "local-tool"]);

  const rootCause = signal.signal.evidence.guardrailRootCause;
  assert.equal(rootCause.category, "extension-name-resolution");
  assert.equal(rootCause.requestedName, "project:backlog");
  assert.equal(rootCause.operation, "inspect");
  assert.deepEqual(rootCause.availableExtensions, ["user:backlog", "user:grease", "user:uhura"]);
  assert.deepEqual(rootCause.suggestedExtensions, ["user:backlog", "user:grease", "user:uhura"]);
  assert.match(rootCause.fix, /(fully qualified extension IDs|reload|install)/i);
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

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "stale-preimage-editing");
  assert.equal(signal.signal.evidence.failureDiagnosis.oldStringLength, 13);
  assert.match(recoveryText(signal.signal.evidence.failureDiagnosis), /current target region/);
});

test("diagnoses stale edit preimages with fresh-read recovery", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "edit",
    error: { message: "No match found", code: "failure" },
    arguments: {
      path: "C:\\Users\\marcusm\\repos\\grease\\.github\\extensions\\grease\\core\\classifier.mjs",
      old_str: "stale content",
      new_str: "new content"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "stale-preimage-editing");
  assert.equal(diagnosis.path, "C:\\Users\\marcusm\\repos\\grease\\.github\\extensions\\grease\\core\\classifier.mjs");
  assert.match(diagnosis.reason, /stale|preimage/i);
  assert.match(recoveryText(diagnosis), /fresh read|current target|reread/i);
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

test("diagnoses stale known-path reads with discovery-first recovery", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "view",
    error: { message: "Path does not exist", code: "failure" },
    arguments: {
      path: "C:\\Users\\marcusm\\.sd\\sidequests\\sd-schema-upgrade-system\\src\\merge\\chunks.ts"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "known-path-read-preflight");
  assert.equal(diagnosis.path, "C:\\Users\\marcusm\\.sd\\sidequests\\sd-schema-upgrade-system\\src\\merge\\chunks.ts");
  assert.match(diagnosis.reason, /stale|unproven/i);

  const recoveryCandidates = [];
  if (typeof diagnosis.recovery === "string") {
    recoveryCandidates.push(diagnosis.recovery);
  } else {
    if (diagnosis.recovery?.text) {
      recoveryCandidates.push(diagnosis.recovery.text);
    }
    if (Array.isArray(diagnosis.recovery?.steps)) {
      recoveryCandidates.push(...diagnosis.recovery.steps);
    }
  }
  const recoveryText = recoveryCandidates.join("\n");
  assert.match(recoveryText, /re-derive|discovery/i);
});

test("routes proven file-backed output paths to atrium-read", () => {
  const path = "C:\\Users\\marcusm\\AppData\\Local\\Temp\\atrium\\reads\\abc\\content.txt";
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "view",
    error: { message: "Path does not exist", code: "failure" },
    arguments: {
      path
    },
    decisionContext: {
      previousToolStarts: [{
        toolName: "atrium.run",
        result: {
          file: path
        }
      }]
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "known-path-read-preflight");

  const recoveryCandidates = [];
  if (typeof diagnosis.recovery === "string") {
    recoveryCandidates.push(diagnosis.recovery);
  } else {
    if (diagnosis.recovery?.text) {
      recoveryCandidates.push(diagnosis.recovery.text);
    }
    if (Array.isArray(diagnosis.recovery?.steps)) {
      recoveryCandidates.push(...diagnosis.recovery.steps);
    }
  }
  const recoveryText = recoveryCandidates.join("\n");
  assert.match(recoveryText, /atrium-read/i);
  assert.match(recoveryText, /startLine|count|endLine|bounded/i);
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

  assert.equal(signal.signal.evidence.failureDiagnosis.category, "stale-preimage-editing");
  assert.equal(signal.signal.evidence.failureDiagnosis.targetPath, "C:\\Users\\marcusm\\repos\\winch\\src\\Winch.Adapters.Web\\Substrate\\Cdp\\CdpSubstrate.cs");
});

test("diagnoses stale apply_patch preimages with hunk rebuild recovery", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "apply_patch",
    error: {
      message: "Error: Failed to find expected lines in C:\\Users\\marcusm\\repos\\winch\\src\\Winch.Adapters.Web\\Substrate\\SubstrateTypes.cs:\ninternal sealed record DomResolution(",
      code: "failure"
    },
    arguments: "*** Begin Patch\n*** Update File: C:\\Users\\marcusm\\repos\\winch\\src\\Winch.Adapters.Web\\Substrate\\Cdp\\CdpSubstrate.cs\n@@\n"
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "stale-preimage-editing");
  assert.equal(diagnosis.targetPath, "C:\\Users\\marcusm\\repos\\winch\\src\\Winch.Adapters.Web\\Substrate\\Cdp\\CdpSubstrate.cs");
  assert.match(recoveryText(diagnosis), /fresh read|rebuild|hunk/i);
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
  assert.match(recoveryText(signal.signal.evidence.failureDiagnosis), /fresh background agent/i);
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

test("diagnoses near-miss tool names", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "atrium_grep-code",
    error: { message: "Tool 'atrium_grep-code' does not exist.", code: "failure" },
    arguments: {
      root: "C:\\Users\\marcusm\\repos\\backlog",
      query: "burndown"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "tool-name-alias");
  assert.equal(diagnosis.requestedTool, "atrium_grep-code");
  assert.equal(diagnosis.suggestedTool, "atrium-grep-code");
});

test("diagnoses missing skills with refresh guidance", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "skill",
    error: "Skill not found: looper",
    arguments: {
      skill: "looper"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "skill-not-found");
  assert.equal(diagnosis.skill, "looper");
  assert.match(recoveryText(diagnosis), /reload/i);
});

test("diagnoses ask_user schemas missing requested field types", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "ask_user",
    error: {
      message: '"requestedSchema.properties.choice": Invalid input: expected type',
      code: "failure"
    },
    arguments: {
      question: "Pick one",
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            oneOf: [{ const: "a", title: "A" }]
          }
        }
      }
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "ask-user-schema-missing-type");
  assert.equal(diagnosis.fieldPath, "requestedSchema.properties.choice");
});

test("diagnoses broad search roots after access denied", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "atrium-find-files",
    error: "FILES_FAILED: rg: .\\Microsoft Policy Platform\\authorityDb: Access is denied. (os error 5)",
    arguments: {
      root: "C:\\Users\\marcusm",
      glob: "**/*"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "broad-search-root");
  assert.equal(diagnosis.root, "C:\\Users\\marcusm");
  assert.match(recoveryText(diagnosis), /narrower root/i);
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

test("diagnoses web_fetch redirects with bounded-length retry guidance", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "web_fetch",
    error: "WebFetchRedirectError: web_fetch refused to follow redirect 301 from https://t.co/v694m8Eaj6 to https://x.com/i/article/2074204645845839872.",
    arguments: {
      url: "https://t.co/v694m8Eaj6",
      max_length: 20000,
      raw: false
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(diagnosis.category, "redirect-requires-explicit-url");
  assert.equal(diagnosis.originalUrl, "https://t.co/v694m8Eaj6");
  assert.equal(diagnosis.redirectUrl, "https://x.com/i/article/2074204645845839872");
  assert.equal(diagnosis.requestedMaxLength, 20000);
  assert.equal(diagnosis.recommendedMaxLength, 5000);

  const recovery = recoveryText(diagnosis);
  assert.match(recovery, /retry once/i);
  assert.match(recovery, /final URL/i);
  assert.match(recovery, /bounded length/i);
  assert.match(recovery, /shortened URL/i);
  assert.match(recovery, /max_length 20000/i);
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
  assert.match(diagnosis.planning.suggestedQueries.join("\n"), /session_files/);
  assert.match(diagnosis.planning.suggestedQueries.join("\n"), /file_path/);
});

test("diagnoses session store SQL timeout planning guidance", () => {
  const cases = [
    {
      description: "Find turns with architecture references",
      query: "SELECT id, session_id, message, created_at FROM turns WHERE message ILIKE '%architecture%' ORDER BY created_at DESC LIMIT 50",
      expectedPlanningHint: /first identify candidate session_id values before scanning message text/i,
      expectedSuggestedQuery: /turns[\s\S]*%architecture%/,
      expectedFix: /Narrow the query before text matching/
    },
    {
      description: "Find recent sessions for architecture doc",
      query: "SELECT session_id, created_at, last_event_at FROM sessions WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 100",
      expectedSuggestedQuery: /sessions/,
      expectedPlanningHint: /recency window, ORDER BY, and LIMIT/i,
      expectedRiskLevel: "medium-risk",
      expectedFix: /Preserve the recency window, ORDER BY, and LIMIT/
    },
    {
      description: "Find turns user messages with architecture references",
      query: "SELECT session_id, user_message, timestamp FROM turns WHERE user_message ILIKE '%architecture%' ORDER BY timestamp DESC LIMIT 25",
      expectedSuggestedQuery: /turns[\s\S]*user_message[\s\S]*%architecture%/,
      expectedPlanningHint: /first identify candidate session_id values before scanning message text/i,
      expectedRiskLevel: "high-risk",
      expectedFix: /Narrow the query before text matching/
    },
    {
      description: "Find user messages for a specific session by text",
      query: "SELECT session_id, user_message, timestamp FROM turns WHERE session_id = 'session-84' AND user_message ILIKE '%architecture%' ORDER BY timestamp DESC LIMIT 25",
      expectedSuggestedQuery: /turns[\s\S]*session-84[\s\S]*user_message[\s\S]*%architecture%/,
      expectedPlanningHint: /Keep the exact session_id filter/i,
      expectedRiskLevel: "medium-risk",
      expectedFix: /Keep the exact session_id filter/
    },
    {
      description: "Find tool requests for a specific session by text",
      query: "SELECT id, session_id, tool_name, created_at FROM tool_requests WHERE session_id = 'session-42' AND tool_name ILIKE '%arch%' ORDER BY created_at DESC LIMIT 20",
      expectedSuggestedQuery: /tool_requests[\s\S]*session-42/,
      expectedRiskLevel: "medium-risk",
      expectedFix: /Keep the exact session_id filter/
    }
  ];

  for (const testCase of cases) {
    const [signal] = classifySessionEvent("tool.execution_complete", {
      success: false,
      toolName: "session_store_sql",
      error: {
        message: "CloudQueryError: {\"documentation_url\":\"\",\"message\":\"query timed out\"}\n",
        code: "failure"
      },
      arguments: {
        description: testCase.description,
        query: testCase.query
      }
    });

    const diagnosis = signal.signal.evidence.failureDiagnosis;
    assert.equal(signal.signal.kind, "timeout");
    assert.equal(diagnosis.category, "session-store-query-timeout");
    assert.equal(diagnosis.description, testCase.description);
    assert.match(diagnosis.fix, testCase.expectedFix);
    assert.ok(diagnosis.planning);
    assert.ok(diagnosis.planning.riskLevel);
    if (testCase.expectedRiskLevel) {
      assert.equal(diagnosis.planning.riskLevel, testCase.expectedRiskLevel);
    }
    assert.ok(Array.isArray(diagnosis.planning.risks) && diagnosis.planning.risks.length > 0);
    assert.ok(Array.isArray(diagnosis.planning.recommendedSteps) && diagnosis.planning.recommendedSteps.length > 0);

    const planningText = [
      diagnosis.planning.riskLevel,
      ...diagnosis.planning.risks,
      ...diagnosis.planning.recommendedSteps
    ].join("\n");

    assert.match(diagnosis.planning.suggestedQueries.join("\n"), testCase.expectedSuggestedQuery);

    if (testCase.expectedPlanningHint) {
      assert.ok(Array.isArray(diagnosis.planning.suggestedQueries) && diagnosis.planning.suggestedQueries.length > 0);
      assert.match(planningText, testCase.expectedPlanningHint);
      assert.match(planningText, /safer|candidate|session_id/i);
    }
  }
});

test("diagnoses GitHub MCP repository lookup misses", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "github-mcp-server-get_file_contents",
    error: {
      message: "MCP server 'github-mcp-server': failed to resolve git reference: failed to get repository info: GET https://api.github.com/repos/doobidoo/mcp-memory-service: 404 Not Found []",
      code: "failure"
    },
    arguments: {
      owner: "doobidoo",
      repo: "mcp-memory-service",
      path: "/"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(signal.signal.kind, "mcp-error");
  assert.equal(diagnosis.category, "github-repository-not-found");
  assert.equal(diagnosis.requestedRepository, "doobidoo/mcp-memory-service");
  assert.equal(diagnosis.path, "/");
  assert.match(diagnosis.fix, /Verify the owner and repo/);
});

test("diagnoses GitHub MCP code search query parse errors", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "github-mcp-server-search_code",
    error: {
      message: "MCP server 'github-mcp-server': failed to search code with query 'recallm RecallM in:name language:python': GET https://api.github.com/search/code?page=1&per_page=30&q=recallm+RecallM+in%3Aname+language%3Apython: 422 ERROR_TYPE_QUERY_PARSING_FATAL unable to parse query! []",
      code: "failure"
    },
    arguments: {
      query: "recallm RecallM in:name language:python"
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(signal.signal.kind, "mcp-error");
  assert.equal(diagnosis.category, "github-code-search-query-parse-error");
  assert.equal(diagnosis.query, "recallm RecallM in:name language:python");
  assert.deepEqual(diagnosis.unsupportedQualifiers, ["in:name"]);
  assert.deepEqual(diagnosis.suggestedQueries, [
    "recallm RecallM language:python",
    "filename:recallm language:python",
    "filename:RecallM language:python"
  ]);
});

test("diagnoses missing file-backed MCP inputs", () => {
  const [signal] = classifySessionEvent("tool.execution_complete", {
    success: false,
    toolName: "atrium-run",
    error: {
      message: "MCP server 'atrium': ENOENT: no such file or directory, open 'C:\\Users\\marcusm\\repos\\kb\\.persona-v2-payload.json'",
      code: "failure"
    },
    arguments: {
      tool: "python",
      args: ["-X", "utf8", "-c", "import sys,json; json.load(sys.stdin)"],
      stdin: {
        file: "C:\\Users\\marcusm\\repos\\kb\\.persona-v2-payload.json"
      },
      cwd: "C:\\Users\\marcusm\\repos\\kb",
      timeoutMs: 60000
    }
  });

  const diagnosis = signal.signal.evidence.failureDiagnosis;
  assert.equal(signal.signal.kind, "mcp-error");
  assert.equal(diagnosis.category, "missing-file-backed-input");
  assert.equal(diagnosis.missingPath, "C:\\Users\\marcusm\\repos\\kb\\.persona-v2-payload.json");
  assert.deepEqual(diagnosis.matchingReference, {
    at: "stdin.file",
    path: "C:\\Users\\marcusm\\repos\\kb\\.persona-v2-payload.json"
  });
  assert.equal(diagnosis.cwd, "C:\\Users\\marcusm\\repos\\kb");
  assert.equal(diagnosis.childTool, "python");
  assert.match(diagnosis.fix, /pass inline stdin/);
});

test("a tool failure title carries the error cause, so one tool name does not absorb unrelated failures", () => {
  const [missing] = classifySessionEvent("tool.failure", {
    toolName: "view",
    error: "Path does not exist: C:\\Users\\marcusm\\repos\\grease\\nope.mjs"
  });
  const [bounds] = classifySessionEvent("tool.failure", {
    toolName: "view",
    error: "view_range out of bounds"
  });

  assert.match(missing.signal.title, /^view failed: /);
  assert.match(missing.signal.title, /Path does not exist/);
  assert.match(bounds.signal.title, /view_range out of bounds/);
  assert.notEqual(missing.signal.title, bounds.signal.title, "two causes under one tool get separate titles");
});

test("an error signature drops the path so the same failure on different paths shares a title", () => {
  const [first] = classifySessionEvent("tool.failure", {
    toolName: "atrium-grep",
    error: JSON.stringify({ message: "MCP server 'atrium': invalid root: C:\\Users\\marcusm\\repos\\soda", code: "failure" })
  });
  const [second] = classifySessionEvent("tool.failure", {
    toolName: "atrium-grep",
    error: JSON.stringify({ message: "MCP server 'atrium': invalid root: C:\\Users\\marcusm\\repos\\kb", code: "failure" })
  });

  assert.equal(first.signal.title, second.signal.title, "the varying root path is stripped from the identity");
  assert.match(first.signal.title, /invalid root/);
});

test("an error signature drops the echoed pattern but keeps the parse failure that names the cause", () => {
  const [unclosed] = classifySessionEvent("tool.failure", {
    toolName: "atrium-grep",
    error: "fatal search error: invalid pattern: regex parse error:\n    (?:alpha|beta()\n    ^\nerror: unclosed group"
  });
  const [charClass] = classifySessionEvent("tool.failure", {
    toolName: "atrium-grep",
    error: "fatal search error: invalid pattern: regex parse error:\n    (?:[a&&[b])\n    ^\nerror: unclosed character class"
  });

  assert.match(unclosed.signal.title, /unclosed group/);
  assert.match(charClass.signal.title, /unclosed character class/);
  assert.equal(unclosed.signal.title.includes("alpha"), false, "the echoed pattern is not part of the identity");
});

test("a failure with no error text keeps the plain tool title", () => {
  const [signal] = classifySessionEvent("tool.failure", { toolName: "view" });
  assert.equal(signal.signal.title, "view failed");
});

test("a local tool is classified local even when its arguments mention an MCP server by name", () => {
  // isMcpTool used to search the argument text for "atrium", so viewing any
  // file under a path containing that word relabelled view as an MCP tool and
  // split one friction across two sources.
  const [mentions] = classifySessionEvent("tool.failure", {
    toolName: "view",
    error: "Path does not exist",
    arguments: { path: "C:\\Users\\marcusm\\repos\\atrium\\src\\index.ts" }
  });
  const [plain] = classifySessionEvent("tool.failure", {
    toolName: "view",
    error: "Path does not exist",
    arguments: { path: "C:\\Users\\marcusm\\repos\\grease\\src\\index.ts" }
  });

  assert.equal(mentions.signal.source, plain.signal.source, "the argument text does not change the tool source");
  assert.equal(mentions.signal.kind, plain.signal.kind, "the argument text does not change the failure kind");
  assert.notEqual(mentions.signal.source, "mcp");
  assert.notEqual(mentions.signal.kind, "mcp-error");
});

test("a tool named for an MCP server is still classified as an MCP call", () => {
  const [signal] = classifySessionEvent("tool.failure", {
    toolName: "atrium-grep",
    error: "MCP server 'atrium': invalid root"
  });

  assert.equal(signal.signal.source, "mcp");
  assert.equal(signal.signal.kind, "mcp-error");
});