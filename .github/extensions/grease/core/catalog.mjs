import { createHash, randomUUID } from "node:crypto";
import { scheduler } from "node:timers/promises";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CATALOG_VERSION = 6;
const ACTIVE_STATUSES = ["open", "triaged", "in-progress"];
const ALL_STATUSES = ["open", "triaged", "in-progress", "resolved", "ignored"];
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_GRACE_MS = 5_000;
const FILE_REPLACE_TIMEOUT_MS = 2_000;
const projectionWriteQueues = new Map();
const appendWriteQueues = new Map();
const disabledActiveProjectionRoots = new Set();
const PROCESS_START_TIME_MS = Date.now() - Math.floor(process.uptime() * 1000);
const CATALOG_TEMP_PATTERN = /^catalog\.json\.\d+\.\d+\.\d+\.tmp$/;
const ACTIVE_TEMP_PATTERN = /^active\.json\.\d+\.\d+\.\d+\.tmp$/;
let atomicWriteId = 0;

export function defaultStoreRoot() {
  return path.join(os.homedir(), ".grease");
}

export async function appendEvent(event, options = {}) {
  const root = options.root ?? defaultStoreRoot();
  const normalized = await enqueueAppendWrite(root, async () => {
    await ensureStore(root);
    const entry = normalizeEvent(event, options);
    await appendFile(eventsPath(root), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  });
  await maintainProjectionAfterAppend(root);
  return { event: normalized };
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
  return enqueueProjectionWrite(root, () => rebuildCatalogUnlocked(root));
}

async function rebuildCatalogUnlocked(root) {
  await ensureStore(root);
  const boundary = await captureEventLogBoundary(root);
  const generationId = buildGenerationId(boundary.events, boundary.size, boundary.mtimeMs);
  const generatedAt = new Date().toISOString();
  const catalog = buildCatalog(boundary.events, {
    generatedAt,
    generationId,
    sourceEventLogBytes: boundary.size,
    sourceEventLogMtimeMs: boundary.mtimeMs
  });
  const active = buildActiveProjection(catalog);
  await writeJsonFilesAtomic(root, catalog, active);
  return catalog;
}

async function maintainProjectionAfterAppend(root) {
  // Capture never waits on projection work. Take the projection lock only if it
  // is free. If a rebuild or repair already holds it, that holder sweeps temps
  // and refreshes the projection, so this append returns without blocking.
  const release = await tryAcquireProjectionLock(root);
  if (!release) {
    return;
  }
  try {
    await sweepOrphanTempFiles(root);
    try {
      await stat(catalogPath(root));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await rebuildCatalogUnlocked(root);
    }
  } finally {
    await release();
  }
}

async function captureEventLogBoundary(root) {
  let handle;
  try {
    handle = await open(eventsPath(root), "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { events: [], size: 0, mtimeMs: 0 };
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(info.size);
    if (info.size > 0) {
      await handle.read(buffer, 0, info.size, 0);
    }
    // The rebuild is pinned to this captured byte offset and identity. Appends
    // that land after the boundary grow the file past info.size and are ignored
    // here, so the published generation stays internally consistent.
    return { events: parseEventLogBuffer(buffer), size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

function parseEventLogBuffer(buffer) {
  const lines = buffer.toString("utf8").split("\n");
  // A trailing segment without a newline is a partial append past the captured
  // boundary and must not be parsed as a complete event.
  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.pop();
  }
  const events = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      continue;
    }
    events.push(JSON.parse(line));
  }
  return events;
}

export async function readCatalog(options = {}) {
  const root = options.root ?? defaultStoreRoot();
  await ensureStore(root);
  const validation = await validateCatalogProjection(root);
  if (validation.valid) {
    return validation.catalog;
  }
  return enqueueProjectionWrite(root, async () => {
    const lockedValidation = await validateCatalogProjection(root);
    if (lockedValidation.valid) {
      return lockedValidation.catalog;
    }
    return rebuildCatalogUnlocked(root);
  });
}

export async function readActiveCatalog(options = {}) {
  const root = options.root ?? defaultStoreRoot();
  const normalizedRoot = path.resolve(root);
  await ensureStore(root);
  const activeFilePath = activePath(root);
  if (disabledActiveProjectionRoots.has(normalizedRoot)) {
    return readActiveCatalogFallback(root, activeFilePath);
  }

  let initialValidation;
  try {
    initialValidation = await validateActiveProjection(root, activeFilePath);
  } catch (error) {
    if (isActiveProjectionReadFailure(error)) {
      markActiveProjectionDisabled(normalizedRoot, error);
      return readActiveCatalogFallback(root, activeFilePath);
    }
    throw error;
  }
  if (initialValidation.valid) {
    return initialValidation.projection;
  }

  return enqueueProjectionWrite(root, async () => {
    let lockedValidation;
    try {
      lockedValidation = await validateActiveProjection(root, activeFilePath, { strict: true });
    } catch (error) {
      if (isActiveProjectionReadFailure(error)) {
        markActiveProjectionDisabled(normalizedRoot, error);
        return readActiveCatalogFallback(root, activeFilePath);
      }
      throw error;
    }
    if (lockedValidation.valid) {
      return lockedValidation.projection;
    }
    if (lockedValidation.reason === "tail-parse" && lockedValidation.error instanceof SyntaxError) {
      throw lockedValidation.error;
    }
    await rebuildCatalogUnlocked(root);
    if (disabledActiveProjectionRoots.has(normalizedRoot)) {
      return readActiveCatalogFallback(root, activeFilePath);
    }
    try {
      return await readActiveProjectionFile(root, activeFilePath);
    } catch (error) {
      if (isActiveProjectionReadFailure(error)) {
        markActiveProjectionDisabled(normalizedRoot, error);
        return readActiveCatalogFallback(root, activeFilePath);
      }
      throw error;
    }
  });
}

async function validateActiveProjection(root, activeFilePath, options = {}) {
  const strict = options.strict ?? false;
  let active;
  try {
    active = JSON.parse(await readFile(activeFilePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { valid: false, reason: error instanceof SyntaxError ? "active-json-syntax" : "missing-active" };
    }
    throw error;
  }

  const sourceEventLogMetadata = await readSourceEventLogMetadata(root);
  let expectedGenerationId;
  try {
    expectedGenerationId = await deriveGenerationId(root, sourceEventLogMetadata.size, sourceEventLogMetadata.mtimeMs);
  } catch (error) {
    if (error instanceof SyntaxError) {
      if (strict) {
        return { valid: false, reason: "tail-parse", error };
      }
      return { valid: false, reason: "tail-parse", error };
    }
    throw error;
  }
  if (active.version !== CATALOG_VERSION ||
      active.sourceEventLogBytes !== sourceEventLogMetadata.size ||
      active.sourceEventLogMtimeMs !== sourceEventLogMetadata.mtimeMs ||
      active.generationId !== expectedGenerationId) {
    return { valid: false, reason: "stale" };
  }

  return {
    valid: true,
    projection: { ...active, path: activeFilePath }
  };
}

async function validateCatalogProjection(root) {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath(root), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { valid: false };
    }
    throw error;
  }
  if (catalog.version !== CATALOG_VERSION) {
    return { valid: false };
  }
  const sourceEventLogMetadata = await readSourceEventLogMetadata(root);
  let expectedGenerationId;
  try {
    expectedGenerationId = await deriveGenerationId(root, sourceEventLogMetadata.size, sourceEventLogMetadata.mtimeMs);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { valid: false };
    }
    throw error;
  }
  if (catalog.sourceEventLogBytes !== sourceEventLogMetadata.size ||
      catalog.sourceEventLogMtimeMs !== sourceEventLogMetadata.mtimeMs ||
      catalog.generationId !== expectedGenerationId) {
    return { valid: false };
  }
  return { valid: true, catalog };
}

