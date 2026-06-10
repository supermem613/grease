import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendEvent, getFriction, searchCatalog } from "../.github/extensions/grease/core/catalog.mjs";
import { classifyManualCapture } from "../.github/extensions/grease/core/classifier.mjs";
import { runInCurrentSession } from "../.github/extensions/grease/core/run-current-session.mjs";

test("runInCurrentSession sends prompt and marks items in-progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-run-"));
  const sent = [];
  try {
    const event = classifyManualCapture({
      title: "Local tool timeout",
      summary: "powershell timed out",
      severity: "high",
      kind: "timeout",
      source: "local-tool",
      tags: ["timeout"]
    }, {
      sessionId: "session-1"
    });
    await appendEvent(event, { root });
    const { items } = await searchCatalog({ query: "timeout" }, { root });

    const result = await runInCurrentSession({
      ids: [items[0].id]
    }, {
      root,
      getSession: () => ({
        send: async (message) => sent.push(message)
      })
    });

    assert.equal(result.status, "sent-to-current-session");
    assert.equal(sent.length, 1);
    assert.match(sent[0].prompt, /Grease closure/);
    const updated = await getFriction(items[0].id, { root });
    assert.equal(updated.item.status, "in-progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
