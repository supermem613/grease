import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGreaseTools } from "../.github/extensions/grease/core/tools.mjs";

test("tools capture, brief, and export canvas-ready HTML", async () => {
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

    const sessionRequest = await callTool(tools.get("grease_session_request"), {
      ids: [search.data.items[0].id]
    });
    assert.match(sessionRequest.data.title, /Fix Atrium access denied/);
    assert.match(sessionRequest.data.prompt, /Atrium access denied/);
    assert.deepEqual(sessionRequest.data.itemIds, [search.data.items[0].id]);

    const exportResult = await callTool(tools.get("grease_export_canvas"), {});
    const html = await readFile(exportResult.data.outputPath, "utf8");
    assert.match(html, /<div class="brand">Grease<\/div>/);
    assert.doesNotMatch(html, /Friction triage/);
    assert.match(html, /Atrium access denied/);
    assert.match(html, /Fix session/);
    assert.match(html, /Run in current session/);
    assert.doesNotMatch(html, /Active work/);
    assert.doesNotMatch(html, /id="catalog-title"/);
    assert.doesNotMatch(html, /Search catalog/);
    assert.match(html, /Tool test session/);
    assert.match(html, /Resolved/);
    assert.match(html, /aria-label="Refresh catalog"/);
    assert.ok(html.includes("postJson('/run-current-session'"));
    assert.match(html, /focusFixPanel/);
    assert.match(html, /id="fix-panel"/);
    assert.doesNotMatch(html, /id="prepare" class="primary" disabled/);
    assert.doesNotMatch(html, /Prepare selected/);
    assert.doesNotMatch(html, /Select visible/);
    assert.doesNotMatch(html, /Select high/);
    assert.match(html, /showRequestForSelection/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("README documents safe browser canvas instance ids for live validation", async () => {
  const readme = await readFile(path.resolve(import.meta.dirname, "..", "README.md"), "utf8");

  assert.match(readme, /### Live validation/);
  assert.match(readme, /fresh browser `instanceId`/);
  assert.match(readme, /Do not reuse an `instanceId` across canvas types/);
  assert.match(readme, /CanvasInstanceIdConflictError/);
  assert.match(readme, /do not call `invoke_canvas_action` against an old instance/i);
  assert.match(readme, /CanvasRuntimeError: Canvas instance/);
  assert.match(readme, /Re-issue `open_canvas` first/);
  assert.match(readme, /grease-live-refresh-debug-<short-unique-suffix>/);
});

async function callTool(tool, args) {
  const result = await tool.handler(args, { sessionId: "session-1", sessionName: "Tool test session" });
  assert.equal(result.resultType, "success");
  return JSON.parse(result.textResultForLlm);
}
