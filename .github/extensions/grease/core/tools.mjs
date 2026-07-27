import { appendEvent, getFriction, readCatalog, readCatalogSummary, searchCatalog, updateFriction, updateFrictionBulk } from "./catalog.mjs";
import { buildBrief } from "./brief.mjs";
import { classifyManualCapture } from "./classifier.mjs";

const SEVERITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["open", "triaged", "in-progress", "resolved", "ignored"];

const CAPTURE_RULES = [
  { field: "title", type: "string", required: true },
  { field: "summary", type: "string", required: true },
  { field: "severity", type: "string", required: true, accepted: SEVERITIES },
  { field: "kind", type: "string", required: true },
  { field: "source", type: "string", required: true },
  { field: "evidence", type: "string", required: true },
  { field: "machineName", type: "string" },
  { field: "sessionName", type: "string" },
  { field: "workingDirectory", type: "string" },
  { field: "tags", type: "array" }
];

const GET_RULES = [{ field: "id", type: "string", required: true }];

const UPDATE_RULES = [
  { field: "id", type: "string", expected: "a Grease item id, or use ids for a bulk update" },
  { field: "ids", type: "array" },
  { field: "status", type: "string", accepted: STATUSES },
  { field: "severity", type: "string", accepted: SEVERITIES },
  { field: "tags", type: "array" },
  { field: "note", type: "string" }
];

const SEARCH_RULES = [
  { field: "query", type: "string" },
  { field: "status", type: "string" },
  { field: "limit", type: "number" }
];

const BRIEF_RULES = [
  { field: "ids", type: "array" },
  { field: "query", type: "string" },
  { field: "status", type: "string" },
  { field: "limit", type: "number" }
];

export function createGreaseTools(options = {}) {
  // options.now is a clock FUNCTION used to stamp events. The store layer takes
  // a timestamp string, so the clock is resolved here and never forwarded as a
  // function. Forwarding it made appendEvent compare a function against
  // event.at and made updateFriction write the function into event.at, where
  // JSON.stringify silently dropped it and left the event with no timestamp.
  const { now: clock, ...storeOptions } = options;
  const storeOptionsAtNow = () => {
    const now = clock?.();
    return now === undefined ? storeOptions : { ...storeOptions, now };
  };
  return guardAll([
    {
      name: "grease_status",
      description: "Show Grease catalog health and friction counts.",
      parameters: {
        type: "object",
        properties: {}
      },
      handler: async () => {
        const summary = await readCatalogSummary(storeOptions);
        return success("grease_status", summary);
      }
    },
    {
      name: "grease_capture",
      description: "Use whenever you encounter operational friction that passive capture may not see, including confusing instructions, repeated manual work, missing context, avoidable retries, workarounds, or tools that are difficult to use. Capture it during the operation without waiting for the user to ask, even if the task ultimately succeeds. Do not manually duplicate an exact tool failure already captured by Grease.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A concise, stable symptom describing the friction, not the current task."
          },
          summary: {
            type: "string",
            description: "State what was attempted, what was expected, what actually happened, and the impact. Include the workaround or extra steps when applicable."
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
            description: "low is minor delay, medium requires meaningful extra work, high blocks or repeatedly derails work, and critical risks data, security, or broad availability."
          },
          kind: {
            type: "string",
            description: "A reusable category such as confusing-instruction, missing-context, repeated-manual-step, tool-failure, permission, timeout, or workaround."
          },
          source: {
            type: "string",
            description: "The tool, workflow, instruction set, service, or environment where the friction originated."
          },
          machineName: { type: "string", description: "The machine where the friction occurred when known." },
          sessionName: { type: "string", description: "The current session name or alias when known." },
          workingDirectory: { type: "string", description: "The working directory where the friction occurred when relevant." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Short reusable labels for the affected tool, workflow, repo, and failure class."
          },
          evidence: {
            type: "string",
            description: "Redacted evidence sufficient to reproduce or investigate the friction, including the exact observation, reproduction steps, relevant arguments, and workaround when known. Never include credentials, tokens, personal data, or other secrets."
          }
        },
        required: ["title", "summary", "severity", "kind", "source", "evidence"]
      },
      handler: async (args, invocation) => {
        const rejected = reject("grease_capture", args, CAPTURE_RULES);
        if (rejected) {
          return rejected;
        }
        const event = classifyManualCapture(args, {
          sessionId: invocation?.sessionId,
          sessionName: sessionNameFrom(invocation),
          toolCallId: toolCallIdFrom(invocation),
          now: clock?.()
        });
        const result = await appendEvent(event, storeOptions);
        const catalog = await readCatalog(storeOptions);
        return success("grease_capture", {
          eventId: result.event.id,
          itemCount: catalog.items.length
        });
      }
    },
    {
      name: "grease_search",
      description: "Search the Grease friction catalog.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          status: { type: "string" },
          limit: { type: "number" }
        }
      },
      handler: async (args) => {
        const rejected = reject("grease_search", args, SEARCH_RULES);
        if (rejected) {
          return rejected;
        }
        const result = await searchCatalog(args, storeOptions);
        return success("grease_search", {
          items: result.items
        });
      }
    },
    {
      name: "grease_get",
      description: "Get one Grease friction item with occurrence evidence.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" }
        },
        required: ["id"]
      },
      handler: async (args) => {
        const rejected = reject("grease_get", args, GET_RULES);
        if (rejected) {
          return rejected;
        }
        return success("grease_get", await getFriction(args.id, storeOptions));
      }
    },
    {
      name: "grease_update",
      description: "Update one or more Grease friction items' status, severity, tags, or note. Pass id for one item or ids for an atomic bulk update.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          ids: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["open", "triaged", "in-progress", "resolved", "ignored"] },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          tags: { type: "array", items: { type: "string" } },
          note: { type: "string" }
        }
      },
      handler: async (args) => {
        const { id, ids, ...updates } = args;
        const bulk = Array.isArray(ids) && ids.length > 0;
        const rejected = reject("grease_update", args, UPDATE_RULES, bulk ? [] : ["id"]);
        if (rejected) {
          return rejected;
        }
        if (bulk) {
          const result = await updateFrictionBulk(ids, updates, storeOptionsAtNow());
          return success("grease_update", {
            itemIds: result.ids,
            itemCount: result.catalog.items.length
          });
        }
        const result = await updateFriction(id, updates, storeOptionsAtNow());
        return success("grease_update", {
          eventId: result.event.id,
          itemCount: result.catalog.items.length
        });
      }
    },
    {
      name: "grease_brief",
      description: "Create a kickoff prompt from selected or searched friction items.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          query: { type: "string" },
          status: { type: "string" },
          limit: { type: "number" }
        }
      },
      handler: async (args) => {
        const rejected = reject("grease_brief", args, BRIEF_RULES);
        if (rejected) {
          return rejected;
        }
        return success("grease_brief", await buildBrief(args, storeOptions));
      }
    }
  ]);
}

