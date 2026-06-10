import { appendEvent, getFriction, pathsForStore, readCatalog, searchCatalog, updateFriction } from "./catalog.mjs";
import { buildBrief } from "./brief.mjs";
import { classifyManualCapture } from "./classifier.mjs";
import { exportCanvas } from "./canvas.mjs";
import { buildSessionRequest } from "./session-request.mjs";

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
      description: "Manually capture a source of friction when passive capture is not enough.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          kind: { type: "string" },
          source: { type: "string" },
          machineName: { type: "string" },
          sessionName: { type: "string" },
          workingDirectory: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          evidence: {}
        },
        required: ["title", "summary"]
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
      description: "Update a Grease friction item's status, severity, tags, or note.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["open", "triaged", "in-progress", "resolved", "ignored"] },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          tags: { type: "array", items: { type: "string" } },
          note: { type: "string" }
        },
        required: ["id"]
      },
      handler: async (args) => {
        const { id, ...updates } = args;
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
    },
    {
      name: "grease_export_canvas",
      description: "Export a canvas-ready HTML board for the Grease friction catalog.",
      parameters: {
        type: "object",
        properties: {
          outputPath: { type: "string" }
        }
      },
      handler: async (args) => {
        return success("grease_export_canvas", await exportCanvas(args, options));
      }
    },
    {
      name: "grease_session_request",
      description: "Prepare a structured Copilot session request from selected or searched Grease friction items.",
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
        return success("grease_session_request", await buildSessionRequest(args, options));
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
