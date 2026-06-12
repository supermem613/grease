import { joinSession } from "@github/copilot-sdk/extension";
import { appendEvent } from "./core/catalog.mjs";
import { classifySessionEvent } from "./core/classifier.mjs";
import { createGreaseCanvas } from "./core/canvas-provider.mjs";
import { createGreaseTools } from "./core/tools.mjs";
import { createToolCallLedger } from "./core/tool-call-ledger.mjs";

let session;
const toolCalls = createToolCallLedger();

async function recordSignals(eventType, data, context = {}) {
  const signals = classifySessionEvent(eventType, data, {
    eventType,
    sessionId: context.sessionId,
    sessionName: context.sessionName,
    workingDirectory: data?.workingDirectory ?? context.workingDirectory
  });
  for (const signal of signals) {
    await appendEvent(signal);
  }
}

function observeToolStart() {
  session.on("tool.execution_start", (event) => {
    const data = event.data ?? {};
    if (!data.toolCallId) {
      return;
    }
    toolCalls.rememberStart(data, {
      sessionId: event.sessionId,
      sessionName: sessionNameFrom(event, data),
      workingDirectory: data.workingDirectory
    });
  });
}

function observe(eventType) {
  session.on(eventType, (event) => {
    const data = enrichToolEvent(event.data ?? {}, event);
    if (eventType === "user.message") {
      toolCalls.rememberUserMessage(data, {
        sessionId: event.sessionId,
        sessionName: sessionNameFrom(event, data)
      });
    }
    recordSignals(eventType, data, {
      sessionId: event.sessionId,
      sessionName: sessionNameFrom(event, data),
      workingDirectory: data?.workingDirectory
    }).catch((error) => {
      void session.log(`Grease capture failed: ${error.message}`, { level: "error" });
    });
  });
}

session = await joinSession({
  tools: createGreaseTools(),
  canvases: [
    createGreaseCanvas({
      getSession: () => session
    })
  ],
  hooks: {
    onPostToolUseFailure: async (input, invocation) => {
      const data = enrichToolEvent(input, invocation);
      await recordSignals("post_tool_failure", data, {
        sessionId: invocation?.sessionId,
        sessionName: sessionNameFrom(invocation, data),
        workingDirectory: data.workingDirectory
      });
    },
    onErrorOccurred: async (input, invocation) => {
      await recordSignals("error.occurred", input, {
        sessionId: invocation?.sessionId,
        sessionName: sessionNameFrom(invocation, input),
        workingDirectory: input.workingDirectory
      });
    },
    onSessionEnd: async (input, invocation) => {
      if (input.reason === "error" || input.error) {
        await recordSignals("session.error", input, {
          sessionId: invocation?.sessionId,
          sessionName: sessionNameFrom(invocation, input),
          workingDirectory: input.workingDirectory
        });
      }
    }
  }
});

observeToolStart();
for (const eventType of [
  "tool.execution_complete",
  "permission.requested",
  "session.error",
  "user.message"
]) {
  observe(eventType);
}

await session.log("Grease is tracking friction.", { ephemeral: true });

function enrichToolEvent(data = {}, event = {}) {
  return toolCalls.enrich(data, {
    sessionId: event.sessionId,
    sessionName: sessionNameFrom(event, data),
    workingDirectory: data.workingDirectory
  });
}

function sessionNameFrom(...sources) {
  for (const source of sources) {
    const value = source?.sessionName
      ?? source?.sessionTitle
      ?? source?.projectSessionName
      ?? source?.conversationTitle;
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}
