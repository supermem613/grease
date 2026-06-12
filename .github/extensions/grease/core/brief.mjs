import { getFriction, searchCatalog } from "./catalog.mjs";

const GUARDRAIL_TEXT = /\b(search-policy|content\s+policy|content\s+exclusion|excluded\s+by\s+organization\s+content\s+policy|denied\s+by\s+pretooluse\s+hook|blocked\s+by\s+policy|policy\s+denied)\b/i;

export async function buildBrief(input = {}, options = {}) {
  const selected = [];
  if (Array.isArray(input.ids) && input.ids.length > 0) {
    for (const id of input.ids) {
      const selectedItem = await getFriction(id, options);
      if (input.includeClosed === true || isActionableStatus(selectedItem.item.status)) {
        selected.push(selectedItem);
      }
    }
  } else {
    const result = await searchCatalog({
      query: input.query,
      status: input.status ?? "open",
      limit: input.limit ?? 5
    }, options);
    for (const item of result.items) {
      selected.push({
        item,
        occurrences: result.catalog.occurrences.filter((occurrence) => occurrence.frictionId === item.id)
      });
    }
  }

  const lines = selected.length === 0
    ? [
      "No active Grease friction items matched this request.",
      "",
      "The selected items may already be resolved or ignored. Refresh the Grease canvas before creating a fix session."
    ]
    : [
      "Address these Grease friction items. Root cause each one, make the smallest safe fix, and validate the result.",
      ""
    ];

  if (selected.some(({ item }) => isGuardrailItem(item))) {
    lines.push("## Guardrail root cause");
    lines.push("Do not fix guardrail hits by weakening the guardrail, marking them ignored, or teaching agents to bypass policy.");
    lines.push("Root cause why the agent attempted the blocked action in the first place. Check the prompt, loaded skill instructions, tool-selection defaults, fallback path, subagent context, MCP/tool exposure, and copied command shape. Fix the source that led to the forbidden tool or path so the next agent naturally uses the approved route.");
    lines.push("");
  }

  for (const { item, occurrences } of selected) {
    lines.push(`## ${item.title}`);
    lines.push(`- id: ${item.id}`);
    lines.push(`- severity: ${item.severity}`);
    lines.push(`- status: ${item.status}`);
    lines.push(`- occurrences: ${item.occurrenceCount}`);
    lines.push(`- tags: ${item.tags.join(", ") || "none"}`);
    lines.push(`- origins: ${formatOrigins(item)}`);
    lines.push(`- latest summary: ${item.latestSummary || "none"}`);
    const latest = occurrences[0];
    if (latest?.workingDirectory) {
      lines.push(`- latest working directory: ${latest.workingDirectory}`);
    }
    if (latest?.evidence?.toolName) {
      lines.push(`- latest tool: ${latest.evidence.toolName}`);
    }
    if (latest?.evidence?.error) {
      lines.push(`- latest error: ${latest.evidence.error}`);
    }
    lines.push("");
  }

  if (selected.length > 0) {
    lines.push("## Grease closure");
    lines.push("When the fix is validated, mark each item resolved with `grease_update`.");
    lines.push("If the work is blocked or only partially fixed, leave the item open or in-progress and add a note with the blocker.");
    for (const { item } of selected) {
      lines.push(`- grease_update id=${item.id} status=resolved note="<what changed and how it was validated>"`);
    }
  }

  return {
    count: selected.length,
    items: selected.map(({ item }) => item),
    prompt: lines.join("\n").trim()
  };
}

function isActionableStatus(status) {
  return status !== "resolved" && status !== "ignored";
}

function isGuardrailItem(item) {
  return item.kind === "policy-block"
    || (item.tags ?? []).includes("guardrail")
    || GUARDRAIL_TEXT.test(item.latestSummary ?? "");
}

function formatOrigins(item) {
  const origins = item.origins ?? [];
  if (origins.length > 0) {
    return origins.slice(0, 3).map((origin) => {
      const machine = origin.machineName ?? "unknown machine";
      const session = origin.sessionName ?? (origin.sessionId ? `session ${String(origin.sessionId).slice(0, 8)}` : "unknown session");
      return `${machine} / ${session}`;
    }).join("; ");
  }
  const machines = item.machineNames?.join(", ") || "unknown machine";
  const sessions = item.sessionNames?.join(", ")
    || item.sessionIds?.map((id) => `session ${String(id).slice(0, 8)}`).join(", ")
    || "unknown session";
  return `${machines} / ${sessions}`;
}
