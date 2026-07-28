import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, getFriction, readEvents, searchCatalog, updateFriction, updateFrictionBulk } from '../.github/extensions/grease/core/catalog.mjs';
import { classifySessionEvent } from '../.github/extensions/grease/core/classifier.mjs';
import { createGreaseTools } from '../.github/extensions/grease/core/tools.mjs';

async function seed(root, toolName, error) {
  const [signal] = classifySessionEvent('tool.execution_complete', { success: false, toolName, error });
  await appendEvent(signal, { root });
}

test('updateFriction rejects an itemId that does not exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-existence-'));
  try {
    await seed(root, 'alpha.run', 'Access denied');

    const before = await readEvents({ root });
    const result = await updateFriction('9cb748027a0daf36', { status: 'resolved' }, { root });

    assert.equal(result.notFound, true);
    assert.equal(result.event, undefined);
    assert.equal((await readEvents({ root })).length, before.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updateFrictionBulk fails the whole batch when any id is unknown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-existence-'));
  try {
    await seed(root, 'alpha.run', 'Access denied');
    await seed(root, 'beta.run', 'deadline timeout');

    const { items } = await searchCatalog({}, { root });
    const realIds = items.map((item) => item.id);

    const before = await readEvents({ root });
    const result = await updateFrictionBulk([...realIds, '9cb748027a0daf36'], { status: 'resolved' }, { root });

    assert.equal(result.notFound, true);
    assert.equal((await readEvents({ root })).length, before.length);

    for (const id of realIds) {
      assert.equal((await getFriction(id, { root })).item.status, 'open');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grease_update tool reports notFound for an unknown id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-existence-'));
  try {
    await seed(root, 'gamma.run', 'EACCES');

    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const raw = await tools.get('grease_update').handler({ id: '9cb748027a0daf36', status: 'resolved' }, {});
    const payload = JSON.parse(raw.textResultForLlm);

    assert.equal(payload.data.notFound, true);
    assert.equal(payload.data.eventId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updateFriction still updates an existing item', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-existence-'));
  try {
    await seed(root, 'delta.run', 'EPERM');

    const { items } = await searchCatalog({}, { root });
    const [realId] = items.map((item) => item.id);

    await updateFriction(realId, { status: 'triaged' }, { root });

    assert.equal((await getFriction(realId, { root })).item.status, 'triaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updateFriction accepts an item that the persisted projection has not caught up to', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-existence-'));
  try {
    await seed(root, 'alpha.run', 'Access denied');
    await seed(root, 'epsilon.run', 'ETIMEDOUT');

    const { items } = await searchCatalog({}, { root });
    const secondId = items[1].id;

    const result = await updateFriction(secondId, { status: 'triaged' }, { root });

    assert.equal(result.notFound, undefined);
    assert.equal((await getFriction(secondId, { root })).item.status, 'triaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
