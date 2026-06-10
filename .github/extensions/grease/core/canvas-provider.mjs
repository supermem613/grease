import { createCanvas } from "@github/copilot-sdk/extension";
import { exportCanvas } from "./canvas.mjs";
import { readCatalog } from "./catalog.mjs";
import { startServer } from "./canvas-server.mjs";
import { buildSessionRequest } from "./session-request.mjs";
import { runInCurrentSession } from "./run-current-session.mjs";

const servers = new Map();

export function createGreaseCanvas(options = {}) {
  return createCanvas({
    id: "grease",
    displayName: "Grease",
    description: "Inspect captured friction, evidence, severity, and status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        query: { type: "string" }
      }
    },
    actions: [
      {
        name: "refresh_catalog",
        description: "Refresh the Grease canvas catalog summary.",
        inputSchema: {
          type: "object",
          properties: {}
        },
        handler: async () => {
          const catalog = await readCatalog(options);
          return {
            ok: true,
            itemCount: catalog.items.length,
            openCount: catalog.items.filter((item) => item.status === "open").length
          };
        }
      },
      {
        name: "prepare_fix_session",
        description: "Prepare a Copilot session request from selected Grease friction items.",
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" } },
            query: { type: "string" },
            status: { type: "string" },
            limit: { type: "number" }
          }
        },
        handler: async (ctx) => {
          return {
            ok: true,
            ...(await buildSessionRequest(ctx.input ?? {}, options))
          };
        }
      },
      {
        name: "run_in_current_session",
        description: "Send selected Grease friction items to the current Copilot session as a fix prompt.",
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" } },
            query: { type: "string" },
            status: { type: "string" },
            limit: { type: "number" }
          }
        },
        handler: async (ctx) => {
          return {
            ok: true,
            ...(await runInCurrentSession(ctx.input ?? {}, options))
          };
        }
      },
      {
        name: "export_html",
        description: "Export the current Grease catalog to a standalone HTML file.",
        inputSchema: {
          type: "object",
          properties: {
            outputPath: { type: "string" }
          }
        },
        handler: async (ctx) => {
          return {
            ok: true,
            ...(await exportCanvas(ctx.input ?? {}, options))
          };
        }
      }
    ],
    open: async (ctx) => {
      let entry = servers.get(ctx.instanceId);
      if (!entry) {
        entry = await startServer(options);
        servers.set(ctx.instanceId, entry);
      }
      return {
        title: "Grease",
        url: entry.url
      };
    },
    onClose: async (ctx) => {
      const entry = servers.get(ctx.instanceId);
      if (entry) {
        servers.delete(ctx.instanceId);
        await new Promise((resolve) => entry.server.close(resolve));
      }
    }
  });
}
