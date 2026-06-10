import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CATALOG_VERSION = 4;

export function defaultStoreRoot() {
  return path.join(os.homedir(), ".grease");
}

export async function appendEvent(event, options = {}) {
  const root = options.root ?? defaultStoreRoot();
  await ensureStore(root);
  const normalized = normalizeEvent(event, options);
  await appendFile(eventsPath(root), `${JSON.stringify(normalized)}\n`, "utf8");
  const catalog = await rebuildCatalog({ root });
  return { event: normalized, catalog };
}

export async function readEvents(options = {}) {
  const root = options.root ?? defaultStoreRoot();
  await ensureStore(root);
  let text;
  try {
    text = await readFile(eventsPath(root), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Grease event log is not valid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

export async function rebuildCatalog(options = {}) {
  const root = options.root ?? defaultStoreRoot();
  await ensureStore(root);
  const events = await readEvents({ root });
  const catalog = buildCatalog(events);
  await writeJsonAtomic(catalogPath(root), catalog);
  return catalog;
}

export async function readCatalog(options = {}) {
  const root = options.root ?? defaultStoreRoot();
  await ensureStore(root);
  try {
    const catalog = JSON.parse(await readFile(catalogPath(root), "utf8"));
    if (catalog.version !== CATALOG_VERSION) {
      return rebuildCatalog({ root });
    }
    return catalog;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return rebuildCatalog({ root });
    }
    throw error;
  }
}

export async function searchCatalog(query = {}, options = {}) {
  const catalog = await readCatalog(options);
  const text = String(query.query ?? "").toLowerCase();
  const status = query.status ? String(query.status) : undefined;
  const limit = Number.isInteger(query.limit) ? query.limit : 25;
  const items = catalog.items
    .filter((item) => !status || item.status === status)
    .filter((item) => {
      if (!text) {
        return true;
      }
      return [
        item.id,
        item.title,
        item.latestSummary,
        item.kind,
        item.source,
        ...(item.machineNames ?? []),
        ...(item.sessionNames ?? []),
        ...(item.origins ?? []).flatMap((origin) => [
          origin.machineName,
          origin.sessionName,
          origin.sessionId,
          origin.workingDirectory
        ]),
        ...(item.tags ?? [])
      ].join("\n").toLowerCase().includes(text);
    })
    .sort(sortItems)
    .slice(0, Math.max(1, Math.min(limit, 100)));
  return { catalog, items };
}

export async function getFriction(id, options = {}) {
  const catalog = await readCatalog(options);
  const item = catalog.items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`Unknown friction item: ${id}`);
  }
  const occurrences = catalog.occurrences.filter((occurrence) => occurrence.frictionId === id);
  return { item, occurrences };
}

export async function updateFriction(id, updates, options = {}) {
  if (!id) {
    throw new Error("id is required");
  }
  const allowed = {};
  if (updates.status !== undefined) {
    allowed.status = requireOneOf(updates.status, ["open", "triaged", "in-progress", "resolved", "ignored"], "status");
  }
  if (updates.severity !== undefined) {
    allowed.severity = requireOneOf(updates.severity, ["low", "medium", "high", "critical"], "severity");
  }
  if (updates.tags !== undefined) {
    if (!Array.isArray(updates.tags)) {
      throw new Error("tags must be an array");
    }
    allowed.tags = [...new Set(updates.tags.map((tag) => String(tag).trim()).filter(Boolean))];
  }
  if (updates.note !== undefined) {
    allowed.note = String(updates.note);
  }
  const event = {
    type: "friction.update",
    at: options.now ?? new Date().toISOString(),
    itemId: id,
    updates: allowed
  };
  return appendEvent(event, options);
}

