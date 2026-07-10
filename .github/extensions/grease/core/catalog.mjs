import { createHash, randomUUID } from "node:crypto";
import { scheduler } from "node:timers/promises";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CATALOG_VERSION = 5;
const ACTIVE_STATUSES = ["open", "triaged", "in-progress"];
const ALL_STATUSES = ["open", "triaged", "in-progress", "resolved", "ignored"];
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_STALE_MS = 30_000;
const FILE_REPLACE_TIMEOUT_MS = 2_000;
const storeWriteQueues = new Map();
let atomicWriteId = 0;

export function defaultStoreRoot() {
  return path.join(os.homedir(), ".grease");
}

export async function appendEvent(event, options = {}) {
  const root = options.root ?? defaultStoreRoot();
  return enqueueStoreWrite(root, async () => {
    await ensureStore(root);
    const normalized = normalizeEvent(event, options);
    await appendFile(eventsPath(root), `${JSON.stringify(normalized)}\n`, "utf8");
    const catalog = await rebuildCatalogUnlocked(root);
    return { event: normalized, catalog };
  });
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
  return enqueueStoreWrite(root, () => rebuildCatalogUnlocked(root));
}

async function rebuildCatalogUnlocked(root) {
  await ensureStore(root);
  const events = await readEvents({ root });
  const sourceEventLogBytes = await readSourceEventLogBytes(root);
  const generationId = buildGenerationId(events, sourceEventLogBytes);
  let generatedAt = new Date().toISOString();
  try {
    const existingCatalog = JSON.parse(await readFile(catalogPath(root), "utf8"));
    if (existingCatalog?.version === CATALOG_VERSION && existingCatalog?.generationId === generationId) {
      generatedAt = existingCatalog.generatedAt;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const catalog = buildCatalog(events, { generatedAt, generationId, sourceEventLogBytes });
  const active = buildActiveProjection(catalog);
  await writeJsonFilesAtomic(root, catalog, active);
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

export async function readActiveCatalog(options = {}) {
  const root = options.root ?? defaultStoreRoot();
  await ensureStore(root);
  const activeFilePath = activePath(root);
  try {
    const active = JSON.parse(await readFile(activeFilePath, "utf8"));
    const sourceEventLogBytes = await readSourceEventLogBytes(root);
    if (active.version !== CATALOG_VERSION || active.sourceEventLogBytes !== sourceEventLogBytes) {
      return rebuildActiveCatalog(root);
    }
    return { ...active, path: activeFilePath };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return rebuildActiveCatalog(root);
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
  const allowed = normalizeFrictionUpdates(updates);
  const event = {
    type: "friction.update",
    at: options.now ?? new Date().toISOString(),
    itemId: id,
    updates: allowed
  };
  return appendEvent(event, options);
}

export async function updateFrictionBulk(ids, updates, options = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("ids must be a non-empty array");
  }
  const allowed = normalizeFrictionUpdates(updates);
  const root = options.root ?? defaultStoreRoot();
  const at = options.now ?? new Date().toISOString();
  return enqueueStoreWrite(root, async () => {
    await ensureStore(root);
    for (const id of ids) {
      if (!id) {
        throw new Error("id is required");
      }
      const normalized = normalizeEvent({
        type: "friction.update",
        at,
        itemId: id,
        updates: allowed
      }, options);
      await appendFile(eventsPath(root), `${JSON.stringify(normalized)}\n`, "utf8");
    }
    const catalog = await rebuildCatalogUnlocked(root);
    return { ids, catalog };
  });
}

export function buildCatalog(events, options = {}) {
  const items = new Map();
  const occurrences = [];
  const updates = [];
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generationId = options.generationId ?? buildGenerationId(events, options.sourceEventLogBytes ?? 0);
  const sourceEventLogBytes = options.sourceEventLogBytes ?? 0;

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
    generatedAt,
    generationId,
    sourceEventLogBytes,
    items: [...items.values()].sort(sortItems),
    occurrences: occurrences.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  };
}

export function pathsForStore(root = defaultStoreRoot()) {
  return {
    root,
    events: eventsPath(root),
    catalog: catalogPath(root),
    active: activePath(root)
  };
}

async function ensureStore(root) {
  await mkdir(root, { recursive: true });
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

function activePath(root) {
  return path.join(root, "active.json");
}

function storeLockPath(root) {
  return path.join(root, "catalog.lock");
}

async function writeJsonFilesAtomic(root, catalog, active) {
  const catalogTempPath = `${catalogPath(root)}.${process.pid}.${Date.now()}.${atomicWriteId++}.tmp`;
  const activeTempPath = `${activePath(root)}.${process.pid}.${Date.now()}.${atomicWriteId++}.tmp`;
  try {
    await Promise.all([
      writeFile(catalogTempPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8"),
      writeFile(activeTempPath, `${JSON.stringify(active)}\n`, "utf8")
    ]);
    await replaceFileWithRetry(catalogTempPath, catalogPath(root));
    await replaceFileWithRetry(activeTempPath, activePath(root));
  } catch (error) {
    await rm(catalogTempPath, { force: true }).catch(() => undefined);
    await rm(activeTempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function enqueueStoreWrite(root, operation) {
  const previous = storeWriteQueues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => withStoreLock(root, operation));
  const tracked = next.finally(() => {
    if (storeWriteQueues.get(root) === tracked) {
      storeWriteQueues.delete(root);
    }
  });
  storeWriteQueues.set(root, tracked);
  return next;
}

async function withStoreLock(root, operation) {
  const release = await acquireStoreLock(root);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireStoreLock(root) {
  await mkdir(root, { recursive: true });
  const lockPath = storeLockPath(root);
  const owner = {
    pid: process.pid,
    id: randomUUID(),
    acquiredAt: new Date().toISOString()
  };
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() - startedAt > STORE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Grease store lock: ${lockPath}`);
      }
      await waitForRetry();
    }
  }
}

async function removeStaleLock(lockPath) {
  let info;
  try {
    info = await stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (Date.now() - info.mtimeMs <= STORE_LOCK_STALE_MS) {
    return;
  }
  await rm(lockPath, { recursive: true, force: true });
}

async function replaceFileWithRetry(sourcePath, targetPath) {
  const startedAt = Date.now();
  while (true) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!isRetryableReplaceError(error) || Date.now() - startedAt > FILE_REPLACE_TIMEOUT_MS) {
        throw error;
      }
      await waitForRetry();
    }
  }
}

function isRetryableReplaceError(error) {
  return error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
}

async function waitForRetry() {
  await scheduler.wait(25);
}

function buildGenerationId(events, sourceEventLogBytes) {
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  return hash([
    String(CATALOG_VERSION),
    String(sourceEventLogBytes),
    String(events.length),
    String(lastEvent?.id ?? ""),
    String(lastEvent?.at ?? ""),
    String(lastEvent?.type ?? "")
  ]);
}

function buildActiveProjection(catalog) {
  const items = (catalog.items ?? []).filter((item) => ACTIVE_STATUSES.includes(item.status));
  const statusCounts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0]));
  for (const item of catalog.items ?? []) {
    if (statusCounts[item.status] !== undefined) {
      statusCounts[item.status] += 1;
    }
  }
  const activeIds = new Set(items.map((item) => item.id));
  const occurrences = [];
  for (const occurrence of catalog.occurrences ?? []) {
    if (activeIds.has(occurrence.frictionId)) {
      occurrences.push({ ...occurrence });
    }
  }
  return {
    version: catalog.version,
    generatedAt: catalog.generatedAt,
    generationId: catalog.generationId,
    sourceEventLogBytes: catalog.sourceEventLogBytes,
    items: items.map((item) => ({ ...item })),
    occurrences,
    statusCounts
  };
}

async function rebuildActiveCatalog(root) {
  await rebuildCatalog({ root });
  const activeFilePath = activePath(root);
  const projection = JSON.parse(await readFile(activeFilePath, "utf8"));
  return { ...projection, path: activeFilePath };
}

async function readSourceEventLogBytes(root) {
  try {
    return (await stat(eventsPath(root))).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
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

function normalizeFrictionUpdates(updates) {
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
  return allowed;
}

function requireOneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}
