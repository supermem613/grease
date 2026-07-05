import test from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGreaseTools } from "../.github/extensions/grease/core/tools.mjs";

test("tools capture, search, and brief", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grease-test-"));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const capture = await callTool(tools.get("grease_capture"), {
      title: "Atrium access denied",
      summary: "atrium.run returned access denied while calling xray",
      severity: "high",
      kind: "access-denied",
      source: "mcp",
      tags: ["atrium", "mcp"]
    });
    assert.equal(capture.ok, true);

    const search = await callTool(tools.get("grease_search"), {
      query: "atrium"
    });
    assert.equal(search.data.items.length, 1);
    assert.deepEqual(search.data.items[0].sessionNames, ["Tool test session"]);
    assert.ok(search.data.items[0].machineNames.length > 0);

    const brief = await callTool(tools.get("grease_brief"), {
      ids: [search.data.items[0].id]
    });
    assert.match(brief.data.prompt, /Atrium access denied/);
    assert.match(brief.data.prompt, /origins: .*Tool test session/);
    assert.match(brief.data.prompt, /Root cause/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function callTool(tool, args) {
  const result = await tool.handler(args, { sessionId: "session-1", sessionName: "Tool test session" });
  assert.equal(result.resultType, "success");
  return JSON.parse(result.textResultForLlm);
}
