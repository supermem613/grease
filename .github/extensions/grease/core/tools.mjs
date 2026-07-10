import { appendEvent, getFriction, pathsForStore, readCatalog, searchCatalog, updateFriction, updateFrictionBulk } from "./catalog.mjs";
import { buildBrief } from "./brief.mjs";
import { classifyManualCapture } from "./classifier.mjs";

export function createGreaseTools(options = {}) {
  return [
    {
      name: "grease_status",
      description: "Show Grease catalog health and friction counts.",
      parameters: {
        type: "object",
        properties: {}
      },
      handler: async () => {
        const catalog = await readCatalog(options);
        const open = catalog.items.filter((item) => item.status === "open").length;
        return success("grease_status", {
          counts: {
            total: catalog.items.length,
            open
          },
          paths: pathsForStore(options.root)
        });
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
        const event = classifyManualCapture(args, {
          sessionId: invocation?.sessionId,
          sessionName: sessionNameFrom(invocation),
          now: options.now?.()
        });
        const result = await appendEvent(event, options);
        return success("grease_capture", {
          eventId: result.event.id,
          itemCount: result.catalog.items.length
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
        const result = await searchCatalog(args, options);
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
        return success("grease_get", await getFriction(args.id, options));
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
        if (Array.isArray(ids) && ids.length > 0) {
          const result = await updateFrictionBulk(ids, updates, options);
          return success("grease_update", {
            itemIds: result.ids,
            itemCount: result.catalog.items.length
          });
        }
        const result = await updateFriction(id, updates, options);
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
        return success("grease_brief", await buildBrief(args, options));
      }
    }
  ];
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
