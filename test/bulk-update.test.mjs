import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendEvent, getFriction, readEvents, searchCatalog, updateFrictionBulk } from "../.github/extensions/grease/core/catalog.mjs";
import { classifySessionEvent } from "../.github/extensions/grease/core/classifier.mjs";
import { createGreaseTools } from "../.github/extensions/grease/core/tools.mjs";

test("updateFrictionBulk closes multiple items atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-bulk-"));
  try {
    const [a] = classifySessionEvent("tool.execution_complete", { success: false, toolName: "alpha.run", error: "Access denied" });
    const [b] = classifySessionEvent("tool.execution_complete", { success: false, toolName: "beta.run", error: "deadline timeout" });
    await appendEvent(a, { root });
    await appendEvent(b, { root });
    const { items } = await searchCatalog({}, { root });
    assert.equal(items.length, 2);
    const ids = items.map((item) => item.id);

    const result = await updateFrictionBulk(ids, { status: "resolved", note: "closed in bulk" }, { root });
    assert.deepEqual([...result.ids].sort(), [...ids].sort());

    for (const id of ids) {
      const updated = await getFriction(id, { root });
      assert.equal(updated.item.status, "resolved");
      assert.equal(updated.item.latestNote, "closed in bulk");
    }

    const events = await readEvents({ root });
    assert.equal(events.filter((event) => event.type === "friction.update").length, ids.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grease_update tool accepts an ids array for bulk close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-bulk-tool-"));
  try {
    const [a] = classifySessionEvent("tool.execution_complete", { success: false, toolName: "gamma.run", error: "EACCES" });
    const [b] = classifySessionEvent("tool.execution_complete", { success: false, toolName: "delta.run", error: "EPERM" });
    await appendEvent(a, { root });
    await appendEvent(b, { root });
    const { items } = await searchCatalog({}, { root });
    const ids = items.map((item) => item.id);

    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const update = tools.get("grease_update");
    const raw = await update.handler({ ids, status: "resolved", note: "bulk via tool" }, {});
    assert.equal(raw.resultType, "success");
    const payload = JSON.parse(raw.textResultForLlm);
    assert.equal(payload.ok, true);
    assert.deepEqual([...payload.data.itemIds].sort(), [...ids].sort());

    for (const id of ids) {
      const updated = await getFriction(id, { root });
      assert.equal(updated.item.status, "resolved");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