export function buildCatalog(events) {
  const items = new Map();
  const occurrences = [];
  const updates = [];

  for (const event of events) {
    if (event.type === "friction.signal") {
      const signal = event.signal ?? {};
      const id = event.frictionId ?? fingerprintSignal(event);
      const occurrence = {
        id: event.id,
        frictionId: id,
        at: event.at,
        sessionId: event.sessionId,
        sessionName: event.sessionName,
        machineName: event.machineName ?? os.hostname(),
        workingDirectory: event.workingDirectory,
        kind: signal.kind ?? "unknown",
        source: signal.source ?? "unknown",
        severity: signal.severity ?? "medium",
        title: signal.title ?? "Friction captured",
        summary: signal.summary ?? "",
        tags: signal.tags ?? [],
        evidence: signal.evidence ?? {}
      };
      occurrences.push(occurrence);
      const existing = items.get(id);
      if (existing) {
        existing.lastSeen = maxTime(existing.lastSeen, event.at);
        existing.occurrenceCount += 1;
        existing.sessionIds = sortedUnique([...existing.sessionIds, event.sessionId].filter(Boolean));
        existing.sessionNames = sortedUnique([...existing.sessionNames, occurrence.sessionName].filter(Boolean));
        existing.machineNames = sortedUnique([...existing.machineNames, occurrence.machineName].filter(Boolean));
        existing.workingDirectories = sortedUnique([...existing.workingDirectories, event.workingDirectory].filter(Boolean));
        existing.origins = mergeOrigins(existing.origins, occurrence);
        existing.tags = sortedUnique([...existing.tags, ...occurrence.tags]);
        existing.latestSummary = occurrence.summary || existing.latestSummary;
        existing.severity = maxSeverity(existing.severity, occurrence.severity);
      } else {
        items.set(id, {
          id,
          title: occurrence.title,
          status: "open",
          severity: occurrence.severity,
          kind: occurrence.kind,
          source: occurrence.source,
          firstSeen: event.at,
          lastSeen: event.at,
          occurrenceCount: 1,
          tags: sortedUnique(occurrence.tags),
          sessionIds: event.sessionId ? [event.sessionId] : [],
          sessionNames: occurrence.sessionName ? [occurrence.sessionName] : [],
          machineNames: occurrence.machineName ? [occurrence.machineName] : [],
          workingDirectories: event.workingDirectory ? [event.workingDirectory] : [],
          origins: mergeOrigins([], occurrence),
          latestSummary: occurrence.summary
        });
      }
    } else if (event.type === "friction.update") {
      updates.push(event);
    }
  }

  for (const update of updates) {
    const item = items.get(update.itemId);
    if (!item) {
      continue;
    }
    const changes = update.updates ?? {};
    if (changes.status) {
      item.status = changes.status;
    }
    if (changes.severity) {
      item.severity = changes.severity;
    }
    if (changes.tags) {
      item.tags = sortedUnique([...item.tags, ...changes.tags]);
    }
    if (changes.note) {
      item.latestNote = changes.note;
    }
    item.updatedAt = update.at;
  }

  return {
    version: CATALOG_VERSION,
    generatedAt: new Date().toISOString(),
    items: [...items.values()].sort(sortItems),
    occurrences: occurrences.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  };
}

export function pathsForStore(root = defaultStoreRoot()) {
  return {
    root,
    events: eventsPath(root),
    catalog: catalogPath(root),
    canvasDir: path.join(root, "canvas")
  };
}

async function ensureStore(root) {
  await mkdir(root, { recursive: true });
  await mkdir(path.join(root, "canvas"), { recursive: true });
}

function normalizeEvent(event, options) {
  if (!event || typeof event !== "object") {
    throw new Error("event must be an object");
  }
  if (!event.type) {
    throw new Error("event.type is required");
  }
  const at = event.at ?? options.now ?? new Date().toISOString();
  return {
    ...event,
    id: event.id ?? fingerprintEvent(event, at),
    at,
    machineName: event.machineName ?? options.machineName ?? os.hostname()
  };
}

function fingerprintSignal(event) {
  const signal = event.signal ?? {};
  return hash([
    signal.kind,
    signal.source,
    signal.title,
    event.workingDirectory,
    signal.evidence?.toolName,
    signal.evidence?.resultType
  ]);
}

function fingerprintEvent(event, at) {
  return hash([event.type, at, JSON.stringify(event)]);
}

function hash(parts) {
  const digest = createHash("sha256");
  digest.update(parts.map((part) => String(part ?? "")).join("\u001f"));
  return digest.digest("hex").slice(0, 16);
}

function eventsPath(root) {
  return path.join(root, "events.jsonl");
}

function catalogPath(root) {
  return path.join(root, "catalog.json");
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function sortItems(a, b) {
  const severity = severityRank(b.severity) - severityRank(a.severity);
  if (severity !== 0) {
    return severity;
  }
  return String(b.lastSeen).localeCompare(String(a.lastSeen));
}

function severityRank(value) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[value] ?? 2;
}

function maxSeverity(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function maxTime(a, b) {
  return String(a).localeCompare(String(b)) >= 0 ? a : b;
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function mergeOrigins(existing, occurrence) {
  const origins = new Map((existing ?? []).map((origin) => [originKey(origin), { ...origin }]));
  const next = {
    machineName: occurrence.machineName,
    sessionName: occurrence.sessionName,
    sessionId: occurrence.sessionId,
    workingDirectory: occurrence.workingDirectory,
    lastSeen: occurrence.at,
    count: 1
  };
  const key = originKey(next);
  const current = origins.get(key);
  if (current) {
    current.count += 1;
    current.lastSeen = maxTime(current.lastSeen, occurrence.at);
  } else {
    origins.set(key, next);
  }
  return [...origins.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

function originKey(origin) {
  return [
    origin.machineName,
    origin.sessionName,
    origin.sessionId,
    origin.workingDirectory
  ].map((value) => String(value ?? "")).join("\u001f");
}

function requireOneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}
