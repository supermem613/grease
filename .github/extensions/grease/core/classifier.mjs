import { createHash } from "node:crypto";
import path from "node:path";
import { redactText, summarizeValue } from "./redact.mjs";

const ACCESS_DENIED = /\b(access\s+is\s+denied|access\s+denied|permission\s+denied|unauthorized|forbidden|eacces|eperm|denied|rejected)\b/i;
const TIMEOUT = /\b(timeout|timed\s*out|deadline|etimedout|operation\s+timed\s+out)\b/i;
const POLICY = /\b(search-policy|blocked\s+by\s+policy|content\s+exclusion|content\s+policy|excluded\s+by\s+organization\s+content\s+policy|not\s+allowed|prohibited|policy\s+denied|denied\s+by\s+pretooluse\s+hook)\b/i;
const USER_CORRECTION = /\b(no[,.\s]|not\s+that|wrong|you\s+missed|actually|should\s+have|do\s+not|don't)\b/i;
const EXACT_EDIT_MISS = /\bno match found\b/i;
const PATH_MISSING = /\bpath does not exist\b/i;
const PARENT_DIRECTORY_MISSING = /\bparent directory does not exist\b/i;
const PATCH_CONTEXT_MISSING = /\bfailed to find expected lines\b/i;
const MEMORY_REPOSITORY_MISSING = /\brepository was not found\b/i;
const AGENT_NOT_FOUND = /\bagent not found\b/i;
const MISSING_REQUIRED_FIELD = /"([^"]+)":\s*required/i;
const WEB_FETCH_REDIRECT = /\bwebfetchredirecterror\b|\brefused to follow redirect\b/i;
const CLOUD_QUERY_TIMEOUT = /\bcloudqueryerror\b[\s\S]*\bquery timed out\b/i;
const GITHUB_REPOSITORY_NOT_FOUND = /\bgithub\.com\/repos\/([^/\s]+)\/([^:\s]+):\s*404\s+not\s+found\b/i;
const GITHUB_CODE_QUERY_PARSE_ERROR = /\bsearch\/code\b[\s\S]*\b422\b[\s\S]*\bquery_parsing_fatal\b|\bunable to parse query\b/i;
const MISSING_FILE_OPEN = /\benoent\b[\s\S]*\bno such file or directory\b[\s\S]*\bopen '([^']+)'/i;

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
        guardrailRootCause: guardrailRootCauseFor(
          toolName,
          kind,
          failureDetails,
          argumentDetails,
          workingDirectory,
          data.arguments ?? data.toolArgs
        ),
        failureDiagnosis: failureDiagnosisFor(toolName, kind, failureDetails, data.arguments ?? data.toolArgs),
        decisionContext: summarizeValue(data.decisionContext, 4000),
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
  if (kind === "policy-block") {
    tags.push("guardrail");
  }
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

function guardrailRootCauseFor(toolName, kind, failureDetails, argumentDetails, workingDirectory, rawArguments) {
  const details = `${failureDetails}\n${argumentDetails}`;
  if (kind !== "policy-block" && !POLICY.test(details)) {
    return undefined;
  }
  const normalizedTool = String(toolName).toLowerCase();
  if (isDirectSearchTool(normalizedTool) && /\bsearch-policy\b/i.test(details)) {
    return {
      category: "direct-search-tool",
      cause: `The agent selected blocked search tool '${toolName}' instead of the approved Atrium xray route.`,
      fix: "Route file-content search through atrium.run with tool xray and the search subcommand.",
      approvedReplacement: atriumXrayReplacement(rawArguments)
    };
  }
  if (normalizedTool.includes("powershell") && /excluded\s+by\s+organization\s+content\s+policy/i.test(details)) {
    return {
      category: "shell-in-excluded-path",
      cause: "The agent used PowerShell in or against a content-policy-excluded repository path, so command tokens were denied as excluded paths.",
      fix: "Run from an allowed worktree or use the exposed MCP/local tool that owns the operation instead of shell probing the excluded checkout.",
      workingDirectory
    };
  }
  if (normalizedTool.includes("powershell") && /\b(atrium|uatu)\b/i.test(details)) {
    return {
      category: "shell-cli-fallback",
      cause: "The agent attempted Atrium or uatu through PowerShell instead of using the exposed MCP tool surface.",
      fix: "Use the callable MCP tool directly when exposed. If it is not exposed, capture that exposure failure rather than trying shell fallback from an excluded path."
    };
  }
  return {
    category: "guardrail-hit",
    cause: "The agent attempted an action blocked by policy.",
    fix: "Use the captured decisionContext to fix the prompt, skill, fallback, subagent context, or tool-selection path that selected the blocked action."
  };
}

