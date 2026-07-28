import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, getFriction, searchCatalog } from '../.github/extensions/grease/core/catalog.mjs';
import { classifySessionEvent } from '../.github/extensions/grease/core/classifier.mjs';

async function seed(root, toolName, error) {
  const [signal] = classifySessionEvent('tool.execution_complete', { success: false, toolName, error });
  await appendEvent(signal, { root });
}

test('an unknown id that matches nothing returns no nearest matches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-nearest-'));
  try {
    await seed(root, 'alpha.run', 'Access denied');
    await seed(root, 'beta.run', 'deadline timeout');
    await seed(root, 'gamma.run', 'EACCES');

    const result = await getFriction('zzzzzzzzzzzzzzzz', { root });

    assert.equal(result.notFound, true);
    assert.deepEqual(result.nearestMatches, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an id that genuinely prefixes an existing item still returns that item', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-nearest-'));
  try {
    await seed(root, 'delta.run', 'EPERM');

    const { items } = await searchCatalog({}, { root });
    const realId = items[0].id;
    const prefix = realId.slice(0, 8);

    const result = await getFriction(prefix, { root });

    assert.equal(result.notFound, true);
    assert.ok(result.nearestMatches.some((match) => match.id === realId), 'a genuine partial id match must still be offered');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
