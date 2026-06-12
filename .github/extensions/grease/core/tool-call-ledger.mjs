export function createToolCallLedger() {
  const active = new Map();
  const recentUserMessages = [];
  const recentToolStarts = [];
  return {
    rememberUserMessage(data = {}, context = {}) {
      const content = data.content ?? data.prompt ?? data.message;
      if (typeof content !== "string" || content.trim() === "") {
        return;
      }
      recentUserMessages.push({
        at: timestampString(data.timestamp),
        sessionId: data.sessionId ?? context.sessionId,
        sessionName: data.sessionName ?? context.sessionName,
        turnId: data.turnId,
        interactionId: data.interactionId,
        content: content.slice(0, 2000)
      });
      trimTo(recentUserMessages, 3);
    },
    rememberStart(data = {}, context = {}) {
      if (!data.toolCallId) {
        return;
      }
      const started = {
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        arguments: data.arguments,
        startedAt: timestampString(data.timestamp),
        sessionId: data.sessionId ?? context.sessionId,
        sessionName: data.sessionName ?? context.sessionName,
        workingDirectory: data.workingDirectory ?? context.workingDirectory,
        turnId: data.turnId,
        interactionId: data.interactionId
      };
      active.set(data.toolCallId, started);
      recentToolStarts.push(started);
      trimTo(recentToolStarts, 8);
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
        workingDirectory: data.workingDirectory ?? context.workingDirectory ?? started.workingDirectory,
        decisionContext: data.decisionContext ?? buildDecisionContext(started, {
          sessionId: data.sessionId ?? context.sessionId ?? started.sessionId
        })
      };
    }
  };

  function buildDecisionContext(started, context = {}) {
    const sessionId = context.sessionId ?? started.sessionId;
    return {
      recentUserMessages: relevantEntries(recentUserMessages, sessionId),
      currentToolStart: started,
      previousToolStarts: relevantEntries(recentToolStarts, sessionId)
        .filter((entry) => entry.toolCallId !== started.toolCallId)
        .slice(-5)
    };
  }
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

function relevantEntries(entries, sessionId) {
  if (!sessionId) {
    return [...entries];
  }
  return entries.filter((entry) => !entry.sessionId || entry.sessionId === sessionId);
}

function trimTo(values, maxLength) {
  while (values.length > maxLength) {
    values.shift();
  }
}
