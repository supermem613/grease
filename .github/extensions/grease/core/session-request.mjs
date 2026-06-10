import { buildBrief } from "./brief.mjs";

export async function buildSessionRequest(input = {}, options = {}) {
  const brief = await buildBrief(input, options);
  const title = titleForItems(brief.items);
  return {
    title,
    prompt: brief.prompt,
    itemCount: brief.count,
    itemIds: brief.items.map((item) => item.id),
    items: brief.items,
    completionUpdates: brief.items.map((item) => ({
      id: item.id,
      status: "resolved",
      note: "<what changed and how it was validated>"
    })),
    workingDirectoryHints: workingDirectoryHints(brief.items),
    nextStep: "Create a Copilot project session with this prompt. The host app chooses the project from the working directory hints or asks the user when no project can be inferred."
  };
}

function titleForItems(items) {
  if (items.length === 0) {
    return "Address Grease friction";
  }
  if (items.length === 1) {
    return `Fix ${items[0].title}`;
  }
  const highest = items.find((item) => item.severity === "critical")
    ?? items.find((item) => item.severity === "high")
    ?? items[0];
  return `Fix ${items.length} Grease items starting with ${highest.title}`;
}

function workingDirectoryHints(items) {
  const counts = new Map();
  for (const item of items) {
    for (const dir of item.workingDirectories ?? []) {
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([path, count]) => ({ path, count }));
}
