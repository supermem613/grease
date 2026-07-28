import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as catalogModule from '../.github/extensions/grease/core/catalog.mjs';
import { appendEvent, buildCatalog, readCatalogSummary, readEvents, searchCatalog, updateFriction, pathsForStore } from '../.github/extensions/grease/core/catalog.mjs';
import { classifySessionEvent } from '../.github/extensions/grease/core/classifier.mjs';

async function plantOrphan(root, itemId, status) {
  const payload = {
    type: 'friction.update',
    at: '2026-07-01T00:00:00.000Z',
    itemId,
    updates: { status },
    id: 'orphan-' + itemId,
  };
  await appendFile(pathsForStore(root).events, JSON.stringify(payload) + '\n');
}

async function seed(root, toolName, error) {
  const [signal] = classifySessionEvent('tool.execution_complete', { success: false, toolName, error });
  await appendEvent(signal, { root });
}

test('buildCatalog counts friction.update events whose itemId does not resolve', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-orphan-'));
  try {
    await seed(root, 'alpha.run', 'Access denied');
    await plantOrphan(root, '9cb748027a0daf36', 'resolved');
    await plantOrphan(root, 'aaaabbbbccccdddd', 'resolved');

    const catalog = buildCatalog(await readEvents({ root }));
    assert.equal(catalog.orphanedUpdates, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a catalog with no orphaned updates reports a zero count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-orphan-'));
  try {
    await seed(root, 'beta.run', 'EPERM');

    const catalog = buildCatalog(await readEvents({ root }));
    assert.equal(catalog.orphanedUpdates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readCatalogSummary surfaces the orphaned update count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-orphan-'));
  try {
    await seed(root, 'gamma.run', 'EACCES');
    await plantOrphan(root, '9cb748027a0daf36', 'resolved');

    const summary = await readCatalogSummary({ root });
    assert.equal(summary.counts.orphanedUpdates, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneOrphanedUpdates reports orphans without deleting them by default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-orphan-'));
  try {
    await seed(root, 'delta.run', 'ETIMEDOUT');
    await plantOrphan(root, '9cb748027a0daf36', 'resolved');
    await plantOrphan(root, 'aaaabbbbccccdddd', 'resolved');

    const before = await readEvents({ root });
    const pruneOrphanedUpdates = catalogModule.pruneOrphanedUpdates;
    assert.equal(typeof pruneOrphanedUpdates, 'function', 'pruneOrphanedUpdates must be exported');
    const result = await pruneOrphanedUpdates({ root });

    assert.equal(result.dryRun, true);
    assert.equal(result.orphanedUpdates, 2);
    assert.deepEqual([...result.orphanedItemIds].sort(), ['9cb748027a0daf36', 'aaaabbbbccccdddd']);
    assert.equal(result.removed, 0);
    assert.equal(result.backupPath, null);
    assert.equal((await readEvents({ root })).length, before.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneOrphanedUpdates removes only orphaned updates when explicitly asked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-orphan-'));
  try {
    await seed(root, 'epsilon.run', 'EBUSY');

    const { items } = await searchCatalog({}, { root });
    await updateFriction(items[0].id, { status: 'triaged' }, { root });

    await plantOrphan(root, '9cb748027a0daf36', 'resolved');
    await plantOrphan(root, 'aaaabbbbccccdddd', 'resolved');

    const before = await readEvents({ root });
    const pruneOrphanedUpdates = catalogModule.pruneOrphanedUpdates;
    assert.equal(typeof pruneOrphanedUpdates, 'function', 'pruneOrphanedUpdates must be exported');
    const result = await pruneOrphanedUpdates({ root, apply: true });

    assert.equal(result.dryRun, false);
    assert.equal(result.removed, 2);
    assert.equal(typeof result.backupPath, 'string');

    const after = await readEvents({ root });
    assert.equal(after.length, before.length - 2);
    assert.equal(after.filter((event) => event.type === 'friction.update').length, 1);
    assert.equal(after.filter((event) => event.type === 'friction.update')[0].itemId, items[0].id);

    const backupLines = (await readFile(result.backupPath, 'utf8')).trim().split(/\n/).filter(Boolean);
    assert.equal(backupLines.length, before.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