function isDirectSearchTool(normalizedTool) {
  return ["grep", "rg", "ripgrep", "find", "findstr", "git grep", "select-string", "xray"].includes(normalizedTool);
}

function failureDiagnosisFor(toolName, kind, failureDetails, rawArguments) {
  if (kind === "policy-block") {
    return undefined;
  }
  const normalizedTool = String(toolName).toLowerCase();
  const args = normalizeToolArguments(rawArguments);
  if (normalizedTool === "session_store_sql" && kind === "timeout" && CLOUD_QUERY_TIMEOUT.test(failureDetails)) {
    return sessionStoreSqlTimeoutDiagnosis(args);
  }
  if (normalizedTool === "github-mcp-server-get_file_contents" && GITHUB_REPOSITORY_NOT_FOUND.test(failureDetails)) {
    return githubRepositoryNotFoundDiagnosis(failureDetails, args);
  }
  if (normalizedTool === "github-mcp-server-search_code" && GITHUB_CODE_QUERY_PARSE_ERROR.test(failureDetails)) {
    return githubCodeSearchQueryDiagnosis(args);
  }
  if (MISSING_FILE_OPEN.test(failureDetails)) {
    return missingFileBackedInputDiagnosis(failureDetails, args);
  }
  if (normalizedTool === "edit" && EXACT_EDIT_MISS.test(failureDetails)) {
    return {
      category: "exact-edit-miss",
      cause: "The edit tool was asked to replace an exact old_str that no longer matched the file content.",
      fix: "Read the current target region, then retry with a smaller current old_str or use apply_patch with fresh context.",
      oldStringLength: stringLength(args?.old_str),
      newStringLength: stringLength(args?.new_str)
    };
  }
  if (normalizedTool === "view" && PATH_MISSING.test(failureDetails)) {
    return {
      category: "missing-path",
      cause: "The view tool targeted a path that did not exist in the active filesystem context.",
      fix: "Verify the active worktree and exact path before reading. Prefer workspace paths over stale main-checkout paths.",
      path: stringValue(args?.path)
    };
  }
  if (normalizedTool === "create" && PARENT_DIRECTORY_MISSING.test(failureDetails)) {
    return {
      category: "missing-parent-directory",
      cause: "The create tool targeted a file whose parent directory did not exist.",
      fix: "Create or choose the parent directory first, then create the file.",
      path: stringValue(args?.path),
      parentDirectory: parentDirectoryOf(args?.path)
    };
  }
  if (normalizedTool === "apply_patch" && PATCH_CONTEXT_MISSING.test(failureDetails)) {
    return {
      category: "stale-patch-context",
      cause: "The patch expected lines that were not present in the target file, usually because the file changed or the patch context was copied from a different revision.",
      fix: "Read the current target section and regenerate the patch with exact current context.",
      targetPath: patchTargetPath(rawArguments)
    };
  }
  if (normalizedTool === "store_memory" && MEMORY_REPOSITORY_MISSING.test(failureDetails)) {
    return {
      category: "repository-memory-unavailable",
      cause: "The memory request used repository scope where the repository was unavailable, inaccessible, or not enabled for repository-scoped memories.",
      fix: "Use an available memory scope or capture the repository availability failure before retrying repository-scoped memory.",
      scope: stringValue(args?.scope),
      subject: stringValue(args?.subject)
    };
  }
  if (normalizedTool === "read_agent" && AGENT_NOT_FOUND.test(failureDetails)) {
    return {
      category: "stale-agent-id",
      cause: "The read_agent call referenced an agent id that was not live in the current session.",
      fix: "Only read agent ids returned by this session, and refresh with list_agents when resuming after reloads or session changes.",
      agentId: stringValue(args?.agent_id)
    };
  }
  if (normalizedTool === "task") {
    const missingField = missingRequiredField(failureDetails);
    if (missingField) {
      return {
        category: "tool-schema-missing-field",
        cause: `The task call omitted required field '${missingField}'.`,
        fix: "Build tool calls from the declared schema and include all required fields before invocation.",
        missingField
      };
    }
  }
  if (normalizedTool === "web_fetch" && WEB_FETCH_REDIRECT.test(failureDetails)) {
    return {
      category: "redirect-requires-explicit-url",
      cause: "web_fetch refused an HTTP redirect so the redirected URL can be permission-checked explicitly.",
      fix: "Re-invoke web_fetch with the final URL from the error, or use an authenticated browser/workflow when the redirect is a sign-in challenge.",
      originalUrl: stringValue(args?.url),
      redirectUrl: redirectUrlFrom(failureDetails)
    };
  }
  return undefined;
}

