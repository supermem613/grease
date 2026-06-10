export function createToolCallLedger() {
  const active = new Map();
  return {
    rememberStart(data = {}, context = {}) {
      if (!data.toolCallId) {
        return;
      }
      active.set(data.toolCallId, {
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        arguments: data.arguments,
        startedAt: timestampString(data.timestamp),
        sessionId: context.sessionId,
        sessionName: context.sessionName,
        workingDirectory: data.workingDirectory ?? context.workingDirectory
      });
    },
    enrich(data = {}, context = {}) {
      if (!data.toolCallId) {
        return data;
      }
      const started = active.get(data.toolCallId);
      if (!started) {
        return data;
      }
      active.delete(data.toolCallId);
      const completedAt = timestampString(data.timestamp);
      return {
        ...data,
        toolName: isGenericToolName(data.toolName) && started.toolName ? started.toolName : data.toolName,
        arguments: data.arguments ?? data.toolArgs ?? started.arguments,
        toolArgs: data.toolArgs ?? data.arguments ?? started.arguments,
        startedAt: data.startedAt ?? started.startedAt,
        completedAt: data.completedAt ?? completedAt,
        durationMs: data.durationMs ?? durationMs(started.startedAt, completedAt),
        sessionId: data.sessionId ?? context.sessionId ?? started.sessionId,
        sessionName: data.sessionName ?? context.sessionName ?? started.sessionName,
        workingDirectory: data.workingDirectory ?? context.workingDirectory ?? started.workingDirectory
      };
    }
  };
}

function isGenericToolName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "tool";
}

function timestampString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  return new Date().toISOString();
}

function durationMs(startedAt, completedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}
