import { createServer } from "node:http";
import { catalogSignature, renderHtml } from "./canvas.mjs";
import { readCatalog, updateFriction } from "./catalog.mjs";
import { buildSessionRequest } from "./session-request.mjs";
import { runInCurrentSession } from "./run-current-session.mjs";

export async function startServer(options = {}) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/session-request") {
        const input = await readJsonBody(request);
        const requestBody = await buildSessionRequest(input, options);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end(JSON.stringify({ ok: true, data: requestBody }));
        return;
      }
      if (request.method === "POST" && request.url === "/run-current-session") {
        const input = await readJsonBody(request);
        const runResult = await runInCurrentSession(input, options);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end(JSON.stringify({ ok: true, data: runResult }));
        return;
      }
      if (request.method === "POST" && request.url === "/delete-item") {
        const input = await readJsonBody(request);
        if (!input.id || typeof input.id !== "string") {
          throw new Error("delete-item requires an id");
        }
        const result = await updateFriction(input.id, {
          status: "ignored",
          note: "Deleted from the Grease canvas."
        }, options);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end(JSON.stringify({
          ok: true,
          data: {
            id: input.id,
            status: "ignored",
            eventId: result.event.id,
            itemCount: result.catalog.items.length
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/catalog.json") {
        const catalog = await readCatalog(options);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end(JSON.stringify({
          ok: true,
          data: {
            generatedAt: catalog.generatedAt,
            itemCount: catalog.items.length,
            signature: catalogSignature(catalog)
          }
        }));
        return;
      }
      if (request.url !== "/" && request.url !== "/index.html") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const catalog = await readCatalog(options);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(renderHtml(catalog));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Grease canvas failed: ${error.message}`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}/`
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}