function sessionStoreSqlTimeoutDiagnosis(args) {
  const query = stringValue(args?.query);
  const shape = queryShape(query);
  return {
    category: "session-store-query-timeout",
    cause: "The cloud session-store query exceeded the tool timeout. The captured query shape is broad enough to require a narrower or more index-friendly lookup.",
    fix: "Narrow the query before text matching. Prefer exact ids, tighter time windows, indexed metadata filters, fewer OR branches, and smaller projected text columns before using leading-wildcard ILIKE.",
    description: stringValue(args?.description),
    query,
    queryShape: shape
  };
}

function githubRepositoryNotFoundDiagnosis(failureDetails, args) {
  const fromError = GITHUB_REPOSITORY_NOT_FOUND.exec(failureDetails);
  const owner = stringValue(args?.owner) ?? fromError?.[1];
  const repo = stringValue(args?.repo) ?? fromError?.[2];
  return {
    category: "github-repository-not-found",
    cause: "GitHub MCP could not resolve the requested repository. The owner or repo name may be wrong, the repository may be private, or the current token may not have access.",
    fix: "Verify the owner and repo with an explicit repository lookup or user-provided URL before requesting file contents.",
    owner,
    repo,
    path: stringValue(args?.path),
    requestedRepository: owner && repo ? `${owner}/${repo}` : undefined
  };
}

function githubCodeSearchQueryDiagnosis(args) {
  const query = stringValue(args?.query);
  return {
    category: "github-code-search-query-parse-error",
    cause: "GitHub code search could not parse the query shape.",
    fix: "Use supported code-search qualifiers and simplify the query. Remove unsupported qualifiers such as in:name, use filename: for filenames, quote exact phrases, or split broad alternatives into separate searches.",
    query,
    unsupportedQualifiers: unsupportedGithubCodeSearchQualifiers(query),
    suggestedQueries: githubCodeSearchSuggestions(query)
  };
}

function missingFileBackedInputDiagnosis(failureDetails, args) {
  const missingPath = unescapeJsonPath(MISSING_FILE_OPEN.exec(failureDetails)?.[1]);
  const references = fileValueReferences(args);
  return {
    category: "missing-file-backed-input",
    cause: "The MCP call referenced a local file value that did not exist when the server tried to open it.",
    fix: "Create the file immediately before the call, pass inline stdin when the payload is short-lived, or use a durable artifact path that survives across turns and sessions.",
    missingPath,
    matchingReference: references.find((reference) => reference.path === missingPath),
    fileReferences: references,
    cwd: stringValue(args?.cwd),
    childTool: stringValue(args?.tool)
  };
}

function atriumXrayReplacement(rawArguments) {
  const args = normalizeToolArguments(rawArguments);
  if (!args || typeof args.pattern !== "string" || args.pattern.trim() === "") {
    return {
      tool: "xray",
      args: ["search", "<query>", "--root", "<repo>", "--glob", "<scope>"]
    };
  }
  const searchArgs = args.pattern.startsWith("-")
    ? ["search", "--query", args.pattern]
    : ["search", args.pattern];
  const scoped = scopeForSearchPath(args.paths);
  if (scoped.root) {
    searchArgs.push("--root", scoped.root);
  }
  if (scoped.glob) {
    searchArgs.push("--glob", scoped.glob);
  }
  if (args.multiline !== true && looksLikeRegex(args.pattern)) {
    searchArgs.push("--regex");
  }
  if (Number.isInteger(args.head_limit)) {
    searchArgs.push("--max", String(args.head_limit));
  }
  return {
    tool: "xray",
    args: searchArgs
  };
}

