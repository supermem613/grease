import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendEvent, updateFriction } from "../.github/extensions/grease/core/catalog.mjs";
import { classifyManualCapture } from "../.github/extensions/grease/core/classifier.mjs";
import { buildSessionRequest } from "../.github/extensions/grease/core/session-request.mjs";

test("builds a structured session request from selected friction items", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-session-"));
  try {
    const event = classifyManualCapture({
      title: "Atrium timeout",
      summary: "atrium.run timed out",
      severity: "high",
      kind: "timeout",
      source: "mcp",
      tags: ["atrium"]
    }, {
      sessionId: "session-1",
      workingDirectory: "C:\\repos\\xray"
    });

    await appendEvent(event, { root });

    const request = await buildSessionRequest({ query: "atrium", limit: 1 }, { root });

    assert.equal(request.itemCount, 1);
    assert.match(request.title, /Fix Atrium timeout/);
    assert.match(request.prompt, /Root cause/);
    assert.match(request.prompt, /Grease closure/);
    assert.deepEqual(request.completionUpdates, [{
      id: request.itemIds[0],
      status: "resolved",
      note: "<what changed and how it was validated>"
    }]);
    assert.match(request.nextStep, /Create a Copilot project session/);
    assert.deepEqual(request.workingDirectoryHints, [{
      path: "C:\\repos\\xray",
      count: 1
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected resolved items do not produce stale fix session prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-session-"));
  try {
    const event = classifyManualCapture({
      title: "Stale canvas item",
      summary: "A stale canvas still has this item selected",
      severity: "medium",
      kind: "tool-error",
      source: "tool"
    }, {
      sessionId: "session-1"
    });
    const { catalog } = await appendEvent(event, { root });
    const id = catalog.items[0].id;
    await updateFriction(id, {
      status: "resolved",
      note: "Already fixed"
    }, { root });

    const request = await buildSessionRequest({ ids: [id] }, { root });

    assert.equal(request.itemCount, 0);
    assert.deepEqual(request.itemIds, []);
    assert.match(request.prompt, /No active Grease friction items matched this request/);
    assert.match(request.prompt, /already be resolved or ignored/);
    assert.doesNotMatch(request.prompt, /grease_update id=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy-block prompts preserve captured evidence without owning policy guidance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-policy-"));
  try {
    const event = classifyManualCapture({
      title: "tool was blocked by policy",
      summary: "Denied by preToolUse hook: Direct rg, grep, xray, find, and findstr calls are blocked by search-policy.",
      severity: "high",
      kind: "policy-block",
      source: "tool",
      tags: ["policy-block"]
    }, {
      sessionId: "session-1"
    });
    const { catalog } = await appendEvent(event, { root });

    const request = await buildSessionRequest({ ids: [catalog.items[0].id] }, { root });

    assert.match(request.prompt, /## tool was blocked by policy/);
    assert.match(request.prompt, /latest summary: Denied by preToolUse hook/);
    assert.match(request.prompt, /Grease closure/);
    assert.doesNotMatch(request.prompt, /## Tooling constraints/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
