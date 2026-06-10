import { createHash } from "node:crypto";
import { redactText, summarizeValue } from "./redact.mjs";

const ACCESS_DENIED = /\b(access\s+is\s+denied|access\s+denied|permission\s+denied|unauthorized|forbidden|eacces|eperm|denied|rejected)\b/i;
const TIMEOUT = /\b(timeout|timed\s*out|deadline|etimedout|operation\s+timed\s+out)\b/i;
const POLICY = /\b(search-policy|blocked\s+by\s+policy|content\s+exclusion|not\s+allowed|prohibited|policy\s+denied)\b/i;
const USER_CORRECTION = /\b(no[,.\s]|not\s+that|wrong|you\s+missed|actually|should\s+have|do\s+not|don't)\b/i;

const LOCAL_TOOL_NAMES = new Set([
  "powershell",
  "read_powershell",
  "write_powershell",
  "stop_powershell",
  "bash",
  "shell",
  "task",
  "apply_patch",
  "extensions_manage",
  "extensions_reload"
]);

export function classifySessionEvent(eventType, data = {}, context = {}) {
  if (eventType === "tool.execution_complete") {
    return classifyToolCompletion(data, context);
  }
  if (eventType === "tool.execution_start") {
    return [];
  }
  if (eventType === "tool.failure" || eventType === "post_tool_failure") {
    return classifyToolFailure(data, context);
  }
  if (eventType === "permission.requested") {
    return [permissionSignal(data, context)];
  }
  if (eventType === "session.error" || eventType === "error.occurred") {
    const signal = sessionErrorSignal(data, context);
    return signal ? [signal] : [];
  }
  if (eventType === "user.message") {
    return classifyUserMessage(data, context);
  }
  return [];
}

export function classifyManualCapture(input = {}, context = {}) {
  const now = context.now ?? new Date().toISOString();
  const title = requiredString(input.title, "title");
  const summary = requiredString(input.summary, "summary");
  return {
    type: "friction.signal",
    id: stableId(["manual", title, summary, now]),
    at: now,
    sessionId: context.sessionId,
    sessionName: input.sessionName ?? context.sessionName,
    machineName: input.machineName ?? context.machineName,
    workingDirectory: input.workingDirectory ?? context.workingDirectory,
    signal: {
      kind: input.kind ?? "manual",
      source: input.source ?? "manual",
      severity: normalizeSeverity(input.severity ?? "medium"),
      title,
      summary,
      tags: normalizeTags(input.tags),
      evidence: {
        note: summarizeValue(input.evidence ?? summary)
      }
    }
  };
}

function classifyToolCompletion(data, context) {
  const success = data.success === true;
  const resultType = getResultType(data);
  if (success && (!resultType || resultType === "success")) {
    return [];
  }
  return classifyToolFailure(data, context);
}

function classifyToolFailure(data, context) {
  const now = context.now ?? new Date().toISOString();
  const toolName = String(data.toolName ?? data.name ?? context.toolName ?? "tool");
  const workingDirectory = data.workingDirectory ?? context.workingDirectory;
  const sessionId = data.sessionId ?? context.sessionId;
  const sessionName = data.sessionName ?? context.sessionName;
  const failureDetails = [
    data.error,
    data.result,
    data.toolResult,
    data.message
  ].map((value) => summarizeValue(value, 1200)).filter(Boolean).join("\n");
  const argumentDetails = [
    data.arguments,
    data.toolArgs
  ].map((value) => summarizeValue(value, 1200)).filter(Boolean).join("\n");
  const details = [failureDetails, argumentDetails].filter(Boolean).join("\n");
  const kind = classifyFailureKind(toolName, failureDetails);
  const title = titleForToolFailure(toolName, kind);
  const severity = severityForKind(kind);
  return [{
    type: "friction.signal",
    id: stableId(["tool", data.toolCallId, toolName, kind, details || now]),
    at: now,
    sessionId,
    sessionName,
    workingDirectory,
    signal: {
      kind,
      source: classifyToolSource(toolName, data),
      severity,
      title,
      summary: summarizeToolFailure(toolName, kind, details),
      tags: tagsForToolFailure(toolName, kind),
      evidence: {
        eventType: context.eventType,
        availableFields: Object.keys(data).sort(),
        toolCallId: data.toolCallId,
        toolName,
        sessionId,
        sessionName,
        workingDirectory,
        startedAt: data.startedAt,
        completedAt: data.completedAt ?? data.timestamp,
        durationMs: data.durationMs,
        resultType: getResultType(data),
        success: data.success,
        error: summarizeValue(data.error, 2000),
        result: summarizeValue(data.result ?? data.toolResult, 2000),
        arguments: summarizeValue(data.arguments ?? data.toolArgs, 2000),
        rawEvent: summarizeValue(data, 4000)
      }
    }
  }];
}

function permissionSignal(data, context) {
  const now = context.now ?? new Date().toISOString();
  const reason = summarizeValue(data.permissionDecisionReason ?? data.reason ?? data.permissionRequest, 1200);
  const title = reason && ACCESS_DENIED.test(reason)
    ? "Permission or access denial"
    : "Permission requested";
  return {
    type: "friction.signal",
    id: stableId(["permission", data.requestId, reason ?? now]),
    at: now,
    sessionId: context.sessionId,
    sessionName: context.sessionName,
    workingDirectory: data.workingDirectory ?? context.workingDirectory,
    signal: {
      kind: reason && ACCESS_DENIED.test(reason) ? "access-denied" : "permission",
      source: "permission",
      severity: reason && ACCESS_DENIED.test(reason) ? "high" : "medium",
      title,
      summary: reason ?? "A tool permission decision interrupted the workflow.",
      tags: ["permission"],
      evidence: {
        requestId: data.requestId,
        permissionRequest: summarizeValue(data.permissionRequest, 2000),
        reason
      }
    }
  };
}

function sessionErrorSignal(data, context) {
  const now = context.now ?? new Date().toISOString();
  const detail = summarizeValue(data.error ?? data.message ?? data, 2000);
  if (!isActionableSessionErrorDetail(detail)) {
    return undefined;
  }
  return {
    type: "friction.signal",
    id: stableId(["session-error", context.sessionId, detail ?? now]),
    at: now,
    sessionId: context.sessionId,
    sessionName: context.sessionName,
    workingDirectory: data.workingDirectory ?? context.workingDirectory,
    signal: {
      kind: TIMEOUT.test(detail ?? "") ? "timeout" : "session-error",
      source: "session",
      severity: "high",
      title: "Session error",
      summary: detail ?? "The session reported an error.",
      tags: ["session"],
      evidence: {
        errorType: data.errorType,
        message: detail
      }
    }
  };
}

function isActionableSessionErrorDetail(detail) {
  if (detail === undefined || detail === null) {
    return false;
  }
  const text = String(detail).trim();
  return text !== "" && text !== "{}" && text !== "[]";
}

function classifyUserMessage(data, context) {
  const content = redactText(data.content ?? data.prompt ?? "", 1200);
  if (isInjectedContextOnlyMessage(content)) {
    return [];
  }
  if (!USER_CORRECTION.test(content)) {
    return [];
  }
  const now = context.now ?? new Date().toISOString();
  return [{
    type: "friction.signal",
    id: stableId(["user-correction", context.sessionId, content]),
    at: now,
    sessionId: context.sessionId,
    sessionName: context.sessionName,
    workingDirectory: data.workingDirectory ?? context.workingDirectory,
    signal: {
      kind: "correction",
      source: "user",
      severity: "medium",
      title: "User correction",
      summary: content,
      tags: ["correction"],
      evidence: {
        content
      }
    }
  }];
}

function isInjectedContextOnlyMessage(content) {
  const text = String(content ?? "").trim();
  return /^<skill-context\b[\s\S]*<\/skill-context>\s*$/i.test(text)
    || /^<canvas-context\b[\s\S]*<\/canvas-context>\s*$/i.test(text)
    || /^<system_reminder\b[\s\S]*<\/system_reminder>\s*$/i.test(text)
    || /^<system_notification\b[\s\S]*<\/system_notification>\s*$/i.test(text);
}

function classifyFailureKind(toolName, details) {
  const haystack = `${toolName}\n${details}`;
  if (POLICY.test(haystack)) {
    return "policy-block";
  }
  if (ACCESS_DENIED.test(haystack)) {
    return "access-denied";
  }
  if (TIMEOUT.test(haystack)) {
    return "timeout";
  }
  if (isMcpTool(toolName, { details })) {
    return "mcp-error";
  }
  if (isLocalTool(toolName)) {
    return "local-tool-error";
  }
  return "tool-error";
}

function classifyToolSource(toolName, data) {
  if (isMcpTool(toolName, data)) {
    return "mcp";
  }
  if (isLocalTool(toolName)) {
    return "local-tool";
  }
  return "tool";
}

function isLocalTool(toolName) {
  const normalized = String(toolName).toLowerCase();
  return LOCAL_TOOL_NAMES.has(normalized) || normalized.includes("powershell") || normalized.includes("terminal");
}

function isMcpTool(toolName, data) {
  const normalized = String(toolName).toLowerCase();
  const args = summarizeValue(data.arguments ?? data.toolArgs ?? data.details ?? "", 1000) ?? "";
  return normalized.includes("mcp") || normalized.includes("atrium") || /\batrium\b/i.test(args);
}

function titleForToolFailure(toolName, kind) {
  if (kind === "access-denied") {
    return `${toolName} hit access denied`;
  }
  if (kind === "timeout") {
    return `${toolName} timed out`;
  }
  if (kind === "policy-block") {
    return `${toolName} was blocked by policy`;
  }
  if (kind === "mcp-error") {
    return `${toolName} MCP call failed`;
  }
  if (kind === "local-tool-error") {
    return `${toolName} local tool failed`;
  }
  return `${toolName} failed`;
}

function summarizeToolFailure(toolName, kind, details) {
  const intro = {
    "access-denied": "A local tool or MCP call was denied access.",
    timeout: "A local tool or MCP call timed out.",
    "policy-block": "A local tool call was blocked by policy.",
    "mcp-error": "An MCP-backed tool call failed.",
    "local-tool-error": "A local tool call failed.",
    "tool-error": "A tool call failed."
  }[kind];
  return redactText(`${intro} Tool: ${toolName}.${details ? ` Detail: ${details}` : ""}`, 2000);
}

function tagsForToolFailure(toolName, kind) {
  const tags = [kind];
  if (isMcpTool(toolName, {})) {
    tags.push("mcp");
  }
  if (isLocalTool(toolName)) {
    tags.push("local-tool");
  }
  return tags;
}

function severityForKind(kind) {
  if (kind === "access-denied" || kind === "timeout" || kind === "policy-block") {
    return "high";
  }
  return "medium";
}

function getResultType(data) {
  return data.resultType ?? data.toolResult?.resultType ?? data.result?.resultType;
}

function normalizeSeverity(value) {
  if (["low", "medium", "high", "critical"].includes(value)) {
    return value;
  }
  return "medium";
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function stableId(parts) {
  const hash = createHash("sha256");
  hash.update(parts.map((part) => String(part ?? "")).join("\u001f"));
  return hash.digest("hex").slice(0, 16);
}
