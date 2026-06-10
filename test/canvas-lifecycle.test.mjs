import test from "node:test";
import assert from "node:assert/strict";
import { catalogSignature, renderHtml } from "../.github/extensions/grease/core/canvas.mjs";

test("canvas renders lifecycle controls and active/resolved filtering", () => {
  const html = renderHtml({
    generatedAt: "2026-06-09T13:00:00.000Z",
    items: [
      {
        id: "open-1",
        title: "Open item",
        status: "open",
        severity: "high",
        kind: "timeout",
        source: "mcp",
        lastSeen: "2026-06-09T12:00:00.000Z",
        occurrenceCount: 1,
        tags: ["mcp"],
        machineNames: ["devbox-1"],
        sessionNames: ["Grease polish"],
        latestSummary: "Still active"
      },
      {
        id: "progress-1",
        title: "Working item",
        status: "in-progress",
        severity: "medium",
        kind: "local-tool-error",
        source: "local-tool",
        lastSeen: "2026-06-09T12:10:00.000Z",
        updatedAt: "2026-06-09T12:20:00.000Z",
        occurrenceCount: 2,
        tags: ["tool"],
        machineNames: ["devbox-2"],
        sessionNames: ["Fix session"],
        latestSummary: "Being fixed"
      },
      {
        id: "resolved-1",
        title: "Resolved item",
        status: "resolved",
        severity: "high",
        kind: "access-denied",
        source: "local-tool",
        lastSeen: "2026-06-09T11:00:00.000Z",
        occurrenceCount: 1,
        tags: ["done"],
        machineNames: ["devbox-3"],
        sessionNames: ["Closed session"],
        latestSummary: "Already fixed"
      },
      {
        id: "ignored-1",
        title: "Ignored item",
        status: "ignored",
        severity: "low",
        kind: "manual",
        source: "validation",
        lastSeen: "2026-06-09T10:00:00.000Z",
        occurrenceCount: 1,
        tags: ["ignored"],
        latestSummary: "Deleted from the canvas"
      }
    ]
  });

  assert.match(html, /<div class="brand">Grease<\/div>/);
  assert.match(html, /<strong>Working<\/strong>/);
  assert.match(html, /Resolved/);
  assert.doesNotMatch(html, /Active work/);
  assert.doesNotMatch(html, /Open, triaged, and in-progress friction/);
  assert.doesNotMatch(html, /id="catalog-title"/);
  assert.doesNotMatch(html, /id="catalog-subtitle"/);
  assert.doesNotMatch(html, /class="list-head"/);
  assert.doesNotMatch(html, /Friction triage/);
  assert.doesNotMatch(html, /Select items and the fix prompt stays ready/);
  assert.doesNotMatch(html, /class="metrics"/);
  assert.doesNotMatch(html, /class="metric"/);
  assert.match(html, /Preparing session request/);
  assert.match(html, /showRequestForSelection/);
  assert.match(html, /postJson\('\/session-request', \{ ids \}\)/);
  assert.match(html, /Selected items are already closed\. Refresh the canvas\./);
  assert.match(html, /id="refresh-page"/);
  assert.match(html, /aria-label="Refresh catalog"/);
  assert.match(html, /<header>[\s\S]*id="refresh-page"/);
  assert.doesNotMatch(html, /Select visible/);
  assert.doesNotMatch(html, /Select high/);
  assert.doesNotMatch(html, /Prepare selected/);
  assert.doesNotMatch(html, /Search catalog/);
  assert.doesNotMatch(html, /id="search"/);
  assert.match(html, /class="delete-item"/);
  assert.match(html, /data-delete="open-1"/);
  assert.match(html, /\/delete-item/);
  assert.match(html, /Deleted item/);
  assert.doesNotMatch(html, /id="clear"/);
  assert.doesNotMatch(html, /id="prepare"/);
  assert.doesNotMatch(html, /id="select-high"/);
  assert.doesNotMatch(html, /id="select-all"/);
  assert.doesNotMatch(html, /data-delete="ignored-1"/);
  assert.match(html, /id="refresh-status"/);
  assert.match(html, /\/catalog\.json/);
  assert.match(html, /pollCatalogForChanges/);
  assert.match(html, /Catalog changed\. Refreshing\./);
  assert.match(html, /Refresh paused:/);
  assert.match(html, /grease-filter/);
  assert.match(html, /savedFilter/);
  assert.doesNotMatch(html, /titleForFilter/);
  assert.match(html, /status-in-progress/);
  assert.match(html, /status-resolved/);
  assert.match(html, /\.row\[hidden\]/);
  assert.match(html, /visibleByStatus/);
  assert.match(html, /markRowsInProgress/);
  assert.match(html, /devbox-1 · Grease polish/);
  assert.doesNotMatch(html, /detail-machine/);
  assert.doesNotMatch(html, /detail-session/);
  assert.doesNotMatch(html, /detail-grid/);
  assert.match(html, /<strong>Resolved<\/strong>\s+<span>2 items<\/span>/);
});

test("catalog signature changes when item lifecycle state changes", () => {
  const catalog = {
    items: [
      {
        id: "item-1",
        status: "in-progress",
        severity: "medium",
        lastSeen: "2026-06-09T12:00:00.000Z",
        occurrenceCount: 1
      }
    ]
  };

  const before = catalogSignature(catalog);
  const after = catalogSignature({
    items: [
      {
        ...catalog.items[0],
        status: "resolved",
        updatedAt: "2026-06-09T12:05:00.000Z",
        latestNote: "Fixed"
      }
    ]
  });

  assert.notEqual(before, after);
});
