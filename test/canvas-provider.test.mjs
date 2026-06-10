import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendEvent, getFriction, searchCatalog } from "../.github/extensions/grease/core/catalog.mjs";
import { startServer } from "../.github/extensions/grease/core/canvas-server.mjs";
import { classifyManualCapture } from "../.github/extensions/grease/core/classifier.mjs";

test("canvas delete endpoint marks one item ignored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-canvas-"));
  let server;
  try {
    const event = classifyManualCapture({
      title: "Delete me",
      summary: "Manual item to remove from active canvas",
      severity: "low",
      kind: "manual",
      source: "validation"
    });
    await appendEvent(event, { root });
    const { items } = await searchCatalog({ query: "Delete me" }, { root });
    assert.equal(items.length, 1);

    const started = await startServer({ root });
    server = started.server;
    const response = await fetch(new URL("/delete-item", started.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: items[0].id })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.status, "ignored");
    const updated = await getFriction(items[0].id, { root });
    assert.equal(updated.item.status, "ignored");
    assert.equal(updated.item.latestNote, "Deleted from the Grease canvas.");
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