async function readActiveProjectionFile(root, activeFilePath) {
  const projection = JSON.parse(await readFile(activeFilePath, "utf8"));
  return { ...projection, path: activeFilePath };
}

async function deriveGenerationId(root, sourceEventLogBytes, sourceEventLogMtimeMs) {
  const lastEvent = await readLastEvent(root);
  return buildGenerationId(lastEvent ? [lastEvent] : [], sourceEventLogBytes, sourceEventLogMtimeMs);
}

async function readLastEvent(root) {
  const eventLogPath = eventsPath(root);
  let fileSize;
  try {
    fileSize = (await stat(eventLogPath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (fileSize === 0) {
    return undefined;
  }

  const handle = await open(eventLogPath, "r");
  try {
    let buffer = Buffer.alloc(0);
    let offset = fileSize;
    let chunkSize = Math.min(4_096, fileSize);
    while (offset > 0) {
      const readSize = Math.min(chunkSize, offset);
      const position = offset - readSize;
      const readResult = await handle.read(Buffer.alloc(readSize), 0, readSize, position);
      if (readResult.bytesRead === 0) {
        break;
      }
      const chunk = Buffer.from(readResult.buffer.subarray(0, readResult.bytesRead));
      buffer = Buffer.concat([chunk, buffer]);
      offset = position;
      const line = findLastNonEmptyLine(buffer, offset === 0);
      if (line !== undefined) {
        return JSON.parse(line);
      }
      if (offset === 0) {
        break;
      }
      chunkSize = Math.min(chunkSize * 2, fileSize);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function findLastNonEmptyLine(buffer, reachedStart) {
  let cursor = buffer.length;
  while (cursor > 0) {
    while (cursor > 0 && (buffer[cursor - 1] === 0x0a || buffer[cursor - 1] === 0x0d)) {
      cursor -= 1;
    }
    if (cursor === 0) {
      return undefined;
    }
    const newlineIndex = buffer.lastIndexOf(0x0a, cursor - 1);
    if (newlineIndex === -1) {
      if (!reachedStart) {
        return undefined;
      }
      const candidate = buffer.subarray(0, cursor).toString("utf8");
      return candidate.trim() === "" ? undefined : candidate;
    }
    const candidate = buffer.subarray(newlineIndex + 1, cursor).toString("utf8");
    if (candidate.trim() !== "") {
      return candidate;
    }
    cursor = newlineIndex;
  }
  return undefined;
}

export async function readCatalogSummary(options = {}) {
  const root = options.root ?? defaultStoreRoot();
  const active = await readActiveCatalog({ ...options, root });
  const total = Object.values(active.statusCounts ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
  return {
    counts: {
      total,
      open: active.statusCounts?.open ?? 0
    },
    paths: pathsForStore(root)
  };
}

export async function searchCatalog(query = {}, options = {}) {
  const status = query.status ? String(query.status) : undefined;
  const catalog = status && ["open", "triaged", "in-progress"].includes(status)
    ? await readActiveCatalog(options)
    : await readCatalog(options);
  const text = String(query.query ?? "").toLowerCase();
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
  const activeCatalog = await readActiveCatalog(options);
  const activeItem = activeCatalog.items.find((candidate) => candidate.id === id);
  if (activeItem) {
    const occurrences = await readOccurrencesForId(id, options);
    return { item: activeItem, occurrences };
  }
  const catalog = await readCatalog(options);
  const item = catalog.items.find((candidate) => candidate.id === id);
  if (!item) {
    return {
      notFound: true,
      id,
      recovery: "No Grease item matches this id. Run grease_search with a title, tool name, or symptom to find the current item id.",
      nearestMatches: nearestFrictionMatches(id, catalog.items)
    };
  }
  const occurrences = await readOccurrencesForId(id, options);
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
  const result = await appendEvent(event, options);
  const catalog = await readCatalog(options);
  return { event: result.event, catalog };
}

export async function updateFrictionBulk(ids, updates, options = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("ids must be a non-empty array");
  }
  const allowed = normalizeFrictionUpdates(updates);
  const root = options.root ?? defaultStoreRoot();
  const at = options.now ?? new Date().toISOString();
  await enqueueAppendWrite(root, async () => {
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
  });
  await maintainProjectionAfterAppend(root);
  const catalog = await readCatalog({ ...options, root });
  return { ids, catalog };
}

export function buildCatalog(events, options = {}) {
  const items = new Map();
  const occurrences = [];
  const updates = [];
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generationId = options.generationId ?? buildGenerationId(events, options.sourceEventLogBytes ?? 0, options.sourceEventLogMtimeMs ?? 0);
  const sourceEventLogBytes = options.sourceEventLogBytes ?? 0;
  const sourceEventLogMtimeMs = options.sourceEventLogMtimeMs ?? 0;

  for (const event of events) {
    if (event.type === "friction.signal") {
      const occurrence = occurrenceFromSignal(event);
      const id = occurrence.frictionId;
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

  const occurrencesByRecency = [...occurrences].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const occurrence of occurrencesByRecency) {
    const item = items.get(occurrence.frictionId);
    if (item && item.latestOccurrence === undefined) {
      item.latestOccurrence = occurrence;
    }
  }

  return {
    version: CATALOG_VERSION,
    generatedAt,
    generationId,
    sourceEventLogBytes,
    sourceEventLogMtimeMs,
    items: [...items.values()].sort(sortItems)
  };
}

function occurrenceFromSignal(event) {
  const signal = event.signal ?? {};
  const frictionId = event.frictionId ?? fingerprintSignal(event);
  return {
    id: event.id,
    frictionId,
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
}

function buildOccurrences(events) {
  const occurrences = [];
  for (const event of events) {
    if (event.type === "friction.signal") {
      occurrences.push(occurrenceFromSignal(event));
    }
  }
  return occurrences.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function readOccurrencesForId(id, options = {}) {
  const occurrences = buildOccurrences(await readEvents(options));
  if (id === undefined) {
    return occurrences;
  }
  return occurrences.filter((occurrence) => occurrence.frictionId === id);
}

export function pathsForStore(root = defaultStoreRoot()) {
  return {
    root,
    events: eventsPath(root),
    catalog: catalogPath(root)
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

function appendLockPath(root) {
  return path.join(root, "append.lock");
}

async function writeJsonFilesAtomic(root, catalog, active) {
  const resolvedRoot = path.resolve(root);
  const catalogTempPath = `${catalogPath(root)}.${process.pid}.${Date.now()}.${atomicWriteId++}.tmp`;
  let activeTempPath;
  try {
    await writeFile(catalogTempPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await replaceFileWithRetry(catalogTempPath, catalogPath(root));

    activeTempPath = `${activePath(root)}.${process.pid}.${Date.now()}.${atomicWriteId++}.tmp`;
    try {
      await writeFile(activeTempPath, `${JSON.stringify(active, null, 2)}\n`, "utf8");
      await replaceFileWithRetry(activeTempPath, activePath(root));
      disabledActiveProjectionRoots.delete(resolvedRoot);
    } catch (error) {
      if (activeTempPath) {
        await rm(activeTempPath, { force: true }).catch(() => undefined);
      }
      markActiveProjectionDisabled(resolvedRoot, error);
    }
  } catch (error) {
    await rm(catalogTempPath, { force: true }).catch(() => undefined);
    if (activeTempPath) {
      await rm(activeTempPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function markActiveProjectionDisabled(root, error) {
  const normalizedRoot = path.resolve(root);
  if (disabledActiveProjectionRoots.has(normalizedRoot)) {
    return false;
  }
  disabledActiveProjectionRoots.add(normalizedRoot);
  process.emitWarning("active projection persistence failure; falling back to full catalog", {
    code: "GREASE_ACTIVE_PROJECTION"
  });
  return true;
}

function isActiveProjectionReadFailure(error) {
  return error?.code === "ENOENT" || error?.code === "EISDIR" || error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EBUSY";
}

async function readActiveCatalogFallback(root, activeFilePath) {
  const catalog = await readCatalog({ root });
  return { ...buildActiveProjection(catalog), path: activeFilePath };
}

function enqueueSerial(queues, root, operation) {
  const previous = queues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => operation());
  const tracked = next.finally(() => {
    if (queues.get(root) === tracked) {
      queues.delete(root);
    }
  });
  queues.set(root, tracked);
  return next;
}

function enqueueProjectionWrite(root, operation) {
  return enqueueSerial(projectionWriteQueues, root, () => withProjectionLock(root, operation));
}

function enqueueAppendWrite(root, operation) {
  return enqueueSerial(appendWriteQueues, root, () => withAppendLock(root, operation));
}

async function withProjectionLock(root, operation) {
  const release = await acquireLock(root, storeLockPath(root));
  try {
    await sweepOrphanTempFiles(root);
    return await operation();
  } finally {
    await release();
  }
}

export async function withAppendLock(root, operation) {
  const release = await acquireLock(root, appendLockPath(root));
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function sweepOrphanTempFiles(root) {
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const removed = [];
  for (const name of entries) {
    // Only the exclusive-lock holder runs this, so any file matching a strict
    // projection owner-temp pattern is an orphan from a crashed write. The
    // filename pid is never trusted for liveness; the held lock is the proof.
    if (!CATALOG_TEMP_PATTERN.test(name) && !ACTIVE_TEMP_PATTERN.test(name)) {
      continue;
    }
    await rm(path.join(root, name), { force: true }).catch(() => undefined);
    removed.push(name);
  }
  return removed;
}

async function acquireLock(root, lockPath) {
  await mkdir(root, { recursive: true });
  const owner = buildStoreLockOwner();
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      return () => releaseStoreLock(lockPath, owner.token);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      await reclaimAbandonedLock(lockPath);
      if (Date.now() - startedAt > STORE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Grease store lock: ${lockPath}`);
      }
      await waitForRetry();
    }
  }
}

async function tryAcquireProjectionLock(root) {
  await mkdir(root, { recursive: true });
  const lockPath = storeLockPath(root);
  const owner = buildStoreLockOwner();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      return () => releaseStoreLock(lockPath, owner.token);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      // A live holder owns the projection lock, so never wait. Reclaim only a
      // provably abandoned lock, then retry the claim exactly once.
      await reclaimAbandonedLock(lockPath);
    }
  }
  return undefined;
}

export function buildStoreLockOwner() {
  return {
    pid: process.pid,
    startTimeMs: PROCESS_START_TIME_MS,
    token: randomUUID(),
    acquiredAt: new Date().toISOString()
  };
}

export function isStoreLockOwnerAlive(owner) {
  const pid = owner?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this process may not signal it.
    return error?.code === "EPERM";
  }
}

export function shouldReclaimStoreLock(owner, options = {}) {
  const now = options.now ?? Date.now();
  const mtimeMs = options.mtimeMs ?? now;
  const graceMs = options.graceMs ?? STORE_LOCK_GRACE_MS;
  const isAlive = options.isProcessAliveFn ?? ((pid) => isStoreLockOwnerAlive({ pid }));
  if (!owner || !Number.isInteger(owner.pid)) {
    // Missing or corrupt owner metadata may be the mkdir->owner.json window.
    // Reclaim only after a bounded grace so a half-written lock survives.
    return now - mtimeMs > graceMs;
  }
  return !isAlive(owner.pid);
}

export async function releaseStoreLock(lockPath, ownerToken) {
  let owner;
  try {
    owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    // A corrupt owner.json is not proof of ownership, so refuse to delete it.
    return;
  }
  if (owner.token !== ownerToken) {
    // The lock was reclaimed and re-acquired by another owner. Deleting it now
    // would be an ABA deletion of a foreign lock.
    return;
  }
  const tombstonePath = `${lockPath}.${process.pid}.${atomicWriteId++}.released`;
  const startedAt = Date.now();
  while (true) {
    try {
      await rename(lockPath, tombstonePath);
      break;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      // Windows can transiently refuse a directory rename with EPERM/EBUSY when
      // another store operation holds a handle on the parent. Retry within a
      // bound rather than leaking the lock, matching replaceFileWithRetry.
      if (!isRetryableReplaceError(error) || Date.now() - startedAt > FILE_REPLACE_TIMEOUT_MS) {
        throw error;
      }
      await waitForRetry();
    }
  }
  await rm(tombstonePath, { recursive: true, force: true });
}

async function reclaimAbandonedLock(lockPath) {
  let info;
  try {
    info = await stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
    owner = undefined;
  }
  if (!shouldReclaimStoreLock(owner, { now: Date.now(), mtimeMs: info.mtimeMs })) {
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

function buildGenerationId(events, sourceEventLogBytes, sourceEventLogMtimeMs) {
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const lastEventSnapshot = lastEvent === undefined ? "" : JSON.stringify(lastEvent);
  return hash([
    String(CATALOG_VERSION),
    String(sourceEventLogBytes),
    String(sourceEventLogMtimeMs ?? 0),
    lastEventSnapshot
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
  return {
    version: catalog.version,
    generatedAt: catalog.generatedAt,
    generationId: catalog.generationId,
    sourceEventLogBytes: catalog.sourceEventLogBytes,
    sourceEventLogMtimeMs: catalog.sourceEventLogMtimeMs,
    items: items.map((item) => ({ ...item })),
    statusCounts
  };
}

async function rebuildActiveCatalog(root) {
  await rebuildCatalog({ root });
  const activeFilePath = activePath(root);
  const projection = JSON.parse(await readFile(activeFilePath, "utf8"));
  return { ...projection, path: activeFilePath };
}

async function readSourceEventLogMetadata(root) {
  try {
    const info = await stat(eventsPath(root));
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { size: 0, mtimeMs: 0 };
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

function nearestFrictionMatches(id, items) {
  const query = String(id ?? "").toLowerCase();
  return (items ?? [])
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      score: nearestMatchScore(query, item)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || String(left.title).localeCompare(String(right.title)))
    .slice(0, 5)
    .map(({ score, ...item }) => item);
}

function nearestMatchScore(query, item) {
  if (!query) {
    return 1;
  }
  const fields = [
    item.id,
    item.title,
    item.latestSummary,
    item.kind,
    item.source,
    ...(item.tags ?? [])
  ].map((value) => String(value ?? "").toLowerCase());
  if (fields.some((field) => field === query)) {
    return 100;
  }
  if (fields.some((field) => field.includes(query) || query.includes(field))) {
    return 50;
  }
  const queryPrefix = query.slice(0, 6);
  return fields.some((field) => field.includes(queryPrefix)) ? 10 : 1;
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