// Every rejection has to be a returned result. The host SDK discards a thrown
// error's message and reports only "Tool execution failed", which turns a
// fixable argument mistake into an apparently broken tool. guardAll makes that
// impossible for any tool, including ones added later.
function guardAll(tools) {
  return tools.map((tool) => ({
    ...tool,
    handler: async (args, invocation) => {
      try {
        return await tool.handler(args, invocation);
      } catch (error) {
        const detail = error?.message ?? String(error);
        return failure(tool.name, {
          error: detail,
          recovery: `${tool.name} rejected the call: ${detail}. Correct that and call ${tool.name} again.`
        });
      }
    }
  }));
}

function reject(command, args = {}, rules, alsoRequired = []) {
  const problems = [];
  for (const rule of rules) {
    const required = rule.required || alsoRequired.includes(rule.field);
    const expected = rule.expected ?? expectationFor(rule);
    const value = args?.[rule.field];
    if (value === undefined || value === null) {
      if (required) {
        problems.push({ field: rule.field, problem: "missing", expected });
      }
      continue;
    }
    const problem = shapeProblem(rule, value);
    if (problem) {
      problems.push({ field: rule.field, expected, ...problem });
      continue;
    }
    if (rule.accepted && !rule.accepted.includes(value)) {
      problems.push({
        field: rule.field,
        problem: "not an accepted value",
        received: value,
        accepted: rule.accepted
      });
    }
  }
  if (problems.length === 0) {
    return undefined;
  }
  const fields = problems.map((problem) => problem.field).join(", ");
  return failure(command, {
    error: "invalid arguments",
    problems,
    recovery: `Correct these ${command} arguments and call it again: ${fields}.`
  });
}

function shapeProblem(rule, value) {
  if (rule.type === "array") {
    return Array.isArray(value) ? undefined : { problem: "wrong type", received: typeNameOf(value) };
  }
  if (Array.isArray(value) || typeof value !== rule.type) {
    return { problem: "wrong type", received: typeNameOf(value) };
  }
  if (rule.type === "string" && value.trim() === "") {
    return { problem: "empty", received: "an empty string" };
  }
  if (rule.type === "number" && !Number.isFinite(value)) {
    return { problem: "wrong type", received: String(value) };
  }
  return undefined;
}

function expectationFor(rule) {
  if (rule.accepted) {
    return `one of ${rule.accepted.join(", ")}`;
  }
  if (rule.type === "array") {
    return "an array of strings";
  }
  if (rule.type === "number") {
    return "a number";
  }
  return "a non-empty string";
}

function typeNameOf(value) {
  return Array.isArray(value) ? "array" : typeof value;
}

function success(command, data) {
  return {
    resultType: "success",
    textResultForLlm: JSON.stringify({
      ok: true,
      command,
      data
    })
  };
}

// A rejection travels on the success transport on purpose. The payload says
// ok false, so the caller still sees a failure, while the diagnostic text takes
// the same path as the grease_get not-found guidance, which is known to reach
// the caller intact.
function failure(command, data) {
  return {
    resultType: "success",
    textResultForLlm: JSON.stringify({
      ok: false,
      command,
      ...data
    })
  };
}

function sessionNameFrom(invocation) {
  const value = invocation?.sessionName
    ?? invocation?.sessionTitle
    ?? invocation?.projectSessionName
    ?? invocation?.conversationTitle;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}

function toolCallIdFrom(invocation) {
  // Only fields that name a specific invocation are accepted. A generic id is
  // deliberately excluded: if it were the session or extension id, every repeat
  // of one friction inside a session would collapse into a single occurrence
  // and never be counted again.
  const value = invocation?.toolCallId
    ?? invocation?.callId
    ?? invocation?.invocationId;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}