function normalizeToolArguments(rawArguments) {
  if (!rawArguments) {
    return undefined;
  }
  if (typeof rawArguments === "object") {
    return rawArguments;
  }
  if (typeof rawArguments !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
}

function scopeForSearchPath(value) {
  const firstPath = Array.isArray(value) ? value[0] : value;
  if (typeof firstPath !== "string" || firstPath.trim() === "") {
    return {};
  }
  const parser = /^[A-Za-z]:\\/.test(firstPath) || firstPath.includes("\\")
    ? path.win32
    : path;
  const parsed = parser.parse(firstPath);
  if (parsed.ext) {
    return {
      root: parser.dirname(firstPath),
      glob: parser.basename(firstPath)
    };
  }
  return {
    root: firstPath,
    glob: "**"
  };
}

function looksLikeRegex(value) {
  return /[\\^$.*+?()[\]{}|]/.test(value);
}

function queryShape(query) {
  const text = String(query ?? "");
  const lower = text.toLowerCase();
  return {
    hasLeadingWildcardIlike: /\bilike\s+'%/.test(lower),
    ilikeCount: (lower.match(/\bilike\b/g) ?? []).length,
    hasOr: /\bor\b/.test(lower),
    hasTimeWindow: /\b(timestamp|first_seen_at|created_at|updated_at|last_seen_at)\b\s*[><=]/.test(lower),
    hasOrderBy: /\border\s+by\b/.test(lower),
    hasLimit: /\blimit\s+\d+\b/.test(lower),
    projectedWideText: /\b(user_message|assistant_message|content|raw_event)\b/.test(lower)
  };
}

function unsupportedGithubCodeSearchQualifiers(query) {
  const text = String(query ?? "");
  const supported = new Set([
    "repo",
    "org",
    "user",
    "language",
    "path",
    "filename",
    "extension",
    "in",
    "size",
    "is"
  ]);
  return [...text.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*):/g)]
    .map((match) => {
      const name = match[1];
      const value = text.slice(match.index + match[0].length).split(/\s+/)[0];
      if (name.toLowerCase() === "in" && !["file", "path"].includes(value.toLowerCase())) {
        return `in:${value}`;
      }
      return name;
    })
    .filter((name) => name.includes(":") || !supported.has(name.toLowerCase()));
}

function githubCodeSearchSuggestions(query) {
  const text = stringValue(query);
  if (!text) {
    return [];
  }
  const withoutUnsupportedInName = text.replace(/\s*\bin:name\b/gi, "");
  const suggestions = [];
  if (withoutUnsupportedInName !== text) {
    suggestions.push(withoutUnsupportedInName.trim());
  }
  const filenameTerms = bareSearchTerms(withoutUnsupportedInName).slice(0, 2);
  for (const term of filenameTerms) {
    suggestions.push(replaceBareTerms(withoutUnsupportedInName, `filename:${term}`));
  }
  return [...new Set(suggestions.filter(Boolean))].slice(0, 3);
}

function fileValueReferences(value, pathParts = []) {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (!Array.isArray(value) && typeof value.file === "string") {
    return [{
      at: [...pathParts, "file"].join("."),
      path: value.file
    }];
  }
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : Object.entries(value);
  return entries.flatMap(([key, entry]) => fileValueReferences(entry, [...pathParts, key]));
}

function unescapeJsonPath(value) {
  return typeof value === "string" ? value.replace(/\\\\/g, "\\") : undefined;
}

function bareSearchTerms(query) {
  return String(query ?? "")
    .split(/\s+/)
    .filter((part) => part && !part.includes(":") && !["OR", "AND", "NOT"].includes(part.toUpperCase()));
}

function replaceBareTerms(query, replacement) {
  const qualifiers = String(query ?? "")
    .split(/\s+/)
    .filter((part) => part.includes(":"))
    .join(" ");
  return [replacement, qualifiers].filter(Boolean).join(" ");
}

function stringLength(value) {
  return typeof value === "string" ? value.length : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parentDirectoryOf(value) {
  const filePath = stringValue(value);
  if (!filePath) {
    return undefined;
  }
  const parser = /^[A-Za-z]:\\/.test(filePath) || filePath.includes("\\")
    ? path.win32
    : path;
  return parser.dirname(filePath);
}

function patchTargetPath(rawArguments) {
  const text = typeof rawArguments === "string"
    ? rawArguments
    : summarizeValue(rawArguments, 4000);
  if (!text) {
    return undefined;
  }
  const match = /\*\*\* Update File:\s*(.+)/.exec(text)
    ?? /in ([A-Za-z]:\\[^\n:]+):/.exec(text);
  return match?.[1]?.trim();
}

function missingRequiredField(details) {
  return MISSING_REQUIRED_FIELD.exec(details)?.[1]?.replace(/\\+$/g, "");
}

function redirectUrlFrom(details) {
  const match = /\bto (https?:\/\/\S+)/i.exec(details);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/[.,;]+$/, "");
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
